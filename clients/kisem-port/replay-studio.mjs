// Replays one PostMan (KISEM) commit into Report Studio: report_studio_ares, branch report-studio-web, folder postman/.
//   node clients/kisem-port/replay-studio.mjs <commit>      (working tree only: settle clashes, then commit there)
// KISEM names become AR's (app names, Console, addresses). Never taken: src/vendor/feeds.js (rebuild it with
// npm run feeds from the AR apps), docs, pictures. Leave out Inventory WTEA parts (walkthrough chapter, inv_ kinds).
// Report Studio's repo takes no AI attribution in its commits.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const BASE = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', '..', '..');
const PM = process.env.POSTMAN || path.join(BASE, 'PostMan-KISEM'), RS = process.env.REPORT_STUDIO || path.join(BASE, 'report_studio_ares');
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
const show = (rev, f) => { try { return g(PM, 'show', `${rev}:${f}`).replace(/\r\n/g, '\n'); } catch { return null; } };
const ar = s => s.replace(/FOX Console/g, 'ARES Console').replace(/\bPostMan\b/g, 'Report Studio').replace(/\bKISEM\b/g, 'AR')
  .replace(/console\.foxauditiitgn\.com/g, 'ops.arenergyservices.in').replace(/foxauditiitgn\.com/g, 'arenergyservices.in')
  .replace(/AC, AHU & Chiller/g, 'Cool Zone').replace(/A-CMP/g, 'Air Findings').replace(/Thermo-X|THERMO-X/g, 'Boiler & Fuel').replace(/GridMap/g, 'BRIEF')
  .replace(/JET-Eff/g, 'Dye House').replace(/Pump EFF/g, 'Hydro Flow').replace(/Xmer-Eff/g, 'Trafo Check').replace(/AI-PQA/g, 'Grid Lens');
const c = process.argv[2];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-'));
const files = g(PM, 'diff', '--name-status', '--no-renames', `${c}^`, c).trim().split('\n').map(l => l.split('\t'));
for (const [st, f] of files) {
  const t = path.join(RS, 'postman', f);
  if (/^(src\/vendor\/feeds\.js|docs\/|test-old\/|README\.md|package-lock\.json)/.test(f) || /\.(png|jpe?g|svg|ico)$/.test(f)) { console.log(`  skip ${f}`); continue; }
  const o = show(`${c}^`, f), n = show(c, f);
  const ours = fs.existsSync(t) ? fs.readFileSync(t, 'utf8').replace(/\r\n/g, '\n') : null;
  if (n === null) { if (ours !== null && ours === ar(o || '')) { fs.rmSync(t); console.log(`D ${f}`); } else console.log(`  deleted in KISEM, kept: ${f}`); continue; }
  if (ours === null) { fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, ar(n)); console.log(`A ${f}`); continue; }
  fs.writeFileSync(tmp + '/a', ours); fs.writeFileSync(tmp + '/b', ar(o || '')); fs.writeFileSync(tmp + '/c', ar(n));
  let out, clash = 0;
  try { out = execFileSync('git', ['merge-file', '-p', '-L', 'AR', '-L', 'KISEM-before', '-L', 'KISEM', tmp + '/a', tmp + '/b', tmp + '/c'], { encoding: 'utf8', maxBuffer: 1 << 28 }); }
  catch (e) { out = e.stdout; clash = e.status; }
  fs.writeFileSync(t, out);
  console.log(`${clash ? 'CONFLICT' : 'M'} ${f}${clash ? ` (${clash})` : ''}`);
}
