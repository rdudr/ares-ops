// End-to-end check of the Console and the sync API, on a throwaway in-memory database.
// Run: npm test
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../lib/db.js';
import { createServer } from '../server.js';

const db = openDb(':memory:');
const { server, setupCode } = createServer(db);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };

// Console client: keeps the session cookie, sends the same-origin header.
function consoleClient() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-ARES': '1', Cookie: cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
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
let auditId, p1, p2;

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

await step('newer edit wins, older copy is kept as a version', async () => {
  const edited = { ...firstRecord, saved_at: Date.now(), payload: { tag: 'C-01', kw: 45 } };
  const r = await two('POST', '/api/sync', { since: twoSince, records: [edited] });
  assert.equal(r.data.results[0].status, 'updated');
  const stale = await one('POST', '/api/sync', { since: oneSince, records: [{ ...firstRecord, saved_at: firstRecord.saved_at + 1 }] });
  assert.equal(stale.data.results[0].status, 'kept_server');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM record_versions').get().n, 1);
});

await step('dashboard shows hours, records and records per hour per person', async () => {
  const r = await admin('GET', '/api/dashboard?days=30');
  const p = r.data.people.find(x => x.login_id === 'fl.one');
  assert.equal(p.records, 2);
  assert.equal(p.hours, 2);
  assert.equal(p.records_per_hour, 1);
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

await step('five wrong passwords lock the account for 15 minutes', async () => {
  for (let i = 0; i < 5; i++) await appLogin('fl.two', 'wrong-pass-1', 'air');
  assert.equal((await appLogin('fl.two', p2.pw, 'air')).status, 423);
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

server.close();
console.log(`\n${passed} checks passed`);
