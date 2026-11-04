// The AR audit process, one company at a time:
//
//   Audit initiated → Walkthrough energy audit → Detailed energy audit → Data processing
//   → Initial draft → Approval (Rahul Patel) → Final draft → Completed → Post audit
//
// A walkthrough-only company (type of work "walkthrough") skips the detailed audit.
// The stage is separate from the audit status the apps use: the apps save until the company is
// Completed, which finalises it (status archived), as "Finalise audit" always did. Post audit
// comes 2–3 months after the report is submitted; for now it only records done or not done.
//
// The Console suggests the next stage when the data shows it; the team lead or a Super Admin
// confirms. Only the approver (Rahul Patel, login APPROVER_LOGIN) approves the initial draft.
import { fail } from './http.js';
import { logActivity } from './db.js';

export const STAGES = [
  { key: 'initiated', label: 'Audit initiated', short: 'Initiated' },
  { key: 'walkthrough', label: 'Walkthrough energy audit', short: 'Walkthrough' },
  { key: 'detailed', label: 'Detailed energy audit', short: 'Detailed' },
  { key: 'processing', label: 'Data processing', short: 'Processing' },
  { key: 'draft', label: 'Initial draft', short: 'Draft' },
  { key: 'approval', label: 'Approval', short: 'Approval' },
  { key: 'final', label: 'Final draft', short: 'Final' },
  { key: 'completed', label: 'Completed', short: 'Completed' },
  { key: 'post_audit', label: 'Post audit', short: 'Post audit' },
];
const KEYS = STAGES.map(s => s.key);
export const TEAM_ROLES = { lead: 'Team lead', field: 'Field engineer', report: 'Report writer' };
export const APPROVER_LOGIN = (process.env.APPROVER_LOGIN || 'rahul').toLowerCase();
export const POST_AUDIT_DAYS = 60;            // post audit falls due about two months after completion
const DAY = 86400000;
const CLOSED = new Set(['archived', 'published']);

/** The stages this company goes through (walkthrough-only companies skip the detailed audit). */
export function stagesFor(audit) {
  return STAGES.filter(s => !(s.key === 'detailed' && audit.work_type === 'walkthrough'));
}


/** What to do next, and whether the data already points to it. */
export function nextStep(db, a, approver) {
  const list = stagesFor(a), i = list.findIndex(s => s.key === a.stage), next = list[i + 1] || null;
  const facts = {
    records: db.prepare("SELECT COUNT(*) AS n FROM records WHERE audit_id = ? AND kind NOT IN ('company_profile','report','report_part','report_facts')").get(a.id).n,
    lastField: db.prepare("SELECT MAX(synced_at) AS t FROM records WHERE audit_id = ? AND app NOT IN ('report','power')").get(a.id).t,
    report: db.prepare("SELECT version, saved_at FROM records WHERE audit_id = ? AND kind = 'report'").get(a.id) || null,
    issues: db.prepare('SELECT COUNT(*) AS n FROM sync_issues WHERE audit_id = ? AND resolved_at IS NULL').get(a.id).n,
    uploading: db.prepare("SELECT COUNT(*) AS n FROM files WHERE audit_id = ? AND status = 'uploading'").get(a.id).n,
  };
  const approverName = approver ? approver.name : 'the approver';
  let hint = '', ready = false, waitingFor = null;
  switch (a.stage) {
    case 'initiated':
      ready = facts.records > 0;
      hint = ready ? `The team has started: ${facts.records} records from the field apps.` : 'Waiting for the team to start on site.';
      break;
    case 'walkthrough':
    case 'detailed':
      ready = facts.records > 0 && facts.lastField && facts.lastField < Date.now() - 2 * DAY;
      hint = ready ? 'No field data for two days: the site work looks finished.' : 'Field work in progress.';
      break;
    case 'processing':
      ready = !!facts.report && facts.issues === 0 && facts.uploading === 0;
      hint = facts.issues || facts.uploading
        ? `Finish the field data first: ${facts.issues ? `${facts.issues} sync problem${facts.issues > 1 ? 's' : ''}` : ''}${facts.issues && facts.uploading ? ', ' : ''}${facts.uploading ? `${facts.uploading} photo${facts.uploading > 1 ? 's' : ''} still uploading` : ''}.`
        : facts.report ? 'Photos, thermal images and data are in; the report has been started in Report Studio.'
          : 'Add the thermal images and photos, check each app\'s data, then start the report in Report Studio.';
      break;
    case 'draft':
      ready = !!facts.report;
      hint = facts.report ? `Report saved (version ${facts.report.version}). Send it to ${approverName} when the draft is ready.` : 'Write the initial draft in Report Studio.';
      break;
    case 'approval':
      waitingFor = approver ? approver.id : null;
      hint = `Waiting for ${approverName} to approve the draft, or send it back with a note.`;
      break;
    case 'final':
      hint = 'Make the final draft in Report Studio, then mark the audit completed (attach the final PDF).';
      ready = !!facts.report;
      break;
    case 'completed': {
      const due = (a.finalized_at || a.stage_at || Date.now()) + POST_AUDIT_DAYS * DAY;
      ready = Date.now() >= due;
      hint = ready ? 'Post audit is due: check what the plant has done.' : `Post audit due around ${new Date(due).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}.`;
      break;
    }
    case 'post_audit':
      hint = a.post_audit_status === 'done' ? 'Post audit done.' : a.post_audit_status === 'not_done' ? 'Post audit: recommendations not carried out.' : 'Record whether the post audit is done.';
      break;
  }
  return { next: next && next.key, ready: !!ready, hint, waiting_for: waitingFor, facts };
}

