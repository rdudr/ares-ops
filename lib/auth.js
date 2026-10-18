import { HttpError, fail } from './http.js';
import { verifyPassword, dummyVerify, newToken, hashToken } from './security.js';
import { logActivity } from './db.js';

export const WEB_IDLE_MS = 30 * 60 * 1000;          // console logs out after 30 min idle
export const WEB_MAX_MS = 12 * 60 * 60 * 1000;      // and after 12 h at most
export const DEVICE_MAX_MS = 7 * 24 * 60 * 60 * 1000; // field apps sign in again weekly
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

export const STATUS_MESSAGE = {
  hold: 'Your access is on hold. Please contact your admin.',
  revoked: 'Your access has been removed. Please contact your admin.',
};

// Checks login ID + password and the account's lock and status.
// Returns the user row. Throws HttpError with a safe message otherwise.
export async function checkCredentials(db, loginId, password, ip) {
  const user = db.prepare('SELECT * FROM users WHERE login_id = ?').get(String(loginId || '').trim());
  if (!user) {
    await dummyVerify(String(password || ''));
    logActivity(db, { action: 'login.failed', target: String(loginId || '').slice(0, 40), detail: 'unknown login ID', ip });
    fail(401, 'Login ID or password is incorrect.');
  }
  const now = Date.now();
  if (user.locked_until && user.locked_until > now) {
    const mins = Math.ceil((user.locked_until - now) / 60000);
    fail(423, `Too many wrong attempts. Try again in ${mins} minute${mins > 1 ? 's' : ''}.`);
  }
  const ok = await verifyPassword(String(password || ''), user.pw_hash);
  if (!ok) {
    const fails = user.failed_logins + 1;
    const lock = fails >= MAX_FAILS ? now + LOCK_MS : null;
    db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(lock ? 0 : fails, lock, user.id);
    logActivity(db, { userId: user.id, action: lock ? 'login.locked' : 'login.failed', ip });
    fail(401, 'Login ID or password is incorrect.');
  }
  if (user.status !== 'active') {
    logActivity(db, { userId: user.id, action: 'login.refused', detail: `status ${user.status}`, ip });
    fail(403, STATUS_MESSAGE[user.status], `status_${user.status}`);
  }
  db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(now, user.id);
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
export function loadSession(db, token, kind) {
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
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, h);
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
  if (isManager(user)) return !!db.prepare('SELECT 1 FROM audits WHERE id = ?').get(auditId);
  return !!db.prepare('SELECT 1 FROM assignments WHERE user_id = ? AND audit_id = ?').get(user.id, auditId);
}
