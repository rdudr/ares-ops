import crypto from 'node:crypto';
import { fail, str, oneOf } from './http.js';
import { tx, logActivity } from './db.js';
import { APPS, APP_CODES, SECTORS, AUDIT_STATUSES, TASK_STATUSES } from './apps.js';
import { hashPassword, verifyPassword, passwordProblem, tempPassword, randomId, rateLimiter } from './security.js';
import { checkCredentials, createSession, endUserSessions, isManager, clearLockouts, isLockedOut } from './auth.js';
import { scopeOf, seesApp, seesAudit, seesPerson, seesActivity, appFilter, ownerId, canManage, canChangeApp, canDirect, canGiveRole } from './scope.js';
import { dashboard } from './dashboard.js';
import { createAudit } from './audits.js';

const LOGIN_ID = /^[a-z0-9][a-z0-9._-]{2,31}$/i;
const setupLimit = rateLimiter(20, 10 * 60 * 1000);

const publicUser = u => ({
  id: u.id, login_id: u.login_id, name: u.name, phone: u.phone, role: u.role,
  employment: u.employment, status: u.status, must_change_pw: !!u.must_change_pw,
  last_login_at: u.last_login_at, created_at: u.created_at,
});

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

export function registerConsoleRoutes(router, { setupCode }) {
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

  router.add('GET', '/api/me', ({ db, auth }) => ({
    user: { ...publicUser(auth.user), owner: auth.user.id === ownerId(db) },
    apps: APPS,
    // The apps this person works with in the Console (all of them for a Super Admin).
    my_apps: scopeOf(db, auth.user).apps,
    sectors: SECTORS,
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
    const role = oneOf(b.role || 'engineer', ['super_admin', 'head', 'engineer'], 'Role');
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
      for (const app of apps) db.prepare('INSERT INTO app_access (user_id, app, granted_by, granted_at) VALUES (?, ?, ?, ?)').run(id, app, actor.id, now);
      for (const a of audits) {
        if (!db.prepare('SELECT 1 FROM audits WHERE id = ?').get(a)) fail(400, `Audit ${a} not found.`);
        db.prepare('INSERT INTO assignments (user_id, audit_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?)').run(id, a, actor.id, now);
      }
      logActivity(db, { userId: actor.id, action: 'user.created', target: id, detail: `${loginId} (${role}, ${employment}); apps: ${apps.join(', ') || 'none'}`, ip });
    });
    return { user: publicUser(getUser(db, id)), temp_password: temp };
  });

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
    db.prepare('UPDATE users SET name = ?, phone = ?, employment = ?, role = ? WHERE id = ?').run(name, phone, employment, role, target.id);
    if (role !== target.role) endUserSessions(db, target.id);
    logActivity(db, { userId: auth.user.id, action: 'user.updated', target: target.id, detail: role !== target.role ? `role ${target.role} → ${role}` : null, ip });
    return { user: publicUser(getUser(db, target.id)) };
  });

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
      SELECT au.*, s.name AS site_name, s.cluster, s.industry_tag, c.name AS client_name, c.sector,
        (SELECT name FROM users WHERE id = au.finalized_by) AS finalized_by_name,
        (SELECT COUNT(*) FROM records r WHERE r.audit_id = au.id AND ${appFilter(scope, 'r.app')} AND COALESCE(json_extract(r.payload, '$._deleted'), 0) = 0) AS records,
        (SELECT COUNT(*) FROM tasks t WHERE t.audit_id = au.id AND t.status != 'done') AS open_tasks,
        (SELECT MAX(r.synced_at) FROM records r WHERE r.audit_id = au.id) AS last_sync
      FROM audits au JOIN sites s ON s.id = au.site_id JOIN clients c ON c.id = s.client_id
      ORDER BY au.created_at DESC`).all().filter(a => seesAudit(scope, a.id));
    const team = db.prepare(`SELECT a.audit_id, u.id, u.name, u.employment FROM assignments a JOIN users u ON u.id = a.user_id`).all()
      .filter(t => seesPerson(scope, t.id));
    return { audits: audits.map(a => ({ ...a, team: team.filter(t => t.audit_id === a.id) })) };
  });

  router.add('POST', '/api/audits', async ({ db, body, auth, ip }) => {
    const b = await body();
    return { id: tx(db, () => createAudit(db, b, { actorId: auth.user.id, ip })) };
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
    if (b.assign) {
      db.prepare('INSERT OR IGNORE INTO assignments (user_id, audit_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?)').run(target.id, params.id, auth.user.id, Date.now());
    } else {
      db.prepare('DELETE FROM assignments WHERE user_id = ? AND audit_id = ?').run(target.id, params.id);
    }
    logActivity(db, { userId: auth.user.id, action: b.assign ? 'audit.assigned' : 'audit.unassigned', target: params.id, detail: target.id, ip });
    return { ok: true };
  });

  // ---------- tasks ----------
  router.add('GET', '/api/tasks', ({ db, auth }) => ({
    tasks: visibleTasks(db, auth.user, db.prepare(`
      SELECT t.*, u.name AS assignee_name, s.industry_tag, s.name AS site_name
      FROM tasks t JOIN audits au ON au.id = t.audit_id JOIN sites s ON s.id = au.site_id
      LEFT JOIN users u ON u.id = t.assignee
      ORDER BY CASE t.status WHEN 'running' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END, COALESCE(t.due_at, 9e15), t.created_at DESC`).all()),
  }));

  router.add('POST', '/api/tasks', async ({ db, body, auth, ip }) => {
    const b = await body();
    const auditId = String(b.audit_id || '');
    db.prepare('SELECT 1 FROM audits WHERE id = ?').get(auditId) || fail(400, 'Choose an audit.');
    const scope = scopeOf(db, auth.user);
    if (!seesAudit(scope, auditId)) fail(400, 'Choose an audit.');
    const title = str(b.title, { field: 'Task', max: 160 });
    const app = b.app ? (APP_CODES.has(b.app) ? b.app : fail(400, 'Unknown app.')) : null;
    if (app && !seesApp(scope, app)) fail(403, 'You can only add tasks for your own apps.');
    let assignee = null;
    if (b.assignee) {
      const person = getUser(db, String(b.assignee));
      if (!canDirect(db, auth.user, person)) fail(403, 'You can only give tasks to your own team.');
      assignee = person.id;
      db.prepare('INSERT OR IGNORE INTO assignments (user_id, audit_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?)').run(assignee, auditId, auth.user.id, Date.now());
    }
    let due = null;
    if (b.due) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.due)) fail(400, 'Due date is not valid.');
      due = Date.parse(`${b.due}T23:59:59+05:30`);
    }
    const id = randomId('T', 6);
    db.prepare('INSERT INTO tasks (id, audit_id, app, title, assignee, status, due_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, auditId, app, title, assignee, 'todo', due, Date.now(), auth.user.id);
    logActivity(db, { userId: auth.user.id, action: 'task.created', target: id, detail: title, ip });
    return { id };
  });

  router.add('POST', '/api/tasks/:id/status', async ({ db, body, auth, params, ip }) => {
    const b = await body();
    const status = oneOf(b.status, TASK_STATUSES, 'Status');
    const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id);
    if (!t || !visibleTasks(db, auth.user, [t]).length) fail(404, 'Task not found.');
    const now = Date.now();
    db.prepare('UPDATE tasks SET status = ?, started_at = ?, done_at = ? WHERE id = ?').run(
      status,
      status === 'todo' ? null : (t.started_at || now),
      status === 'done' ? now : null,
      t.id);
    logActivity(db, { userId: auth.user.id, action: 'task.status', target: t.id, detail: status, ip });
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