export function approverOf(db) {
  return db.prepare("SELECT id, name, login_id FROM users WHERE lower(login_id) = ? AND status = 'active'").get(APPROVER_LOGIN) || null;
}

/** Who may move this company on: a Super Admin, its team lead, or any Team Head when it has no lead. */
export function canMove(db, user, auditId) {
  if (user.role === 'super_admin') return true;
  const lead = db.prepare("SELECT user_id FROM assignments WHERE audit_id = ? AND role = 'lead'").get(auditId);
  if (lead) return lead.user_id === user.id;
  return user.role === 'head';
}

/** Moves a company to another stage (forward, or back with a note). Returns the new stage. */
export function moveStage(db, auditId, to, user, { note = null, ip = null, reportFileId = null } = {}) {
  const a = db.prepare('SELECT * FROM audits WHERE id = ?').get(auditId) || fail(404, 'Audit not found.');
  if (!KEYS.includes(to)) fail(400, 'Unknown stage.');
  const list = stagesFor(a).map(s => s.key);
  if (!list.includes(to)) fail(400, 'A walkthrough-only audit has no detailed audit stage.');
  const from = a.stage || 'initiated';
  const forward = list.indexOf(to) > list.indexOf(from);
  const approver = approverOf(db);
  const isApprover = approver && approver.id === user.id;
  // Approval: only the approver takes a draft from Approval to Final draft.
  if (from === 'approval' && to === 'final' && !isApprover) fail(403, `Only ${approver ? approver.name : 'the approver'} approves the draft.`);
  if (from === 'approval' && !forward && !(isApprover || canMove(db, user, a.id))) fail(403, 'Only the approver or the team lead sends a draft back.');
  if (!(from === 'approval' && (isApprover || !forward)) && !canMove(db, user, a.id)) fail(403, 'Only the team lead or a Super Admin moves this audit on.');
  if (!forward && !note) fail(400, 'Say why it goes back (a short note).');
  if (forward && list.indexOf(to) > list.indexOf(from) + 1 && user.role !== 'super_admin') fail(400, 'Move one stage at a time.');

  const now = Date.now();
  if (to === 'completed' && !CLOSED.has(a.status)) {
    // Completing finalises the audit, exactly as "Finalise audit": the apps stop saving to it.
    let reportId = null;
    if (reportFileId) {
      const f = db.prepare("SELECT id FROM files WHERE id = ? AND audit_id = ? AND status = 'ready'").get(String(reportFileId), a.id);
      if (!f) fail(400, 'The report file was not found for this audit.');
      reportId = f.id;
    }
    db.prepare("UPDATE audits SET status = 'archived', finalized_at = ?, finalized_by = ?, report_file_id = COALESCE(?, report_file_id) WHERE id = ?").run(now, user.id, reportId, a.id);
  }
  if (CLOSED.has(a.status) && list.indexOf(to) < list.indexOf('completed')) {
    // Back before Completed: the audit opens again so the team can correct its data.
    db.prepare("UPDATE audits SET status = 'in_field', finalized_at = NULL, finalized_by = NULL WHERE id = ?").run(a.id);
  }
  db.prepare('UPDATE audits SET stage = ?, stage_at = ? WHERE id = ?').run(to, now, a.id);
  db.prepare('INSERT INTO audit_stage_log (audit_id, from_stage, to_stage, at, by_user, note) VALUES (?, ?, ?, ?, ?, ?)').run(a.id, from, to, now, user.id, note ? String(note).slice(0, 500) : null);
  logActivity(db, { userId: user.id, action: forward ? 'audit.stage' : 'audit.stage_back', target: a.id,
    detail: `${STAGES.find(s => s.key === from)?.label} → ${STAGES.find(s => s.key === to)?.label}${note ? `: ${String(note).slice(0, 200)}` : ''}`, ip });
  return to;
}

