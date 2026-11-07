import crypto from 'node:crypto';
import { fail, str, oneOf } from './http.js';
import { tx, logActivity } from './db.js';
import { APPS, APP_CODES, SECTORS, WORK_TYPES, STATES, AUDIT_STATUSES, TASK_STATUSES, DEFAULT_CARD_ROLE } from './apps.js';
import { hashPassword, verifyPassword, passwordProblem, tempPassword, randomId, rateLimiter } from './security.js';
import { checkCredentials, createSession, endUserSessions, isManager, clearLockouts, isLockedOut, CLOSED_AUDIT } from './auth.js';
import { scopeOf, seesApp, seesAudit, seesPerson, seesActivity, appFilter, ownerId, canManage, canChangeApp, canDirect, canGiveRole } from './scope.js';
import { dashboard } from './dashboard.js';
import { createAudit, updateAuditDetails, currentFy } from './audits.js';
import { issueLaunchCode } from './launch.js';
import { openStream, publish } from './events.js';
import { createToken, mcpEnabled } from './mcp.js';
import { plantHandle } from './mcp-guard.js';
import { aiOpen, aiUntil, AI_ACCESS_MS, AI_ACCESS_DAYS } from './ai-access.js';
import { auditStatus, resolveSyncIssue } from './audit-status.js';
import { pipeline, moveStage, TEAM_ROLES } from './stages.js';
import { reconcileTasks, listTasks, RECORD_KINDS } from './tasks.js';

const LOGIN_ID = /^[a-z0-9][a-z0-9._-]{2,31}$/i;
const setupLimit = rateLimiter(20, 10 * 60 * 1000);

const publicUser = u => ({
  id: u.id, login_id: u.login_id, name: u.name, phone: u.phone, role: u.role,
  employment: u.employment, status: u.status, must_change_pw: !!u.must_change_pw,
  last_login_at: u.last_login_at, created_at: u.created_at,
  position: u.position || null, qualification: u.qualification || null, experience: u.experience || null,
  email: u.email || null, photo: u.photo || null, in_report: u.in_report !== 0, report_order: u.report_order || 0,
});

// ---------- profile cards ----------
const EMAIL = /^[^\s@<>()]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const MAX_PHOTO = 300 * 1024;
const PROFILE_BODY_LIMIT = 600 * 1024; // a 300 KB photo is ~400 KB as base64, plus the other fields // bytes after decoding; the Console shrinks photos to 480 px first
const PHOTO_MAGIC = { jpeg: [0xff, 0xd8, 0xff], png: [0x89, 0x50, 0x4e, 0x47], webp: [0x52, 0x49, 0x46, 0x46] };

// The card fields present in a request body, checked. Missing fields are left out (unchanged).
function profileFields(b) {
  const out = {};
  const text = (key, label, max) => {
    if (b[key] === undefined) return;
    const v = b[key] === null ? '' : String(b[key]).trim();
    out[key] = v ? str(v, { field: label, max }) : null;
  };
  text('position', 'Position', 80);
  text('qualification', 'Qualification', 160);
  text('experience', 'Experience', 600);
  if (b.email !== undefined) {
    const v = b.email ? String(b.email).trim() : '';
    if (v && !EMAIL.test(v)) fail(400, 'Please enter a valid e-mail address.');
    out.email = v || null;
  }
  if (b.in_report !== undefined) out.in_report = b.in_report ? 1 : 0;
  if (b.report_order !== undefined) {
    const n = Number(b.report_order);
    if (!Number.isInteger(n) || n < 0 || n > 999) fail(400, 'Order must be a whole number from 0 to 999.');
    out.report_order = n;
  }
  return out;
}

// A photo is accepted only as a small JPEG, PNG or WebP whose bytes really are that image type.
function checkPhoto(dataUrl) {
  if (dataUrl === null || dataUrl === '') return null;
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl));
  if (!m) fail(400, 'The photo must be a JPEG, PNG or WebP image.');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > MAX_PHOTO) fail(413, 'The photo is too large (300 KB at most).');
  if (!PHOTO_MAGIC[m[1]].every((x, i) => bytes[i] === x)) fail(400, 'That file is not a valid image.');
  return `data:image/${m[1]};base64,${bytes.toString('base64')}`;
}

function saveProfile(db, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE users SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => fields[k]), id);
}

// What the report's "assessment team" section and the apps may show about a person.
const teamCard = u => ({
  id: u.id, name: u.name, position: u.position || null, qualification: u.qualification || null,
  experience: u.experience || null, email: u.email || null, phone: u.phone || null, photo: u.photo || null,
});

// An associated faculty member as the report and the apps see them.
const facultyCard = f => ({
  id: f.id, name: f.name, position: f.position || null, department: f.department || null, email: f.email || null, photo: f.photo || null, faculty: true,
});
// The faculty fields present in a request body, checked (name is needed when adding).
function facultyFields(b, adding) {
  const out = {};
  if (adding || b.name !== undefined) out.name = str(b.name, { field: 'Name', max: 80 });
  if (b.department !== undefined) out.department = b.department ? str(String(b.department).trim(), { field: 'Department', max: 160 }) : null;
  const p = profileFields(b);
  for (const k of ['position', 'email', 'in_report', 'report_order']) if (p[k] !== undefined) out[k] = p[k];
  if (b.photo !== undefined) out.photo = checkPhoto(b.photo);
  return out;
}

// Tasks an Admin may see: on their audits and apps, or given to or made by them.
function visibleTasks(db, user, tasks) {
  const scope = scopeOf(db, user);
  if (scope.all) return tasks;
  return tasks.filter(t => t.assignee === user.id || t.created_by === user.id
    || (seesAudit(scope, t.audit_id) && (t.app ? seesApp(scope, t.app) : true)));
}

function getUser(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || fail(404, 'Person not found.');
}

