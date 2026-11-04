// Task management tied to the audit process and to the data the team saves.
//
//   - Process tasks: when a company reaches a stage, its standard tasks appear, assigned by role
//     on the audit (audit lead, report writer, field engineers, the reviewer). Many close by
//     themselves when the data shows the work is done (report saved, sync problems solved, photos
//     in, draft approved); any left open close when the company moves past their stage.
//   - Data-entry tasks: "record 25 motors in Motor Pulse" for a person; progress is counted from what that
//     person synced to that company (or anyone, when nobody is assigned) and the task closes at
//     the target.
//   - Ordinary tasks: anything else, by hand, as before.
//
// reconcileTasks() keeps all this in step; it runs on reading the tasks, after a sync and after a
// stage move. It only adds missing process tasks and closes finished ones; it never deletes.
import { randomId } from './security.js';
import { stagesFor } from './stages.js';

const DAY = 86400000;

/** What each app records, for data-entry targets ("25 motors"). */
export const RECORD_KINDS = {
  survey: { zone: 'main inputs', panel: 'panels', machine: 'machines', apfc: 'APFC stages', energy_source: 'energy sources' },
  motor: { motor: 'motors', monitoring_session: 'monitoring sessions' },
  heat: { boiler: 'boilers and heaters', fuel: 'fuels', direct_test: 'direct tests', indirect_test: 'indirect tests' },
  textile: { jet: 'jets' },
  air: { compressor: 'compressors' },
  pump: { pump_test: 'pumps' },
  cool: { air_unit: 'AC / AHU units', chiller: 'chillers', cooling_tower: 'cooling towers' },
  xmer: { transformer: 'transformers' },
  light: { lighting_area: 'lighting areas' },
  dryer: { dryer: 'dryers' },
  power: { pq_recording: 'PQ recordings' },
};

// The standard tasks of each stage. who: lead | report | reviewer | none. done(f): the data says it is done.
const TEMPLATES = {
  setup: [
    { key: 'team', title: 'Add the audit team and an audit lead', who: 'lead', due: 2, done: f => f.hasLead },
    { key: 'details', title: 'Fill in the company and plant details', who: 'lead', due: 3, done: f => f.detailsDone },
  ],
  field: [
    { key: 'field-data', title: 'Collect the field data in the apps', who: 'lead', due: 14, done: f => f.records > 0 && f.issues === 0 },
    { key: 'site-photos', title: 'Take the site photos with the records', who: 'lead', due: 14, done: f => f.photos > 0 },
  ],
  processing: [
    { key: 'photos', title: 'Check that every photo has uploaded', who: 'lead', due: 5, done: f => f.photosMissing === 0 && f.uploading === 0 && f.photos > 0 },
    { key: 'sync', title: 'Solve the sync problems', who: 'lead', due: 3, done: f => f.issues === 0 },
    { key: 'check', title: 'Check the data of each app against the site notes', who: 'lead', due: 5, done: () => false },
    { key: 'draft', title: 'Write the draft report in Report Studio', who: 'report', due: 10, done: f => !!f.report },
  ],
  review: [
    { key: 'review', title: 'Review the draft report: approve it, or send it back with a reason', who: 'reviewer', due: 3, done: f => f.stageIndex > f.indexOf('review') },
  ],
  approved: [
    { key: 'publish', title: 'Make the final report, attach the PDF and publish the audit', who: 'report', due: 5, done: f => f.stageIndex > f.indexOf('approved') },
  ],
};

