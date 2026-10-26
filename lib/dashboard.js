const DAY = 24 * 60 * 60 * 1000;
const OPEN_SESSION_CAP = 12 * 60 * 60 * 1000; // an unclosed work session counts for at most 12 h
const IST = "'+330 minutes'";

// Everything here is computed from what the apps logged. Nothing is estimated.
export function dashboard(db, days) {
  const now = Date.now();
  const since = now - days * DAY;

  const users = db.prepare('SELECT id, name, login_id, role, employment, status, last_login_at FROM users ORDER BY name').all();

  const hours = loggedTime(db, since, now);
  const records = rows(db, `
    SELECT user_id, COUNT(*) AS n, MAX(taken_at) AS last FROM records WHERE taken_at >= ? GROUP BY user_id`, since);
  const days_ = rows(db, `
    SELECT user_id, COUNT(DISTINCT d) AS n FROM (
      SELECT user_id, date(taken_at / 1000, 'unixepoch', ${IST}) AS d FROM records WHERE taken_at >= ?
      UNION SELECT user_id, date(started_at / 1000, 'unixepoch', ${IST}) FROM work_sessions WHERE started_at >= ?
    ) GROUP BY user_id`, since, since);
  const tasksDone = rows(db, `
    SELECT assignee AS user_id, COUNT(*) AS n,
      SUM(CASE WHEN due_at IS NULL OR done_at <= due_at THEN 1 ELSE 0 END) AS on_time
    FROM tasks WHERE status = 'done' AND done_at >= ? AND assignee IS NOT NULL GROUP BY assignee`, since);
  const overdue = rows(db, `
    SELECT assignee AS user_id, COUNT(*) AS n FROM tasks
    WHERE status != 'done' AND due_at IS NOT NULL AND due_at < ? AND assignee IS NOT NULL GROUP BY assignee`, now);
  const lastSession = rows(db, `SELECT user_id, MAX(COALESCE(ended_at, started_at)) AS last FROM work_sessions GROUP BY user_id`);

  const workingNow = db.prepare(`
    SELECT w.user_id, u.name, w.app, w.audit_id, w.started_at, w.records, s.industry_tag
    FROM work_sessions w JOIN users u ON u.id = w.user_id
    LEFT JOIN audits au ON au.id = w.audit_id LEFT JOIN sites s ON s.id = au.site_id
    WHERE w.ended_at IS NULL AND w.started_at > ? ORDER BY w.started_at`).all(now - OPEN_SESSION_CAP);

  const people = users.map(u => {
    const ms = hours.get(u.id) || 0;
    const rec = records.get(u.id)?.n || 0;
    const done = tasksDone.get(u.id);
    const h = ms / 3600000;
    return {
      ...u,
      hours: round1(h),
      records: rec,
      records_per_hour: h >= 0.25 ? round1(rec / h) : null,
      active_days: days_.get(u.id)?.n || 0,
      tasks_done: done?.n || 0,
      on_time_pct: done?.n ? Math.round((done.on_time / done.n) * 100) : null,
      overdue: overdue.get(u.id)?.n || 0,
      last_active: Math.max(u.last_login_at || 0, records.get(u.id)?.last || 0, lastSession.get(u.id)?.last || 0) || null,
      working_now: workingNow.find(w => w.user_id === u.id) || null,
    };
  });

  const runningTasks = db.prepare(`
    SELECT t.id, t.title, t.app, t.started_at, t.due_at, u.name AS assignee_name, s.industry_tag
    FROM tasks t JOIN audits au ON au.id = t.audit_id JOIN sites s ON s.id = au.site_id
    LEFT JOIN users u ON u.id = t.assignee
    WHERE t.status = 'running' ORDER BY t.started_at`).all();

  const perDay = db.prepare(`
    SELECT date(taken_at / 1000, 'unixepoch', ${IST}) AS d, COUNT(*) AS n
    FROM records WHERE taken_at >= ? GROUP BY d ORDER BY d`).all(now - 14 * DAY);

  const auditCounts = db.prepare('SELECT status, COUNT(*) AS n FROM audits GROUP BY status').all();

  const recent = db.prepare(`
    SELECT a.id, a.at, a.action, a.target, a.detail, u.name AS user_name, tu.name AS target_name
    FROM activity a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN users tu ON tu.id = a.target
    ORDER BY a.id DESC LIMIT 12`).all();

  return {
    days,
    generated_at: now,
    totals: {
      active_people: users.filter(u => u.status === 'active').length,
      working_now: workingNow.length,
      running_tasks: runningTasks.length,
      open_tasks: db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status != 'done'").get().n,
      records: people.reduce((s, p) => s + p.records, 0),
      hours: round1(people.reduce((s, p) => s + p.hours, 0)),
      open_audits: auditCounts.filter(a => !['published', 'archived'].includes(a.status)).reduce((s, a) => s + a.n, 0),
    },
    people,
    working_now: workingNow,
    running_tasks: runningTasks,
    records_per_day: fillDays(perDay, now, 14),
    recent,
  };
}

// Logged time per person. Overlapping sessions (two apps open at once, or a resent session) are
// merged so no minute is counted twice. A session that was never closed counts only up to the
// last record that person saved in that app after it started (never more than 12 h), so a
// forgotten open session does not add hours nobody worked.
function loggedTime(db, since, now) {
  const sessions = db.prepare('SELECT user_id, app, started_at, ended_at FROM work_sessions WHERE started_at >= ? ORDER BY user_id, started_at').all(since);
  const lastSave = db.prepare('SELECT MAX(saved_at) AS t FROM records WHERE updated_by = ? AND app = ? AND saved_at >= ? AND saved_at <= ?');
  const byUser = new Map();
  for (const s of sessions) {
    const cap = Math.min(s.started_at + OPEN_SESSION_CAP, now);
    const end = s.ended_at != null ? Math.min(s.ended_at, cap) : Math.max(s.started_at, lastSave.get(s.user_id, s.app, s.started_at, cap).t || s.started_at);
    if (end > s.started_at) (byUser.get(s.user_id) || byUser.set(s.user_id, []).get(s.user_id)).push([s.started_at, end]);
  }
  const out = new Map();
  for (const [user, spans] of byUser) {
    spans.sort((x, y) => x[0] - y[0]);
    let total = 0, [cs, ce] = spans[0];
    for (const [st, en] of spans.slice(1)) {
      if (st <= ce) ce = Math.max(ce, en);
      else { total += ce - cs; [cs, ce] = [st, en]; }
    }
    out.set(user, total + (ce - cs));
  }
  return out;
}

function rows(db, sql, ...params) {
  return new Map(db.prepare(sql).all(...params).map(r => [r.user_id, r]));
}

const round1 = n => Math.round(n * 10) / 10;

function fillDays(list, now, n) {
  const map = new Map(list.map(r => [r.d, r.n]));
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now - i * DAY + 330 * 60000).toISOString().slice(0, 10);
    out.push({ d, n: map.get(d) || 0 });
  }
  return out;
}
