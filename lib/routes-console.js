import crypto from 'node:crypto';
import { fail, str, oneOf } from './http.js';
import { tx, logActivity } from './db.js';
import { APPS, APP_CODES, SECTORS, AUDIT_STATUSES, TASK_STATUSES } from './apps.js';
import { hashPassword, verifyPassword, passwordProblem, tempPassword, randomId, rateLimiter } from './security.js';
import { checkCredentials, createSession, endUserSessions, isManager } from './auth.js';
import { dashboard } from './dashboard.js';

const LOGIN_ID = /^[a-z0-9][a-z0-9._-]{2,31}$/i;
const loginLimit = rateLimiter(20, 10 * 60 * 1000);

const publicUser = u => ({
  id: u.id, login_id: u.login_id, name: u.name, phone: u.phone, role: u.role,
  employment: u.employment, status: u.status, must_change_pw: !!u.must_change_pw,
  last_login_at: u.last_login_at, created_at: u.created_at,
});

// Super Admin manages everyone but themselves; a Head manages Engineers only.
function canManage(actor, target) {
  if (actor.id === target.id) return false;
  if (actor.role === 'super_admin') return true;
  return actor.role === 'head' && target.role === 'engineer';
}

function getUser(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || fail(404, 'Person not found.');
}

function fyCode(fy) {
  const m = /^FY(\d{4})-(\d{2})$/.exec(fy);
  return m[1].slice(2) + m[2];
}

