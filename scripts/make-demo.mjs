// Makes a demo company: one audit marked as demo, with a company profile, logo and site photo,
// records with photos and thermal images in every AR app (lib/demo.js), and Energy Ledger bills,
// baseline and GHG (lib/demo-ledger.js). All names, numbers and pictures are invented. It never
// changes another audit. Run on the server:
//
//   sudo -u ares DB_FILE=/var/lib/ares/ares.db node /opt/ares-ops/scripts/make-demo.mjs [<super admin login_id>]
//   ... make-demo.mjs --ledger <audit id> [<login_id>]   adds only the Ledger part to an existing demo audit
//
// Without a login ID it uses the main Super Admin (the owner). FILES_DIR defaults to files/ next to the database.
import path from 'node:path';
import { openDb } from '../lib/db.js';
import { createDemoAudit } from '../lib/demo.js';
import { createDemoLedger } from '../lib/demo-ledger.js';
import { ownerId } from '../lib/scope.js';
import { migrateCea } from '../lib/cea.js';

const dbFile = process.env.DB_FILE || '/var/lib/ares/ares.db';
const filesDir = process.env.FILES_DIR || path.join(path.dirname(dbFile), 'files');
const db = openDb(dbFile);
migrateCea(db); // the CEA versions table, as the server makes it on start
const args = process.argv.slice(2);
const li = args.indexOf('--ledger');
const ledgerAudit = li >= 0 ? args.splice(li, 2)[1] : null;
const loginId = args[0];
const actor = loginId
  ? db.prepare("SELECT * FROM users WHERE login_id = ? AND role = 'super_admin'").get(loginId)
  : db.prepare('SELECT * FROM users WHERE id = ?').get(ownerId(db));
if (!actor) {
  console.error(loginId ? `"${loginId}" is not a Super Admin.` : 'No Super Admin yet.');
  process.exit(1);
}
try {
  if (ledgerAudit) {
    const l = createDemoLedger(db, actor, ledgerAudit, { ip: 'server' });
    console.log(`Energy Ledger added to ${ledgerAudit}: ${l.bills} bills, ${l.baseline_months} baseline months, ${l.ghg_lines} GHG lines, grid factor ${l.grid_ef} (CEA ${l.cea}).`);
  } else {
    const r = createDemoAudit(db, actor, { ip: 'server', filesDir });
    console.log(`Demo company made: audit ${r.audit_id}, ${r.records} records, ${r.pictures} pictures, Energy Ledger with ${r.ledger.bills} bills (by ${actor.name}).`);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