function factsFor(db, a) {
  const list = stagesFor(a).map(s => s.key);
  const site = db.prepare('SELECT district, state, contract_demand_kva FROM sites WHERE id = ?').get(a.site_id) || {};
  const ready = new Set(db.prepare("SELECT id FROM files WHERE audit_id = ? AND status = 'ready'").all(a.id).map(f => f.id));
  let photosMissing = 0;
  for (const r of db.prepare("SELECT payload, synced_at FROM records WHERE audit_id = ? AND payload LIKE '%ares-photo:%'").all(a.id)) {
    if (r.synced_at > Date.now() - 15 * 60 * 1000) continue;   // photos follow their record by a few minutes
    for (const m of r.payload.matchAll(/ares-photo:([0-9a-f-]{36})/g)) if (!ready.has(m[1])) photosMissing++;
  }
  return {
    indexOf: k => list.indexOf(k),
    stageIndex: list.indexOf(a.stage || 'setup'),
    hasLead: !!db.prepare("SELECT 1 FROM assignments WHERE audit_id = ? AND role = 'lead'").get(a.id),
    detailsDone: !!(site.district && site.state && site.contract_demand_kva != null && a.work_type),
    records: db.prepare("SELECT COUNT(*) AS n FROM records WHERE audit_id = ? AND kind NOT IN ('company_profile','report','report_part','report_facts')").get(a.id).n,
    photos: ready.size,
    photosMissing,
    uploading: db.prepare("SELECT COUNT(*) AS n FROM files WHERE audit_id = ? AND status = 'uploading'").get(a.id).n,
    issues: db.prepare('SELECT COUNT(*) AS n FROM sync_issues WHERE audit_id = ? AND resolved_at IS NULL').get(a.id).n,
    report: db.prepare("SELECT 1 FROM records WHERE audit_id = ? AND kind = 'report'").get(a.id),
  };
}

function whoFor(db, a, who) {
  const team = db.prepare('SELECT user_id, role FROM assignments WHERE audit_id = ?').all(a.id);
  const lead = team.find(t => t.role === 'lead');
  if (who === 'reviewer') return (team.find(t => t.role === 'reviewer') || {}).user_id || null;
  if (who === 'report') return (team.find(t => t.role === 'report') || lead || {}).user_id || null;
  if (who === 'lead') return lead ? lead.user_id : null;
  return null;
}

/** How far a data-entry task has got: records of that app (and kind) on that company, by its person. */
export function taskProgress(db, t) {
  if (!t.target || !t.app) return null;
  const args = [t.audit_id, t.app];
  let sql = "SELECT COUNT(*) AS n FROM records WHERE audit_id = ? AND app = ? AND kind NOT IN ('company_profile','report','report_part','report_facts') AND COALESCE(json_extract(payload, '$._deleted'), 0) = 0";
  if (t.record_kind) { sql += ' AND kind = ?'; args.push(t.record_kind); }
  if (t.assignee) { sql += ' AND user_id = ?'; args.push(t.assignee); }
  return { count: db.prepare(sql).get(...args).n, target: t.target };
}

/** Adds the current stage's missing process tasks and closes the finished ones, for one audit or all. */
export function reconcileTasks(db, auditId = null) {
  const now = Date.now();
  const audits = db.prepare(`SELECT * FROM audits ${auditId ? 'WHERE id = ?' : ''}`).all(...(auditId ? [auditId] : []));
  const has = db.prepare('SELECT * FROM tasks WHERE audit_id = ? AND auto_key = ?');
  const add = db.prepare(`INSERT INTO tasks (id, audit_id, app, title, assignee, status, due_at, created_at, created_by, stage, source, auto_key)
                          VALUES (?, ?, NULL, ?, ?, 'todo', ?, ?, NULL, ?, 'process', ?)`);
  const close = db.prepare("UPDATE tasks SET status = 'done', started_at = COALESCE(started_at, ?), done_at = ?, done_note = ? WHERE id = ?");
  const fill = db.prepare('UPDATE tasks SET assignee = ? WHERE id = ? AND assignee IS NULL');
  for (const a of audits) {
    const f = factsFor(db, a);
    const list = stagesFor(a).map(s => s.key);
    const cur = list.indexOf(a.stage || 'setup');
    // Process tasks of the current stage (and closing those of stages already passed).
    for (const [stage, templates] of Object.entries(TEMPLATES)) {
      const si = list.indexOf(stage);
      if (si < 0 || si > cur) continue;
      for (const tp of templates) {
        let t = has.get(a.id, `${stage}:${tp.key}`);
        if (!t && si === cur) {
          const id = randomId('T', 6);
          add.run(id, a.id, tp.title, whoFor(db, a, tp.who), (a.stage_at || now) + tp.due * DAY, now, stage, `${stage}:${tp.key}`);
          t = has.get(a.id, `${stage}:${tp.key}`);
        }
        if (!t || t.status === 'done') continue;
        if (!t.assignee) { const w = whoFor(db, a, tp.who); if (w) fill.run(w, t.id); }
        if (tp.done(f)) close.run(now, now, 'done (the data shows it)', t.id);
        else if (si < cur) close.run(now, now, 'closed: the audit moved on', t.id);
      }
    }
    // Data-entry tasks that reached their target.
    for (const t of db.prepare("SELECT * FROM tasks WHERE audit_id = ? AND status != 'done' AND target IS NOT NULL").all(a.id)) {
      const p = taskProgress(db, t);
      if (p && p.count >= p.target) close.run(now, now, `done: ${p.count} of ${p.target} recorded`, t.id);
    }
  }
}