export function registerConsoleRoutes(router, { setupCode, filesDir }) {
  // ---------- first-run setup ----------
  router.add('GET', '/api/setup', ({ db }) => ({
    needed: !db.prepare('SELECT 1 FROM users LIMIT 1').get(),
  }), { public: true });

  router.add('POST', '/api/setup', async ({ db, body, ip }) => {
    const b = await body();
    if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) fail(403, 'Setup is already done.');
    if (!setupLimit(`setup:${ip}`)) fail(429, 'Too many attempts. Wait a few minutes.');
    const code = String(b.code || '');
    if (code.length !== setupCode.length || !crypto.timingSafeEqual(Buffer.from(code), Buffer.from(setupCode))) {
      fail(403, 'Setup code is not correct. It is printed in the server window.');
    }
    const name = str(b.name, { field: 'Name', max: 80 });
    const loginId = str(b.login_id, { field: 'Login ID', min: 3, max: 32, pattern: LOGIN_ID }).toLowerCase();
    const problem = passwordProblem(b.password);
    if (problem) fail(400, problem);
    const id = randomId('U');
    db.prepare(`INSERT INTO users (id, login_id, name, role, employment, status, pw_hash, must_change_pw, created_at)
                VALUES (?, ?, ?, 'super_admin', 'staff', 'active', ?, 0, ?)`)
      .run(id, loginId, name, await hashPassword(b.password), Date.now());
    logActivity(db, { userId: id, action: 'setup.super_admin_created', target: id, ip });
    return { ok: true };
  }, { public: true });

  // ---------- login / logout / own password ----------
  router.add('POST', '/api/login', async ({ db, body, ip, setSessionCookie }) => {
    const b = await body();
    const user = await checkCredentials(db, b.login_id, b.password, ip);
    if (!isManager(user)) {
      logActivity(db, { userId: user.id, action: 'login.refused', detail: 'not a console role', ip });
      fail(403, 'This console is for admins and team heads. Please use your field app.');
    }
    setSessionCookie(createSession(db, user, { kind: 'web' }));
    logActivity(db, { userId: user.id, action: 'login.console', ip });
    return { user: publicUser(user) };
  }, { public: true });

  router.add('POST', '/api/logout', ({ db, auth, clearSessionCookie }) => {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(auth.tokenHash);
    clearSessionCookie();
    return { ok: true };
  }, { allowPasswordChange: true });

  // Live updates for the Console pages (an open stream; it does not keep the session awake).
  router.add('GET', '/api/events', ({ db, req, res, auth, sessionToken }) => openStream(db, req, res, auth, { token: sessionToken }), { background: true });

  router.add('GET', '/api/me', ({ db, auth }) => ({
    user: { ...publicUser(auth.user), owner: auth.user.id === ownerId(db) },
    apps: APPS,
    // The apps this person works with in the Console (all of them for a Super Admin).
    my_apps: scopeOf(db, auth.user).apps,
    sectors: SECTORS,
    work_types: WORK_TYPES,
    states: STATES,
    fy: currentFy(),
  }), { allowPasswordChange: true });

  // Field apps: who may use each app and what has reached the server from it. With ?app=<code>,
  // also the audits that app has data in, broken down by record kind. Deleted records not counted.
  router.add('GET', '/api/apps', ({ db, query, auth }) => {
    const scope = scopeOf(db, auth.user);
    const LIVE = "COALESCE(json_extract(r.payload, '$._deleted'), 0) = 0";
    const totals = db.prepare(`SELECT r.app, COUNT(*) AS records, COUNT(DISTINCT r.audit_id) AS audits,
        COUNT(DISTINCT r.user_id) AS recorders, MAX(r.synced_at) AS last_sync FROM records r WHERE ${LIVE} GROUP BY r.app`).all();
    const users = db.prepare("SELECT id, name, role, status, employment FROM users ORDER BY name").all();
    const access = db.prepare('SELECT user_id, app FROM app_access').all();
    const apps = APPS.filter(a => seesApp(scope, a.code)).map(a => {
      const t = totals.find(x => x.app === a.code) || {};
      const people = users.filter(u => seesPerson(scope, u.id))
        .filter(u => u.role === 'super_admin' || access.some(x => x.user_id === u.id && x.app === a.code))
        .map(u => ({ id: u.id, name: u.name, status: u.status, employment: u.employment, role: u.role }));
      return { ...a, records: t.records || 0, audits: t.audits || 0, recorders: t.recorders || 0, last_sync: t.last_sync || null, people };
    });
    const code = query.get('app');
    if (!code) return { apps };
    const app = apps.find(a => a.code === code) || fail(404, 'App not found.');
    const byAudit = db.prepare(`SELECT r.audit_id, au.title, au.status, au.fy, au.finalized_at, s.industry_tag, s.name AS site_name,
        c.name AS client_name, COUNT(*) AS records, MIN(r.taken_at) AS first_taken, MAX(r.synced_at) AS last_sync FROM records r
        JOIN audits au ON au.id = r.audit_id JOIN sites s ON s.id = au.site_id JOIN clients c ON c.id = s.client_id
        WHERE r.app = ? AND ${LIVE} GROUP BY r.audit_id ORDER BY last_sync DESC`).all(code).filter(a => seesAudit(scope, a.audit_id));
    const kinds = db.prepare(`SELECT r.audit_id, r.kind, COUNT(*) AS n FROM records r WHERE r.app = ? AND ${LIVE} GROUP BY r.audit_id, r.kind`).all(code);
    // Who created what, per company: records first saved by each person, and when they last worked.
    const creators = db.prepare(`SELECT r.audit_id, u.name, COUNT(*) AS n, MIN(r.taken_at) AS first, MAX(r.saved_at) AS last
        FROM records r JOIN users u ON u.id = r.user_id WHERE r.app = ? AND ${LIVE} AND r.kind != 'company_profile'
        GROUP BY r.audit_id, r.user_id ORDER BY n DESC`).all(code);
    // The company profile as saved in this app (who saved it and when), else as saved in any app.
    const profiles = db.prepare(`SELECT r.audit_id, r.app, r.payload, r.saved_at, COALESCE(ub.name, u.name) AS saved_by FROM records r
        JOIN users u ON u.id = r.user_id LEFT JOIN users ub ON ub.id = r.updated_by
        WHERE r.kind = 'company_profile' AND ${LIVE} ORDER BY (r.app = ?) DESC, r.saved_at DESC`).all(code);
    return {
      app,
      audits: byAudit.map(a => {
        const p = profiles.find(x => x.audit_id === a.audit_id);
        return {
          ...a,
          kinds: kinds.filter(k => k.audit_id === a.audit_id).map(k => ({ kind: k.kind, n: k.n })),
          creators: creators.filter(c => c.audit_id === a.audit_id).map(c => ({ name: c.name, records: c.n, first: c.first, last: c.last })),
          profile: p ? { ...JSON.parse(p.payload), saved_by: p.saved_by, saved_at: p.saved_at, from_app: p.app } : null,
        };
      }),
    };
  });

  router.add('POST', '/api/change-password', async ({ db, body, auth, ip }) => {
    const b = await body();
    if (!(await verifyPassword(String(b.current || ''), auth.user.pw_hash))) fail(400, 'Current password is not correct.');
    const problem = passwordProblem(b.next);
    if (problem) fail(400, problem);
    if (b.next === b.current) fail(400, 'Choose a password different from the current one.');
    db.prepare('UPDATE users SET pw_hash = ?, must_change_pw = 0 WHERE id = ?').run(await hashPassword(b.next), auth.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(auth.user.id, auth.tokenHash);
    logActivity(db, { userId: auth.user.id, action: 'password.changed', ip });
    return { ok: true };
  }, { allowPasswordChange: true });

  // ---------- dashboard ----------
  router.add('GET', '/api/dashboard', ({ db, query, auth }) => {
    const days = Math.min(365, Math.max(1, parseInt(query.get('days') || '30', 10) || 30));
    return dashboard(db, days, scopeOf(db, auth.user));
  });

  // ---------- team ----------
  router.add('GET', '/api/users', ({ db, auth }) => {
    const scope = scopeOf(db, auth.user);
    const owner = ownerId(db);
    const users = db.prepare('SELECT * FROM users ORDER BY status, name').all().filter(u => seesPerson(scope, u.id));
    const access = db.prepare('SELECT user_id, app FROM app_access').all();
    const assigned = db.prepare(`SELECT a.user_id, a.audit_id, s.industry_tag FROM assignments a
                                 JOIN audits au ON au.id = a.audit_id JOIN sites s ON s.id = au.site_id`).all();
    return {
      users: users.map(u => ({
        ...publicUser(u),
        owner: u.id === owner,
        locked: isLockedOut(u.id),
        // An Admin sees only their own apps and audits on each person.
        apps: (u.role === 'super_admin' ? APPS.map(a => a.code) : access.filter(a => a.user_id === u.id).map(a => a.app)).filter(a => seesApp(scope, a)),
        audits: assigned.filter(a => a.user_id === u.id && seesAudit(scope, a.audit_id)).map(a => ({ id: a.audit_id, tag: a.industry_tag })),
        can_manage: canManage(db, auth.user, u),
        // Apps the viewer may give or take from this person.
        can_change_apps: APPS.filter(a => canChangeApp(db, auth.user, u, a.code)).map(a => a.code),
      })),
    };
  });

  router.add('POST', '/api/users', async ({ db, body, auth, ip }) => {
    const b = await body();
    const actor = auth.user;
    const name = str(b.name, { field: 'Name', max: 80 });
    const loginId = str(b.login_id, { field: 'Login ID', min: 3, max: 32, pattern: LOGIN_ID }).toLowerCase();
    const phone = b.phone ? str(b.phone, { field: 'Phone', min: 6, max: 20, pattern: /^[0-9+ -]+$/ }) : null;
    const employment = oneOf(b.employment || 'staff', ['staff', 'freelancer'], 'Type');
    const role = oneOf(b.role || (employment === 'freelancer' ? 'engineer' : DEFAULT_CARD_ROLE), ['super_admin', 'head', 'engineer'], 'Role');
    const profile = profileFields(b);
    const photo = b.photo !== undefined ? checkPhoto(b.photo) : undefined;
    if (!canGiveRole(db, actor, role)) {
      fail(403, role === 'super_admin' ? 'Only the main Super Admin can add Super Admins.' : role === 'head' ? 'Only a Super Admin can add Admins.' : 'Not allowed.');
    }
    if (employment === 'freelancer' && role !== 'engineer') fail(400, 'Freelancers can only have the Engineer role.');
    const scope = scopeOf(db, actor);
    const apps = Array.isArray(b.apps) ? b.apps.filter(a => APP_CODES.has(a)) : [];
    if (apps.some(a => !seesApp(scope, a))) fail(403, 'You can only give the apps you have yourself.');
    const audits = Array.isArray(b.audits) ? b.audits.map(String) : [];
    if (audits.some(a => !seesAudit(scope, a))) fail(403, 'You can only add people to your own audits.');
    if (db.prepare('SELECT 1 FROM users WHERE login_id = ?').get(loginId)) fail(409, 'That Login ID is already used.');

    const temp = tempPassword();
    const hash = await hashPassword(temp);
    const id = randomId('U');
    const now = Date.now();
    tx(db, () => {
      db.prepare(`INSERT INTO users (id, login_id, name, phone, role, employment, status, pw_hash, must_change_pw, created_at, created_by)
                  VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 1, ?, ?)`)
        .run(id, loginId, name, phone, role, employment, hash, now, actor.id);
      saveProfile(db, id, photo !== undefined ? { ...profile, photo } : profile);
      for (const app of apps) db.prepare('INSERT INTO app_access (user_id, app, granted_by, granted_at) VALUES (?, ?, ?, ?)').run(id, app, actor.id, now);
      for (const a of audits) {
        if (!db.prepare('SELECT 1 FROM audits WHERE id = ?').get(a)) fail(400, `Audit ${a} not found.`);
        db.prepare('INSERT INTO assignments (user_id, audit_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?)').run(id, a, actor.id, now);
      }
      logActivity(db, { userId: actor.id, action: 'user.created', target: id, detail: `${loginId} (${role}, ${employment}); apps: ${apps.join(', ') || 'none'}`, ip });
    });
    return { user: publicUser(getUser(db, id)), temp_password: temp };
  }, { bodyLimit: PROFILE_BODY_LIMIT });

  router.add('PATCH', '/api/users/:id', async ({ db, body, auth, params, ip }) => {
    const b = await body();
    const target = getUser(db, params.id);
    if (!canManage(db, auth.user, target)) fail(403, 'You cannot change this person.');
    const name = b.name !== undefined ? str(b.name, { field: 'Name', max: 80 }) : target.name;
    const phone = b.phone !== undefined ? (b.phone ? str(b.phone, { field: 'Phone', min: 6, max: 20, pattern: /^[0-9+ -]+$/ }) : null) : target.phone;
    const employment = b.employment !== undefined ? oneOf(b.employment, ['staff', 'freelancer'], 'Type') : target.employment;
    let role = target.role;
    if (b.role !== undefined && b.role !== target.role) {
      if (auth.user.role !== 'super_admin') fail(403, 'Only a Super Admin can change roles.');
      role = oneOf(b.role, ['super_admin', 'head', 'engineer'], 'Role');
      if (!canGiveRole(db, auth.user, role)) fail(403, 'Only the main Super Admin can make Super Admins.');
    }
    if (employment === 'freelancer' && role !== 'engineer') fail(400, 'Freelancers can only have the Engineer role.');
    const profile = profileFields(b);
    if (b.photo !== undefined) profile.photo = checkPhoto(b.photo);
    db.prepare('UPDATE users SET name = ?, phone = ?, employment = ?, role = ? WHERE id = ?').run(name, phone, employment, role, target.id);
    saveProfile(db, target.id, profile);
    if (role !== target.role) endUserSessions(db, target.id);
    logActivity(db, { userId: auth.user.id, action: 'user.updated', target: target.id, detail: role !== target.role ? `role ${target.role} → ${role}` : null, ip });
    return { user: publicUser(getUser(db, target.id)) };
  }, { bodyLimit: PROFILE_BODY_LIMIT });

  router.add('POST', '/api/users/:id/status', async ({ db, body, auth, params, ip }) => {
    const b = await body();
    const target = getUser(db, params.id);
    if (!canManage(db, auth.user, target)) fail(403, 'You cannot change this person.');
    const status = oneOf(b.status, ['active', 'hold', 'revoked'], 'Status');
    tx(db, () => {
      db.prepare('UPDATE users SET status = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(status, target.id);
      if (status !== 'active') endUserSessions(db, target.id, { webOnly: true });
      logActivity(db, { userId: auth.user.id, action: `user.${status === 'active' ? 'activated' : status === 'hold' ? 'put_on_hold' : 'revoked'}`, target: target.id, ip });
    });
    return { user: publicUser(getUser(db, target.id)) };
  });

  router.add('POST', '/api/users/:id/apps', async ({ db, body, auth, params, ip }) => {
    const b = await body();
    const target = getUser(db, params.id);
    if (!APP_CODES.has(b.app)) fail(400, 'Unknown app.');
    if (!canChangeApp(db, auth.user, target, b.app)) {
      fail(403, target.id === auth.user.id ? 'You cannot change your own access.' : 'You can only give or take the apps you have yourself, for your own team.');
    }
    if (b.grant) {
      db.prepare('INSERT OR IGNORE INTO app_access (user_id, app, granted_by, granted_at) VALUES (?, ?, ?, ?)').run(target.id, b.app, auth.user.id, Date.now());
    } else {
      // Open app sessions are refused on their next call (see endUserSessions).
      db.prepare('DELETE FROM app_access WHERE user_id = ? AND app = ?').run(target.id, b.app);
    }
    logActivity(db, { userId: auth.user.id, action: b.grant ? 'app.granted' : 'app.removed', target: target.id, detail: b.app, ip });
    return { ok: true };
  });

  // Clears wrong-password lockouts for this person on every address.
  router.add('POST', '/api/users/:id/unlock', ({ db, auth, params, ip }) => {
    const target = getUser(db, params.id);
    if (!canManage(db, auth.user, target)) fail(403, 'You cannot change this person.');
    clearLockouts(target.id);
    logActivity(db, { userId: auth.user.id, action: 'user.unlocked', target: target.id, ip });
    return { ok: true };
  });

  router.add('POST', '/api/users/:id/reset-password', async ({ db, auth, params, ip }) => {
    const target = getUser(db, params.id);
    if (!canManage(db, auth.user, target)) fail(403, 'You cannot change this person.');
    const temp = tempPassword();
    db.prepare('UPDATE users SET pw_hash = ?, must_change_pw = 1, failed_logins = 0, locked_until = NULL WHERE id = ?')
      .run(await hashPassword(temp), target.id);
    endUserSessions(db, target.id);
    clearLockouts(target.id);
    logActivity(db, { userId: auth.user.id, action: 'password.reset', target: target.id, ip });
    return { temp_password: temp };
  });

  // Anyone signed in to the Console may keep their own profile card up to date.
  router.add('PATCH', '/api/me/profile', async ({ db, body, auth, ip }) => {
    const b = await body();
    const profile = profileFields(b);
    if (b.name !== undefined) profile.name = str(b.name, { field: 'Name', max: 80 });
    if (b.phone !== undefined) profile.phone = b.phone ? str(b.phone, { field: 'Phone', min: 6, max: 20, pattern: /^[0-9+ -]+$/ }) : null;
    if (b.photo !== undefined) profile.photo = checkPhoto(b.photo);
    delete profile.report_order; // the report order is set by the Super Admin on the Team page
    const keys = Object.keys(profile);
    if (keys.length) db.prepare(`UPDATE users SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => profile[k]), auth.user.id);
    logActivity(db, { userId: auth.user.id, action: 'profile.updated', target: auth.user.id, detail: keys.join(', ') || null, ip });
    return { user: publicUser(getUser(db, auth.user.id)) };
  }, { bodyLimit: PROFILE_BODY_LIMIT });

  // Open an app already signed in: a one-time code for that app (see lib/launch.js).
  router.add('POST', '/api/launch', async ({ db, body, auth, ip }) => {
    const b = await body();
    const app = String(b.app || '');
    if (!APP_CODES.has(app)) fail(400, 'Unknown app.');
    const audit = b.audit ? str(b.audit, { field: 'Audit', max: 40 }) : null;
    if (audit && !db.prepare('SELECT 1 FROM audits WHERE id = ?').get(audit)) fail(404, 'Audit not found.');
    logActivity(db, { userId: auth.user.id, action: 'launch.issued', target: app, detail: audit || 'quick check', ip });
    return issueLaunchCode(auth.user.id, app);
  });

  // The team as the report shows it: active people marked "show in reports", in report order, and
  // the associated faculty marked the same way. Readable by the Console and by the apps and Report Studio.
  router.add('GET', '/api/team-cards', ({ db }) => ({
    team: db.prepare(`SELECT * FROM users WHERE status = 'active' AND in_report = 1 ORDER BY report_order, name`).all().map(teamCard),
    faculty: db.prepare('SELECT * FROM faculty WHERE in_report = 1 ORDER BY report_order, name').all().map(facultyCard),
  }), { auth: 'either' });

  // A demo company with test data in every app (lib/demo.js), for testing Report Studio and training.

  // ---------- the audit process (lib/stages.js) ----------
  router.add('GET', '/api/pipeline', ({ db, auth }) => {
    const p = pipeline(db), scope = scopeOf(db, auth.user);
    return { ...p, audits: p.audits.filter(a => seesAudit(scope, a.id)) };
  });
  router.add('GET', '/api/audits/:id/pipeline', ({ db, params, auth }) => {
    const p = pipeline(db, { auditId: params.id });
    if (!p.audits.length || !seesAudit(scopeOf(db, auth.user), params.id)) fail(404, 'Audit not found.');
    return { ...p, audit: p.audits[0] };
  });
  router.add('POST', '/api/audits/:id/stage', async ({ db, body, auth, params, ip }) => {
    const b = await body();
    const stage = tx(db, () => { const s = moveStage(db, params.id, String(b.to || ''), auth.user, { note: b.note ? String(b.note) : null, ip, reportFileId: b.report_file_id || null }); reconcileTasks(db, params.id); return s; });
    publish(db, { audit_id: params.id, what: 'audit' });
    return { ok: true, stage };
  });

  // ---------- the team and sync picture of one audit (lib/audit-status.js) ----------
  router.add('GET', '/api/audits/:id/status', ({ db, params }) => {
    db.prepare('SELECT 1 FROM audits WHERE id = ?').get(params.id) || fail(404, 'Audit not found.');
    return auditStatus(db, params.id);
  });
  router.add('POST', '/api/sync-issues/:id/resolve', ({ db, params, auth, ip }) => {
    const id = Number(params.id);
    if (!Number.isInteger(id)) fail(400, 'Unknown problem.');
    return resolveSyncIssue(db, id, auth.user, ip) ? { ok: true } : fail(404, 'Problem not found.');
  });

  // ---------- AI report connector: demo flag, personal tokens, the call log ----------
  router.add('GET', '/api/audits/:id/mcp', ({ db, params, auth }) => {
    const a = db.prepare('SELECT id, synthetic, status, ai_until FROM audits WHERE id = ?').get(params.id) || fail(404, 'Audit not found.');
    const mine = auth.user.role === 'super_admin' ? '' : 'AND t.user_id = ?';
    const args = auth.user.role === 'super_admin' ? [a.id] : [a.id, auth.user.id];
    return {
      enabled: mcpEnabled(), real_allowed: process.env.MCP_REAL_DATA === 'on', demo: !!a.synthetic, handle: plantHandle(a.id),
      ai_open: aiOpen(a), ai_until: aiUntil(a), ai_days: AI_ACCESS_DAYS, closed: CLOSED_AUDIT.has(a.status),
      tokens: db.prepare(`SELECT t.id, t.label, t.created_at, t.expires_at, t.last_used_at, t.revoked_at, u.name AS user_name
        FROM mcp_tokens t JOIN users u ON u.id = t.user_id WHERE t.audit_id = ? ${mine} ORDER BY t.created_at DESC LIMIT 50`).all(...args),
      log: db.prepare(`SELECT l.tool, l.bytes, l.blocked, l.ok, l.at, u.name AS user_name FROM mcp_log l JOIN users u ON u.id = l.user_id
        WHERE l.audit_id = ? ORDER BY l.at DESC LIMIT 40`).all(a.id),
    };
  });
  router.add('POST', '/api/audits/:id/mcp/tokens', async ({ db, params, body, auth, ip }) => {
    const b = await body();
    const a = db.prepare('SELECT id, synthetic, status, ai_until FROM audits WHERE id = ?').get(params.id) || fail(404, 'Audit not found.');
    if (!mcpEnabled()) fail(409, 'The AI report connector is switched off on this server.');
    if (!aiOpen(a) && process.env.MCP_REAL_DATA !== 'on') fail(409, 'AI access to this audit is off. The Super Admin turns it on (it lasts a few days).');
    const label = b.label ? str(b.label, { field: 'Name', max: 60 }) : null;
    const t = createToken(db, { user: auth.user, auditId: a.id, label });
    logActivity(db, { userId: auth.user.id, action: 'mcp.token_created', target: a.id, detail: t.id, ip });
    return { ...t, url: `${process.env.PUBLIC_URL || 'https://ops.arenergyservices.in'}/mcp` };
  });
  router.add('POST', '/api/mcp/tokens/:id/revoke', ({ db, params, auth, ip }) => {
    const t = db.prepare('SELECT * FROM mcp_tokens WHERE id = ?').get(params.id) || fail(404, 'Token not found.');
    if (t.user_id !== auth.user.id && auth.user.role !== 'super_admin') fail(403, 'Only its owner or the Super Admin can revoke this token.');
    db.prepare('UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), t.id);
    logActivity(db, { userId: auth.user.id, action: 'mcp.token_revoked', target: t.audit_id, detail: t.id, ip });
    return { ok: true };
  });
  router.add('POST', '/api/audits/:id/demo', async ({ db, params, body, auth, ip }) => {
    if (auth.user.role !== 'super_admin') fail(403, 'Only the Super Admin marks an audit as demo data.');
    const b = await body();
    const a = db.prepare('SELECT id FROM audits WHERE id = ?').get(params.id) || fail(404, 'Audit not found.');
    db.prepare('UPDATE audits SET synthetic = ? WHERE id = ?').run(b.demo ? 1 : 0, a.id);
    // Turning demo off ends every connector token of the audit at once.
    if (!b.demo) db.prepare('UPDATE mcp_tokens SET revoked_at = ? WHERE audit_id = ? AND revoked_at IS NULL').run(Date.now(), a.id);
    logActivity(db, { userId: auth.user.id, action: b.demo ? 'audit.demo_on' : 'audit.demo_off', target: a.id, ip });
    return { ok: true };
  });

  // A real company's audit: AI access for AI_ACCESS_DAYS from now (again: from now), or off at once.
  router.add('POST', '/api/audits/:id/ai-access', async ({ db, params, body, auth, ip }) => {
    if (auth.user.role !== 'super_admin') fail(403, 'Only the Super Admin turns AI access on or off.');
    const b = await body();
    const a = db.prepare('SELECT id, synthetic, status, ai_until FROM audits WHERE id = ?').get(params.id) || fail(404, 'Audit not found.');
    if (b.on) {
      if (CLOSED_AUDIT.has(a.status)) fail(409, 'This audit is finished (published or archived); AI access cannot be turned on.');
      const until = Date.now() + AI_ACCESS_MS;
      db.prepare('UPDATE audits SET ai_until = ? WHERE id = ?').run(until, a.id);
      logActivity(db, { userId: auth.user.id, action: 'audit.ai_on', target: a.id, detail: `until ${new Date(until).toISOString()}`, ip });
      return { ok: true, ai_until: until };
    }
    db.prepare('UPDATE audits SET ai_until = NULL WHERE id = ?').run(a.id);
    if (!a.synthetic) db.prepare('UPDATE mcp_tokens SET revoked_at = ? WHERE audit_id = ? AND revoked_at IS NULL').run(Date.now(), a.id);
    logActivity(db, { userId: auth.user.id, action: 'audit.ai_off', target: a.id, ip });
    return { ok: true, ai_until: null };
  });

  // ---------- associated faculty (no login; the Super Admin keeps the list) ----------
  router.add('GET', '/api/faculty', ({ db }) => ({
    faculty: db.prepare('SELECT * FROM faculty ORDER BY report_order, name').all().map(f => ({ ...facultyCard(f), in_report: f.in_report !== 0, report_order: f.report_order })),
  }));
  router.add('POST', '/api/faculty', async ({ db, body, auth, ip }) => {
    if (auth.user.role !== 'super_admin') fail(403, 'Only the Super Admin can change the faculty list.');
    const f = facultyFields(await body(), true);
    const id = randomId('F');
    db.prepare(`INSERT INTO faculty (id, name, position, department, email, photo, in_report, report_order, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, f.name, f.position ?? null, f.department ?? null, f.email ?? null, f.photo ?? null,
      f.in_report ?? 1, f.report_order ?? 0, Date.now(), auth.user.id);
    logActivity(db, { userId: auth.user.id, action: 'faculty.added', target: id, detail: f.name, ip });
    return { ok: true, id };
  }, { bodyLimit: PROFILE_BODY_LIMIT });
  router.add('PATCH', '/api/faculty/:id', async ({ db, body, auth, params, ip }) => {
    if (auth.user.role !== 'super_admin') fail(403, 'Only the Super Admin can change the faculty list.');
    if (!db.prepare('SELECT 1 FROM faculty WHERE id = ?').get(params.id)) fail(404, 'Faculty member not found.');
    const f = facultyFields(await body(), false);
    const keys = Object.keys(f);
    if (keys.length) db.prepare(`UPDATE faculty SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => f[k]), params.id);
    logActivity(db, { userId: auth.user.id, action: 'faculty.updated', target: params.id, detail: keys.join(', ') || null, ip });
    return { ok: true };
  }, { bodyLimit: PROFILE_BODY_LIMIT });
  router.add('DELETE', '/api/faculty/:id', ({ db, auth, params, ip }) => {
    if (auth.user.role !== 'super_admin') fail(403, 'Only the Super Admin can change the faculty list.');
    const row = db.prepare('SELECT name FROM faculty WHERE id = ?').get(params.id);
    if (!row) fail(404, 'Faculty member not found.');
    db.prepare('DELETE FROM faculty WHERE id = ?').run(params.id);
    logActivity(db, { userId: auth.user.id, action: 'faculty.removed', target: params.id, detail: row.name, ip });
    return { ok: true };
  });

  // ---------- clients, sites, audits ----------
  router.add('GET', '/api/clients', ({ db, auth }) => {
    const scope = scopeOf(db, auth.user);
    // An Admin sees the companies of their own audits.
    const mine = scope.all ? null : new Set(db.prepare('SELECT id, site_id FROM audits').all().filter(a => seesAudit(scope, a.id)).map(a => a.site_id));
    const sites = db.prepare('SELECT * FROM sites ORDER BY name').all().filter(s => !mine || mine.has(s.id));
    const clients = db.prepare('SELECT * FROM clients ORDER BY name').all().filter(c => !mine || sites.some(s => s.client_id === c.id));
    return { clients: clients.map(c => ({ ...c, sites: sites.filter(s => s.client_id === c.id) })) };
  });

  router.add('GET', '/api/audits', ({ db, auth }) => {
    const scope = scopeOf(db, auth.user);
    const audits = db.prepare(`
      SELECT au.*, s.name AS site_name, s.cluster, s.industry_tag, s.district, s.state, s.pincode, s.contract_demand_kva,
        c.name AS client_name, c.sector, c.msme_no,
        (SELECT f.id FROM files f WHERE f.audit_id = au.id AND f.kind = 'logo' AND f.status = 'ready' ORDER BY f.created_at DESC LIMIT 1) AS logo_file_id,
        (SELECT name FROM users WHERE id = au.finalized_by) AS finalized_by_name,
        (SELECT COUNT(*) FROM records r WHERE r.audit_id = au.id AND ${appFilter(scope, 'r.app')} AND COALESCE(json_extract(r.payload, '$._deleted'), 0) = 0) AS records,
        (SELECT COUNT(*) FROM tasks t WHERE t.audit_id = au.id AND t.status != 'done') AS open_tasks,
        (SELECT MAX(r.synced_at) FROM records r WHERE r.audit_id = au.id) AS last_sync
      FROM audits au JOIN sites s ON s.id = au.site_id JOIN clients c ON c.id = s.client_id
      ORDER BY au.created_at DESC`).all().filter(a => seesAudit(scope, a.id));
    const team = db.prepare(`SELECT a.audit_id, a.role, u.id, u.name, u.employment, u.role AS user_role FROM assignments a JOIN users u ON u.id = a.user_id
      ORDER BY CASE a.role WHEN 'lead' THEN 0 WHEN 'field' THEN 1 ELSE 2 END, u.name`).all()
      .filter(t => seesPerson(scope, t.id));
    return { audits: audits.map(a => ({ ...a, team: team.filter(t => t.audit_id === a.id) })) };
  });

  router.add('POST', '/api/audits', async ({ db, body, auth, ip }) => {
    const b = await body();
    return { id: tx(db, () => createAudit(db, b, { actorId: auth.user.id, ip })) };
  });

  // Correct the company, plant and audit details (audit page > Edit details).
  router.add('POST', '/api/audits/:id/details', async ({ db, body, auth, params, ip }) => {
    const b = await body();
    tx(db, () => updateAuditDetails(db, params.id, b, { actorId: auth.user.id, ip }));
    return { ok: true };
  });

  router.add('POST', '/api/audits/:id/status', async ({ db, body, auth, params, ip }) => {
    const b = await body();
    const status = oneOf(b.status, AUDIT_STATUSES, 'Status');
    if (!seesAudit(scopeOf(db, auth.user), params.id)) fail(404, 'Audit not found.');
    const r = db.prepare('UPDATE audits SET status = ? WHERE id = ?').run(status, params.id);
    if (!r.changes) fail(404, 'Audit not found.');
    logActivity(db, { userId: auth.user.id, action: 'audit.status', target: params.id, detail: status, ip });
    return { ok: true };
  });

  router.add('POST', '/api/audits/:id/assign', async ({ db, body, auth, params, ip }) => {
    const b = await body();
    db.prepare('SELECT 1 FROM audits WHERE id = ?').get(params.id) || fail(404, 'Audit not found.');
    if (!seesAudit(scopeOf(db, auth.user), params.id)) fail(404, 'Audit not found.');
    const target = getUser(db, String(b.user_id || ''));
    if (!canDirect(db, auth.user, target)) fail(403, 'You can only put Engineers of your own team on an audit.');
    // The audit team: who works on this company and as what. Engineers see only the audits they
    // are on; the audit lead, an Admin or a Super Admin moves it through its stages (only an Admin or Super Admin approves).
    if (target.status !== 'active') fail(400, `${target.name} cannot sign in at the moment (on hold or removed).`);
    const role = b.role == null ? null : oneOf(b.role, Object.keys(TEAM_ROLES), 'Role on this audit');
    tx(db, () => {
      if (b.assign) {
        if (role === 'lead') db.prepare("UPDATE assignments SET role = 'field' WHERE audit_id = ? AND role = 'lead' AND user_id != ?").run(params.id, target.id);
        db.prepare(`INSERT INTO assignments (user_id, audit_id, assigned_by, assigned_at, role) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(user_id, audit_id) DO UPDATE SET role = COALESCE(?, role)`).run(target.id, params.id, auth.user.id, Date.now(), role || 'field', role);
      } else {
        db.prepare('DELETE FROM assignments WHERE user_id = ? AND audit_id = ?').run(target.id, params.id);
      }
      logActivity(db, { userId: auth.user.id, action: b.assign ? 'audit.assigned' : 'audit.unassigned', target: params.id,
        detail: `${target.name}${b.assign && role ? ` as ${TEAM_ROLES[role]}` : ''}`, ip });
    });
    return { ok: true };
  });

  // ---------- tasks ----------
  // Tasks: process tasks are added and finished ones closed first (lib/tasks.js).
  router.add('GET', '/api/tasks', ({ db, auth, query }) => {
    const auditId = query.get('audit') || null;
    tx(db, () => reconcileTasks(db, auditId));
    const out = listTasks(db, { auditId });
    out.tasks = visibleTasks(db, auth.user, out.tasks);
    return out;
  });

  router.add('POST', '/api/tasks', async ({ db, body, auth, ip }) => {
    const b = await body();
    const auditId = String(b.audit_id || '');
    db.prepare('SELECT 1 FROM audits WHERE id = ?').get(auditId) || fail(400, 'Choose an audit.');
    const scope = scopeOf(db, auth.user);
    if (!seesAudit(scope, auditId)) fail(400, 'Choose an audit.');
    const title = str(b.title, { field: 'Task', max: 160 });
    const app = b.app ? (APP_CODES.has(b.app) ? b.app : fail(400, 'Unknown app.')) : null;
    if (app && !seesApp(scope, app)) fail(403, 'You can only add tasks for your own apps.');
    // A data-entry task: a number of records of one app (and kind) to collect.
    const target = b.target == null || b.target === '' ? null : Number(b.target);
    if (target !== null && !(Number.isInteger(target) && target > 0 && target <= 10000)) fail(400, 'The target is a whole number of records.');
    if (target !== null && !app) fail(400, 'Choose the app the records are made in.');
    const kind = b.record_kind ? String(b.record_kind) : null;
    if (kind && !(app && RECORD_KINDS[app] && RECORD_KINDS[app][kind])) fail(400, 'That kind of record is not made in this app.');
    const stage = db.prepare('SELECT stage FROM audits WHERE id = ?').get(auditId).stage || 'setup';
    const note = b.note ? String(b.note).slice(0, 500) : null;
    let assignee = null;
    if (b.assignee) {
      const person = getUser(db, String(b.assignee));
      if (!canDirect(db, auth.user, person)) fail(403, 'You can only give tasks to your own team.');
      assignee = person.id;
      db.prepare("INSERT OR IGNORE INTO assignments (user_id, audit_id, assigned_by, assigned_at, role) VALUES (?, ?, ?, ?, 'field')").run(assignee, auditId, auth.user.id, Date.now());
    }
    let due = null;
    if (b.due) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.due)) fail(400, 'Due date is not valid.');
      due = Date.parse(`${b.due}T23:59:59+05:30`);
    }
    const id = randomId('T', 6);
    db.prepare(`INSERT INTO tasks (id, audit_id, app, title, assignee, status, due_at, created_at, created_by, stage, source, target, record_kind, note)
                VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, auditId, app, title, assignee, due, Date.now(), auth.user.id, stage, target ? 'data' : 'manual', target, kind, note);
    if (target) tx(db, () => reconcileTasks(db, auditId));
    logActivity(db, { userId: auth.user.id, action: 'task.created', target: id, detail: title, ip });
    return { id };
  });

  router.add('POST', '/api/tasks/:id/status', async ({ db, body, auth, params, ip }) => {
    const b = await body();
    const status = oneOf(b.status, TASK_STATUSES, 'Status');
    const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id);
    if (!t || !visibleTasks(db, auth.user, [t]).length) fail(404, 'Task not found.');
    const now = Date.now();
    db.prepare('UPDATE tasks SET status = ?, started_at = ?, done_at = ?, done_note = ? WHERE id = ?').run(
      status,
      status === 'todo' ? null : (t.started_at || now),
      status === 'done' ? now : null,
      status === 'done' ? `marked done by ${auth.user.name}` : null,
      t.id);
    logActivity(db, { userId: auth.user.id, action: 'task.status', target: t.id, detail: status, ip });
    return { ok: true };
  });

  // Change a task: who, when, the target; or remove one added by hand (process tasks stay).
  router.add('POST', '/api/tasks/:id', async ({ db, body, auth, params, ip }) => {
    const b = await body();
    const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id) || fail(404, 'Task not found.');
    const set = {};
    if ('assignee' in b) set.assignee = b.assignee ? getUser(db, String(b.assignee)).id : null;
    if ('due' in b) {
      if (b.due && !/^\d{4}-\d{2}-\d{2}$/.test(b.due)) fail(400, 'Due date is not valid.');
      set.due_at = b.due ? Date.parse(`${b.due}T23:59:59+05:30`) : null;
    }
    if ('title' in b && t.source !== 'process') set.title = str(b.title, { field: 'Task', max: 160 });
    if ('target' in b && t.source === 'data') {
      const n = Number(b.target);
      if (!(Number.isInteger(n) && n > 0 && n <= 10000)) fail(400, 'The target is a whole number of records.');
      set.target = n;
    }
    if ('note' in b) set.note = b.note ? String(b.note).slice(0, 500) : null;
    const keys = Object.keys(set);
    if (!keys.length) return { ok: true };
    db.prepare(`UPDATE tasks SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => set[k]), t.id);
    if (set.assignee) db.prepare("INSERT OR IGNORE INTO assignments (user_id, audit_id, assigned_by, assigned_at, role) VALUES (?, ?, ?, ?, 'field')").run(set.assignee, t.audit_id, auth.user.id, Date.now());
    logActivity(db, { userId: auth.user.id, action: 'task.edited', target: t.id, detail: t.title, ip });
    return { ok: true };
  });
  router.add('DELETE', '/api/tasks/:id', ({ db, auth, params, ip }) => {
    const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id) || fail(404, 'Task not found.');
    if (t.source === 'process') fail(400, 'Process tasks close by themselves; mark it done instead.');
    db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
    logActivity(db, { userId: auth.user.id, action: 'task.removed', target: t.audit_id, detail: t.title, ip });
    return { ok: true };
  });

  // ---------- activity log ----------
  router.add('GET', '/api/activity', ({ db, query, auth }) => {
    const limit = Math.min(500, Math.max(1, parseInt(query.get('limit') || '100', 10) || 100));
    const scope = scopeOf(db, auth.user);
    // An Admin sees what their own team did (themselves included), and nothing else.
    const rows = db.prepare(`SELECT a.*, u.name AS user_name, tu.name AS target_name FROM activity a
                             LEFT JOIN users u ON u.id = a.user_id LEFT JOIN users tu ON tu.id = a.target
                             ORDER BY a.id DESC LIMIT ?`).all(scope.all ? limit : limit * 20);
    return { activity: (scope.all ? rows : rows.filter(a => seesActivity(scope, a))).slice(0, limit) };
  });
}