export function setPostAudit(db, auditId, status, note, user, ip) {
  const a = db.prepare('SELECT * FROM audits WHERE id = ?').get(auditId) || fail(404, 'Audit not found.');
  if (a.stage !== 'post_audit') fail(400, 'The audit is not at the post audit stage yet.');
  if (!['pending', 'done', 'not_done'].includes(status)) fail(400, 'Done, not done or pending.');
  if (!canMove(db, user, a.id)) fail(403, 'Only the team lead or a Super Admin records the post audit.');
  db.prepare('UPDATE audits SET post_audit_status = ?, post_audit_note = ?, post_audit_at = ? WHERE id = ?').run(status, note ? String(note).slice(0, 1000) : null, Date.now(), a.id);
  logActivity(db, { userId: user.id, action: 'audit.post_audit', target: a.id, detail: `${status}${note ? `: ${String(note).slice(0, 200)}` : ''}`, ip });
}

/** Every audit with its stage, team, next step and history, for the Overview and the audit page. */
export function pipeline(db, { auditId = null } = {}) {
  const approver = approverOf(db);
  const rows = db.prepare(`
    SELECT au.*, s.name AS site_name, s.industry_tag, s.district, s.state, c.name AS client_name, c.sector,
      (SELECT f.id FROM files f WHERE f.audit_id = au.id AND f.kind = 'logo' AND f.status = 'ready' ORDER BY f.created_at DESC LIMIT 1) AS logo_file_id,
      (SELECT COUNT(*) FROM records r WHERE r.audit_id = au.id AND r.kind NOT IN ('company_profile','report','report_part','report_facts')) AS records,
      (SELECT COUNT(*) FROM files f WHERE f.audit_id = au.id AND f.status = 'ready' AND f.mime LIKE 'image/%') AS photos,
      (SELECT COUNT(DISTINCT r.app) FROM records r WHERE r.audit_id = au.id AND r.kind != 'company_profile' AND r.app NOT IN ('report','power')) AS apps,
      (SELECT COUNT(*) FROM sync_issues i WHERE i.audit_id = au.id AND i.resolved_at IS NULL) AS issues,
      (SELECT COUNT(*) FROM tasks t WHERE t.audit_id = au.id AND t.status != 'done') AS open_tasks,
      (SELECT MAX(r.synced_at) FROM records r WHERE r.audit_id = au.id) AS last_sync
    FROM audits au JOIN sites s ON s.id = au.site_id JOIN clients c ON c.id = s.client_id
    ${auditId ? 'WHERE au.id = ?' : ''} ORDER BY au.created_at DESC`).all(...(auditId ? [auditId] : []));
  const team = db.prepare(`SELECT a.audit_id, a.role, u.id, u.name, u.role AS user_role FROM assignments a JOIN users u ON u.id = a.user_id ORDER BY
    CASE a.role WHEN 'lead' THEN 0 WHEN 'field' THEN 1 ELSE 2 END, u.name`).all();
  const log = db.prepare(`SELECT l.*, u.name AS by_name FROM audit_stage_log l LEFT JOIN users u ON u.id = l.by_user ${auditId ? 'WHERE l.audit_id = ?' : ''} ORDER BY l.at`).all(...(auditId ? [auditId] : []));
  return {
    stages: STAGES, roles: TEAM_ROLES, approver, post_audit_days: POST_AUDIT_DAYS,
    audits: rows.map(a => ({
      ...a,
      stages: stagesFor(a).map(s => s.key),
      team: team.filter(t => t.audit_id === a.id),
      history: log.filter(l => l.audit_id === a.id),
      next: nextStep(db, a, approver),
    })),
  };
}
