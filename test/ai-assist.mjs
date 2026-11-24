// Real-time AI help (lib/ai-assist.js) against a fake OpenAI-style provider: no real AI is called.
// Run: npm test (after smoke.mjs)
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, tx } from '../lib/db.js';
import { createDemoAudit } from '../lib/demo.js';
import { createServer } from '../server.js';
import { classifyProviderError } from '../lib/ai-assist.js';

// ---- the fake provider: answers from a queue, remembers what it was sent ----
const sent = [];
let queue = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    sent.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
    const next = queue.shift() || { status: 500, body: { error: { message: 'queue empty' } } };
    res.writeHead(next.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(next.body));
  });
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const answer = obj => ({ status: 200, body: { model: 'fake-lite', choices: [{ message: { content: JSON.stringify(obj) }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 40 } } });

Object.assign(process.env, { AI_ASSIST_BASE_URL: `http://127.0.0.1:${fake.address().port}/v1beta/openai/`, AI_ASSIST_KEY: 'test-key',
  AI_ASSIST_MODEL: 'fake-lite', AI_ASSIST_USER_GAP_S: '0', AI_ASSIST_DAILY_MAX: '50', AI_ASSIST_AUDIT_DAILY_MAX: '25', AI_ASSIST_RETRY_MS: '5' });
delete process.env.AI_ASSIST; delete process.env.AI_ASSIST_TIER;
const BACKUP_ENV = ['NVIDIA_NIM_KEY', 'NVIDIA_NIM_MODEL', 'NVIDIA_NIM_BASE_URL', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'OPENROUTER_BASE_URL'];
for (const k of BACKUP_ENV) delete process.env[k];

const db = openDb(':memory:');
const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ares-ai-files-'));
const { server, setupCode } = createServer(db, { filesDir });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };

const PW = 'Ai-assist-test-2026';
await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ARES': '1' },
  body: JSON.stringify({ code: setupCode, name: 'Asha Admin', login_id: 'asha', password: PW }) });
const sa = db.prepare("SELECT * FROM users WHERE role = 'super_admin' LIMIT 1").get();
const demo = tx(db, () => createDemoAudit(db, sa, { ip: 'test', filesDir })).audit_id;
const login = await (await fetch(base + '/api/device/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ login_id: 'asha', password: PW, app: 'report', device_id: 'rs-test' }) })).json();
const rs = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
};

// A real company's audit (not a demo): copies of the demo's client, site and audit rows under new ids.
const real = 'AU-2526-0999';
const clone = (table, id, changes) => {
  const row = { ...db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id), ...changes };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map(c => row[c]));
};
const demoRow = db.prepare('SELECT * FROM audits WHERE id = ?').get(demo);
const demoSite = db.prepare('SELECT * FROM sites WHERE id = ?').get(demoRow.site_id);
clone('clients', demoSite.client_id, { id: 'C-REAL', name: 'Navrang Dyeing Works' });
clone('sites', demoSite.id, { id: 'S-REAL', client_id: 'C-REAL', name: 'Unit 2', industry_tag: 'TX-SRT-999' });
clone('audits', demo, { id: real, site_id: 'S-REAL', synthetic: 0, ai_until: null });

const sheet = { schema: 'postman-facts/v1', reportType: 'detailed',
  modules: [{ id: 'bills', title: 'Electricity bill', enabled: true }, { id: 'motors', title: 'Motor load analysis', enabled: true, records: 2 }],
  slots: [{ id: 'chapter:motors', label: 'Motor load analysis: analysis', module: 'motors', filled: false }],
  facts: [{ id: 'bill.kwh.total', module: 'bills', label: 'Units in the year', unit: 'kWh', value: 412000, display: '4,12,000 kWh' },
    { id: 'motor.M-01.load', module: 'motors', equipment: 'M-01', label: 'Load factor', unit: '%', value: 31.2, display: '31.2 %', flag: 'bad' }],
  series: [{ id: 'motor.load', module: 'motors', label: 'Load factor by motor', unit: '%', kind: 'equipment', types: ['bar'], points: [{ x: 'M-01', y: 31.2 }] }],
  candidates: [{ id: 'motor.M-01.under', module: 'motors', equipment: 'M-01', text: 'M-01 runs at 31.2 % load', facts: ['motor.M-01.load'] }] };
