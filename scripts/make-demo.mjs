// Makes a demo company: one audit marked as demo, with a company profile, logo and site photo, and
// records with photos and thermal images in every AR app (lib/demo.js). All names, numbers and
// pictures are invented. It never changes another audit. Run on the server:
//
//   sudo -u ares DB_FILE=/var/lib/ares/ares.db node /opt/ares-ops/scripts/make-demo.mjs [<super admin login_id>]
//
// Without a login ID it uses the main Super Admin (the owner). FILES_DIR defaults to files/ next to the database.
import path from 'node:path';
import { openDb } from '../lib/db.js';
import { createDemoAudit } from '../lib/demo.js';
import { ownerId } from '../lib/scope.js';

const dbFile = process.env.DB_FILE || '/var/lib/ares/ares.db';
const filesDir = process.env.FILES_DIR || path.join(path.dirname(dbFile), 'files');
const db = openDb(dbFile);
const loginId = process.argv[2];
const actor = loginId
  ? db.prepare("SELECT * FROM users WHERE login_id = ? AND role = 'super_admin'").get(loginId)
  : db.prepare('SELECT * FROM users WHERE id = ?').get(ownerId(db));
if (!actor) {
  console.error(loginId ? `"${loginId}" is not a Super Admin.` : 'No Super Admin yet.');
  process.exit(1);
}
const r = createDemoAudit(db, actor, { ip: 'server', filesDir });
console.log(`Demo company made: audit ${r.audit_id}, ${r.records} records, ${r.pictures} pictures (by ${actor.name}).`);
