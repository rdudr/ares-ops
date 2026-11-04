// The AR audit process, one company at a time (docs/PLATFORM_RULES.md §7):
//
//   Draft → In field → Processing → Review → Approved → Published
//
//   Draft       the company and plant are set up; the team is not in the field yet
//   In field    the team collects data in the apps (a walkthrough audit is shorter, same stages)
//   Processing  photos and data are checked, sync problems solved, the report is written in Report Studio
//   Review      the draft report is with an Admin
//   Approved    an Admin or Super Admin approved it (nobody else can)
//   Published   the final report is out; the audit is finalised and its data locked
//
// The stage is separate from the audit status the apps use (Published finalises the audit, as
// "Finalise audit" always did, status archived). Moving back needs a written reason, which goes in
// the activity log. The Console suggests the next stage when the data shows it; the audit lead,
// an Admin who sees the audit, or a Super Admin confirms. Approving is for Admins and Super Admins.
import { fail } from './http.js';
import { logActivity } from './db.js';
import { scopeOf, seesAudit } from './scope.js';

export const STAGES = [
  { key: 'setup', label: 'Draft', short: 'Draft' },
  { key: 'field', label: 'In field', short: 'In field' },
  { key: 'processing', label: 'Processing', short: 'Processing' },
  { key: 'review', label: 'Review', short: 'Review' },
  { key: 'approved', label: 'Approved', short: 'Approved' },
  { key: 'published', label: 'Published', short: 'Published' },
];
const KEYS = STAGES.map(s => s.key);
// People on an audit and what they do there. (Console roles are Super Admin, Admin and Engineer.)
export const TEAM_ROLES = { lead: 'Audit lead', field: 'Field engineer', report: 'Report writer', reviewer: 'Reviewer' };
const DAY = 86400000;
const CLOSED = new Set(['archived', 'published']);


/** The stages this company goes through (all of them, for every kind of audit). */
export function stagesFor() {
  return STAGES;
}

/** What to do next, and whether the data already points to it. */
export function nextStep(db, a) {
  const list = stagesFor(a), i = list.findIndex(s => s.key === a.stage), next = list[i + 1] || null;
  const facts = {
    records: db.prepare("SELECT COUNT(*) AS n FROM records WHERE audit_id = ? AND kind NOT IN ('company_profile','report','report_part','report_facts')").get(a.id).n,
    lastField: db.prepare("SELECT MAX(synced_at) AS t FROM records WHERE audit_id = ? AND app NOT IN ('report','power')").get(a.id).t,
    report: db.prepare("SELECT version, saved_at FROM records WHERE audit_id = ? AND kind = 'report'").get(a.id) || null,
    issues: db.prepare('SELECT COUNT(*) AS n FROM sync_issues WHERE audit_id = ? AND resolved_at IS NULL').get(a.id).n,
    uploading: db.prepare("SELECT COUNT(*) AS n FROM files WHERE audit_id = ? AND status = 'uploading'").get(a.id).n,
  };
  let hint = '', ready = false;
  switch (a.stage) {
    case 'setup':
      ready = facts.records > 0;
      hint = ready ? `The team has started: ${facts.records} records from the field apps.` : 'Waiting for the team to start on site.';
      break;
    case 'field':
      ready = facts.records > 0 && facts.lastField && facts.lastField < Date.now() - 2 * DAY;
      hint = ready ? 'No field data for two days: the site work looks finished.' : 'Field work in progress.';
      break;
    case 'processing':
      ready = !!facts.report && facts.issues === 0 && facts.uploading === 0;
      hint = facts.issues || facts.uploading
        ? `Finish the field data first: ${facts.issues ? `${facts.issues} sync problem${facts.issues > 1 ? 's' : ''}` : ''}${facts.issues && facts.uploading ? ', ' : ''}${facts.uploading ? `${facts.uploading} photo${facts.uploading > 1 ? 's' : ''} still uploading` : ''}.`
        : facts.report ? 'Photos and data are in; the report has been started in Report Studio.'
          : 'Check the photos and each app\'s data, then write the report in Report Studio.';
      break;
    case 'review':
      hint = facts.report ? `Draft saved (version ${facts.report.version}). An Admin reviews it: approve it, or send it back with a reason.` : 'Waiting for the draft report from Report Studio.';
      break;
    case 'approved':
      ready = !!facts.report;
      hint = 'Approved. Publish it: mark the audit published (attach the final PDF), which finalises it and locks its data.';
      break;
    case 'published':
      hint = 'Published. The audit is finalised and its data is locked. Send it back only with a reason.';
      break;
  }
  return { next: next && next.key, ready: !!ready, hint, waiting_for: null, facts };
}

