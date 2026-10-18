import { fail, str } from './http.js';
import { tx, logActivity } from './db.js';
import { APP_CODES } from './apps.js';
import { hashPassword, verifyPassword, passwordProblem, rateLimiter } from './security.js';
import { checkCredentials, createSession, hasApp, isManager, canUseAudit } from './auth.js';

const loginLimit = rateLimiter(20, 10 * 60 * 1000);
const RECORD_ID = /^[A-Za-z0-9-]{8,64}$/;
const MAX_PAYLOAD = 256 * 1024;
const PULL_LIMIT = 1000;
const FUTURE_SLACK = 24 * 60 * 60 * 1000;

// Each sync gets its own strictly increasing stamp, so a phone's `since` never skips or
// repeats a record, even when two syncs land in the same millisecond.
let lastStamp = null;
function syncStamp(db) {
  if (lastStamp === null) lastStamp = db.prepare('SELECT MAX(synced_at) AS m FROM records').get().m || 0;
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

function myAudits(db, user) {
  const sql = `SELECT au.id, au.title, au.fy, au.status, s.name AS site_name, s.industry_tag
               FROM audits au JOIN sites s ON s.id = au.site_id`;
  return isManager(user)
    ? db.prepare(`${sql} WHERE au.status NOT IN ('published','archived') ORDER BY au.created_at DESC`).all()
    : db.prepare(`${sql} JOIN assignments a ON a.audit_id = au.id WHERE a.user_id = ? ORDER BY au.created_at DESC`).all(user.id);
}

function requireReady(user) {
  if (user.must_change_pw) fail(403, 'Please set your own password first.', 'password_change_required');
}

export function registerDeviceRoutes(router) {
  // Field app sign-in. Same Login ID and password for every app; access is checked per app.
  router.add('POST', '/api/device/login', async ({ db, body, ip }) => {
    const b = await body();
    if (!loginLimit(`dlogin:${ip}`)) fail(429, 'Too many attempts. Wait a few minutes.');
    const app = String(b.app || '');
    if (!APP_CODES.has(app)) fail(400, 'Unknown app.');
    const deviceId = b.device_id ? str(b.device_id, { field: 'Device ID', max: 80 }) : null;
    const user = await checkCredentials(db, b.login_id, b.password, ip);
    if (!hasApp(db, user, app)) {
      logActivity(db, { userId: user.id, action: 'login.refused', target: app, detail: 'no access to app', ip });
      fail(403, 'You do not have access to this app. Please contact your admin.', 'no_app_access');
    }
    const token = createSession(db, user, { kind: 'device', app, deviceId });
    logActivity(db, { userId: user.id, action: 'login.app', target: app, detail: deviceId, ip });
    return {
      token,
      user: { id: user.id, name: user.name, login_id: user.login_id },
      must_change_pw: !!user.must_change_pw,
      audits: user.must_change_pw ? [] : myAudits(db, user),
    };
  }, { public: true });

  router.add('POST', '/api/device/change-password', async ({ db, body, auth, ip }) => {
    const b = await body();
    if (!(await verifyPassword(String(b.current || ''), auth.user.pw_hash))) fail(400, 'Current password is not correct.');
    const problem = passwordProblem(b.next);
    if (problem) fail(400, problem);
    if (b.next === b.current) fail(400, 'Choose a password different from the current one.');
    db.prepare('UPDATE users SET pw_hash = ?, must_change_pw = 0 WHERE id = ?').run(await hashPassword(b.next), auth.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(auth.user.id, auth.tokenHash);
    logActivity(db, { userId: auth.user.id, action: 'password.changed', target: auth.session.app, ip });
    return { ok: true };
  }, { device: true });

  router.add('GET', '/api/device/me', ({ db, auth }) => {
    requireReady(auth.user);
    return {
      user: { id: auth.user.id, name: auth.user.name, login_id: auth.user.login_id },
      app: auth.session.app,
      audits: myAudits(db, auth.user),
    };
  }, { device: true });

  // One call does both directions: push this phone's queue, then pull what changed for the team.
  router.add('POST', '/api/sync', async ({ db, body, auth, ip }) => {
    const b = await body();
    const user = auth.user;
    requireReady(user);
    const app = auth.session.app;
    const now = syncStamp(db);
    const incoming = Array.isArray(b.records) ? b.records : [];
    const sessions = Array.isArray(b.sessions) ? b.sessions : [];
    if (incoming.length > 500 || sessions.length > 200) fail(413, 'Send at most 500 records per sync.');
    const auditOk = new Map();
    const allowed = id => {
      if (!auditOk.has(id)) auditOk.set(id, canUseAudit(db, user, id));
      return auditOk.get(id);
    };

    const results = tx(db, () => incoming.map(r => pushRecord(db, user, app, r, now, allowed)));

    tx(db, () => {
      for (const w of sessions) {
        if (typeof w?.id !== 'string' || !RECORD_ID.test(w.id)) continue;
        const startedAt = Number(w.started_at);
        const endedAt = w.ended_at == null ? null : Number(w.ended_at);
        if (!Number.isFinite(startedAt) || startedAt > now + FUTURE_SLACK) continue;
        if (endedAt !== null && (!Number.isFinite(endedAt) || endedAt < startedAt)) continue;
        const auditId = w.audit_id ? String(w.audit_id) : null;
        if (auditId && !allowed(auditId)) continue;
        const existing = db.prepare('SELECT user_id FROM work_sessions WHERE id = ?').get(w.id);
        if (existing && existing.user_id !== user.id) continue;
        db.prepare(`INSERT INTO work_sessions (id, user_id, app, audit_id, device_id, started_at, ended_at, records)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, records = excluded.records`)
          .run(w.id, user.id, app, auditId, auth.session.device_id, startedAt, endedAt, Math.max(0, Math.floor(Number(w.records) || 0)));
      }
    });

    const stored = results.filter(r => r.status === 'stored' || r.status === 'updated').length;
    const refused = results.filter(r => r.status === 'refused').length;
    if (stored || refused) logActivity(db, { userId: user.id, action: 'sync', target: app, detail: `${stored} saved, ${refused} refused`, ip });

    // Pull: everything changed since the phone's last sync, for its audits and this app.
    const since = Number(b.since) || 0;
    const audits = myAudits(db, user).map(a => a.id);
    let changed = [];
    if (audits.length) {
      changed = db.prepare(`
        SELECT r.id, r.audit_id, r.app, r.kind, r.tag, r.taken_at, r.saved_at, r.synced_at, r.version, r.payload,
               r.user_id, u.name AS recorded_by, r.updated_by, ub.name AS updated_by_name
        FROM records r JOIN users u ON u.id = r.user_id LEFT JOIN users ub ON ub.id = r.updated_by
        WHERE r.app = ? AND r.synced_at > ? AND r.audit_id IN (${audits.map(() => '?').join(',')})
        ORDER BY r.synced_at LIMIT ?`).all(app, since, ...audits, PULL_LIMIT + 1)
        .map(r => ({ ...r, payload: JSON.parse(r.payload) }));
    }
    const more = changed.length > PULL_LIMIT;
    if (more) changed.pop();
    return {
      results,
      records: changed,
      more,
      // Next `since`. When the list was cut short, step back one stamp so the rest of that
      // sync's batch is fetched (re-pulling a record is harmless: the phone matches it by ID).
      next_since: more ? changed[changed.length - 1].synced_at - 1 : Math.max(since, now),
      server_time: now,
    };
  }, { device: true, bodyLimit: 8 * 1024 * 1024 });
}

function pushRecord(db, user, app, r, now, allowed) {
  const id = typeof r?.id === 'string' ? r.id : '';
  const refuse = reason => ({ id, status: 'refused', reason });
  if (!RECORD_ID.test(id)) return refuse('Record ID is missing or not valid.');
  if (r.app && r.app !== app) return refuse('Record belongs to a different app.');
  const auditId = String(r.audit_id || '');
  if (!allowed(auditId)) return refuse('You are not assigned to this audit.');
  const takenAt = Number(r.taken_at), savedAt = Number(r.saved_at);
  if (!Number.isFinite(takenAt) || !Number.isFinite(savedAt) || savedAt > now + FUTURE_SLACK || takenAt > now + FUTURE_SLACK) {
    return refuse('Record times are missing or in the future.');
  }
  if (!r.payload || typeof r.payload !== 'object') return refuse('Record has no data.');
  const payload = JSON.stringify(r.payload);
  if (payload.length > MAX_PAYLOAD) return refuse('Record is too large.');
  const tag = r.tag == null ? null : String(r.tag).trim().slice(0, 60) || null;
  const kind = r.kind == null ? null : String(r.kind).slice(0, 40);

  const existing = db.prepare('SELECT * FROM records WHERE id = ?').get(id);
  if (existing && (existing.app !== app || existing.audit_id !== auditId)) return refuse('Record ID already used elsewhere.');

  if (tag) {
    const clash = db.prepare(`SELECT r.id, u.name FROM records r JOIN users u ON u.id = r.user_id
                              WHERE r.audit_id = ? AND r.app = ? AND lower(r.tag) = lower(?) AND r.id != ?`)
      .get(auditId, app, tag.replace(/\s+/g, ' '), id);
    if (clash) return refuse(`Tag "${tag}" is already recorded by ${clash.name}.`);
  }

  if (!existing) {
    db.prepare(`INSERT INTO records (id, audit_id, app, user_id, updated_by, device_id, kind, tag, taken_at, saved_at, synced_at, version, payload)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
      .run(id, auditId, app, user.id, user.id, r.device_id ? String(r.device_id).slice(0, 80) : null, kind, tag, takenAt, savedAt, now, payload);
    return { id, status: 'stored', version: 1 };
  }
  if (savedAt <= existing.saved_at) return { id, status: 'kept_server', version: existing.version };
  // Newer save wins; the older copy is kept as a version.
  db.prepare('INSERT INTO record_versions (record_id, version, user_id, saved_at, payload) VALUES (?, ?, ?, ?, ?)')
    .run(existing.id, existing.version, existing.updated_by || existing.user_id, existing.saved_at, existing.payload);
  db.prepare('UPDATE records SET updated_by = ?, kind = ?, tag = ?, taken_at = ?, saved_at = ?, synced_at = ?, version = ?, payload = ? WHERE id = ?')
    .run(user.id, kind, tag, takenAt, savedAt, now, existing.version + 1, payload, id);
  return { id, status: 'updated', version: existing.version + 1 };
}
