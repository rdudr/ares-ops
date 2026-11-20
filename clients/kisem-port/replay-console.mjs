// Merges one FOX Console commit into ares-ops by 3-way merge, KISEM names turned into AR's (nothing committed).
//   node clients/kisem-port/replay-console.mjs <commit|from..to> [--only=<regex>] [--except=<regex>]
// Run ONE commit at a time and settle every clash (<<<<<<< AR ... >>>>>>> KISEM) before the next:
// a second merge over a file that still has clash markers drags KISEM-only code (inventory) along.
// Leave out KISEM-only parts with --except (e.g. '^docs/|^test/|inventory|site-data').
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const AR = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', '..');
const FOX = process.env.FOX_CONSOLE || path.resolve(AR, '..', 'fox-console');
const [spec, ...rest] = process.argv.slice(2);
const opt = n => { const a = rest.find(x => x.startsWith(`--${n}=`)); return a ? new RegExp(a.slice(n.length + 3)) : null; };
const only = opt('only'), except = opt('except');
const git = (...a) => execFileSync('git', a, { cwd: FOX, encoding: 'utf8', maxBuffer: 1 << 28 });
const show = (rev, f) => { try { return git('show', `${rev}:${f}`); } catch { return null; } };
const lf = s => s.replace(/\r\n/g, '\n');
// KISEM names in comments and messages -> AR's.
const ar = s => s.replace(/FOX Console/g, 'ARES Console').replace(/\bPostMan\b/g, 'Report Studio')
  .replace(/console\.foxauditiitgn\.com/g, 'ops.arenergyservices.in').replace(/\bKISEM\b/g, 'AR');
const [from, to] = spec.includes('..') ? spec.split('..') : [`${spec}^`, spec];
const files = git('diff', '--name-status', '--no-renames', from, to).trim().split('\n').map(l => l.split('\t'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-'));
for (const [st, f] of files) {
  if ((only && !only.test(f)) || (except && except.test(f))) continue;
  const target = path.join(AR, f);
  const o = show(from, f), n = show(to, f);
  const ours = fs.existsSync(target) ? lf(fs.readFileSync(target, 'utf8')) : null;
  if (n === null) { console.log(`  deleted in KISEM (left alone): ${f}`); continue; }
  if (ours === null) { if (st === 'A') { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, ar(lf(n))); console.log(`A ${f}`); } else console.log(`  not in AR (left alone): ${f}`); continue; }
  const [a, b, c] = ['ours', 'base', 'theirs'].map(x => path.join(tmp, x));
  fs.writeFileSync(a, ours); fs.writeFileSync(b, ar(lf(o || ''))); fs.writeFileSync(c, ar(lf(n)));
  let merged, clash = 0;
  try { merged = execFileSync('git', ['merge-file', '-p', '-L', 'AR', '-L', 'KISEM-before', '-L', 'KISEM', a, b, c], { encoding: 'utf8', maxBuffer: 1 << 28 }); }
  catch (e) { merged = e.stdout; clash = e.status; }
  fs.writeFileSync(target, merged);
  console.log(`${clash ? 'CONFLICT' : 'M'} ${f}${clash ? ` (${clash})` : ''}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
