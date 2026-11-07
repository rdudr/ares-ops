// End-to-end check of the Console and the sync API, on a throwaway in-memory database.
// Run: npm test
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import * as LC from '../public/ledger-calc.js';
import { checkCea, latestOnPage } from '../lib/cea.js';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { openDb, tx } from '../lib/db.js';
import { createDemoAudit } from '../lib/demo.js';
import { createDemoLedger } from '../lib/demo-ledger.js';
import { createServer } from '../server.js';

const db = openDb(':memory:');
const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ares-test-files-'));
const { server, setupCode } = createServer(db, { filesDir });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };

// Console client: keeps the session cookie, sends the same-origin header.
function consoleClient() {
  let cookie = '';
  const client = async (method, path, body, extra = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-ARES': '1', Cookie: cookie, ...extra },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  client.cookie = () => cookie; // for raw downloads (the ZIP export)
  return client;
}

// Field app client: bearer token.
function appClient(token) {
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
}
const appLogin = async (login_id, password, app) => {
  const res = await fetch(base + '/api/device/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login_id, password, app, device_id: `phone-${login_id}` }),
  });
  return { status: res.status, data: await res.json() };
};

const admin = consoleClient();
const ADMIN_PW = 'Admin-pass-2026';
let auditId, p1, p2, cardmember;

await step('setup needs the code printed by the server', async () => {
  assert.equal((await admin('POST', '/api/setup', { code: 'WRONG', name: 'Axita', login_id: 'axita', password: ADMIN_PW })).status, 403);
  assert.equal((await admin('POST', '/api/setup', { code: setupCode, name: 'Axita Patel', login_id: 'axita', password: ADMIN_PW })).status, 200);
  assert.equal((await admin('POST', '/api/setup', { code: setupCode, name: 'X', login_id: 'xx', password: ADMIN_PW })).status, 403);
});

await step('console rejects requests without the same-origin header', async () => {
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
});

await step('admin logs in; wrong password is refused', async () => {
  assert.equal((await admin('POST', '/api/login', { login_id: 'axita', password: 'nope' })).status, 401);
  const r = await admin('POST', '/api/login', { login_id: 'axita', password: ADMIN_PW });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'super_admin');
});

await step('admin creates an audit with a system-generated industry tag', async () => {
  const r = await admin('POST', '/api/audits', { client_name: 'Shree Textiles', sector: 'TX', site_name: 'Unit 1', cluster: 'srt', fy: 'FY2026-27', title: 'Detailed energy audit' });
  assert.equal(r.status, 200);
  auditId = r.data.id;
  assert.equal(auditId, 'AU-2627-0001');
  const list = await admin('GET', '/api/audits');
  assert.equal(list.data.audits[0].industry_tag, 'TX-SRT-001');
});

await step('admin adds two freelancers with access to chosen apps only', async () => {
  const a = await admin('POST', '/api/users', { name: 'Freelancer One', login_id: 'fl.one', employment: 'freelancer', apps: ['air', 'pump'], audits: [auditId] });
  const b = await admin('POST', '/api/users', { name: 'Freelancer Two', login_id: 'fl.two', employment: 'freelancer', apps: ['air'], audits: [auditId] });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.ok(a.data.temp_password.length >= 10);
  p1 = { id: a.data.user.id, pw: a.data.temp_password };
  p2 = { id: b.data.user.id, pw: b.data.temp_password };
  const bad = await admin('POST', '/api/users', { name: 'X', login_id: 'fl.x', employment: 'freelancer', role: 'head' });
  assert.equal(bad.status, 400);
});

await step('a freelancer cannot open the admin console', async () => {
  const c = consoleClient();
  assert.equal((await c('POST', '/api/login', { login_id: 'fl.one', password: p1.pw })).status, 403);
});

await step('same login works in every granted app, refused in others', async () => {
  assert.equal((await appLogin('fl.two', p2.pw, 'pump')).status, 403);
  assert.equal((await appLogin('fl.one', p1.pw, 'pump')).status, 200);
  assert.equal((await appLogin('fl.two', p2.pw, 'nope')).status, 400); // unknown apps are refused
});

await step('first login must change the temporary password before syncing', async () => {
  const l = await appLogin('fl.one', p1.pw, 'air');
  const app = appClient(l.data.token);
  assert.equal((await app('POST', '/api/sync', { records: [] })).data.code, 'password_change_required');
  assert.equal((await app('POST', '/api/device/change-password', { current: p1.pw, next: 'short' })).status, 400);
  assert.equal((await app('POST', '/api/device/change-password', { current: p1.pw, next: 'Field-one-2026' })).status, 200);
  p1.pw = 'Field-one-2026';
  const l2 = await appLogin('fl.two', p2.pw, 'air');
  await appClient(l2.data.token)('POST', '/api/device/change-password', { current: p2.pw, next: 'Field-two-2026' });
  p2.pw = 'Field-two-2026';
});

const rec = (tag, takenAt, extra = {}) => ({
  id: crypto.randomUUID(), audit_id: auditId, kind: 'compressor', tag,
  taken_at: takenAt, saved_at: takenAt, payload: { tag, kw: 37, ...extra },
});

