// Super Admin recovery, run on the server when nobody can sign in to the Console.
// Gives the account a new one-time password, reactivates it and ends its sessions.
//
//   sudo -u ares DB_FILE=/var/lib/ares/ares.db node /opt/ares-ops/scripts/recover-admin.mjs <login_id>
//   sudo systemctl restart ares-ops      # also clears in-memory wrong-password lockouts
//
// Only someone with shell access to the server (SSH key) can run this.
import { openDb, logActivity } from '../lib/db.js';
import { hashPassword, tempPassword } from '../lib/security.js';

const loginId = process.argv[2];
if (!loginId) {
  console.error('Usage: node scripts/recover-admin.mjs <login_id>');
  process.exit(2);
}
const db = openDb(process.env.DB_FILE || '/var/lib/ares/ares.db');
const user = db.prepare('SELECT * FROM users WHERE login_id = ?').get(loginId);
if (!user) {
  const admins = db.prepare("SELECT login_id FROM users WHERE role = 'super_admin'").all().map(u => u.login_id);
  console.error(`No account "${loginId}". Super Admin login IDs: ${admins.join(', ') || '(none)'}`);
  process.exit(1);
}
if (user.role !== 'super_admin') {
  console.error(`"${loginId}" is not a Super Admin. Use the Console to reset other people.`);
  process.exit(1);
}
const temp = tempPassword();
db.prepare(`UPDATE users SET pw_hash = ?, must_change_pw = 1, status = 'active', failed_logins = 0, locked_until = NULL WHERE id = ?`)
  .run(await hashPassword(temp), user.id);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
logActivity(db, { userId: user.id, action: 'admin.recovered', target: user.id, detail: 'via server recovery command', ip: 'server' });
console.log(`\n${user.name} (${loginId}) is active again.`);
console.log(`One-time password: ${temp}`);
console.log('Sign in with it, then set a new password. Now run: sudo systemctl restart ares-ops\n');
