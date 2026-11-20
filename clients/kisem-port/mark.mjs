// Records AR's answer for KISEM update codes in docs/kisem-sync/ar-status.json (KISEM's ledger reads it).
//
//   node clients/kisem-port/mark.mjs ported <ar_ref> <code|kisem-hash> [...]      in AR main (ar_ref: "ares-air 980098a")
//   node clients/kisem-port/mark.mjs pr-open <ar_ref> <code|hash> [...]          on a branch, not merged yet
//   node clients/kisem-port/mark.mjs skipped "<why>" <code|hash> [...]           deliberately not taken
//   node clients/kisem-port/mark.mjs not-applicable "<why>" <code|hash> [...]    KISEM-only
//   node clients/kisem-port/mark.mjs --never                                     every KISEM-only code pending.mjs leaves out
//
// A KISEM commit hash (7+ characters) is turned into its update code through pending.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pending } from './pending.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATUS = path.resolve(HERE, '..', '..', 'docs', 'kisem-sync', 'ar-status.json');
const STATES = ['ported', 'pr-open', 'skipped', 'not-applicable'];
const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

const status = JSON.parse(fs.readFileSync(STATUS, 'utf8'));
const [what, ref, ...ids] = process.argv.slice(2);
const save = n => {
  const sorted = Object.fromEntries(Object.entries(status).sort(([a], [b]) => b.localeCompare(a)));
  fs.writeFileSync(STATUS, JSON.stringify(sorted, null, 1) + '\n');
  console.log(`${n} code(s) recorded in docs/kisem-sync/ar-status.json`);
};

if (what === '--never') {
  let n = 0;
  for (const r of pending()) if (r.never) { status[r.code] = { status: 'not-applicable', ar_ref: '', at: today, note: r.never }; n++; }
  save(n);
} else {
  if (!STATES.includes(what) || !ref || !ids.length) { console.error('Usage: mark.mjs ported|pr-open|skipped|not-applicable <ar_ref or why> <code|hash> [...]'); process.exit(1); }
  const open = ids.some(x => !x.startsWith('KU-')) ? pending() : [];
  let n = 0;
  for (const id of ids) {
    const code = id.startsWith('KU-') ? id : open.find(r => id.startsWith(r.hash) || r.hash.startsWith(id))?.code;
    if (!code) { console.error(`  ${id}: no pending KISEM update with that hash`); continue; }
    const asRef = what === 'ported' || what === 'pr-open';
    status[code] = { status: what, ar_ref: asRef ? ref : '', at: today, note: asRef ? '' : ref };
    n++;
  }
  save(n);
}