let one, two, oneSince = 0, twoSince = 0, firstRecord;
await step('person 1 collected offline; on reconnect the queue syncs to the cloud', async () => {
  one = appClient((await appLogin('fl.one', p1.pw, 'air')).data.token);
  firstRecord = rec('C-01', Date.now() - 3 * 3600000);
  const r = await one('POST', '/api/sync', {
    since: oneSince,
    records: [firstRecord, rec('C-02', Date.now() - 2 * 3600000)],
    sessions: [{ id: crypto.randomUUID(), audit_id: auditId, started_at: Date.now() - 3 * 3600000, ended_at: Date.now() - 3600000, records: 2 }],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.results.map(x => x.status), ['stored', 'stored']);
  oneSince = r.data.next_since;
});

await step('person 2 syncs and now sees person 1\'s data', async () => {
  two = appClient((await appLogin('fl.two', p2.pw, 'air')).data.token);
  const r = await two('POST', '/api/sync', { since: twoSince, records: [rec('C-03', Date.now() - 1800000)] });
  assert.equal(r.status, 200);
  const tags = r.data.records.map(x => x.tag).sort();
  assert.deepEqual(tags, ['C-01', 'C-02', 'C-03']);
  assert.equal(r.data.records.find(x => x.tag === 'C-01').recorded_by, 'Freelancer One');
  twoSince = r.data.next_since;
});

await step('person 1 then pulls person 2\'s record', async () => {
  const r = await one('POST', '/api/sync', { since: oneSince });
  assert.deepEqual(r.data.records.map(x => x.tag), ['C-03']);
  oneSince = r.data.next_since;
});

await step('duplicate tag is refused with the name of who recorded it', async () => {
  const r = await two('POST', '/api/sync', { since: twoSince, records: [rec('c-01', Date.now())] });
  assert.equal(r.data.results[0].status, 'refused');
  assert.match(r.data.results[0].reason, /Freelancer One/);
});

await step('newer edit wins; an older edit comes back as a conflict, never silently dropped', async () => {
  const edited = { ...firstRecord, saved_at: Date.now(), payload: { tag: 'C-01', kw: 45 } };
  const r = await two('POST', '/api/sync', { since: twoSince, records: [edited] });
  assert.equal(r.data.results[0].status, 'updated');
  const stale = await one('POST', '/api/sync', { since: oneSince, records: [{ ...firstRecord, saved_at: firstRecord.saved_at + 1, payload: { tag: 'C-01', kw: 40 } }] });
  assert.equal(stale.data.results[0].status, 'conflict');
  assert.equal(stale.data.results[0].server.payload.kw, 45);
  assert.match(stale.data.results[0].reason, /Freelancer Two/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM record_versions').get().n, 1);
  // Sending exactly what the server has (a retry) is not a conflict.
  assert.equal((await two('POST', '/api/sync', { records: [edited] })).data.results[0].status, 'unchanged');
});

await step('base_version: an edit made from the current version is accepted, a stale one is a conflict', async () => {
  const ok = await one('POST', '/api/sync', { records: [{ ...firstRecord, base_version: 2, saved_at: Date.now() - 60000, payload: { tag: 'C-01', kw: 50 } }] });
  assert.equal(ok.data.results[0].status, 'updated'); // accepted even though its clock is earlier
  const late = await two('POST', '/api/sync', { records: [{ ...firstRecord, base_version: 2, saved_at: Date.now(), payload: { tag: 'C-01', kw: 55 } }] });
  assert.equal(late.data.results[0].status, 'conflict');
});

await step('a phone clock far ahead is refused instead of winning every conflict', async () => {
  const r = await two('POST', '/api/sync', { records: [rec('C-20', Date.now() + 3 * 3600000)] });
  assert.equal(r.data.results[0].status, 'refused');
  assert.match(r.data.results[0].reason, /clock/);
});

await step('tags are stored with their spacing tidied', async () => {
  const r = await one('POST', '/api/sync', { records: [rec('  C   30 ', Date.now() - 1000)] });
  assert.equal(r.data.results[0].status, 'stored');
  assert.equal(db.prepare("SELECT tag FROM records WHERE tag LIKE 'C%30'").get().tag, 'C 30');
  assert.equal((await two('POST', '/api/sync', { records: [rec('c 30', Date.now() - 1000)] })).data.results[0].status, 'refused');
});

let auditB;
await step('someone added to an audit later also receives its older records (back-fill)', async () => {
  auditB = (await admin('POST', '/api/audits', { client_name: 'Second Client', sector: 'CH', site_name: 'Plant B', cluster: 'ANK', fy: 'FY2026-27', title: 'Air study' })).data.id;
  await admin('POST', `/api/audits/${auditB}/assign`, { user_id: p1.id, assign: true });
  const old = { ...rec('B-01', Date.now() - 7200000), audit_id: auditB };
  assert.equal((await one('POST', '/api/sync', { records: [old] })).data.results[0].status, 'stored');
  const before = await two('POST', '/api/sync', { since: twoSince });
  assert.ok(!before.data.records.some(x => x.tag === 'B-01'));
  twoSince = before.data.next_since;
  await new Promise(r => setTimeout(r, 5));
  await admin('POST', `/api/audits/${auditB}/assign`, { user_id: p2.id, assign: true });
  const after = await two('POST', '/api/sync', { since: twoSince });
  assert.ok(after.data.records.some(x => x.tag === 'B-01'));
  assert.deepEqual(after.data.backfilled_audits, [auditB]);
  twoSince = after.data.next_since;
});

await step('a published audit refuses new data', async () => {
  await admin('POST', `/api/audits/${auditB}/status`, { status: 'published' });
  const r = await one('POST', '/api/sync', { records: [{ ...rec('B-02', Date.now()), audit_id: auditB }] });
  assert.equal(r.data.results[0].status, 'refused');
  assert.match(r.data.results[0].reason, /closed/);
});

// A tiny valid PNG (1x1 pixel).
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const putChunk = (token, id, offset, bytes) => fetch(`${base}/api/files/${id}/content?offset=${offset}`, {
  method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: bytes,
}).then(async r => ({ status: r.status, data: await r.json() }));
let oneToken, fileId;

await step('photos upload in chunks, resume, and are checked on arrival', async () => {
  oneToken = (await appLogin('fl.one', p1.pw, 'air')).data.token;
  one = appClient(oneToken);
  fileId = crypto.randomUUID();
  const meta = { id: fileId, audit_id: auditId, kind: 'thermal', equipment_tag: 'C-01', pair_id: 'pair-1', caption: 'Compressor C-01 motor, hot spot on terminal box', mime: 'image/png', size: PNG.length, sha256: sha(PNG), taken_at: Date.now() };
  const init = await one('POST', '/api/files', meta);
  assert.equal(init.status, 200);
  assert.equal(init.data.file.status, 'uploading');
  assert.equal((await putChunk(oneToken, fileId, 0, PNG.subarray(0, 30))).data.file.received, 30);
  assert.equal((await putChunk(oneToken, fileId, 0, PNG.subarray(0, 30))).status, 409); // wrong offset: resume point is reported
  assert.equal((await one('POST', '/api/files', meta)).data.file.received, 30); // re-announcing resumes
  const done = await putChunk(oneToken, fileId, 30, PNG.subarray(30));
  assert.equal(done.data.file.status, 'ready');
  // A text file disguised as a PNG is rejected.
  const fake = Buffer.from('not really an image at all');
  const fid = crypto.randomUUID();
  await one('POST', '/api/files', { ...meta, id: fid, size: fake.length, sha256: sha(fake) });
  assert.equal((await putChunk(oneToken, fid, 0, fake)).status, 422);
  assert.equal((await one('POST', '/api/files', { ...meta, id: crypto.randomUUID(), mime: 'application/x-msdownload' })).status, 415);
});

await step('a teammate on the audit can download the photo; other apps and outsiders cannot', async () => {
  const twoToken = (await appLogin('fl.two', p2.pw, 'air')).data.token;
  two = appClient(twoToken);
  const res = await fetch(`${base}/api/files/${fileId}`, { headers: { Authorization: `Bearer ${twoToken}` } });
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  const pumpToken = (await appLogin('fl.one', p1.pw, 'pump')).data.token;
  assert.equal((await fetch(`${base}/api/files/${fileId}`, { headers: { Authorization: `Bearer ${pumpToken}` } })).status, 404);
  assert.equal((await fetch(`${base}/api/files/${fileId}`)).status, 401);
});

await step('read API returns an audit\'s records per app and its files', async () => {
  const r = await admin('GET', `/api/audits/${auditId}/data`);
  assert.equal(r.data.audit.synthetic, false, 'audits say whether they are demo data (report connector gate)');
  assert.equal(r.status, 200);
  assert.equal(r.data.schema, 'ares.audit-data/v0');
  assert.equal(r.data.audit.industry_tag, 'TX-SRT-001');
  assert.equal(r.data.audit.client_name, 'Shree Textiles');
  assert.ok(r.data.apps.air.length >= 3);
  assert.equal(r.data.files[0].caption, 'Compressor C-01 motor, hot spot on terminal box');
  const viaApp = await two('GET', `/api/audits/${auditId}/data`);
  assert.equal(viaApp.data.audit.client_name, undefined); // client names only for managers
  assert.deepEqual(Object.keys(viaApp.data.apps), ['air']);
});

await step('dashboard shows hours, records and records per hour per person', async () => {
  const r = await admin('GET', '/api/dashboard?days=30');
  const p = r.data.people.find(x => x.login_id === 'fl.one');
  assert.equal(p.records, 4); // C-01, C-02, C 30 and B-01
  assert.equal(p.hours, 2);
  assert.equal(p.records_per_hour, 2);
});

await step('putting a person on hold blocks them at once, even mid-session', async () => {
  await admin('POST', `/api/users/${p2.id}/status`, { status: 'hold' });
  const r = await two('POST', '/api/sync', { since: twoSince, records: [rec('C-09', Date.now())] });
  assert.equal(r.data.code, 'status_hold');
  assert.equal((await two('POST', '/api/sync', {})).status, 401); // and the session is gone
  const l = await appLogin('fl.two', p2.pw, 'air');
  assert.equal(l.data.code, 'status_hold');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM records WHERE tag = 'C-09'").get().n, 0);
});

await step('removing one app keeps the others working', async () => {
  const pump = appClient((await appLogin('fl.one', p1.pw, 'pump')).data.token);
  await admin('POST', `/api/users/${p1.id}/apps`, { app: 'air', grant: false });
  assert.equal((await one('POST', '/api/sync', { since: oneSince })).data.code, 'app_revoked');
  assert.equal((await appLogin('fl.one', p1.pw, 'air')).data.code, 'no_app_access');
  assert.equal((await pump('GET', '/api/device/me')).status, 200);
});

await step('reactivating restores access', async () => {
  await admin('POST', `/api/users/${p2.id}/status`, { status: 'active' });
  assert.equal((await appLogin('fl.two', p2.pw, 'air')).status, 200);
});

await step('five wrong passwords lock that address out; an admin can unlock', async () => {
  for (let i = 0; i < 5; i++) await appLogin('fl.two', 'wrong-pass-1', 'air');
  assert.equal((await appLogin('fl.two', p2.pw, 'air')).status, 423);
  const list = await admin('GET', '/api/users');
  assert.equal(list.data.users.find(u => u.login_id === 'fl.two').locked, true);
  assert.equal((await admin('POST', `/api/users/${p2.id}/unlock`)).status, 200);
  assert.equal((await appLogin('fl.two', p2.pw, 'air')).status, 200);
});

await step('a mistyped password in the Login ID box is not written to the log', async () => {
  await appLogin('My-Secret-Pass-99', 'x', 'air');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity WHERE target LIKE '%Secret%' OR detail LIKE '%Secret%'").get().n, 0);
});

await step('automatic refreshes do not keep an idle Console session alive', async () => {
  const before = db.prepare("SELECT last_seen_at FROM sessions WHERE kind = 'web'").get().last_seen_at;
  await new Promise(r => setTimeout(r, 15));
  await admin('GET', '/api/dashboard', null, { 'X-ARES-Background': '1' });
  assert.equal(db.prepare("SELECT last_seen_at FROM sessions WHERE kind = 'web'").get().last_seen_at, before);
  await admin('GET', '/api/dashboard');
  assert.ok(db.prepare("SELECT last_seen_at FROM sessions WHERE kind = 'web'").get().last_seen_at > before);
});

await step('dashboard merges overlapping sessions and does not count an idle open session', async () => {
  const fresh = appClient((await appLogin('fl.two', p2.pw, 'air')).data.token);
  const t = Date.now() - 4 * 3600000;
  await fresh('POST', '/api/sync', { sessions: [
    { id: crypto.randomUUID(), audit_id: auditId, started_at: t, ended_at: t + 3600000, records: 0 },
    { id: crypto.randomUUID(), audit_id: auditId, started_at: t + 1800000, ended_at: t + 5400000, records: 0 }, // overlaps
    { id: 'stale-session-0001', audit_id: auditId, started_at: Date.now() - 1200000, ended_at: null, records: 0 }, // open, nothing saved since
  ] });
  // The phone went silent (app killed): it last reported right when the session started.
  db.prepare("UPDATE work_sessions SET last_seen_at = started_at WHERE id = 'stale-session-0001'").run();
  const r = await admin('GET', '/api/dashboard?days=30');
  assert.equal(r.data.people.find(x => x.login_id === 'fl.two').hours, 1.5);
  assert.ok(!r.data.working_now.some(w => w.name === 'Freelancer Two'));
});

await step('an open session the phone keeps reporting shows as working now', async () => {
  const live = appClient((await appLogin('fl.two', p2.pw, 'air')).data.token);
  await live('POST', '/api/sync', { sessions: [{ id: crypto.randomUUID(), audit_id: auditId, started_at: Date.now() - 1800000, ended_at: null, records: 0 }] });
  const r = await admin('GET', '/api/dashboard?days=30');
  assert.ok(r.data.working_now.some(w => w.name === 'Freelancer Two'));
  assert.equal(r.data.people.find(x => x.login_id === 'fl.two').hours, 2); // 1.5 h + the live 0.5 h
});

await step('a malformed request gets an error instead of crashing the server', async () => {
  await new Promise(resolve => {
    const sock = net.connect(server.address().port, '127.0.0.1', () => sock.end('GET http://[bad HTTP/1.1\r\nHost: x\r\n\r\n'));
    sock.on('data', () => {}).on('close', resolve).on('error', resolve);
  });
  assert.equal((await fetch(base + '/api/setup')).status, 200);
});

await step('AR apps on allowed origins may call the app API; other sites and Console routes may not', async () => {
  const pre = (path, origin) => fetch(base + path, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } });
  const ok = await pre('/api/sync', 'https://localhost');
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://localhost');
  assert.equal((await pre('/api/device/login', 'https://pump.arenergyservices.in')).headers.get('access-control-allow-origin'), 'https://pump.arenergyservices.in');
  assert.equal((await pre('/api/sync', 'https://evil.example')).headers.get('access-control-allow-origin'), null);
  assert.equal((await pre('/api/sync', 'https://arenergyservices.in.evil.example')).headers.get('access-control-allow-origin'), null);
  assert.equal((await pre('/api/device/login', 'https://x.evil.arenergyservices.in')).headers.get('access-control-allow-origin'), null);
  assert.equal((await pre('/api/users', 'https://localhost')).headers.get('access-control-allow-origin'), null);
  // Report Studio (report.arenergyservices.in) also reads the AI bill reader and the team cards from its own address.
  for (const p of ['/api/ai/status', '/api/ai/bill-read', '/api/team-cards'])
    assert.equal((await pre(p, 'https://report.arenergyservices.in')).headers.get('access-control-allow-origin'), 'https://report.arenergyservices.in', p);
  assert.equal((await pre('/api/ai/bill-read', 'https://evil.example')).headers.get('access-control-allow-origin'), null);
});

