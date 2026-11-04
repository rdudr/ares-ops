// The team and sync picture of one audit, for its page in the Console:
//
//   - who is on it: assigned people and anyone who worked on it, with the app they last had open
//     on this company, whether they are working now, their last sync and the app version they
//     saved with;
//   - sync problems: saves the Console refused or that clashed with a teammate's (kept in
//     sync_issues when they happen, closed by themselves when the same record saves later),
//     photos a record points to that never reached the server, and uploads stuck half-way.
//
// Nothing here changes data; the page offers the fixes (reopen, add to the audit, open records).
import { logActivity } from './db.js';

const LIVE_MS = 15 * 60 * 1000;          // an app seen within this time counts as "working now"
const PHOTO_GRACE_MS = 15 * 60 * 1000;   // photos may follow their record by a few minutes
const PHOTO_REF = /ares-photo:([0-9a-f-]{36})/g;

/** Keeps the refused and conflicting saves of one sync; a record that saves later closes its own. */
export function logSyncIssues(db, { user, app, build, incoming, results, audit }) {
  const now = Date.now();
  const open = db.prepare(`SELECT id FROM sync_issues WHERE resolved_at IS NULL AND audit_id = ? AND app = ? AND record_id = ? AND status = ? AND reason = ?`);
  const bump = db.prepare('UPDATE sync_issues SET last_at = ?, count = count + 1, user_id = ?, app_version = ? WHERE id = ?');
  const add = db.prepare(`INSERT INTO sync_issues (audit_id, app, user_id, record_id, tag, kind, status, reason, app_version, first_at, last_at, count)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
  const close = db.prepare(`UPDATE sync_issues SET resolved_at = ?, resolution = 'saved later' WHERE resolved_at IS NULL AND record_id = ? AND app = ?`);
  results.forEach((res, i) => {
    const r = incoming[i] || {};
    if (!res || !res.id) return;
    if (res.status === 'stored' || res.status === 'updated' || res.status === 'unchanged') { close.run(now, res.id, app); return; }
    if (res.status !== 'refused' && res.status !== 'conflict') return;
    const auditId = String(r.audit_id || '').slice(0, 40);
    if (!auditId || !audit(auditId, true)) return;   // only audits that exist
    const reason = String(res.reason || (res.status === 'conflict' ? 'Changed by a teammate since this phone started editing.' : 'Refused.')).slice(0, 300);
    const hit = open.get(auditId, app, res.id, res.status, reason);
    if (hit) bump.run(now, user.id, build, hit.id);
    else add.run(auditId, app, user.id, res.id, r.tag == null ? null : String(r.tag).slice(0, 60), r.kind == null ? null : String(r.kind).slice(0, 40),
      res.status, reason, build, now, now);
  });
}

export function resolveSyncIssue(db, id, user, ip) {
  const row = db.prepare('SELECT * FROM sync_issues WHERE id = ?').get(id);
  if (!row) return null;
  db.prepare("UPDATE sync_issues SET resolved_at = ?, resolved_by = ?, resolution = 'marked solved' WHERE id = ? AND resolved_at IS NULL").run(Date.now(), user.id, id);
  logActivity(db, { userId: user.id, action: 'sync_issue.solved', target: row.audit_id, detail: `${row.app} ${row.tag || row.record_id}: ${row.reason}`, ip });
  return row;
}

export function auditStatus(db, auditId) {
  const now = Date.now();
  const users = new Map();
  const person = (id, name, extra = {}) => {
    if (!id) return null;
    if (!users.has(id)) users.set(id, { id, name: name || '—', role: null, assigned: false, apps: {}, ...extra });
    return users.get(id);
  };
  for (const u of db.prepare(`SELECT u.id, u.name, u.role FROM assignments a JOIN users u ON u.id = a.user_id WHERE a.audit_id = ?`).all(auditId)) {
    const p = person(u.id, u.name); p.assigned = true; p.role = u.role;
  }
  const appOf = (p, app) => (p.apps[app] = p.apps[app] || { app, records: 0, last_sync: null, app_version: null, last_seen: null, live: false, open_session: false });

  // Work sessions: the app each person had open on this company, and when it last reported.
  for (const s of db.prepare(`SELECT w.user_id, u.name, u.role, w.app, MAX(COALESCE(w.last_seen_at, w.ended_at, w.started_at)) AS seen,
                                     MAX(CASE WHEN w.ended_at IS NULL THEN 1 ELSE 0 END) AS open
                              FROM work_sessions w JOIN users u ON u.id = w.user_id WHERE w.audit_id = ? GROUP BY w.user_id, w.app`).all(auditId)) {
    const p = person(s.user_id, s.name); p.role = p.role || s.role;
    const a = appOf(p, s.app);
    a.last_seen = s.seen; a.open_session = !!s.open; a.live = !!s.open && s.seen > now - LIVE_MS;
  }
  // Records: how much each person saved per app, their last sync and the app version they used.
  for (const r of db.prepare(`SELECT COALESCE(r.updated_by, r.user_id) AS uid, u.name, u.role, r.app, COUNT(*) AS n, MAX(r.synced_at) AS last
                              FROM records r JOIN users u ON u.id = COALESCE(r.updated_by, r.user_id)
                              WHERE r.audit_id = ? AND r.kind != 'company_profile' GROUP BY uid, r.app`).all(auditId)) {
    const p = person(r.uid, r.name); p.role = p.role || r.role;
    const a = appOf(p, r.app);
    a.records = r.n; a.last_sync = r.last;
  }
  for (const v of db.prepare(`SELECT COALESCE(updated_by, user_id) AS uid, app, app_version FROM records r1
                              WHERE audit_id = ? AND app_version IS NOT NULL AND app_version != 'Console'
                                AND synced_at = (SELECT MAX(synced_at) FROM records r2 WHERE r2.audit_id = r1.audit_id AND r2.app = r1.app
                                                 AND COALESCE(r2.updated_by, r2.user_id) = COALESCE(r1.updated_by, r1.user_id)
                                                 AND r2.app_version IS NOT NULL AND r2.app_version != 'Console')`).all(auditId)) {
    const p = users.get(v.uid); if (p) appOf(p, v.app).app_version = v.app_version;
  }

  // Photos a record points to that are not (yet) on the server, and uploads stuck half-way.
  const ready = new Set(db.prepare("SELECT id FROM files WHERE audit_id = ? AND status = 'ready'").all(auditId).map(f => f.id));
  const uploading = new Map(db.prepare("SELECT id, uploaded_by, created_at, received, size FROM files WHERE audit_id = ? AND status = 'uploading'").all(auditId).map(f => [f.id, f]));
  const missing = new Map();
  for (const r of db.prepare(`SELECT r.id, r.app, r.kind, r.tag, r.saved_at, r.synced_at, r.payload, COALESCE(r.updated_by, r.user_id) AS uid, u.name
                              FROM records r JOIN users u ON u.id = COALESCE(r.updated_by, r.user_id) WHERE r.audit_id = ?`).all(auditId)) {
    if (!r.payload.includes('ares-photo:')) continue;
    let p; try { p = JSON.parse(r.payload); } catch { continue; }
    if (p._deleted) continue;
    const ids = new Set([...r.payload.matchAll(PHOTO_REF)].map(m => m[1]));
    const gone = [...ids].filter(id => !ready.has(id));
    if (!gone.length) continue;
    const key = `${r.uid}|${r.app}`;
    const m = missing.get(key) || { user_id: r.uid, name: r.name, app: r.app, photos: 0, half_sent: 0, tags: new Set(), newest: 0 };
    for (const id of gone) { m.photos++; if (uploading.has(id)) m.half_sent++; }
    if (r.tag) m.tags.add(r.tag);
    m.newest = Math.max(m.newest, r.synced_at || r.saved_at || 0);
    missing.set(key, m);
  }
  const photos = [...missing.values()].map(m => ({ ...m, tags: [...m.tags].slice(0, 8), arriving: m.newest > now - PHOTO_GRACE_MS }));

  const issues = db.prepare(`SELECT i.*, u.name AS user_name FROM sync_issues i LEFT JOIN users u ON u.id = i.user_id
                             WHERE i.audit_id = ? AND i.resolved_at IS NULL ORDER BY i.last_at DESC LIMIT 200`).all(auditId);
  const solved = db.prepare('SELECT COUNT(*) AS n FROM sync_issues WHERE audit_id = ? AND resolved_at IS NOT NULL').get(auditId).n;

  const people = [...users.values()].map(p => ({ ...p, apps: Object.values(p.apps).sort((a, b) => (b.last_seen || b.last_sync || 0) - (a.last_seen || a.last_sync || 0)) }))
    .sort((a, b) => Number(b.apps.some(x => x.live)) - Number(a.apps.some(x => x.live))
      || Math.max(0, ...b.apps.map(x => x.last_seen || x.last_sync || 0)) - Math.max(0, ...a.apps.map(x => x.last_seen || x.last_sync || 0)));
  return { now, live_minutes: LIVE_MS / 60000, people, issues, solved, photos };
}