/** Admins and Super Admins review and approve. An Admin only on audits they see (their own apps and teams). */
export function canApprove(db, user, auditId) {
  if (user.role === 'super_admin') return true;
  return user.role === 'head' && seesAudit(scopeOf(db, user), auditId);
}

/** Who may move this company on: a Super Admin, an Admin who sees it, or its audit lead. */
export function canMove(db, user, auditId) {
  if (canApprove(db, user, auditId)) return true;
  const lead = db.prepare("SELECT user_id FROM assignments WHERE audit_id = ? AND role = 'lead'").get(auditId);
  return !!lead && lead.user_id === user.id;
}

/** Moves a company to another stage (forward, or back with a reason). Returns the new stage. */
export function moveStage(db, auditId, to, user, { note = null, ip = null, reportFileId = null } = {}) {
  const a = db.prepare('SELECT * FROM audits WHERE id = ?').get(auditId) || fail(404, 'Audit not found.');
  if (!KEYS.includes(to)) fail(400, 'Unknown stage.');
  const list = stagesFor(a).map(s => s.key);
  const from = a.stage || 'setup';
  const forward = list.indexOf(to) > list.indexOf(from);
  if (to === from) fail(400, 'The audit is already at that stage.');
  // Only an Admin or Super Admin takes a draft from Review to Approved (docs/PLATFORM_RULES.md §7).
  if (from === 'review' && to === 'approved' && !canApprove(db, user, a.id)) fail(403, 'Only an Admin or Super Admin approves the draft.');
  if (!canMove(db, user, a.id)) fail(403, 'Only the audit lead, an Admin or a Super Admin moves this audit on.');
  if (!forward && !note) fail(400, 'Say why it goes back (a short written reason).');
  if (forward && list.indexOf(to) > list.indexOf(from) + 1 && user.role !== 'super_admin') fail(400, 'Move one stage at a time.');
  if (forward && to === 'approved' && !canApprove(db, user, a.id)) fail(403, 'Only an Admin or Super Admin approves.');

  const now = Date.now();
  if (to === 'published' && !CLOSED.has(a.status)) {
    // Publishing finalises the audit, exactly as "Finalise audit": the apps stop saving to it.
    let reportId = null;
    if (reportFileId) {
      const f = db.prepare("SELECT id FROM files WHERE id = ? AND audit_id = ? AND status = 'ready'").get(String(reportFileId), a.id);
      if (!f) fail(400, 'The report file was not found for this audit.');
      reportId = f.id;
    }
    db.prepare("UPDATE audits SET status = 'archived', finalized_at = ?, finalized_by = ?, report_file_id = COALESCE(?, report_file_id) WHERE id = ?").run(now, user.id, reportId, a.id);
  }
  if (CLOSED.has(a.status) && list.indexOf(to) < list.indexOf('published')) {
    // Back before Published: the audit opens again so the team can correct its data.
    db.prepare("UPDATE audits SET status = 'in_field', finalized_at = NULL, finalized_by = NULL WHERE id = ?").run(a.id);
  }
  db.prepare('UPDATE audits SET stage = ?, stage_at = ? WHERE id = ?').run(to, now, a.id);
  db.prepare('INSERT INTO audit_stage_log (audit_id, from_stage, to_stage, at, by_user, note) VALUES (?, ?, ?, ?, ?, ?)').run(a.id, from, to, now, user.id, note ? String(note).slice(0, 500) : null);
  logActivity(db, { userId: user.id, action: forward ? 'audit.stage' : 'audit.stage_back', target: a.id,
    detail: `${STAGES.find(s => s.key === from)?.label} → ${STAGES.find(s => s.key === to)?.label}${note ? `: ${String(note).slice(0, 200)}` : ''}`, ip });
  return to;
}

/** Every audit with its stage, team, next step and history, for the Overview and the audit page. */
export function pipeline(db, { auditId = null } = {}) {
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
    stages: STAGES, roles: TEAM_ROLES,
    audits: rows.map(a => ({
      ...a,
      stages: stagesFor(a).map(s => s.key),
      team: team.filter(t => t.audit_id === a.id),
      history: log.filter(l => l.audit_id === a.id),
      next: nextStep(db, a),
    })),
  };
}
