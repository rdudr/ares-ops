// Puts the demo company on the server: one company, one audit marked "demo", with records in every
// AR app (and the Energy Ledger) covering normal, light-load, overloaded and faulty cases, plus
// pictures, for testing Report Studio and for training (lib/demo.js). All of it is invented.
//
//   sudo -u ares DB_FILE=/var/lib/ares/ares.db node /opt/ares-ops/scripts/create-demo.mjs
//
// Keeps to one demo company: if one already exists it says which and stops, unless
//   --new          makes another one anyway
//   --if-missing   quietly does nothing when one exists (used by the deploy)
//   --as <login>   records the data under this Super Admin (default: the main Super Admin)
// The server does not need a restart: the new audit shows in the Console at once.
import path from 'node:path';
import { openDb, tx, logActivity } from '../lib/db.js';
import { createDemoAudit } from '../lib/demo.js';
import { ownerId } from '../lib/scope.js';

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const asLogin = args.includes('--as') ? args[args.indexOf('--as') + 1] : null;

const dbFile = process.env.DB_FILE || '/var/lib/ares/ares.db';
const filesDir = process.env.FILES_DIR || path.join(path.dirname(dbFile), 'files');
const db = openDb(dbFile);

const existing = db.prepare(`SELECT a.id, s.industry_tag, c.name AS company FROM audits a JOIN sites s ON s.id = a.site_id JOIN clients c ON c.id = s.client_id
  WHERE a.synthetic = 1 AND a.id IN (SELECT target FROM activity WHERE action = 'audit.demo_created') ORDER BY a.created_at DESC`).all();
if (existing.length && !flag('--new')) {
  if (flag('--if-missing')) process.exit(0);
  console.log(`A demo company is already on this server: ${existing[0].company}, audit ${existing[0].id} (${existing[0].industry_tag}).`);
  console.log('Run again with --new to make another one.');
  process.exit(0);
}

const actor = asLogin
  ? db.prepare("SELECT * FROM users WHERE login_id = ? AND role = 'super_admin'").get(asLogin)
  : db.prepare('SELECT * FROM users WHERE id = ?').get(ownerId(db))
    || db.prepare("SELECT * FROM users WHERE role = 'super_admin' AND status = 'active' ORDER BY created_at LIMIT 1").get();
if (!actor) {
  if (flag('--if-missing')) process.exit(0); // a fresh server with no Super Admin yet
  console.error(asLogin ? `"${asLogin}" is not a Super Admin.` : 'No active Super Admin yet: create one in the Console first.');
  process.exit(1);
}

const out = tx(db, () => createDemoAudit(db, actor, { ip: 'server', filesDir }));
logActivity(db, { userId: actor.id, action: 'audit.demo_loaded', target: out.audit_id, detail: `${out.records} records, ${out.pictures} pictures, via server command`, ip: 'server' });
const a = db.prepare('SELECT s.industry_tag, c.name FROM audits a JOIN sites s ON s.id = a.site_id JOIN clients c ON c.id = s.client_id WHERE a.id = ?').get(out.audit_id);
console.log(`Demo company ready: ${a.name}`);
console.log(`Audit ${out.audit_id} (${a.industry_tag}): ${out.records} records, ${out.pictures} pictures, under ${actor.name}.`);
console.log('Open it in the Console under Audits, or in Report Studio.');