await step('plant details saved in one app are offered to other apps on the same audit', async () => {
  const pumpApp = appClient((await appLogin('fl.one', p1.pw, 'pump')).data.token);
  const now = Date.now();
  await pumpApp('POST', '/api/sync', { records: [{ id: `company-${auditId}`, audit_id: auditId, kind: 'company_profile', tag: null, taken_at: now, saved_at: now,
    payload: { id: 'x', companyName: 'Shree Textiles', area: 'Sachin GIDC', district: 'Surat', state: 'Gujarat', pincode: '394230', updatedAt: new Date(now).toISOString() } }] });
  const other = appClient((await appLogin('fl.two', p2.pw, 'air')).data.token);
  const r = await other('GET', `/api/device/company-profiles?audit_id=${auditId}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.site.client_name, 'Shree Textiles');
  const pump = r.data.profiles.find(p => p.app === 'pump');
  assert.equal(pump.profile.district, 'Surat');
  assert.equal(pump.saved_by, 'Freelancer One');
  assert.equal((await other('GET', '/api/device/company-profiles?audit_id=AU-9999-0001')).status, 404);
});

await step('company and plant details are kept once and every app reads them, logo included', async () => {
  // A bad pincode or an unknown state is refused; the good details are stored.
  assert.equal((await admin('POST', `/api/audits/${auditId}/details`, { pincode: '12345' })).status, 400);
  assert.equal((await admin('POST', `/api/audits/${auditId}/details`, { state: 'Atlantis' })).status, 400);
  const ok = await admin('POST', `/api/audits/${auditId}/details`, { district: 'Surat', state: 'gujarat', pincode: '394230',
    contract_demand_kva: '450', msme_no: 'udyam-gj-22-0001234', work_type: 'detailed', site_name: 'Unit 1' });
  assert.equal(ok.status, 200);
  const air = appClient((await appLogin('fl.two', p2.pw, 'air')).data.token);
  const p = (await air('GET', `/api/device/audit-profile?audit_id=${auditId}`)).data.profile;
  assert.equal(p.company_name, 'Shree Textiles');
  assert.equal(p.plant_name, 'Unit 1');
  assert.equal(p.state, 'Gujarat');
  assert.equal(p.contract_demand_kva, 450);
  assert.equal(p.msme_no, 'UDYAM-GJ-22-0001234');
  assert.equal(p.work_type_name, 'Detailed energy audit');
  assert.equal((await air('GET', '/api/device/audit-profile?audit_id=AU-9999-0001')).status, 404);
  // The logo, uploaded from one app, is shown by another app and listed with the audit.
  const pump = appClient((await appLogin('fl.one', p1.pw, 'pump')).data.token);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
  const sha = crypto.createHash('sha256').update(png).digest('hex');
  const id = crypto.randomUUID();
  await pump('POST', '/api/files', { id, audit_id: auditId, kind: 'logo', caption: 'Company logo', mime: 'image/png', size: png.length, sha256: sha });
  await fetch(`${base}/api/files/${id}/content?offset=0`, { method: 'PUT', headers: { Authorization: `Bearer ${(await appLogin('fl.one', p1.pw, 'pump')).data.token}`, 'Content-Type': 'application/octet-stream' }, body: png });
  const airToken = (await appLogin('fl.two', p2.pw, 'air')).data.token;
  assert.equal((await fetch(`${base}/api/files/${id}`, { headers: { Authorization: `Bearer ${airToken}` } })).status, 200);
  const mine = (await air('GET', '/api/device/me')).data.audits.find(a => a.id === auditId);
  assert.equal(mine.logo_file_id, id);
});

await step('a photo is stored with its record, field, tag and where it was taken, in either order', async () => {
  const tok = (await appLogin('fl.one', p1.pw, 'pump')).data.token;
  const app = appClient(tok);
  const now = Date.now();
  const upload = async (id, extra = {}) => {
    await app('POST', '/api/files', { id, audit_id: auditId, kind: 'photo', caption: 'Pump nameplate', mime: 'image/png', size: PNG.length,
      sha256: sha(PNG), taken_at: now, lat: 21.1702, lng: 72.8311, accuracy_m: 12.4, captured_in: '/transit', ...extra });
    await putChunk(tok, id, 0, PNG);
  };
  // Photo first, record after.
  const p1id = crypto.randomUUID();
  await upload(p1id);
  await app('POST', '/api/sync', { records: [{ id: 'pump-photo-1', audit_id: auditId, kind: 'pump_test', tag: 'P-07', taken_at: now, saved_at: now,
    payload: { pumpNo: 'P-07', photoPath: `ares-photo:${p1id}` } }] });
  // Record first, photo after (a list of photos).
  const p2id = crypto.randomUUID();
  await app('POST', '/api/sync', { records: [{ id: 'pump-photo-2', audit_id: auditId, kind: 'pump_test', tag: 'P-08', taken_at: now, saved_at: now,
    payload: { pumpNo: 'P-08', photos: ['ares-photo:00000000-0000-4000-8000-000000000000', `ares-photo:${p2id}`] } }] });
  await upload(p2id, { lat: 'not a number' });
  const data = await admin('GET', `/api/audits/${auditId}/data`);
  const f1 = data.data.files.find(f => f.id === p1id), f2 = data.data.files.find(f => f.id === p2id);
  assert.equal(f1.record_id, 'pump-photo-1');
  assert.equal(f1.record_kind, 'pump_test');
  assert.equal(f1.field, 'photoPath');
  assert.equal(f1.equipment_tag, 'P-07');
  assert.equal(f1.captured_in, '/transit');
  assert.equal(f1.location.accuracy_m, 12);
  assert.match(f1.location.map_url, /maps.*21\.1702,72\.8311/);
  assert.equal(f2.record_id, 'pump-photo-2');
  assert.equal(f2.field, 'photos[1]');
  assert.equal(f2.equipment_tag, 'P-08');
  assert.equal(f2.location, null); // a bad position is dropped, not stored
});

await step('an engineer starts a new audit from the app and is assigned to it', async () => {
  const login = await appLogin('fl.two', p2.pw, 'air');
  const app = appClient(login.data.token);
  const opts = await app('GET', '/api/device/audit-options');
  assert.equal(opts.status, 200);
  assert.match(opts.data.fy, /^FY\d{4}-\d{2}$/);
  assert.ok(opts.data.sectors.TX);
  const body = { client_name: 'Navkar Dye House', site_name: 'Pandesara Unit', sector: 'TX', cluster: 'srt' };
  const r = await app('POST', '/api/device/audits', body);
  assert.equal(r.status, 200);
  const made = r.data.audits.find(a => a.id === r.data.audit_id);
  assert.equal(made.status, 'in_field');
  assert.match(made.industry_tag, /^TX-SRT-\d{3}$/);
  // The same company and plant again reuses them (one client, one industry tag), as a new audit.
  const again = await app('POST', '/api/device/audits', { ...body, client_name: 'navkar dye house' });
  assert.notEqual(again.data.audit_id, r.data.audit_id);
  assert.equal(again.data.audits.find(a => a.id === again.data.audit_id).industry_tag, made.industry_tag);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM clients WHERE lower(name) = 'navkar dye house'").get().n, 1);
  // It can record straight away.
  const now = Date.now();
  const s = await app('POST', '/api/sync', { since: 0, records: [{ id: `cp-${made.id}`, audit_id: made.id, kind: 'company_profile', tag: null, taken_at: now, saved_at: now, payload: { companyName: 'Navkar Dye House' } }] });
  assert.equal(s.data.results[0].status, 'stored');
  assert.equal((await app('POST', '/api/device/audits', { ...body, sector: 'XX' })).status, 400);
  const log = await admin('GET', '/api/activity?limit=200');
  assert.ok(log.data.activity.some(a => a.action === 'audit.created_in_app' && a.target === made.id));
});

await step('the Console shows each field app with its people and the data it has sent', async () => {
  const all = await admin('GET', '/api/apps');
  assert.equal(all.status, 200);
  const air = all.data.apps.find(a => a.code === 'air');
  assert.equal(air.name, 'Air Findings');
  assert.ok(air.field && air.records > 0 && air.audits > 0 && air.last_sync);
  assert.ok(air.people.some(p => p.name === 'Freelancer Two'));
  const one = await admin('GET', '/api/apps?app=air');
  assert.ok(one.data.audits.length > 0 && one.data.audits[0].kinds.length > 0);
  assert.equal(one.data.audits.reduce((n, a) => n + a.records, 0), air.records);
  assert.equal((await admin('GET', '/api/apps?app=nope')).status, 404);
  assert.equal((await fetch(base + '/api/apps')).status, 401);
});

await step('the Console edits and removes records, phones get the change; finalising locks and hides the audit; ZIP export', async () => {
  const tok = (await appLogin('fl.one', p1.pw, 'pump')).data.token;
  const app = appClient(tok);
  const now = Date.now();
  await app('POST', '/api/sync', { records: [
    { id: 'edit-record-1', audit_id: auditId, kind: 'pump_test', tag: 'P-21', taken_at: now, saved_at: now, payload: { pumpNo: 'P-21', head: 30 } },
    { id: 'remove-record-1', audit_id: auditId, kind: 'pump_test', tag: 'P-22', taken_at: now, saved_at: now, payload: { pumpNo: 'P-22', head: 28 } },
  ] });
  const since = (await app('POST', '/api/sync', { since: 0, records: [] })).data.next_since;
  assert.equal((await admin('PUT', '/api/records/edit-record-1', { payload: { pumpNo: 'P-21', head: 32 } })).status, 200);
  assert.equal((await admin('DELETE', '/api/records/remove-record-1')).status, 200);
  assert.equal((await admin('PUT', '/api/records/edit-record-1', { payload: { pumpNo: 'P-21' }, tag: 'P-07' })).status, 409); // tag already used
  const pulled = (await app('POST', '/api/sync', { since, records: [] })).data.records;
  assert.equal(pulled.find(r => r.id === 'edit-record-1').payload.head, 32);
  assert.equal(pulled.find(r => r.id === 'remove-record-1').payload._deleted, true);

  const zipRes = await fetch(`${base}/api/audits/${auditId}/export.zip`, { headers: { Cookie: admin.cookie() } });
  assert.equal(zipRes.status, 200);
  const zip = Buffer.from(await zipRes.arrayBuffer());
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const listing = zip.toString('latin1');
  assert.ok(listing.includes('Company.json') && listing.includes('Apps/Hydro Flow/pump_test.csv') && listing.includes('Files/index.csv'));

  assert.equal((await admin('POST', `/api/audits/${auditId}/finalise`, {})).status, 200);
  const me = await app('GET', '/api/device/me');
  assert.ok(!me.data.audits.some(a => a.id === auditId)); // gone from the running list
  assert.equal((await admin('PUT', '/api/records/edit-record-1', { payload: { head: 1 } })).status, 409); // locked
  const list = await admin('GET', '/api/audits');
  assert.ok(list.data.audits.find(a => a.id === auditId).finalized_at);
  assert.equal((await admin('POST', `/api/audits/${auditId}/reopen`, { note: 'Correcting a reading' })).status, 200);
  assert.ok((await app('GET', '/api/device/me')).data.audits.some(a => a.id === auditId));
});

await step('GST Billing opens only through the ARES sign-in', async () => {
  const get = (p, headers = {}) => fetch(`${base}${p}`, { redirect: 'manual', headers });
  const BILLING = { 'X-Forwarded-Host': 'billing.arenergyservices.in' };
  // Not signed in to billing: a page goes to the Console, an API call gets 401.
  let r = await get('/api/billing/check', { Accept: 'text/html', 'X-Forwarded-Uri': '/invoices' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://ops.arenergyservices.in/api/billing/sso?next=%2Finvoices');
  assert.equal((await get('/api/billing/check', { 'X-Forwarded-Uri': '/api/bills' })).status, 401);
  // Not signed in to the Console either: its sign-in, then on to billing.
  assert.equal((await get('/api/billing/sso')).headers.get('location'), '/#/billing');
  // Signed in to the Console: a one-time code, which becomes a billing session.
  r = await get('/api/billing/sso?next=%2Finvoices', { Cookie: admin.cookie() });
  const to = new URL(r.headers.get('location'));
  assert.equal(to.host, 'billing.arenergyservices.in');
  const enter = `/api/billing/enter?code=${to.searchParams.get('code')}`;
  assert.equal((await get(enter)).status, 404); // only on the billing host
  r = await get(enter, BILLING);
  assert.equal(r.headers.get('location'), '/invoices');
  const token = /ares-bills=([^;]+)/.exec(r.headers.get('set-cookie'))[1];
  assert.equal((await get('/api/billing/check', { Cookie: `ares-bills=${token}` })).status, 204);
  assert.match((await get(enter, BILLING)).headers.get('location'), /\/api\/billing\/sso$/); // code works once
  // The billing session is not a Console session, and an open redirect is refused.
  assert.equal((await get('/api/me', { Cookie: `ares=${token}` })).status, 401);
  r = await get('/api/billing/sso?next=%2F%2Fevil.example', { Cookie: admin.cookie() });
  const code2 = new URL(r.headers.get('location')).searchParams.get('code');
  assert.equal((await get(`/api/billing/enter?code=${code2}`, BILLING)).headers.get('location'), '/');
  // Signing out of billing ends that session.
  await get('/api/billing/signout', { ...BILLING, Cookie: `ares-bills=${token}` });
  assert.equal((await get('/api/billing/check', { Cookie: `ares-bills=${token}` })).status, 401);
});

await step('an Admin sees and manages only their own apps; the main Super Admin cannot be changed', async () => {
  // The owner (the setup account) adds an Admin with BRIEF only, and a second Super Admin.
  const ownerId = (await admin('GET', '/api/me')).data.user.id;
  assert.equal((await admin('GET', '/api/me')).data.user.owner, true);
  const signIn = async (login_id, temp) => {
    const c = consoleClient();
    assert.equal((await c('POST', '/api/login', { login_id, password: temp })).status, 200);
    assert.equal((await c('POST', '/api/change-password', { current: temp, next: `${login_id}-Pass-2026` })).status, 200);
    return c;
  };
  const a = await admin('POST', '/api/users', { name: 'Admin Brief', login_id: 'adm.brief', role: 'head', apps: ['survey'] });
  const s2 = await admin('POST', '/api/users', { name: 'Second Super', login_id: 'super.two', role: 'super_admin' });
  assert.equal(a.status, 200);
  assert.equal(s2.status, 200);
  const adm = await signIn('adm.brief', a.data.temp_password);
  const sup2 = await signIn('super.two', s2.data.temp_password);

  // What the Admin sees: BRIEF only, no audit without BRIEF data, nobody outside their team.
  assert.deepEqual((await adm('GET', '/api/me')).data.my_apps, ['survey']);
  assert.deepEqual((await adm('GET', '/api/apps')).data.apps.map(x => x.code), ['survey']);
  assert.equal((await adm('GET', '/api/apps?app=pump')).status, 404);
  assert.equal((await adm('GET', '/api/audits')).data.audits.length, 0);
  assert.equal((await adm('GET', `/api/audits/${auditId}/data`)).status, 404);
  assert.equal((await fetch(`${base}/api/audits/${auditId}/export.zip`, { headers: { Cookie: adm.cookie() } })).status, 404);
  assert.equal((await adm('PUT', '/api/records/edit-record-1', { payload: { head: 1 } })).status, 404);
  assert.equal((await adm('GET', '/api/tasks')).data.tasks.length, 0);
  assert.deepEqual((await adm('GET', '/api/users')).data.users.map(u => u.login_id), ['adm.brief']);
  const dash = (await adm('GET', '/api/dashboard')).data;
  assert.deepEqual(dash.people.map(u => u.login_id), ['adm.brief']);
  assert.equal(dash.totals.records, 0);
  assert.ok(!(await adm('GET', '/api/activity')).data.activity.some(x => x.user_id !== a.data.user.id));

  // What the Admin cannot change: themselves, other people's apps, Super Admins, roles.
  assert.equal((await adm('POST', `/api/users/${a.data.user.id}/apps`, { app: 'pump', grant: true })).status, 403);
  assert.equal((await adm('POST', `/api/users/${p1.id}/apps`, { app: 'survey', grant: true })).status, 403);
  assert.equal((await adm('POST', `/api/users/${p1.id}/status`, { status: 'hold' })).status, 403);
  assert.equal((await adm('POST', `/api/users/${ownerId}/status`, { status: 'revoked' })).status, 403);
  assert.equal((await adm('POST', `/api/users/${s2.data.user.id}/reset-password`)).status, 403);
  assert.equal((await adm('POST', '/api/users', { name: 'X', login_id: 'adm.x', role: 'head', apps: ['survey'] })).status, 403);
  assert.equal((await adm('POST', '/api/users', { name: 'X', login_id: 'eng.x', apps: ['pump'] })).status, 403);
  // Their own team: an Engineer on BRIEF, whom they can manage, but only with BRIEF.
  const e = await adm('POST', '/api/users', { name: 'Brief Engineer', login_id: 'eng.brief', apps: ['survey'] });
  assert.equal(e.status, 200);
  assert.equal((await adm('POST', `/api/users/${e.data.user.id}/apps`, { app: 'air', grant: true })).status, 403);
  assert.equal((await adm('POST', `/api/users/${e.data.user.id}/status`, { status: 'hold' })).status, 200);
  assert.equal((await adm('POST', `/api/users/${e.data.user.id}/status`, { status: 'active' })).status, 200);
  assert.equal((await adm('POST', `/api/audits/${auditId}/assign`, { user_id: e.data.user.id, assign: true })).status, 404);
  // Once the Engineer also works on another app, only a Super Admin can hold them.
  assert.equal((await admin('POST', `/api/users/${e.data.user.id}/apps`, { app: 'air', grant: true })).status, 200);
  assert.equal((await adm('POST', `/api/users/${e.data.user.id}/status`, { status: 'hold' })).status, 403);
  assert.deepEqual((await adm('GET', '/api/users')).data.users.find(u => u.login_id === 'eng.brief').apps, ['survey']);

  // A second Super Admin cannot touch the owner or make Super Admins; the owner manages them.
  assert.equal((await sup2('POST', `/api/users/${ownerId}/status`, { status: 'revoked' })).status, 403);
  assert.equal((await sup2('PATCH', `/api/users/${ownerId}`, { role: 'engineer' })).status, 403);
  assert.equal((await sup2('POST', '/api/users', { name: 'X', login_id: 'super.x', role: 'super_admin' })).status, 403);
  assert.equal((await sup2('PATCH', `/api/users/${a.data.user.id}`, { role: 'super_admin' })).status, 403);
  assert.equal((await sup2('POST', `/api/users/${a.data.user.id}/apps`, { app: 'air', grant: true })).status, 200);
  assert.equal((await admin('POST', `/api/users/${s2.data.user.id}/status`, { status: 'hold' })).status, 200);
  assert.equal((await admin('POST', `/api/users/${s2.data.user.id}/status`, { status: 'active' })).status, 200);
  assert.equal((await admin('POST', `/api/users/${ownerId}/status`, { status: 'hold' })).status, 403); // not even themselves
});

await step('activity log cannot be edited or deleted', async () => {
  assert.throws(() => db.exec('DELETE FROM activity'), /append-only/);
  assert.throws(() => db.exec("UPDATE activity SET action = 'x'"), /append-only/);
  const r = await admin('GET', '/api/activity?limit=200');
  assert.ok(r.data.activity.some(a => a.action === 'access.refused'));
});

await step('passwords and tokens are never stored in plain text', async () => {
  const row = db.prepare("SELECT pw_hash FROM users WHERE login_id = 'fl.one'").get();
  assert.match(row.pw_hash, /^scrypt\$/);
  assert.ok(!db.prepare('SELECT token_hash FROM sessions').all().some(s => s.token_hash.length !== 64));
});

// A real 1x1 JPEG, and a "photo" whose bytes are not an image at all.
const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const FAKE_JPEG = 'data:image/jpeg;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');

await step('AR profile cards: created with photo and details; an Engineer unless another role is chosen', async () => {
  const r = await admin('POST', '/api/users', {
    name: 'Card Member', login_id: 'cardmember', position: 'Energy Auditor', qualification: 'M.Tech (Energy)',
    experience: '4 years of industrial energy audits', email: 'cardmember@example.com', photo: TINY_JPEG,
    role: 'head', apps: ['survey'],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'head');
  const eng = await admin('POST', '/api/users', { name: 'Card Engineer', login_id: 'card.eng', apps: ['survey'] });
  assert.equal(eng.data.user.role, 'engineer');
  assert.equal(r.data.user.position, 'Energy Auditor');
  assert.match(r.data.user.photo, /^data:image\/jpeg;base64,/);
  assert.equal((await admin('POST', '/api/users', { name: 'Bad', login_id: 'bad.photo', photo: FAKE_JPEG })).status, 400);
  assert.equal((await admin('POST', '/api/users', { name: 'Bad', login_id: 'bad.mail', email: 'not-an-email' })).status, 400);
  const big = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(320 * 1024)]).toString('base64');
  assert.equal((await admin('POST', '/api/users', { name: 'Bad', login_id: 'bad.big', photo: big })).status, 413);
  assert.equal((await admin('PATCH', `/api/users/${r.data.user.id}`, { in_report: false })).status, 200);
  cardmember = { id: r.data.user.id, pw: r.data.temp_password };
});

await step('an Admin edits their own card; cannot change Super Admins, other apps\' people or roles above them', async () => {
  const member = consoleClient();
  assert.equal((await member('POST', '/api/login', { login_id: 'cardmember', password: cardmember.pw })).status, 200);
  assert.equal((await member('POST', '/api/change-password', { current: cardmember.pw, next: 'Cardmember-pass-2026' })).status, 200);
  const own = await member('PATCH', '/api/me/profile', { experience: '5 years of industrial energy audits' });
  assert.equal(own.status, 200);
  assert.equal(own.data.user.experience, '5 years of industrial energy audits');
  const admins = (await admin('GET', '/api/users')).data.users;
  const superAdmin = admins.find(u => u.role === 'super_admin');
  assert.equal((await member('PATCH', `/api/users/${superAdmin.id}`, { position: 'Changed by someone else' })).status, 403);
  assert.equal((await member('PATCH', `/api/users/${p1.id}`, { position: 'Changed by someone else' })).status, 403);
  assert.equal((await member('POST', `/api/users/${p1.id}/status`, { status: 'revoked' })).status, 403);
  assert.equal((await member('POST', `/api/users/${p1.id}/reset-password`)).status, 403);
  assert.equal((await member('POST', '/api/users', { name: 'Someone', login_id: 'someone', role: 'head' })).status, 403);
  assert.equal((await member('POST', '/api/users', { name: 'Someone', login_id: 'someone2', apps: ['pump'] })).status, 403);
  assert.notEqual((await admin('GET', '/api/users')).data.users.find(u => u.id === superAdmin.id).position, 'Changed by someone else');
});

await step('everyone can edit their own card; the apps read the team for the report', async () => {
  const me = await admin('PATCH', '/api/me/profile', { position: 'Project Lead', experience: '10 years', photo: TINY_JPEG, report_order: 5 });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.position, 'Project Lead');
  assert.equal(me.data.user.report_order, 0); // report order is not self-service
  const app = appClient((await appLogin('fl.one', p1.pw, 'pump')).data.token);
  const cards = await app('GET', '/api/team-cards');
  assert.equal(cards.status, 200);
  assert.ok(cards.data.team.some(t => t.position === 'Project Lead'));
  assert.ok(!cards.data.team.some(t => t.name === 'Card Member')); // switched off from reports
  assert.ok(cards.data.team.every(t => !('login_id' in t) && !('pw_hash' in t) && !('role' in t)));
  assert.equal((await fetch(base + '/api/team-cards')).status, 401); // not without signing in
});

await step('advisors without a login: none to start with; only the Super Admin edits them', async () => {
  const list = await admin('GET', '/api/faculty');
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.faculty, []); // no KISEM people on the AR side
  const add = await admin('POST', '/api/faculty', { name: 'Test Advisor', department: 'Technical advisor', in_report: false });
  assert.equal(add.status, 200);
  assert.equal((await admin('PATCH', `/api/faculty/${add.data.id}`, { position: 'Advisor', email: 'bad mail' })).status, 400);
  const app = appClient((await appLogin('fl.one', p1.pw, 'pump')).data.token);
  const cards = await app('GET', '/api/team-cards');
  assert.equal(cards.data.faculty.length, 0); // the one not in reports is left out
  assert.ok([401, 403].includes((await app('POST', '/api/faculty', { name: 'X' })).status)); // apps cannot change it
  assert.equal((await admin('DELETE', `/api/faculty/${add.data.id}`)).status, 200);
});

await step('a new audit without a cluster code takes it from the district', async () => {
  const r = await admin('POST', '/api/audits', { client_name: 'Cluster Test Mills', sector: 'TX', site_name: 'Unit 9', district: 'Ankleshwar', state: 'Gujarat', fy: 'FY2026-27', title: 'Walkthrough' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const list = await admin('GET', '/api/audits');
  assert.match(list.data.audits.find(a => a.id === r.data.id).industry_tag, /^TX-ANK-\d{3}$/);
});

await step('the Console opens an app already signed in with a one-time code', async () => {
  const swap = (app, code) => fetch(base + '/api/device/launch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app, code, device_id: 'web-test' }),
  }).then(async r => ({ status: r.status, data: await r.json() }));
  const issued = await admin('POST', '/api/launch', { app: 'power', audit: auditId });
  assert.equal(issued.status, 200);
  assert.ok(issued.data.code.length >= 32 && issued.data.expires_in <= 60);
  assert.equal((await swap('motor', issued.data.code)).status, 401); // a code is for one app only…
  const again = await admin('POST', '/api/launch', { app: 'power' });
  const ok = await swap('power', again.data.code);
  assert.equal(ok.status, 200);
  assert.ok(ok.data.token && ok.data.user.login_id);
  assert.equal((await appClient(ok.data.token)('GET', '/api/device/me')).data.app, 'power');
  assert.equal((await swap('power', again.data.code)).status, 401); // …and works once
  assert.equal((await swap('power', 'made-up-code')).status, 401);
  assert.equal((await fetch(base + '/api/launch', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ARES': '1' }, body: '{"app":"power"}' })).status, 401); // not without the Console
  assert.equal((await admin('POST', '/api/launch', { app: 'power', audit: 'NO-SUCH' })).status, 404);
});

// Reads a live-update stream until `want` appears (or gives up after `ms`).
async function waitForEvent(res, want, ms = 3000) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  const timer = setTimeout(() => reader.cancel(), ms);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text;
      text += dec.decode(value);
      if (text.includes(want)) return text;
    }
  } finally { clearTimeout(timer); reader.cancel().catch(() => {}); }
}

await step('live updates: a teammate\'s phone is told at once when data changes; no stream without sign-in', async () => {
  assert.equal((await fetch(`${base}/api/device/events`)).status, 401);
  const twoToken = (await appLogin('fl.two', p2.pw, 'air')).data.token;
  const stream = await fetch(`${base}/api/device/events`, { headers: { Authorization: `Bearer ${twoToken}` } });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const got = waitForEvent(stream, `"audit_id":"${auditId}"`);
  await new Promise(r => setTimeout(r, 100));
  // On the AR side fl.one lost the Air app earlier in these tests: give it back and sign in again.
  await admin('POST', `/api/users/${p1.id}/apps`, { app: 'air', grant: true });
  const oneAgain = appClient((await appLogin('fl.one', 'Field-one-2026', 'air')).data.token);
  const r = await oneAgain('POST', '/api/sync', { since: oneSince, records: [rec('C-LIVE', Date.now() - 60000)] });
  assert.equal(r.data.results[0].status, 'stored', JSON.stringify(r.data));
  const text = await got;
  assert.ok(text.includes('event: change') && text.includes('"what":"records"'), 'the change was announced');
  assert.ok(!text.includes('C-LIVE'), 'the announcement carries no record data');
});

await step('signing out of an app ends that app pass at once', async () => {
  const t = (await appLogin('fl.two', p2.pw, 'air')).data.token;
  const c = appClient(t);
  assert.equal((await c('GET', '/api/device/me')).status, 200);
  assert.equal((await c('POST', '/api/device/logout', {})).status, 200);
  assert.equal((await c('GET', '/api/device/me')).status, 401);
});

await step('AI connector: demo audits only, a personal token, and the privacy guard', async () => {
  // A demo audit with a facts sheet (as Report Studio saves it), where one equipment label carries the company name.
  const demo = await admin('POST', '/api/audits', { client_name: 'Navrang Dyeing Works', sector: 'TX', site_name: 'Sachin Unit', district: 'Surat', state: 'Gujarat', fy: 'FY2026-27', title: 'Detailed energy audit' });
  const aid = demo.data.id;
  assert.equal((await admin('POST', `/api/audits/${aid}/mcp/tokens`, { label: 'Claude' })).status, 409); // not demo yet
  assert.equal((await admin('POST', `/api/audits/${aid}/demo`, { demo: true })).status, 200);
  const made = await admin('POST', `/api/audits/${aid}/mcp/tokens`, { label: 'Claude' });
  assert.equal(made.status, 200);
  assert.match(made.data.token, /^kmcp_/);
  assert.ok(made.data.url.endsWith('/mcp'));

  const rpc = (body, token = made.data.token) => fetch(base + '/mcp', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body) }).then(async r => ({ status: r.status, data: r.status === 202 ? null : await r.json() }));
  const call = async (name, args = {}) => (await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } })).data.result;

  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, null)).status, 401);
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert.equal(init.data.result.protocolVersion, '2025-06-18');
  assert.ok(init.data.result.capabilities.tools);
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.data.result.tools.map(t => t.name).sort(),
    ['get_candidates', 'get_chart_options', 'get_facts', 'get_overview', 'get_report_outline', 'save_draft', 'validate_draft']);
  assert.match((await call('get_overview')).structuredContent.error, /has not saved this report/);

  // Report Studio saves the report (with the company's real name inside) and the facts sheet.
  const pm = appClient((await appLogin('axita', ADMIN_PW, 'report')).data.token);
  const state = { company: { name: 'Navrang Dyeing Works', addr1: 'Plot 77, Sachin GIDC', poc: 'Mahesh Kothari', phone: '9824012345' },
    bills: [{ month: 'Apr', kwh: 412000, consumerNo: '61234500987' }] };
  const sheet = { schema: 'postman-facts/v1', reportType: 'detailed',
    modules: [{ id: 'bills', title: 'Electricity bill', enabled: true }, { id: 'motors', title: 'Motor load analysis', enabled: true, records: 2 }],
    slots: [{ id: 'chapter:motors', label: 'Motor load analysis: analysis', module: 'motors', filled: false }],
    facts: [{ id: 'bill.kwh.total', module: 'bills', label: 'Units in the year', unit: 'kWh', value: 412000, display: '4,12,000 kWh' },
      { id: 'motor.M-01.load', module: 'motors', equipment: 'M-01', label: 'Load factor', unit: '%', value: 31.2, display: '31.2 %', flag: 'bad' }],
    series: [{ id: 'motor.load', module: 'motors', label: 'Load factor by motor', unit: '%', kind: 'equipment', types: ['bar'], points: [{ x: 'M-01', y: 31.2 }] }],
    candidates: [{ id: 'motor.M-01.under', module: 'motors', equipment: 'M-01', text: 'M-01 runs at 31.2 % load', facts: ['motor.M-01.load'] }] };
  const now = Date.now();
  const saved = await pm('POST', '/api/sync', { since: now, records: [
    { id: `rpt-${aid}`, audit_id: aid, kind: 'report', taken_at: now, saved_at: now, payload: { schema: 'postman-report/v1', n: 1, c: JSON.stringify(state) } },
    { id: `rpt-${aid}-facts`, audit_id: aid, kind: 'report_facts', taken_at: now, saved_at: now, payload: sheet }] });
  assert.deepEqual(saved.data.results.map(r => r.status), ['stored', 'stored']);

  const over = await call('get_overview');
  assert.equal(over.isError, false);
  assert.match(over.structuredContent.plant, /^PLANT-[A-Z2-9]{4}$/);
  const facts = await call('get_facts', { module: 'motors' });
  assert.equal(facts.structuredContent.facts[0].id, 'motor.M-01.load');
  for (const r of [over, facts, await call('get_report_outline'), await call('get_candidates'), await call('get_chart_options')]) {
    const text = r.content[0].text;
    for (const secret of ['Navrang', 'Sachin', 'Surat', 'Mahesh', '9824012345', '61234500987', 'Axita', 'TX-']) assert.ok(!text.includes(secret), `${secret} must not leave the server`);
  }

  // The AI may not type numbers; references, standard names and chapters are fine.
  const bad = await call('validate_draft', { draft: { recos: [{ module: 'motors', equipment: 'M-01', title: 'Right-size M-01', observation: 'M-01 runs at about 31 % load.', recommendation: 'Replace it with a smaller IE3 motor.' }] } });
  assert.equal(bad.structuredContent.ok, false);
  assert.ok(bad.structuredContent.errors.some(e => /typed by hand/.test(e)));
  const leak = await call('validate_draft', { draft: { sections: [{ slot: 'chapter:motors', text: 'At Navrang the motors [[F.motor.M-01.load]] run light.' }] } });
  assert.ok(leak.structuredContent.errors.some(e => /name of this plant/.test(e)));
  const good = { note: 'Motors chapter', draft: {
    sections: [{ slot: 'chapter:motors', text: 'Motor M-01 runs at a load factor of [[F.motor.M-01.load]], well below its best-efficiency range (IEC 60034-30-1, IE3).' }],
    recos: [{ module: 'motors', equipment: 'M-01', title: 'Right-size motor M-01', observation: 'M-01 runs at [[F.motor.M-01.load]] of its rating.', recommendation: 'Replace it with a smaller IE3 motor.', priority: 'high' }],
    charts: [{ module: 'motors', series: ['motor.load'], type: 'bar', title: 'Load factor of the motors', caption: 'Measured with the MLA app.' }] } };
  const vg = await call('validate_draft', good); assert.equal(vg.structuredContent.ok, true, JSON.stringify(vg.structuredContent.errors));
  const s = await call('save_draft', good);
  assert.equal(s.structuredContent.saved, true);
  const rec = db.prepare('SELECT payload FROM records WHERE id = ?').get(s.structuredContent.suggestion);
  const items = JSON.parse(rec.payload).items;
  assert.equal(items.length, 3);
  assert.ok(items[0].text.includes('31.2 %'), 'the server puts Report Studio\'s value in');

  // A facts sheet that carries the company name is blocked whole, and logged.
  const t2 = Date.now() + 5;
  await pm('POST', '/api/sync', { since: t2, records: [{ id: `rpt-${aid}-facts`, audit_id: aid, kind: 'report_facts', taken_at: t2, saved_at: t2,
    payload: { ...sheet, facts: [...sheet.facts, { id: 'x.1', module: 'motors', equipment: 'Navrang boiler', label: 'Load', unit: '%', value: 1 }] } }] });
  const blocked = await call('get_facts');
  assert.equal(blocked.isError, true);
  assert.match(blocked.structuredContent.error, /privacy guard/);
  const log = await admin('GET', `/api/audits/${aid}/mcp`);
  assert.ok(log.data.log.some(l => l.blocked));

  // Revoking stops the token at once; demo off ends all tokens.
  assert.equal((await admin('POST', `/api/mcp/tokens/${made.data.id}/revoke`)).status, 200);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).status, 401);
});

await step('AI access for a real audit: Super Admin only, three days at a time, ends when finished', async () => {
  const real = await admin('POST', '/api/audits', { client_name: 'Kesar Polymers', sector: 'CH', site_name: 'Vapi Unit', district: 'Valsad', state: 'Gujarat', fy: 'FY2026-27', title: 'Flow study' });
  const aid = real.data.id;
  let d = (await admin('GET', `/api/audits/${aid}/mcp`)).data;
  assert.equal(d.ai_open, false); assert.equal(d.ai_until, null); assert.equal(d.ai_days, 3);
  assert.equal((await admin('POST', `/api/audits/${aid}/mcp/tokens`, { label: 'Claude' })).status, 409);
  const t0 = Date.now();
  const on = await admin('POST', `/api/audits/${aid}/ai-access`, { on: true });
  assert.equal(on.status, 200);
  assert.ok(Math.abs(on.data.ai_until - (t0 + 3 * 86400000)) < 60000, 'three days from now');
  d = (await admin('GET', `/api/audits/${aid}/mcp`)).data;
  assert.equal(d.ai_open, true); assert.equal(d.demo, false, 'no Demo mark needed');
  const tok = await admin('POST', `/api/audits/${aid}/mcp/tokens`, { label: 'Claude' });
  assert.equal(tok.status, 200);
  // The read API and the apps' audit list tell the report connector.
  const pm = appClient((await appLogin('axita', ADMIN_PW, 'report')).data.token);
  assert.equal((await pm('GET', `/api/audits/${aid}/data`)).data.audit.ai_access, true);
  assert.equal((await pm('GET', '/api/device/me')).data.audits.find(a => a.id === aid).ai_access, true);
  // Time runs out: closed again, no button press needed.
  db.prepare('UPDATE audits SET ai_until = ? WHERE id = ?').run(Date.now() - 1000, aid);
  assert.equal((await admin('GET', `/api/audits/${aid}/mcp`)).data.ai_open, false);
  assert.equal((await pm('GET', `/api/audits/${aid}/data`)).data.audit.ai_access, false);
  // Turned off by hand: ends every token of the audit.
  await admin('POST', `/api/audits/${aid}/ai-access`, { on: true });
  assert.equal((await admin('POST', `/api/audits/${aid}/ai-access`, { on: false })).status, 200);
  assert.ok(db.prepare('SELECT revoked_at FROM mcp_tokens WHERE id = ?').get(tok.data.id).revoked_at, 'token revoked');
  // A finished audit closes at once and cannot be reopened.
  await admin('POST', `/api/audits/${aid}/ai-access`, { on: true });
  db.prepare("UPDATE audits SET status = 'archived' WHERE id = ?").run(aid);
  assert.equal((await admin('GET', `/api/audits/${aid}/mcp`)).data.ai_open, false);
  assert.equal((await admin('POST', `/api/audits/${aid}/ai-access`, { on: true })).status, 409);
  const acts = db.prepare("SELECT action FROM activity WHERE target = ? AND action LIKE 'audit.ai_%'").all(aid).map(r => r.action);
  assert.ok(acts.includes('audit.ai_on') && acts.includes('audit.ai_off'), 'logged');
});

await step('demo company (made from the server): every app gets test data, marked as demo; no button or route for it', async () => {
  assert.ok(!fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').includes('/api/demo-audit'), 'no Create demo company button');
  const sa = db.prepare("SELECT * FROM users WHERE role = 'super_admin' LIMIT 1").get();
  const d = { data: tx(db, () => createDemoAudit(db, sa, { ip: 'test', filesDir })) };
  // Building ~100 pictures blocks this process for a few seconds; let idle connections close first.
  await new Promise(r => setTimeout(r, 300));
  const data = await admin('GET', `/api/audits/${d.data.audit_id}/data`);
  const apps = Object.keys(data.data.apps).sort();
  assert.deepEqual(apps, ['air', 'cool', 'dryer', 'heat', 'ledger', 'light', 'motor', 'power', 'pump', 'report', 'survey', 'textile', 'xmer']);
  // Energy Ledger: bills, baseline and GHG for the same company, with the CEA grid factor.
  assert.deepEqual(data.data.apps.ledger.map(r => r.kind).sort(), ['ledger_baseline', 'ledger_bills', 'ledger_ghg']);
  assert.equal(d.data.ledger.bills, 12);
  assert.ok(d.data.ledger.grid_ef > 0.5 && d.data.ledger.grid_ef < 1, String(d.data.ledger.grid_ef));
  assert.equal(tx(db, () => { try { createDemoLedger(db, sa, d.data.audit_id, { ip: 'test' }); return 'made'; } catch (e) { return e.status; } }), 409); // not twice
  assert.ok(d.data.records >= 70, String(d.data.records));
  assert.equal(db.prepare('SELECT synthetic FROM audits WHERE id = ?').get(d.data.audit_id).synthetic, 1);
  assert.ok(d.data.pictures >= 60, String(d.data.pictures));
  const pics = data.data.files.filter(f => f.mime === 'image/png');
  assert.ok(pics.some(f => f.kind === 'thermal' && f.pair_id) && pics.some(f => f.kind === 'logo') && pics.some(f => f.kind === 'site'));
  const one = await fetch(base + pics[0].url, { headers: { Cookie: admin.cookie?.() || '' } });
  assert.ok([200, 401, 403].includes(one.status));
});

await step('every save logs the app version that made it; the overview works out each app from its own engine', async () => {
  const token = (await appLogin('fl.one', p1.pw, 'air')).data.token;
  const send = (tag, header) => fetch(base + '/api/sync', {
    method: 'POST', body: JSON.stringify({ since: Date.now(), records: [rec(tag, Date.now() - 60000)] }),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(header ? { 'X-ARES-App': header } : {}) },
  }).then(r => r.json());
  assert.equal((await send('C-VER-1', 'air 0.2.9 android')).results[0].status, 'stored');
  const stored = db.prepare("SELECT app_version FROM records WHERE tag = 'C-VER-1'").get();
  assert.equal(stored.app_version, 'v0.2.9 Android');
  assert.match(db.prepare("SELECT detail FROM activity WHERE action = 'sync' ORDER BY rowid DESC LIMIT 1").get().detail, /app v0\.2\.9 Android$/);
  await send('C-VER-2', 'air <script> web');
  assert.equal(db.prepare("SELECT app_version FROM records WHERE tag = 'C-VER-2'").get().app_version, null);
  assert.match(db.prepare("SELECT detail FROM activity WHERE action = 'sync' ORDER BY rowid DESC LIMIT 1").get().detail, /not reported/);

  const js = await fetch(base + '/overview.js');
  assert.equal(js.status, 200);
  const sandbox = { window: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
  sandbox.globalThis = sandbox.window;
  vm.runInNewContext(await js.text(), sandbox.window);
  const demoId = db.prepare("SELECT audit_id AS id FROM records WHERE kind = 'monitoring_session' LIMIT 1").get().id; // the demo company
  const recs = db.prepare("SELECT id, app, kind, tag, payload FROM records WHERE audit_id = ?").all(demoId).map(r => ({ ...r, payload: JSON.parse(r.payload) }));
  for (const app of sandbox.window.ARES_OVERVIEW.apps) {
    const o = sandbox.window.ARES_OVERVIEW.overview(app, recs.filter(r => r.app === app));
    assert.ok(o && o.kpis.length === 4 && o.charts.length >= 1, `${app}: ${JSON.stringify(o)}`);
    assert.ok(o.kpis.every(k => !/NaN|undefined/.test(k.value)), `${app}: ${JSON.stringify(o.kpis)}`);
    assert.ok(o.donuts.length >= 2 && o.donuts.every(d => d.slices.length && d.slices.every(x => x.value > 0)), `${app} donuts: ${JSON.stringify(o.donuts)}`);
  }
});

await step('audit page: refused and clashing saves are kept until solved; who works where; photos that never arrived', async () => {
  const token = (await appLogin('fl.one', p1.pw, 'air')).data.token;
  const send = (body, ver = 'air 0.2.9 android') => fetch(base + '/api/sync', { method: 'POST', body: JSON.stringify({ since: Date.now(), ...body }),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-ARES-App': ver } }).then(r => r.json());
  // a refused save (same tag as a teammate's record), then the same record saved under a new tag
  const dupId = crypto.randomUUID();
  const r1 = await send({ records: [{ ...rec('C-01', Date.now() - 60000), id: dupId }],
    sessions: [{ id: crypto.randomUUID(), audit_id: auditId, started_at: Date.now() - 60000, records: 1 }] });
  assert.equal(r1.results[0].status, 'refused');
  let st = (await admin('GET', `/api/audits/${auditId}/status`)).data;
  const issue = st.issues.find(i => i.record_id === dupId);
  assert.ok(issue && /already recorded/.test(issue.reason) && issue.app_version === 'v0.2.9 Android', JSON.stringify(st.issues));
  const one = st.people.find(p => p.apps.some(x => x.app === 'air' && x.live));
  assert.ok(one, 'the engineer shows as working now in A-CMP');
  await send({ records: [{ ...rec('C-01-B', Date.now() - 30000), id: dupId }] });
  st = (await admin('GET', `/api/audits/${auditId}/status`)).data;
  assert.ok(!st.issues.some(i => i.record_id === dupId), 'a record that saves later closes its own problem');
  // marked solved by hand
  const id2 = crypto.randomUUID();
  await send({ records: [{ ...rec('C-02', Date.now() - 20000), id: id2 }] });
  st = (await admin('GET', `/api/audits/${auditId}/status`)).data;
  const i2 = st.issues.find(i => i.record_id === id2);
  assert.equal((await admin('POST', `/api/sync-issues/${i2.id}/resolve`)).status, 200);
  st = (await admin('GET', `/api/audits/${auditId}/status`)).data;
  assert.ok(!st.issues.some(i => i.record_id === id2));
  // a photo the record points to that never arrived
  await send({ records: [{ ...rec('C-PHOTO', Date.now() - 10000), payload: { tag: 'C-PHOTO', kw: 30, photoPath: `ares-photo:${crypto.randomUUID()}` } }] });
  st = (await admin('GET', `/api/audits/${auditId}/status`)).data;
  const ph = st.photos.find(m => m.app === 'air');
  assert.ok(ph && ph.photos === 1 && ph.arriving, JSON.stringify(st.photos));
});

// ---------- Energy Ledger ----------
await step('Energy Ledger: a bill works out to the rupee, with the demand above contract at its own rate', async () => {
  // Invented figures. 750 kVA contract, 789 kVA recorded.
  const b = LC.blankBills(); b.cfg.contractDemand = 750;
  b.rows = [{ month: 'Apr-25', kwh: 100000, net: 100000, pf: 0.98, actualMD: 789, energyRate: 4.1, fppaRate: 2.4, todNight: 0, todPeak: 0 }];
  const c = LC.billCalc(b);
  assert.equal(c.rows[0].demand, 161645);  // 500 @ 150 + 250 @ 260 + 39 above contract @ 555
  assert.equal(c.total.kwh, 100000);
  assert.equal(c.overMonths, 1);
});

await step('Energy Ledger: the report and Excel keep the team bill table, all 33 columns in its order', async () => {
  const src = fs.readFileSync(new URL('../public/ledger.js', import.meta.url), 'utf8');
  const part = src.slice(src.indexOf('const BILL_SHEET'), src.indexOf('/** Heading groups'));
  const heads = [...part.matchAll(/col\((?:null|'[^']+'), '([^']+)'/g)].map(m => m[1]);
  assert.equal(heads.length, 33);
  assert.deepEqual(heads.slice(25, 28), ['TOU DISC Unit', 'Rate Per KVA', 'TOU Disc']);
  assert.deepEqual([heads[0], heads[1], heads[2], heads[31], heads[32]], ['Month', 'Total Unit Consumed', 'Total Bill Amount', 'Total Bill', 'Difference']);
});

await step('Energy Ledger: a misread demand figure stays quick to work out', async () => {
  const b = LC.blankBills();
  b.cfg.contractDemand = 750;
  b.rows = Array.from({ length: 36 }, (_, i) => ({ id: `r${i}`, month: `Apr-${10 + i}`, kwh: 1000, actualMD: i ? 800 : 6321700 }));
  const t = performance.now();
  for (let i = 0; i < 50; i++) LC.billCalc(b);
  assert.ok(performance.now() - t < 500, `${performance.now() - t} ms for 50 calculations`);
});

await step('Energy Ledger: TOU discount, printed or worked out, comes off the bill once', async () => {
  const b = LC.blankBills();
  b.cfg.contractDemand = 750; b.cfg.touDiscRate = 2;
  b.rows = [
    { id: 'a', month: 'Apr-25', kwh: 1000, actualMD: 700, energyRate: 4 },
    { id: 'b', month: 'May-25', kwh: 1000, actualMD: 700, energyRate: 4, touDiscount: 500 },
    { id: 'c', month: 'Jun-25', kwh: 1000, actualMD: 700, energyRate: 4, touDiscount: -500 },
    { id: 'd', month: 'Jul-25', kwh: 1000, actualMD: 700, energyRate: 4, touDiscUnits: 300 },
    { id: 'e', month: 'Aug-25', kwh: 1000, actualMD: 700, energyRate: 4, touDiscUnits: 300, touDiscount: 500 },
  ];
  const c = LC.billCalc(b), [a, m, j, u, both] = c.rows;
  const off = r => a.totalCons - r.totalCons;
  assert.deepEqual([off(m), off(j), off(u), off(both)], [500, 500, 600, 500]);
  assert.equal(c.rebates.tou, 2100);
  assert.equal(c.total.discUnits, 600);
});

await step('Energy Ledger: baseline, TOE and emissions from the same figures', async () => {
  const b = LC.blankBaseline();
  b.months = [{ y: 2025, m: 4 }]; b.grid['2025-04'] = 100000; b.production['2025-04'] = 50000;
  b.fuels = [{ id: 'f', name: 'Coal', unit: 'Ton', gcv: 4000, ef: 2415.03994, values: { '2025-04': 10 } }];
  const bc = LC.baselineCalc(b);
  assert.ok(Math.abs(bc.total.elecToe - 8.6) < 1e-9);           // 100,000 x 860 / 1e7
  assert.ok(Math.abs(bc.total.thermalToe - 4) < 1e-9);          // 10 x 1000 x 4000 / 1e7
  assert.equal(bc.total.secKwh, 2);
  const g = { ...LC.blankGhg(), gridEF: 0.675, reOffset: 5, lines: [{ id: 'l', type: 'fugitive', qty: 2, ef: 1300 }, { id: 'm', type: 'scope3', qty: 1000, ef: 1 }] };
  const gc = LC.ghgCalc(bc, b, g);
  assert.ok(Math.abs(gc.fuelT - 24.1503994) < 1e-6);
  assert.ok(Math.abs(gc.s1 - (24.1503994 + 2.6)) < 1e-6);
  assert.equal(gc.gross2, 67.5);
  assert.equal(gc.s2, 62.5);
  assert.equal(gc.s3, 1);
  assert.ok(Math.abs(gc.total12 - (gc.s1 + 62.5)) < 1e-9);
});

await step('Energy Ledger: the bill reader takes the right number for each label, and loads nothing from a CDN', async () => {
  const src = fs.readFileSync(new URL('../public/ledger-ocr.js', import.meta.url), 'utf8');
  const { extractBill } = await import('../public/ledger-ocr.js');
  const hits = extractBill('Bill Month: Apr-2025\nUnits Consumed 6,32,170\nPower Factor 0.996\nMaximum Demand 789 kVA\nContract Demand 750\nNet Amount Payable 51,19,031.90');
  assert.equal(hits.kwh.value, 632170);
  assert.equal(hits.pf.value, 0.996);
  assert.equal(hits.actualMD.value, 789);
  assert.equal(hits.contract.value, 750);
  assert.equal(hits.net.value, 5119031.9);
  assert.ok(!/https?:\/\/(cdn|cdnjs|tessdata)/.test(src.replace(/^\s*\/\/.*$/gm, '')), 'the reader must not load anything from a CDN');
});

await step('Energy Ledger: DEFRA library holds the workbook values', async () => {
  const d = JSON.parse(fs.readFileSync(new URL('../public/ledger-factors.json', import.meta.url)));
  const v = (g, n, u) => d.items.find(i => i.g === g && i.n === n && i.u === u)?.v;
  assert.equal(v('Fuels', 'Coal (industrial)', 'tonnes'), 2415.03994);
  assert.equal(v('Fuels', 'Diesel (100% mineral diesel)', 'litres'), 2.66155);
  assert.equal(v('Fuels', 'Natural gas (100% mineral blend)', 'cubic metres'), 2.04987);
  assert.equal(v('Refrigerants and gases', 'HFC-134a', 'kg'), 1300);
  assert.equal(d.year, '2026');
});

await step('Energy Ledger: CEA Version 22.0 is held, with the factors of its User Guide', async () => {
  const r = await admin('GET', '/api/ledger/cea');
  assert.equal(r.status, 200);
  assert.equal(r.data.current, '22.0');
  const v = r.data.versions[0];
  const f = LC.ceaFactor(v, '2025-26');
  assert.deepEqual([f.value, f.version, f.exact], [0.675, '22.0', true]);
  assert.equal(LC.ceaFactor(v, '2025-26', 'cm').value, 0.705);
  assert.equal(LC.ceaFactor(v, '2025-26', 'average', false).value, 0.678);
  assert.equal(LC.ceaFactor(v, '2024-25').value, 0.710);
  const later = LC.ceaFactor(v, '2026-27'); // not published yet: the newest, and it says so
  assert.deepEqual([later.value, later.fy, later.exact], [0.675, '2025-26', false]);
  assert.equal(LC.ceaLabel({ basis: 'average', cea: { version: '22.0', published: 'August 2026', fy: '2025-26' } }),
    'CEA CO2 Baseline Database Version 22.0 (August 2026), FY 2025-26, weighted average');
});

await step('Energy Ledger: the CEA watch tells us of a new version, and says when it could not look', async () => {
  assert.equal(latestOnPage('<td>Version 21.0</td> <td>Version 22.0</td><td>Version 9.0</td>'), '22.0');
  assert.equal(latestOnPage('<p>under maintenance</p>'), null);
  const page = body => async () => new Response(body, { status: 200 });
  let st = await checkCea(db, { fetchImpl: page('Version 22.0 Version 21.0') });
  assert.deepEqual([st.ok, st.newer, st.latest], [true, false, '22.0']);
  st = await checkCea(db, { fetchImpl: async () => new Response('', { status: 503 }) });
  assert.equal(st.ok, false);
  assert.match(st.error, /503/);
  st = await checkCea(db, { fetchImpl: page('nothing here') });
  assert.equal(st.ok, false);
  st = await checkCea(db, { fetchImpl: page('Version 23.0 Version 22.0') });
  assert.deepEqual([st.ok, st.newer, st.latest, st.current], [true, true, '23.0', '22.0']);
  await checkCea(db, { fetchImpl: page('Version 23.0') }); // the log says it once
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity WHERE action = 'cea.new_version'").get().n, 1);
});

await step('Energy Ledger: only the Super Admin adds a CEA version, and it must be newer and complete', async () => {
  const add = b => admin('POST', '/api/ledger/cea/versions', b);
  const row = { fy: '2026-27', cross_border: true, average: 0.65, om: 0.95, bm: 0.42, cm: 0.685 };
  assert.equal((await add({ version: '21.0', published: 'x', rows: [row] })).status, 409);
  assert.equal((await add({ version: 'new', published: 'x', rows: [row] })).status, 400);
  assert.equal((await add({ version: '23.0', published: 'August 2027', rows: [] })).status, 400);
  assert.equal((await add({ version: '23.0', published: 'August 2027', rows: [{ ...row, average: 650 }] })).status, 400);
  const ok = await add({ version: '23.0', published: 'August 2027', guide_url: 'https://cea.nic.in/x', rows: [row] });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.data.current, ok.data.newer], ['23.0', false]);
  db.prepare("DELETE FROM cea_versions WHERE version = '23.0'").run();
  db.prepare("UPDATE cea_watch SET latest = '22.0', told = NULL").run();
});

await step('Energy Ledger: a company saves its data, a stale page is refused, it comes back with the audit data', async () => {
  const au = (await admin('POST', '/api/audits', { client_name: 'Ledger Mills', sector: 'TX', site_name: 'Unit L', cluster: 'srt', fy: 'FY2025-26', title: 'Detailed energy audit' })).data.id;
  const url = `/api/ledger/company/${au}`;
  assert.deepEqual((await admin('GET', url)).data.records, {});
  const payload = { ...LC.blankBills(), rows: [{ month: 'Apr-25', kwh: 1000, verified: true }] };
  const first = await admin('PUT', `${url}/ledger_bills`, { payload, base_version: 0 });
  assert.deepEqual([first.status, first.data.version], [200, 1]);
  assert.equal((await admin('PUT', `${url}/ledger_bills`, { payload, base_version: 0 })).status, 409); // a page that never saw version 1
  const second = await admin('PUT', `${url}/ledger_bills`, { payload: { ...payload, note: 'x' }, base_version: 1 });
  assert.equal(second.data.version, 2);
  assert.equal((await admin('PUT', `${url}/ledger_nope`, { payload })).status, 404);
  assert.equal((await admin('GET', url)).data.records.ledger_bills.version, 2);
  assert.equal((await admin('GET', '/api/ledger/summary')).data.companies[au].bills, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM record_versions WHERE record_id = ?').get(`led-bills-${au}`).n, 1); // the older one is kept
  const pm = appClient((await appLogin('axita', ADMIN_PW, 'report')).data.token);
  const feed = await pm('GET', `/api/audits/${au}/data`);
  assert.equal(feed.data.apps.ledger[0].kind, 'ledger_bills');
  assert.equal(feed.data.apps.ledger[0].payload.rows[0].kwh, 1000);
  const anon = await fetch(`${base}${url}`);
  assert.equal(anon.status, 401);
});

await step('Energy Ledger: its files are served, and only the OCR files may run WebAssembly', async () => {
  const page = await fetch(`${base}/`);
  assert.ok(!page.headers.get('content-security-policy').includes('wasm'));
  for (const p of ['/ledger.js', '/ledger-calc.js', '/ledger-ocr.js', '/ledger-xlsx-worker.js', '/ledger-factors.json', '/icons/bills.png', '/vendor/xlsx.full.min.js', '/vendor/ocr/pdf.min.js', '/vendor/ocr/eng.traineddata.gz'])
    assert.equal((await fetch(base + p)).status, 200, p);
  assert.match((await fetch(`${base}/vendor/ocr/worker.min.js`)).headers.get('content-security-policy'), /wasm-unsafe-eval/);
  assert.equal((await fetch(`${base}/vendor/ocr/../../server.js`)).status, 404);
});


await step('Energy Ledger: only people given it reach it; it is not GST Billing; saving bills is not field work', async () => {
  const signIn = async (login_id, temp) => {
    const c = consoleClient();
    assert.equal((await c('POST', '/api/login', { login_id, password: temp })).status, 200);
    assert.equal((await c('POST', '/api/change-password', { current: temp, next: `${login_id}-Pass-2026` })).status, 200);
    return c;
  };
  const without = await admin('POST', '/api/users', { name: 'No Ledger', login_id: 'adm.noledger', role: 'head', apps: ['survey', 'bills'] });
  const given = await admin('POST', '/api/users', { name: 'Ledger Admin', login_id: 'adm.ledger', role: 'head', apps: ['ledger'] });
  const no = await signIn('adm.noledger', without.data.temp_password), yes = await signIn('adm.ledger', given.data.temp_password);
  const id = (await yes('POST', '/api/audits', { client_name: 'Ledger Scope Mills', site_name: 'Unit 1', sector: 'TX', title: 'Energy audit', fy: 'FY2025-26' })).data.id;
  const hidden = (await admin('POST', '/api/audits', { client_name: 'Other Mills', site_name: 'Unit 9', sector: 'TX', title: 'Energy audit', fy: 'FY2025-26' })).data.id;
  for (const p of ['/api/ledger/cea', '/api/ledger/summary', `/api/ledger/company/${id}`]) assert.equal((await no('GET', p)).status, 403, p);
  assert.equal((await no('PUT', `/api/ledger/company/${id}/ledger_bills`, { payload: { rows: [] } })).status, 403);
  assert.ok(!(await no('GET', '/api/me')).data.my_apps.includes('ledger'));
  assert.equal((await yes('GET', `/api/ledger/company/${hidden}`)).status, 404, 'not an audit they may see');
  const saved = await yes('PUT', `/api/ledger/company/${id}/ledger_bills`, { payload: { rows: [{ month: 'Apr-25', kwh: 1000 }] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.ok((await yes('GET', '/api/ledger/summary')).data.companies[id]);
  assert.ok(!(await yes('GET', '/api/ledger/summary')).data.companies[hidden]);
  assert.equal(db.prepare('SELECT app FROM records WHERE audit_id = ?').get(id).app, 'ledger');
  const pa = (await admin('GET', `/api/audits/${id}/pipeline`)).data.audit;
  assert.equal(pa.records, 0, 'bills are not field records');
  assert.equal(pa.next.ready, false, 'and do not move the audit on');
});

await step('audit process: six AR stages, one at a time; an Admin or Super Admin approves; Published closes the audit', async () => {
  const id = (await admin('POST', '/api/audits', { client_name: 'Stage Test Mills', site_name: 'Unit 2', sector: 'TX', title: 'Walkthrough energy audit',
    fy: 'FY2025-26', district: 'Surat', state: 'Gujarat', work_type: 'walkthrough' })).data.id;
  let pa = (await admin('GET', `/api/audits/${id}/pipeline`)).data.audit;
  assert.equal(pa.stage, 'setup');
  assert.deepEqual(pa.stages, ['setup', 'field', 'processing', 'review', 'approved', 'published']);
  const users = (await admin('GET', '/api/users')).data.users;
  const eng = users.find(u => u.login_id === 'fl.one'), eng2 = users.find(u => u.login_id === 'fl.two');
  assert.equal((await admin('POST', `/api/audits/${id}/assign`, { user_id: eng.id, assign: true, role: 'lead' })).status, 200);
  assert.equal((await admin('POST', `/api/audits/${id}/assign`, { user_id: eng2.id, assign: true, role: 'lead' })).status, 200);
  pa = (await admin('GET', `/api/audits/${id}/pipeline`)).data.audit;
  assert.deepEqual(pa.team.map(t => [t.id === eng2.id ? 'two' : 'one', t.role]).sort(), [['one', 'field'], ['two', 'lead']], 'one lead at a time');
  assert.equal((await admin('POST', `/api/audits/${id}/stage`, { to: 'processing' })).status, 200, 'a Super Admin may jump');
  assert.equal((await admin('POST', `/api/audits/${id}/stage`, { to: 'setup' })).status, 400, 'going back needs a note');
  assert.equal((await admin('POST', `/api/audits/${id}/stage`, { to: 'review' })).status, 200);
  const { moveStage } = await import('../lib/stages.js');
  assert.throws(() => moveStage(db, id, 'approved', { id: eng2.id, role: 'engineer' }), /approves/, 'the audit lead cannot approve');
  assert.equal((await admin('POST', `/api/audits/${id}/stage`, { to: 'approved' })).status, 200, 'a Super Admin approves');
  assert.equal((await admin('POST', `/api/audits/${id}/stage`, { to: 'published' })).status, 200);
  assert.equal(db.prepare('SELECT status FROM audits WHERE id = ?').get(id).status, 'archived', 'Published finalises the audit');
  assert.equal((await admin('POST', `/api/audits/${id}/reopen`, {})).status, 400, 'reopening needs a reason');
  assert.equal((await admin('POST', `/api/audits/${id}/reopen`, { note: 'Boiler readings to correct' })).status, 200);
  pa = (await admin('GET', `/api/audits/${id}/pipeline`)).data.audit;
  assert.equal(pa.stage, 'processing'); assert.equal(pa.status, 'in_field');
  assert.ok(pa.history.length >= 5 && pa.history.some(h => h.note === 'Reopened: Boiler readings to correct'));
});

await step('tasks: process tasks per stage by role, data-entry targets that close on sync, ordinary tasks', async () => {
  const id = (await admin('POST', '/api/audits', { client_name: 'Task Test Mills', site_name: 'Unit 3', sector: 'TX', title: 'Detailed energy audit',
    fy: 'FY2025-26', district: 'Surat', state: 'Gujarat', work_type: 'detailed' })).data.id;
  const users = (await admin('GET', '/api/users')).data.users;
  const eng = users.find(u => u.login_id === 'fl.one');
  await admin('POST', `/api/audits/${id}/assign`, { user_id: eng.id, assign: true, role: 'lead' });
  let T = (await admin('GET', `/api/tasks?audit=${id}`)).data;
  const team = T.tasks.find(t => t.auto_key === 'setup:team');
  assert.ok(team && team.status === 'done', 'the team task closes once there is a lead');
  assert.ok(T.tasks.some(t => t.auto_key === 'setup:details'), 'process tasks of the stage appear');
  assert.equal((await admin('POST', `/api/audits/${id}/stage`, { to: 'field' })).status, 200);
  T = (await admin('GET', `/api/tasks?audit=${id}`)).data;
  assert.equal(T.tasks.find(t => t.auto_key === 'setup:details').status, 'done', 'tasks of a passed stage close');
  const field = T.tasks.find(t => t.auto_key === 'field:field-data');
  assert.ok(field && field.assignee === eng.id, 'assigned to the lead');
  // a data-entry target, closed by the engineer's sync
  const made = await admin('POST', '/api/tasks', { audit_id: id, title: 'Record two compressors', app: 'air', record_kind: 'compressor', target: 2, assignee: eng.id });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.equal((await admin('POST', '/api/tasks', { audit_id: id, title: 'x', target: 3 })).status, 400, 'a target needs its app');
  const token = (await appLogin('fl.one', p1.pw, 'air')).data.token;
  const sync = recs => fetch(base + '/api/sync', { method: 'POST', body: JSON.stringify({ since: Date.now(), records: recs }),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }).then(r => r.json());
  const r1 = { ...rec('TT-1', Date.now() - 5000), audit_id: id };
  await sync([r1]);
  T = (await admin('GET', `/api/tasks?audit=${id}`)).data;
  let d = T.tasks.find(t => t.id === made.data.id);
  assert.deepEqual([d.status, d.progress.count, d.progress.target], ['todo', 1, 2]);
  await sync([{ ...rec('TT-2', Date.now() - 4000), audit_id: id }]);
  d = db.prepare('SELECT status, done_note FROM tasks WHERE id = ?').get(made.data.id);
  assert.equal(d.status, 'done'); assert.match(d.done_note, /2 of 2/);
  assert.ok(T.workload.some(p => p.id === eng.id && p.entered.some(e => e.app === 'air')), 'what each person entered');
  // process tasks cannot be removed; ordinary ones can
  assert.equal((await admin('DELETE', `/api/tasks/${field.id}`)).status, 400);
  const plain = await admin('POST', '/api/tasks', { audit_id: id, title: 'Ask for the last year of bills' });
  assert.equal((await admin('DELETE', `/api/tasks/${plain.data.id}`)).status, 200);
});

await step('a record bounced between two copies of an app is refused after 15 saves in two minutes', async () => {
  const token = (await appLogin('fl.one', p1.pw, 'air')).data.token;
  const id = crypto.randomUUID();
  const send = (n) => fetch(base + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ since: Date.now(), records: [{ ...rec('LOOP-1', Date.now() - 1000), id, payload: { tag: 'LOOP-1', kw: 30 + (n % 2) } }] }) }).then(r => r.json());
  const got = [];
  for (let i = 0; i < 18; i++) got.push((await send(i)).results[0]);
  const refused = got.find(x => x.status === 'refused');
  assert.ok(refused && /too often/.test(refused.reason), JSON.stringify(got.map(x => x.status)));
  assert.ok(db.prepare('SELECT version FROM records WHERE id = ?').get(id).version <= 16);
});

server.close();
fs.rmSync(filesDir, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
