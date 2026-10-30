// Who may see and change what in the Console (docs/PLATFORM_RULES.md §8).
//
// - The owner is the Super Admin made at first setup. Nobody can change, hold, revoke or reset
//   the owner, and only the owner can make or change other Super Admins.
// - A Super Admin sees everything and manages everyone else.
// - An Admin (role code 'head') sees only the apps given to them: those apps' data, the audits
//   that have data from those apps (or that they created or are assigned to), the tasks and the
//   activity of their own team. They manage only Engineers who work on their apps, can only give
//   out apps they hold themselves, and can never change their own access.
// - Engineers do not use the Console.
import { APPS } from './apps.js';

export const ROLE_LABEL = { super_admin: 'Super Admin', head: 'Admin', engineer: 'Engineer' };

export function ownerId(db) {
  return db.prepare("SELECT id FROM users WHERE role = 'super_admin' AND created_by IS NULL ORDER BY created_at LIMIT 1").get()?.id
    || db.prepare("SELECT id FROM users WHERE role = 'super_admin' ORDER BY created_at LIMIT 1").get()?.id
    || null;
}

const appsOf = (db, userId) => db.prepare('SELECT app FROM app_access WHERE user_id = ?').all(userId).map(r => r.app);

// What this person may see. Super Admin: { all: true }. Admin: their apps, audits and people.
export function scopeOf(db, user) {
  if (user.role === 'super_admin') return { all: true, apps: APPS.map(a => a.code) };
  const apps = appsOf(db, user.id).filter(a => APPS.some(x => x.code === a));
  const q = list => list.length ? list.map(() => '?').join(',') : "''";
  const audits = new Set(db.prepare(`
    SELECT DISTINCT audit_id AS id FROM records WHERE app IN (${q(apps)})
    UNION SELECT audit_id FROM assignments WHERE user_id = ?
    UNION SELECT id FROM audits WHERE created_by = ?`).all(...apps, user.id, user.id).map(r => r.id));
  // Their team: Engineers who work on one of their apps, or whom they added. And themselves.
  const people = new Set(db.prepare(`
    SELECT id FROM users WHERE id = ?
    UNION SELECT u.id FROM users u JOIN app_access a ON a.user_id = u.id WHERE u.role = 'engineer' AND a.app IN (${q(apps)})
    UNION SELECT id FROM users WHERE role = 'engineer' AND created_by = ?`).all(user.id, ...apps, user.id).map(r => r.id));
  return { all: false, apps, audits, people, userId: user.id };
}

export const seesApp = (scope, app) => scope.all || scope.apps.includes(app);
export const seesAudit = (scope, auditId) => scope.all || scope.audits.has(auditId);
export const seesPerson = (scope, userId) => scope.all || scope.people.has(userId);

// SQL "col IN (...)" for an Admin's apps (codes come from the fixed app list), or no condition.
export function appFilter(scope, col) {
  if (scope.all) return '1 = 1';
  return scope.apps.length ? `${col} IN (${scope.apps.map(a => `'${a.replace(/[^a-z]/g, '')}'`).join(',')})` : '0 = 1';
}

// May the actor change this person at all (details, hold, revoke, password, audits)?
export function canManage(db, actor, target) {
  if (actor.id === target.id) return false;
  const owner = ownerId(db);
  if (target.id === owner) return false;
  if (actor.role === 'super_admin') return target.role !== 'super_admin' || actor.id === owner;
  if (actor.role !== 'head' || target.role !== 'engineer') return false;
  // An Admin manages an Engineer only when everything that Engineer works on is the Admin's.
  const mine = appsOf(db, actor.id);
  const theirs = appsOf(db, target.id);
  if (theirs.some(a => !mine.includes(a))) return false;
  return theirs.length > 0 || target.created_by === actor.id;
}

// May the actor give or take this app from this person?
export function canChangeApp(db, actor, target, app) {
  if (actor.id === target.id) return false;
  if (actor.role === 'super_admin') return canManage(db, actor, target);
  if (actor.role !== 'head' || target.role !== 'engineer') return false;
  if (!appsOf(db, actor.id).includes(app)) return false;
  return seesPerson(scopeOf(db, actor), target.id);
}

// May the actor put this person on an audit or a task?
export function canDirect(db, actor, target) {
  if (actor.role === 'super_admin') return true;
  if (target.id === actor.id) return true;
  return target.role === 'engineer' && seesPerson(scopeOf(db, actor), target.id);
}

// May the actor make someone with this role? Only the owner makes Super Admins; Admins make Engineers.
export function canGiveRole(db, actor, role) {
  if (role === 'super_admin') return actor.id === ownerId(db);
  if (role === 'head') return actor.role === 'super_admin';
  return actor.role === 'super_admin' || actor.role === 'head';
}

// One activity line for an Admin: by their team, and not about another app or another audit.
const APP_SET = new Set(APPS.map(a => a.code));
export function seesActivity(scope, a) {
  if (scope.all) return true;
  if (!a.user_id || !scope.people.has(a.user_id)) return false;
  if (APP_SET.has(a.target) && !scope.apps.includes(a.target)) return false;
  if (/^AU-/.test(a.target || '') && !scope.audits.has(a.target)) return false;
  const first = String(a.detail || '').split(' ')[0];
  return !(APP_SET.has(first) && !scope.apps.includes(first));
}
