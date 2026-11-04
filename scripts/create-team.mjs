// Creates team members (profile card + login) from the server, e.g. the first Super Admin and the
// team on a fresh Console. Only someone with shell access to the server (SSH key) can run it.
// People who already exist are left alone. Each new person gets a one-time password and must set
// their own at first sign-in. Prints "login_id<TAB>one-time password" per new person, nothing else.
//
//   echo '[{"name":"Rishabh Dangi","login_id":"rishabh","role":"super_admin"}, ...]' |
//     sudo -u ares DB_FILE=/var/lib/ares/ares.db node /opt/ares-ops/scripts/create-team.mjs
import { openDb, logActivity, tx } from '../lib/db.js';
import { hashPassword, tempPassword, randomId } from '../lib/security.js';

const LOGIN_ID = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const ROLES = new Set(['super_admin', 'head', 'engineer']);

let input = '';
for await (const chunk of process.stdin) input += chunk;
const people = JSON.parse(input);
if (!Array.isArray(people) || !people.length) { console.error('Give a JSON list of people on standard input.'); process.exit(2); }

const db = openDb(process.env.DB_FILE || '/var/lib/ares/ares.db');
for (const p of people) {
  const loginId = String(p.login_id || '').toLowerCase();
  const name = String(p.name || '').trim();
  const role = p.role || 'head';
  if (!LOGIN_ID.test(loginId) || !name || name.length > 80 || !ROLES.has(role)) {
    console.error(`skipped (invalid): ${JSON.stringify(p)}`);
    continue;
  }
  if (db.prepare('SELECT 1 FROM users WHERE login_id = ?').get(loginId)) {
    console.error(`skipped (exists): ${loginId}`);
    continue;
  }
  const temp = tempPassword();
  const hash = await hashPassword(temp);
  const id = randomId('U');
  tx(db, () => {
    db.prepare(`INSERT INTO users (id, login_id, name, role, employment, status, pw_hash, must_change_pw, created_at, created_by, position, in_report, report_order)
                VALUES (?, ?, ?, ?, 'staff', 'active', ?, 1, ?, NULL, ?, 1, ?)`)
      .run(id, loginId, name, role, hash, Date.now(), p.position || null, Number.isInteger(p.report_order) ? p.report_order : 0);
    logActivity(db, { userId: null, action: 'user.created', target: id, detail: `${loginId} (${role}) via server command`, ip: 'server' });
  });
  console.log(`${loginId}\t${temp}`);
}