export function registerConsoleRoutes(router, { setupCode }) {
  // ---------- first-run setup ----------
  router.add('GET', '/api/setup', ({ db }) => ({
    needed: !db.prepare('SELECT 1 FROM users LIMIT 1').get(),
  }), { public: true });

  router.add('POST', '/api/setup', async ({ db, body, ip }) => {
    const b = await body();
    if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) fail(403, 'Setup is already done.');
    if (!loginLimit(`setup:${ip}`)) fail(429, 'Too many attempts. Wait a few minutes.');
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
    if (!loginLimit(`login:${ip}`)) fail(429, 'Too many attempts. Wait a few minutes.');
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

  router.add('GET', '/api/me', ({ auth }) => ({
    user: publicUser(auth.user),
    apps: APPS,
    sectors: SECTORS,
  }), { allowPasswordChange: true });

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
  router.add('GET', '/api/dashboard', ({ db, query }) => {
    const days = Math.min(365, Math.max(1, parseInt(query.get('days') || '30', 10) || 30));
    return dashboard(db, days);
  });

  // ---------- team ----------
  router.add('GET', '/api/users', ({ db }) => {
    const users = db.prepare('SELECT * FROM users ORDER BY status, name').all();
    const access = db.prepare('SELECT user_id, app FROM app_access').all();
    const assigned = db.prepare(`SELECT a.user_id, a.audit_id, s.industry_tag FROM assignments a
                                 JOIN audits au ON au.id = a.audit_id JOIN sites s ON s.id = au.site_id`).all();
    return {
      users: users.map(u => ({
        ...publicUser(u),
        apps: u.role === 'super_admin' ? APPS.map(a => a.code) : access.filter(a => a.user_id === u.id).map(a => a.app),
        audits: assigned.filter(a => a.user_id === u.id).map(a => ({ id: a.audit_id, tag: a.industry_tag })),
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
    if (actor.role !== 'super_admin' && role !== 'engineer') fail(403, 'Team heads can add Engineers only.');
    if (employment === 'freelancer' && role !== 'engineer') fail(400, 'Freelancers can only have the Engineer role.');
    const apps = Array.isArray(b.apps) ? b.apps.filter(a => APP_CODES.has(a)) : [];
    const audits = Array.isArray(b.audits) ? b.audits.map(String) : [];
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
    if (!canManage(auth.user, target)) fail(403, 'You cannot change this person.');
    const name = b.name !== undefined ? str(b.name, { field: 'Name', max: 80 }) : target.name;
    const phone = b.phone !== undefined ? (b.phone ? str(b.phone, { field: 'Phone', min: 6, max: 20, pattern: /^[0-9+ -]+$/ }) : null) : target.phone;
    const employment = b.employment !== undefined ? oneOf(b.employment, ['staff', 'freelancer'], 'Type') : target.employment;
    let role = target.role;
    if (b.role !== undefined && b.role !== target.role) {
      if (auth.user.role !== 'super_admin') fail(403, 'Only a Super Admin can change roles.');
      role = oneOf(b.role, ['super_admin', 'head', 'engineer'], 'Role');
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
    if (!canManage(auth.user, target)) fail(403, 'You cannot change this person.');
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
    if (!canManage(auth.user, target)) fail(403, 'You cannot change this person.');
    if (!APP_CODES.has(b.app)) fail(400, 'Unknown app.');
    if (b.grant) {
      db.prepare('INSERT OR IGNORE INTO app_access (user_id, app, granted_by, granted_at) VALUES (?, ?, ?, ?)').run(target.id, b.app, auth.user.id, Date.now());
    } else {
      // Open app sessions are refused on their next call (see endUserSessions).
      db.prepare('DELETE FROM app_access WHERE user_id = ? AND app = ?').run(target.id, b.app);
    }
    logActivity(db, { userId: auth.user.id, action: b.grant ? 'app.granted' : 'app.removed', target: target.id, detail: b.app, ip });
    return { ok: true };
  });

  router.add('POST', '/api/users/:id/reset-password', async ({ db, auth, params, ip }) => {
    const target = getUser(db, params.id);
    if (!canManage(auth.user, target)) fail(403, 'You cannot change this person.');
    const temp = tempPassword();
    db.prepare('UPDATE users SET pw_hash = ?, must_change_pw = 1, failed_logins = 0, locked_until = NULL WHERE id = ?')
      .run(await hashPassword(temp), target.id);
    endUserSessions(db, target.id);
    logActivity(db, { userId: auth.user.id, action: 'password.reset', target: target.id, ip });
    return { temp_password: temp };
  });

  // ---------- clients, sites, audits ----------
  router.add('GET', '/api/clients', ({ db }) => {
    const clients = db.prepare('SELECT * FROM clients ORDER BY name').all();
    const sites = db.prepare('SELECT * FROM sites ORDER BY name').all();
    return { clients: clients.map(c => ({ ...c, sites: sites.filter(s => s.client_id === c.id) })) };
  });

  router.add('GET', '/api/audits', ({ db }) => {
    const audits = db.prepare(`
      SELECT au.*, s.name AS site_name, s.cluster, s.industry_tag, c.name AS client_name, c.sector,
        (SELECT COUNT(*) FROM records r WHERE r.audit_id = au.id) AS records,
        (SELECT COUNT(*) FROM tasks t WHERE t.audit_id = au.id AND t.status != 'done') AS open_tasks,
        (SELECT MAX(r.synced_at) FROM records r WHERE r.audit_id = au.id) AS last_sync
      FROM audits au JOIN sites s ON s.id = au.site_id JOIN clients c ON c.id = s.client_id
      ORDER BY au.created_at DESC`).all();
    const team = db.prepare(`SELECT a.audit_id, u.id, u.name, u.employment FROM assignments a JOIN users u ON u.id = a.user_id`).all();
    return { audits: audits.map(a => ({ ...a, team: team.filter(t => t.audit_id === a.id) })) };
  });

  router.add('POST', '/api/audits', async ({ db, body, auth, ip }) => {
    const b = await body();
    const fy = str(b.fy, { field: 'Financial year', min: 9, max: 9, pattern: /^FY\d{4}-\d{2}$/ });
    const title = str(b.title, { field: 'Audit title', max: 120 });
    const now = Date.now();
    const audit = tx(db, () => {
      let clientId = b.client_id ? String(b.client_id) : null;
      let sector;
      if (clientId) {
        const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId) || fail(400, 'Client not found.');
        sector = c.sector;
      } else {
        const name = str(b.client_name, { field: 'Client name', max: 120 });
        sector = oneOf(b.sector, Object.keys(SECTORS), 'Sector');
        clientId = randomId('CL');
        db.prepare('INSERT INTO clients (id, name, sector, created_at) VALUES (?, ?, ?, ?)').run(clientId, name, sector, now);
      }
      let siteId = b.site_id ? String(b.site_id) : null;
      if (siteId) {
        db.prepare('SELECT 1 FROM sites WHERE id = ? AND client_id = ?').get(siteId, clientId) || fail(400, 'Site not found for this client.');
      } else {
        const siteName = str(b.site_name, { field: 'Plant name', max: 120 });
        const cluster = str(b.cluster, { field: 'Cluster code', min: 3, max: 3, pattern: /^[A-Za-z]{3}$/ }).toUpperCase();
        // Public industry tag: sector + cluster + next free number. Never derived from the name.
        const prefix = `${sector}-${cluster}-`;
        const last = db.prepare("SELECT industry_tag FROM sites WHERE industry_tag LIKE ? ORDER BY industry_tag DESC LIMIT 1").get(prefix + '%');
        const n = last ? parseInt(last.industry_tag.slice(prefix.length), 10) + 1 : 1;
        siteId = randomId('ST');
        db.prepare('INSERT INTO sites (id, client_id, name, cluster, industry_tag, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(siteId, clientId, siteName, cluster, prefix + String(n).padStart(3, '0'), now);
      }
      const code = fyCode(fy);
      const count = db.prepare('SELECT COUNT(*) AS n FROM audits WHERE fy = ?').get(fy).n;
      const id = `AU-${code}-${String(count + 1).padStart(4, '0')}`;
      db.prepare('INSERT INTO audits (id, site_id, fy, title, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, siteId, fy, title, 'draft', now, auth.user.id);
      logActivity(db, { userId: auth.user.id, action: 'audit.created', target: id, ip });
      return id;
    });
    return { id: audit };
  });

  router.add('POST', '/api/audits/:id/status', async ({ db, body, auth, params, ip }) => {
    const b = await body();
    const status = oneOf(b.status, AUDIT_STATUSES, 'Status');
    const r = db.prepare('UPDATE audits SET status = ? WHERE id = ?').run(status, params.id);
    if (!r.changes) fail(404, 'Audit not found.');
    logActivity(db, { userId: auth.user.id, action: 'audit.status', target: params.id, detail: status, ip });
    return { ok: true };
  });

  router.add('POST', '/api/audits/:id/assign', async ({ db, body, auth, params, ip }) => {
    const b = await body();
    db.prepare('SELECT 1 FROM audits WHERE id = ?').get(params.id) || fail(404, 'Audit not found.');
    const target = getUser(db, String(b.user_id || ''));
    if (target.role !== 'engineer' && auth.user.role !== 'super_admin') fail(403, 'Team heads can assign Engineers only.');
    if (b.assign) {
      db.prepare('INSERT OR IGNORE INTO assignments (user_id, audit_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?)').run(target.id, params.id, auth.user.id, Date.now());
    } else {
      db.prepare('DELETE FROM assignments WHERE user_id = ? AND audit_id = ?').run(target.id, params.id);
    }
    logActivity(db, { userId: auth.user.id, action: b.assign ? 'audit.assigned' : 'audit.unassigned', target: params.id, detail: target.id, ip });
    return { ok: true };
  });

  // ---------- tasks ----------
  router.add('GET', '/api/tasks', ({ db }) => ({
    tasks: db.prepare(`
      SELECT t.*, u.name AS assignee_name, s.industry_tag, s.name AS site_name
      FROM tasks t JOIN audits au ON au.id = t.audit_id JOIN sites s ON s.id = au.site_id
      LEFT JOIN users u ON u.id = t.assignee
      ORDER BY CASE t.status WHEN 'running' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END, COALESCE(t.due_at, 9e15), t.created_at DESC`).all(),
  }));

  router.add('POST', '/api/tasks', async ({ db, body, auth, ip }) => {
    const b = await body();
    const auditId = String(b.audit_id || '');
    db.prepare('SELECT 1 FROM audits WHERE id = ?').get(auditId) || fail(400, 'Choose an audit.');
    const title = str(b.title, { field: 'Task', max: 160 });
    const app = b.app ? (APP_CODES.has(b.app) ? b.app : fail(400, 'Unknown app.')) : null;
    let assignee = null;
    if (b.assignee) {
      assignee = getUser(db, String(b.assignee)).id;
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
    const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id) || fail(404, 'Task not found.');
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
  router.add('GET', '/api/activity', ({ db, query }) => {
    const limit = Math.min(500, Math.max(1, parseInt(query.get('limit') || '100', 10) || 100));
    return {
      activity: db.prepare(`SELECT a.*, u.name AS user_name, tu.name AS target_name FROM activity a
                            LEFT JOIN users u ON u.id = a.user_id LEFT JOIN users tu ON tu.id = a.target
                            ORDER BY a.id DESC LIMIT ?`).all(limit),
    };
  });
}