// Report Studio saves the report (with the company's name and contact inside) and the facts sheet.
const state = { company: { name: 'Kesarvan Fabrics', addr1: 'Plot 77, Sachin GIDC', poc: 'Mahesh Kothari', phone: '9824012345' } };
const saveSheet = async aid => {
  const now = Date.now();
  const r = await rs('POST', '/api/sync', { since: now, records: [
    { id: `rpt-${aid}`, audit_id: aid, kind: 'report', taken_at: now, saved_at: now, payload: { schema: 'postman-report/v1', n: 1, c: JSON.stringify(state) } },
    { id: `rpt-${aid}-facts`, audit_id: aid, kind: 'report_facts', taken_at: now, saved_at: now, payload: sheet }] });
  assert.ok(r.data.results.every(x => ['stored', 'updated'].includes(x.status)), JSON.stringify(r.data));
};
const good = { note: 'Motors chapter', text: 'Motor M-01 runs at a load factor of [[F.motor.M-01.load]], well below its best-efficiency range (IEC 60034-30-1).',
  recos: [{ equipment: 'M-01', title: 'Right-size motor M-01', observation: 'M-01 runs at [[F.motor.M-01.load]] of its rating.',
    recommendation: 'Replace it with a smaller IE3 motor.', priority: 'high' }],
  charts: [{ series: ['motor.load'], type: 'bar', title: 'Load factor of the motors', caption: 'Measured on site.' }] };
const ask = (aid, extra = {}) => rs('POST', '/api/ai/assist/ask', { audit_id: aid, chapter: 'motors', text: 'Explain why M-01 should be replaced.', request_id: 'req-1', ...extra });

await step('AI help is off until the server switches it on', async () => {
  const st = await rs('GET', `/api/ai/assist/status?audit_id=${demo}`);
  assert.equal(st.status, 200);
  assert.equal(st.data.enabled, false);
  const r = await ask(demo);
  assert.equal(r.status, 403); assert.equal(r.data.code, 'not_allowed');
  assert.equal(sent.length, 0);
  process.env.AI_ASSIST = 'on';
});

await step('a free key serves demo audits only; a real company is refused before anything is sent', async () => {
  await saveSheet(real);
  const st = (await rs('GET', `/api/ai/assist/status?audit_id=${real}`)).data;
  assert.equal(st.enabled, true); assert.equal(st.demo_only, true); assert.equal(st.allowed, false);
  const r = await ask(real);
  assert.equal(r.status, 403); assert.equal(r.data.code, 'not_allowed'); assert.match(r.data.error, /demo audits/);
  assert.equal(sent.length, 0);
});

await step('without a saved facts sheet the AI is not asked', async () => {
  const r = await ask(demo);
  assert.equal(r.status, 409); assert.equal(r.data.code, 'no_sheet');
  assert.equal(sent.length, 0);
});

await step('Ask AI now: the answer is saved as suggestions with the report\'s own values, and answers the request', async () => {
  await saveSheet(demo);
  queue = [answer(good)];
  const r = await ask(demo);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.items, 3);
  const call = sent.at(-1);
  assert.equal(call.url, '/v1beta/openai/chat/completions');
  assert.equal(call.auth, 'Bearer test-key');
  assert.equal(call.body.model, 'fake-lite');
  assert.equal(call.body.response_format.type, 'json_schema');
  const prompt = JSON.stringify(call.body.messages);
  assert.ok(prompt.includes('PLANT-'), 'the plant goes under its code name');
  for (const w of ['Kesarvan', 'Sachin', 'Mahesh', '9824012345', 'Asha']) assert.ok(!prompt.includes(w), `${w} must not be sent`);
  const rec = JSON.parse(db.prepare('SELECT payload FROM records WHERE id = ?').get(r.data.suggestion).payload);
  assert.equal(rec.source, 'assist'); assert.deepEqual(rec.answers, ['req-1']);
  assert.ok(rec.items[0].text.includes('31.2 %'), 'the server puts Report Studio\'s value in');
  assert.equal(rec.items[0].module, 'motors');
  assert.ok(db.prepare("SELECT 1 FROM activity WHERE action = 'ai.assist_answered'").get());
});

