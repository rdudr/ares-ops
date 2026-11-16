// Brings later KISEM commits into an AR app that was already ported, one commit at a time, without
// redoing the whole port (so the AR app's own later changes stay):
//
//   node clients/kisem-port/replay.mjs <key> <commit|from..to> [...] [--dry] [--only=<regex>] [--except=<regex>]
//
// For each file a KISEM commit touched, the AR names and colours (port-app.mjs textEdits, brand-app.mjs)
// are put on both its old and its new text, and the difference is merged into the AR file
// (git merge-file). A clash is left with conflict markers and listed; nothing is committed then.
// Otherwise the result is committed in the AR app with the KISEM message and "KISEM <app> <hash>".
// "from..to" takes several KISEM commits as one change (e.g. a feature added and taken out again).
// Logos and app icons are never taken (each AR app has its own).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APPS, EXCLUDE, TEXT, textEdits, assetPaths } from './port-app.mjs';
import { COLOURS, BRAND_TEXT } from './brand-app.mjs';

const AR_APPS = 'C:/Users/risha/Desktop/process/AR Apps';
const ICONS = /^(app\/icon\.png|app\/favicon\.ico|assets\/|public\/(logo|app-icon|icon-\d+|favicon)\.png|resources\/)/;
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
const gitBuf = (cwd, ...a) => execFileSync('git', a, { cwd, maxBuffer: 1 << 28 });
const show = (cwd, rev, f) => { try { return gitBuf(cwd, 'show', `${rev}:${f}`); } catch { return null; } };
const arPath = f => f.replace(/^lib\/fox\//, 'lib/ares/').replace(/^components\/fox\//, 'components/ares/');

function arText(s, file, cfg) {
  s = textEdits(s, cfg);
  if (/\.tsx$/.test(file)) s = assetPaths(s);
  s = s.replace(/\bbg-black\b/g, 'bg-[#1c3a8a]').replace(/\bhover:bg-neutral-800\b/g, 'hover:bg-[#15307a]').replace(/#2B2644/gi, '#15233F')
    .replace(/\/brand\/(kisem|ares)-(mark|logo)\.png|\/brand\/iitgn-seal\.png/g, '/brand/ares-mark.png');
  for (const [a, b] of [...COLOURS, ...BRAND_TEXT]) s = s.replace(a, b);
  return s;
}

export function replay(key, spec, { dry = false, only = null, except = null } = {}) {
  const cfg = APPS[key];
  const dest = path.join(AR_APPS, cfg.dest);
  const [from, to] = spec.includes('..') ? spec.split('..') : [`${spec}^`, spec];
  const changes = git(cfg.src, 'diff', '--name-status', '--no-renames', from, to).split('\n').filter(Boolean).map(l => l.split('\t'));
  const out = { applied: [], conflicts: [], skipped: [], deletedChanged: [] };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
  for (const [st, f] of changes) {
    if ((only && !only.test(f)) || (except && except.test(f))) continue;
    if (EXCLUDE.test(f) || ICONS.test(f) || /^\.gitignore$|^package-lock\.json$|^README\.md$/.test(f)) { out.skipped.push(f); continue; }
    const t = arPath(f), target = path.join(dest, t);
    const text = TEXT.test(path.basename(f));
    const oldB = show(cfg.src, from, f), newB = show(cfg.src, to, f);
    if (!text) {
      if (dry) { out.applied.push(`${st} ${t}`); continue; }
      if (newB) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, newB); } else fs.rmSync(target, { force: true });
      out.applied.push(`${st} ${t}`); continue;
    }
    const lf = s => s.replace(/\r\n/g, '\n'); // checkouts may have CRLF (core.autocrlf)
    const o = oldB ? arText(lf(oldB.toString('utf8')), f, cfg) : '';
    const n = newB ? arText(lf(newB.toString('utf8')), f, cfg) : null;
    const ours = fs.existsSync(target) ? lf(fs.readFileSync(target, 'utf8')) : null;
    if (n === null) { // deleted in KISEM
      if (ours === null) continue;
      if (ours === o) { if (!dry) fs.rmSync(target); out.applied.push(`D ${t}`); } else out.deletedChanged.push(t);
      continue;
    }
    if (ours === null) { if (!dry) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, n); } out.applied.push(`A ${t}`); continue; }
    const [a, b, c] = ['ours', 'base', 'theirs'].map(x => path.join(tmp, x));
    fs.writeFileSync(a, ours); fs.writeFileSync(b, o); fs.writeFileSync(c, n);
    let merged, clash = 0;
    try { merged = execFileSync('git', ['merge-file', '-p', '-L', 'AR', '-L', 'KISEM-before', '-L', 'KISEM', a, b, c], { encoding: 'utf8', maxBuffer: 1 << 28 }); }
    catch (e) { merged = e.stdout; clash = e.status; }
    if (!dry) fs.writeFileSync(target, merged);
    (clash ? out.conflicts : out.applied).push(`${st} ${t}${clash ? ` (${clash})` : ''}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return out;
}

export function commitReplay(key, spec) {
  const cfg = APPS[key];
  const dest = path.join(AR_APPS, cfg.dest);
  const to = spec.includes('..') ? spec.split('..')[1] : spec;
  let msg = textEdits(git(cfg.src, 'log', '-1', '--format=%B', to).replace(/\n*Co-Authored-By:.*$/gim, '').trim(), cfg);
  git(dest, 'add', '-A');
  if (!git(dest, 'status', '--porcelain').trim()) return false;
  git(dest, 'commit', '-q', '-m', `${msg}\n\nKISEM ${path.basename(cfg.src)} ${spec}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('replay.mjs')) {
  const [key, ...rest] = process.argv.slice(2);
  const dry = rest.includes('--dry');
  const opt = n => { const a = rest.find(x => x.startsWith(`--${n}=`)); return a ? new RegExp(a.slice(n.length + 3)) : null; };
  const only = opt('only'), except = opt('except');
  for (const spec of rest.filter(x => !x.startsWith('--'))) {
    const r = replay(key, spec, { dry, only, except });
    console.log(`== ${spec}: ${r.applied.length} merged, ${r.conflicts.length} conflicts, ${r.skipped.length} skipped`);
    for (const k of ['conflicts', 'deletedChanged']) if (r[k].length) console.log(`   ${k}: ${r[k].join(', ')}`);
    if (dry) { console.log('   ' + r.applied.join('\n   ')); continue; }
    if (r.conflicts.length || r.deletedChanged.length) { console.log('   stopped: resolve, then commit by hand'); process.exit(2); }
    console.log(commitReplay(key, spec) ? '   committed' : '   nothing changed');
  }
}
