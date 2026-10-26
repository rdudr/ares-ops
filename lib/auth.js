import { HttpError, fail } from './http.js';
import { verifyPassword, dummyVerify, newToken, hashToken } from './security.js';
import { logActivity } from './db.js';

export const WEB_IDLE_MS = 30 * 60 * 1000;          // console logs out after 30 min idle
export const WEB_MAX_MS = 12 * 60 * 60 * 1000;      // and after 12 h at most
export const DEVICE_MAX_MS = 7 * 24 * 60 * 60 * 1000; // field apps sign in again weekly
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

// Wrong-password lockouts are kept per account *and* address, in memory. Someone guessing from one
// address locks only that address out of that account, so they can never lock the real owner
// (e.g. the Super Admin) out from everywhere. The per-address request limit sits on top of this.
const failures = new Map(); // `${userId}|${ip}` -> { n, until }

// Failed sign-ins per address (any account). Successful sign-ins do not count, so a whole team
// behind one office or mobile network is never blocked for logging in normally.
const IP_MAX_FAILS = 30;
const IP_WINDOW_MS = 10 * 60 * 1000;
const ipFailures = new Map(); // ip -> [timestamps]

function recentIpFailures(ip, now) {
  const list = (ipFailures.get(ip) || []).filter(t => now - t < IP_WINDOW_MS);
  if (list.length) ipFailures.set(ip, list); else ipFailures.delete(ip);
  return list;
}

function noteIpFailure(ip, now) {
  const list = recentIpFailures(ip, now);
  list.push(now);
  ipFailures.set(ip, list);
  if (ipFailures.size > 50000) for (const k of ipFailures.keys()) recentIpFailures(k, now);
}

export function clearLockouts(userId) {
  for (const key of failures.keys()) if (key.startsWith(`${userId}|`)) failures.delete(key);
}

export function isLockedOut(userId) {
  const now = Date.now();
  for (const [key, f] of failures) if (key.startsWith(`${userId}|`) && f.until > now) return true;
  return false;
}

export const STATUS_MESSAGE = {
  hold: 'Your access is on hold. Please contact your admin.',
  revoked: 'Your access has been removed. Please contact your admin.',
};

// Checks login ID + password and the account's lock and status.
// Returns the user row. Throws HttpError with a safe message otherwise.
export async function checkCredentials(db, loginId, password, ip) {
  if (recentIpFailures(ip, Date.now()).length >= IP_MAX_FAILS) fail(429, 'Too many failed attempts from this network. Wait a few minutes.');
  const user = db.prepare('SELECT * FROM users WHERE login_id = ?').get(String(loginId || '').trim());
  if (!user) {
    await dummyVerify(String(password || ''));
    noteIpFailure(ip, Date.now());
    // What was typed is not logged: people often type their password into the Login ID box.
    logActivity(db, { action: 'login.failed', detail: 'unknown login ID', ip });
    fail(401, 'Login ID or password is incorrect.');
  }
  const now = Date.now();
  const key = `${user.id}|${ip}`;
  const f = failures.get(key);
  if (f && f.until > now) {
    const mins = Math.ceil((f.until - now) / 60000);
    fail(423, `Too many wrong attempts. Try again in ${mins} minute${mins > 1 ? 's' : ''}.`);
  }
  const ok = await verifyPassword(String(password || ''), user.pw_hash);
  if (!ok) {
    noteIpFailure(ip, now);
    const n = (f && f.until <= now && f.until ? 0 : f?.n || 0) + 1;
    const locked = n >= MAX_FAILS;
    failures.set(key, { n: locked ? 0 : n, until: locked ? now + LOCK_MS : 0 });
    if (failures.size > 50000) for (const [k, v] of failures) if (!v.until || v.until < now) failures.delete(k);
    logActivity(db, { userId: user.id, action: locked ? 'login.locked' : 'login.failed', ip });
    fail(401, 'Login ID or password is incorrect.');
  }
  failures.delete(key);
  if (user.status !== 'active') {
    logActivity(db, { userId: user.id, action: 'login.refused', detail: `status ${user.status}`, ip });
    fail(403, STATUS_MESSAGE[user.status], `status_${user.status}`);
  }
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, user.id);
  return user;
}

export function createSession(db, user, { kind, app = null, deviceId = null }) {
  const token = newToken();
  const now = Date.now();
  db.prepare(`INSERT INTO sessions (token_hash, user_id, kind, app, device_id, created_at, last_seen_at, expires_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(hashToken(token), user.id, kind, app, deviceId, now, now, now + (kind === 'web' ? WEB_MAX_MS : DEVICE_MAX_MS));
  return token;
}

// Loads the session for a token and re-checks everything that can be revoked:
// expiry, idle time, user status and (for apps) app access.
// touch=false (automatic background refreshes) checks the session without extending its idle time.
export function loadSession(db, token, kind, { touch = true } = {}) {
  if (!token) return null;
  const h = hashToken(token);
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND kind = ?').get(h, kind);
  if (!s) return null;
  const now = Date.now();
  const idle = kind === 'web' && now - s.last_seen_at > WEB_IDLE_MS;
  if (s.expires_at < now || idle) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h);
    return null;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
  if (!user || user.status !== 'active') {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h);
    if (!user) return null;
    logActivity(db, { userId: user.id, action: 'access.refused', target: s.app, detail: `status ${user.status}` });
    throw new HttpError(403, STATUS_MESSAGE[user.status], `status_${user.status}`);
  }
  if (kind === 'device' && !hasApp(db, user, s.app)) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h);
    logActivity(db, { userId: user.id, action: 'access.refused', target: s.app, detail: 'app access removed' });
    throw new HttpError(403, 'You no longer have access to this app.', 'app_revoked');
  }
  if (touch) db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, h);
  return { session: s, user, tokenHash: h };
}

export function hasApp(db, user, app) {
  if (user.role === 'super_admin') return true;
  return !!db.prepare('SELECT 1 FROM app_access WHERE user_id = ? AND app = ?').get(user.id, app);
}

// Ends a person's sessions. With webOnly, app sessions are left in place on purpose: the next
// time that phone calls, loadSession refuses it with the reason ("on hold", "app removed"),
// logs the attempt and only then deletes it.
export function endUserSessions(db, userId, { webOnly = false } = {}) {
  if (webOnly) db.prepare("DELETE FROM sessions WHERE user_id = ? AND kind = 'web'").run(userId);
  else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export const isManager = u => u.role === 'super_admin' || u.role === 'head';

// Audits a person may see and add data to.
export function canUseAudit(db, user, auditId) {
  return !!auditAccess(db, user, auditId);
}

export const CLOSED_AUDIT = new Set(['published', 'archived']);

// The audit row if this person may use it (managers: any audit; others: assigned ones), else null.
export function auditAccess(db, user, auditId) {
  const audit = db.prepare('SELECT * FROM audits WHERE id = ?').get(String(auditId || ''));
  if (!audit) return null;
  if (isManager(user)) return audit;
  return db.prepare('SELECT 1 FROM assignments WHERE user_id = ? AND audit_id = ?').get(user.id, audit.id) ? audit : null;
}