await step('the same question on the same figures is answered again without asking the AI', async () => {
  const before = sent.length;
  const r = await ask(demo, { request_id: 'req-2' });
  assert.equal(r.status, 200); assert.equal(r.data.reused, true);
  assert.equal(sent.length, before);
  const rec = JSON.parse(db.prepare('SELECT payload FROM records WHERE id = ?').get(r.data.suggestion).payload);
  assert.deepEqual(rec.answers, ['req-1', 'req-2']);
});

await step('a request that names the plant is not sent', async () => {
  const before = sent.length;
  for (const text of ['Why does Kesarvan have a poor motor M-01?', 'Ask Mahesh Kothari about motor M-01 and explain it.', 'Call 9824012345 about motor M-01 please.']) {
    const r = await ask(demo, { text });
    assert.equal(r.status, 422, text); assert.equal(r.data.code, 'blocked', text);
  }
  assert.equal(sent.length, before);
});

await step('a typed number is sent back once; twice and the answer is not kept', async () => {
  const typed = { ...good, text: 'Motor M-01 runs at about 31 % load.' };
  queue = [answer(typed), answer(good)];
  const ok = await ask(demo, { text: 'Second wording of the question for M-01.' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.match(JSON.stringify(sent.at(-1).body.messages.at(-1)), /typed by hand/);
  queue = [answer(typed), answer(typed)];
  const bad = await ask(demo, { text: 'Third wording of the question for M-01.' });
  assert.equal(bad.status, 422); assert.equal(bad.data.code, 'invalid');
});

await step('insights for a chapter are saved as insight items', async () => {
  queue = [answer({ insights: [{ chapter: 'motors', title: 'M-01 is badly under-loaded', text: 'M-01 runs at [[F.motor.M-01.load]] of its rating.', level: 'high' }] })];
  const r = await rs('POST', '/api/ai/assist/insights', { audit_id: demo, chapter: 'motors' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const rec = JSON.parse(db.prepare('SELECT payload FROM records WHERE id = ?').get(r.data.suggestion).payload);
  assert.equal(rec.purpose, 'insights');
  assert.equal(rec.items[0].type, 'insight'); assert.equal(rec.items[0].module, 'motors');
  assert.ok(rec.items[0].text.includes('31.2 %'));
});

await step('the provider\'s refusals come back in plain words: quota, billing, key, down', async () => {
  queue = [{ status: 429, body: [{ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, per day' } }] }];
  let r = await ask(demo, { text: 'Quota test question for M-01.' });
  assert.equal(r.status, 429); assert.equal(r.data.code, 'quota'); assert.match(r.data.error, /quota/i);
  queue = [{ status: 429, body: { error: { message: 'Quota exceeded: GenerateRequestsPerMinutePerProjectPerModel-FreeTier' } } }];
  r = await ask(demo, { text: 'Minute quota test question for M-01.' });
  assert.equal(r.data.code, 'quota_minute');
  queue = [{ status: 400, body: { error: { message: 'This API method requires billing to be enabled. Please enable billing on project.', status: 'FAILED_PRECONDITION' } } }];
  r = await ask(demo, { text: 'Billing test question for M-01.' });
  assert.equal(r.status, 402); assert.equal(r.data.code, 'billing'); assert.match(r.data.error, /billing/);
  queue = [{ status: 400, body: { error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } } }];
  r = await ask(demo, { text: 'Key test question for M-01.' });
  assert.equal(r.data.code, 'key');
  const down = { status: 503, body: { error: { message: 'The model is overloaded.' } } };
  queue = [down, down, down];
  r = await ask(demo, { text: 'Down test question for M-01.' });
  assert.equal(r.data.code, 'unavailable');
  assert.equal(queue.length, 0, 'a 503 is tried three times in all');
  queue = [down, answer(good)];
  r = await ask(demo, { text: 'Busy-then-fine test question for M-01.' });
  assert.equal(r.status, 200, 'a busy moment is ridden out: ' + JSON.stringify(r.data));
  assert.equal(classifyProviderError(402, '').code, 'billing');
});

await step('backups when the main provider fails: NVIDIA NIM first, then OpenRouter; the reply says which answered', async () => {
  const fakeUrl = `http://127.0.0.1:${fake.address().port}`;
  // NIM with only its key gets MiniMax; OpenRouter is left out without a model.
  Object.assign(process.env, { NVIDIA_NIM_KEY: 'nim-key', OPENROUTER_API_KEY: 'or-key' });
  let st = (await rs('GET', `/api/ai/assist/status?audit_id=${demo}`)).data;
  assert.deepEqual(st.backups, [{ provider: 'NVIDIA NIM', model: 'minimaxai/minimax-m3.1-flash' }]);
  Object.assign(process.env, { NVIDIA_NIM_BASE_URL: `${fakeUrl}/nim/`, NVIDIA_NIM_MODEL: 'backup-a', OPENROUTER_BASE_URL: `${fakeUrl}/or/`, OPENROUTER_MODEL: 'backup-b' });
  st = (await rs('GET', `/api/ai/assist/status?audit_id=${demo}`)).data;
  assert.deepEqual(st.backups, [{ provider: 'NVIDIA NIM', model: 'backup-a' }, { provider: 'OpenRouter', model: 'backup-b' }]);
  const quotaDay = { status: 429, body: { error: { message: 'Quota exceeded for metric: generate_content_free_tier_requests, per day' } } };
  const down = { status: 503, body: { error: { message: 'The model is overloaded.' } } };
  const busyUpstream = { status: 429, body: { error: { message: 'Provider returned error', metadata: { raw: 'backup-a is temporarily rate-limited upstream. Please retry shortly' } } } };
  queue = [quotaDay, answer(good)];
  let r = await ask(demo, { text: 'Backup test question for M-01.' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.backup, true); assert.equal(r.data.provider, 'NVIDIA NIM');
  assert.equal(sent.at(-1).url, '/nim/chat/completions'); assert.equal(sent.at(-1).auth, 'Bearer nim-key'); assert.equal(sent.at(-1).body.model, 'backup-a');
  assert.equal(db.prepare('SELECT model FROM ai_assist_log ORDER BY id DESC LIMIT 1').get().model, 'backup-a');
  assert.match(JSON.parse(db.prepare('SELECT payload FROM records WHERE id = ?').get(r.data.suggestion).payload).client, /^NVIDIA NIM \(/);
  // Main down (tried twice when a backup waits), NIM busy, OpenRouter answers.
  queue = [down, down, busyUpstream, answer(good)];
  r = await ask(demo, { text: 'Second backup test question for M-01.' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.provider, 'OpenRouter');
  assert.equal(sent.at(-1).url, '/or/chat/completions'); assert.equal(sent.at(-1).auth, 'Bearer or-key'); assert.equal(queue.length, 0);
  // Everything fails: the main provider's reason, and that the backup failed too.
  queue = [quotaDay, down, down];
  r = await ask(demo, { text: 'All down test question for M-01.' });
  assert.equal(r.data.code, 'quota'); assert.match(r.data.error, /backup AI \(OpenRouter\) did not answer either/);
  // A busy shared pool is a short wait, not a used-up day.
  assert.equal(classifyProviderError(429, JSON.stringify(busyUpstream.body)).code, 'quota_minute');
  // A free backup never gets a real company's audit, even when the main key is paid.
  process.env.AI_ASSIST_TIER = 'paid';
  assert.deepEqual((await rs('GET', `/api/ai/assist/status?audit_id=${real}`)).data.backups, []);
  delete process.env.AI_ASSIST_TIER;
  for (const k of BACKUP_ENV) delete process.env[k];
});

await step('daily limits: the server\'s, and each person\'s pace', async () => {
  const used = db.prepare('SELECT COUNT(*) AS n FROM ai_assist_log WHERE called = 1').get().n;
  process.env.AI_ASSIST_DAILY_MAX = String(used);
  const before = sent.length;
  let r = await ask(demo, { text: 'Cap test question for M-01.' });
  assert.equal(r.status, 429); assert.equal(r.data.code, 'cap'); assert.match(r.data.error, /limit for today/);
  assert.equal(sent.length, before);
  const st = (await rs('GET', `/api/ai/assist/status?audit_id=${demo}`)).data;
  assert.equal(st.today.used, used); assert.equal(st.today.max, used);
  process.env.AI_ASSIST_DAILY_MAX = '50'; process.env.AI_ASSIST_USER_GAP_S = '30';
  queue = [answer(good)];
  r = await ask(demo, { text: 'Pace test question for M-01.' });
  assert.equal(r.data.code, 'slow_down');
  process.env.AI_ASSIST_USER_GAP_S = '0';
});

server.close(); fake.close();
fs.rmSync(filesDir, { recursive: true, force: true });
console.log(`\n${passed} AI help checks passed`);
