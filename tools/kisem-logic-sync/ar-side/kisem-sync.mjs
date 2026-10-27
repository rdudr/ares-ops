#!/usr/bin/env node
// Copies the KISEM calculation files an AR app is built on, and reports page/graph changes that
// need porting by hand. Driven by kisem-logic.lock.json in the AR app repo root.
//
//   node scripts/kisem-sync.mjs            # update files + lock, write the report
//   node scripts/kisem-sync.mjs --check    # only report what changed; write nothing
//
// Reads GitHub with KISEM_READ_TOKEN (or GITHUB_TOKEN) so private KISEM repos work too.
// Copied files are kept byte-for-byte identical to KISEM, so the formulas can never drift.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCK = 'kisem-logic.lock.json';
const check = process.argv.includes('--check');
const token = process.env.KISEM_READ_TOKEN || process.env.GITHUB_TOKEN || '';

const gh = async (url, accept = 'application/vnd.github+json') => {
  const res = await fetch(`https://api.github.com${url}`, {
    headers: { Accept: accept, 'User-Agent': 'kisem-logic-sync', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`GitHub ${url}: HTTP ${res.status}${res.status === 404 ? ' (private repo? set KISEM_READ_TOKEN)' : ''}`);
  return accept.includes('raw') ? Buffer.from(await res.arrayBuffer()) : res.json();
};
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const toRegex = g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');

const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
const report = [];
let changedAny = false;

for (const src of lock.sources) {
  const branch = src.branch || 'main';
  const head = (await gh(`/repos/${src.repo}/commits/${branch}`)).sha;
  if (head === src.synced_commit) continue;
  src.files ||= {};
  const copied = [];
  for (const { from, to } of src.copy || []) {
    const body = await gh(`/repos/${src.repo}/contents/${from.split('/').map(encodeURIComponent).join('/')}?ref=${head}`, 'application/vnd.github.raw');
    const hash = sha256(body);
    const dest = to || path.posix.join('vendor/kisem', src.repo.split('/')[1], from);
    if (hash !== src.files[from] || !fs.existsSync(dest)) {
      copied.push(from);
      if (!check) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, body);
      }
    }
    src.files[from] = hash;
  }
  let review = [];
  if (src.synced_commit) {
    const cmp = await gh(`/repos/${src.repo}/compare/${src.synced_commit}...${head}`);
    const watch = (src.watch || []).map(toRegex);
    const copiedNames = new Set((src.copy || []).map(c => c.from));
    review = (cmp.files || []).map(f => f.filename).filter(f => !copiedNames.has(f) && watch.some(r => r.test(f)));
  }
  const old = src.synced_commit;
  src.synced_commit = head;
  if (!copied.length && !review.length) continue;
  changedAny = true;
  report.push(`### ${src.repo} → ${head.slice(0, 7)}`, '',
    old ? `Changes: https://github.com/${src.repo}/compare/${old}...${head}` : `First sync at https://github.com/${src.repo}/commit/${head}`, '',
    copied.length ? `**Calculation files copied (identical to KISEM):**\n${copied.map(f => `- \`${f}\``).join('\n')}\n` : '',
    review.length ? `**Port by hand — pages / graphs with logic inside the UI (AR keeps its own names, logos and design):**\n${review.map(f => `- [ ] \`${f}\` — https://github.com/${src.repo}/blob/${head}/${f}`).join('\n')}\n` : '');
}

const text = changedAny
  ? ['## KISEM logic update', '', 'Review the calculation changes, run the AR app\'s tests, then merge.', '', ...report].join('\n')
  : 'No KISEM logic changes since the last sync.';
console.log(text);
if (!check) fs.writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n');
const out = process.env.RUNNER_TEMP || os.tmpdir();
fs.writeFileSync(path.join(out, 'kisem-sync-report.md'), text);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changedAny && !check}\nreport=${path.join(out, 'kisem-sync-report.md')}\n`);
