// What AR has not taken from KISEM yet, fixes first.
//
//   node clients/kisem-port/pending.mjs            every KISEM update AR has not settled, by AR app
//   node clients/kisem-port/pending.mjs --fixes    only the fixes (wrong figures, errors, security)
//   node clients/kisem-port/pending.mjs --json     the same as JSON (for a script or a scheduled check)
//
// Reads KISEM's update ledger (FOX Console tools/updates/updates.mjs, from KISEM's git history on this
// PC) and AR's answer for each code (docs/kisem-sync/ar-status.json). A code AR has not answered is
// pending. Things AR never takes are left out by themselves (KISEM website, Inventory WTEA, the app
// download page, the Excel Team Data Exchange, KISEM logos), so they never hide a real fix.
// After porting, record the result with mark.mjs (see docs/kisem-sync/RUNBOOK.md).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPS = path.resolve(HERE, '..', '..');
const FOX = process.env.FOX_CONSOLE || path.resolve(OPS, '..', 'fox-console');
const STATUS = path.join(OPS, 'docs', 'kisem-sync', 'ar-status.json');

// KISEM code -> AR place (as in docs/kisem-sync/README.md).
export const AR_OF = {
  ACMP: 'Air Findings (ares-air)', THX: 'Boiler & Fuel (ares-boiler)', GRID: 'BRIEF (ares-brief)', ZERO: 'Cool Zone (ares-cooling)',
  DRY: 'Dryer Heat (ares-dryer)', JET: 'Dye House (ares-jet)', LUX: 'Lux Survey (ares-light)', MLA: 'Motor Pulse (ares-mla)',
  PUMP: 'Hydro Flow (ares-pump)', XMER: 'Trafo Check (ares-xmer)', PQA: 'Grid Lens (ares-power)', CON: 'ARES Console (ares-ops)',
  PMN: 'Report Studio (report_studio_ares, report-studio-web)',
};
// Never taken by AR: no such app or site in AR, or left out by the user's decision.
const NEVER = [
  [/-(SITE|INV|DL)(-\d+)?$/, 'KISEM website, Inventory WTEA or the KISEM download page: none in AR'],
  [/Team Data Exchange|app-kit: master copy of the apps' Team Data Exchange/i, 'no Excel Team Data Exchange in AR (decided 16 Nov)'],
  [/FOX Console mark|5B logo|FOX logo/i, 'KISEM logo'],
  [/^Inventory WTEA|Plant inventory/i, 'Inventory WTEA: not in AR (decided)'],
  [/Audit website|audit-site|annual report PDF/i, 'KISEM audit website: none in AR'],
];
// A fix: a figure that was wrong, an error, a crash, data loss or a security hole. These go first.
const FIX = /\bfix|wrong|error|bug|too (high|low)|not 0|missing data|null\b|crash|lost|leak|security|bypass|takeover|refus|corrected|stale|never (counted|handed)|cannot/i;

export function pending() {
  let out;
  try { out = execFileSync(process.execPath, [path.join(FOX, 'tools', 'updates', 'updates.mjs'), 'pending'], { cwd: FOX, encoding: 'utf8', maxBuffer: 64 << 20 }); }
  catch (e) { throw new Error(`KISEM's ledger could not be read from ${FOX} (set FOX_CONSOLE): ${e.message.split('\n')[0]}`); }
  const status = JSON.parse(fs.readFileSync(STATUS, 'utf8'));
  const rows = [];
  for (const line of out.split('\n')) {
    // "KU-…  <KISEM app name>  <hash>  <subject>" (a long app name leaves one space before the hash)
    const m = /^(KU-\d{6}-\d{4}-([A-Z]+)(?:-\d+)?)\s+(.+?)\s+([0-9a-f]{7,})\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, code, app, kisemName, hash, subject] = m;
    if (status[code]) continue;
    const never = NEVER.find(([re]) => re.test(code) || re.test(subject));
    rows.push({ code, app, kisem: kisemName.trim(), hash, subject, ar: AR_OF[app] || '?', fix: FIX.test(subject), never: never ? never[1] : null });
  }
  return rows;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixesOnly = process.argv.includes('--fixes');
  const rows = pending();
  const open = rows.filter(r => !r.never && (!fixesOnly || r.fix));
  if (process.argv.includes('--json')) { console.log(JSON.stringify({ open, never: rows.filter(r => r.never) }, null, 1)); process.exit(0); }
  const fixes = open.filter(r => r.fix);
  console.log(`${open.length} KISEM update(s) not yet in AR, ${fixes.length} of them fixes${fixesOnly ? ' (showing fixes only)' : ''}.`);
  if (fixes.length) {
    console.log('\nIMPORTANT: fixes first (a wrong figure or a hole in KISEM is the same in AR until ported)');
    for (const r of fixes) console.log(`  ${r.code}  ${r.ar}\n      ${r.hash}  ${r.subject.slice(0, 150)}`);
  }
  const rest = open.filter(r => !r.fix);
  if (rest.length && !fixesOnly) {
    console.log('\nOther updates, by AR app:');
    const by = {};
    for (const r of rest) (by[r.ar] ||= []).push(r);
    for (const [ar, list] of Object.entries(by)) {
      console.log(`  ${ar}: ${list.length}`);
      for (const r of list) console.log(`    ${r.code}  ${r.hash}  ${r.subject.slice(0, 120)}`);
    }
  }
  const never = rows.filter(r => r.never).length;
  if (never) console.log(`\n(${never} KISEM-only update(s) left out: website, Inventory WTEA, download page, Excel exchange, logos. Record them with mark.mjs --never.)`);
}