/** Tasks with their company, stage, person and progress, plus each person's workload. */
export function listTasks(db, { auditId = null } = {}) {
  const rows = db.prepare(`
    SELECT t.*, u.name AS assignee_name, s.industry_tag, s.name AS site_name, c.name AS client_name, au.stage AS audit_stage, au.status AS audit_status,
      (SELECT f.id FROM files f WHERE f.audit_id = au.id AND f.kind = 'logo' AND f.status = 'ready' ORDER BY f.created_at DESC LIMIT 1) AS logo_file_id
    FROM tasks t JOIN audits au ON au.id = t.audit_id JOIN sites s ON s.id = au.site_id JOIN clients c ON c.id = s.client_id
    LEFT JOIN users u ON u.id = t.assignee
    ${auditId ? 'WHERE t.audit_id = ?' : ''}
    ORDER BY CASE t.status WHEN 'running' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END, COALESCE(t.due_at, 9e15), t.created_at DESC`).all(...(auditId ? [auditId] : []));
  const tasks = rows.map(t => ({ ...t, progress: taskProgress(db, t) }));
  // Workload: open and overdue tasks, and what each person entered in the last 7 days, per company.
  const now = Date.now(), since = now - 7 * DAY;
  const people = new Map();
  const person = (id, name) => { if (!people.has(id)) people.set(id, { id, name, open: 0, overdue: 0, done_week: 0, entered: [] }); return people.get(id); };
  for (const t of tasks) {
    if (!t.assignee) continue;
    const p = person(t.assignee, t.assignee_name);
    if (t.status !== 'done') { p.open++; if (t.due_at && t.due_at < now) p.overdue++; } else if (t.done_at > since) p.done_week++;
  }
  for (const r of db.prepare(`SELECT r.user_id, u.name, r.audit_id, c.name AS client_name, r.app, COUNT(*) AS n
                              FROM records r JOIN users u ON u.id = r.user_id JOIN audits au ON au.id = r.audit_id JOIN sites s ON s.id = au.site_id JOIN clients c ON c.id = s.client_id
                              WHERE r.taken_at > ? AND r.kind NOT IN ('company_profile','report','report_part','report_facts') ${auditId ? 'AND r.audit_id = ?' : ''}
                              GROUP BY r.user_id, r.audit_id, r.app ORDER BY n DESC`).all(since, ...(auditId ? [auditId] : []))) {
    person(r.user_id, r.name).entered.push({ audit_id: r.audit_id, client_name: r.client_name, app: r.app, n: r.n });
  }
  return { tasks, workload: [...people.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open || a.name.localeCompare(b.name)), kinds: RECORD_KINDS };
}
