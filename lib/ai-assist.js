// Real-time AI help in Report Studio (experiment, branch ai-assist).
//
// An engineer asks for one chapter ("Ask AI now") or asks for the chapter's insights, and the answer
// comes back in seconds as AI suggestions, the same records the Claude connector writes
// (kind ai_suggestion), so Report Studio shows them for accept / edit / reject as before.
//
// Any chat-completions API in the OpenAI format works; the server's settings choose which:
//   AI_ASSIST=on                    switches it on
//   AI_ASSIST_BASE_URL              default Gemini's OpenAI-compatible address
//   AI_ASSIST_KEY (or GEMINI_API_KEY), AI_ASSIST_MODEL (or GEMINI_MODEL)
//   AI_ASSIST_TIER=free|paid        free (default): demo audits only. A free key's provider may keep and read
//                                   what is sent (Google's unpaid tier does), so no client data goes to it.
//                                   paid: also real audits while their AI access is on.
//   AI_ASSIST_DAILY_MAX (50), AI_ASSIST_AUDIT_DAILY_MAX (25), AI_ASSIST_USER_GAP_S (15),
//   AI_ASSIST_TIMEOUT_S (60), AI_ASSIST_REASONING (empty: not sent; e.g. low)
//
// The same privacy rules as the connector (lib/mcp-guard.js): only the facts sheet Report Studio saved,
// from its allow-list, under the plant's code name; the whole prompt is scanned for this audit's names
// and numbers before it leaves, and refused if one is found; the answer may refer to figures only as
// [[F.id]] (checkDraft), and the server puts Report Studio's own values in when it saves.
import crypto from 'node:crypto';
import { logActivity } from './db.js';
import { publish } from './events.js';
import { aiOpen } from './ai-access.js';
import { plantHandle, sensitiveTerms, forSheet, leaks, maskFacts, checkDraft, checkText, resolveRefs } from './mcp-guard.js';

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const int = (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Math.max(0, Math.floor(Number(v))) : d);

export function assistConfig(env = process.env) {
  const key = env.AI_ASSIST_KEY || env.GEMINI_API_KEY || '';
  const baseUrl = String(env.AI_ASSIST_BASE_URL || GEMINI).replace(/\/*$/, '/');
  return {
    on: env.AI_ASSIST === 'on' && !!key,
    baseUrl, key,
    model: env.AI_ASSIST_MODEL || env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    provider: env.AI_ASSIST_PROVIDER || (baseUrl.includes('googleapis.com') ? 'Gemini' : 'AI'),
    tier: env.AI_ASSIST_TIER === 'paid' ? 'paid' : 'free',
    dailyMax: int(env.AI_ASSIST_DAILY_MAX, 50),
    auditDailyMax: int(env.AI_ASSIST_AUDIT_DAILY_MAX, 25),
    userGapMs: int(env.AI_ASSIST_USER_GAP_S, 15) * 1000,
    timeoutMs: Math.max(5, int(env.AI_ASSIST_TIMEOUT_S, 60)) * 1000,
    reasoning: env.AI_ASSIST_REASONING || '',
    retries: Math.min(4, int(env.AI_ASSIST_RETRIES, 2)),
    retryMs: int(env.AI_ASSIST_RETRY_MS, 2000),
    // The whole request, backup included, must finish before the tunnel in front gives up (Cloudflare: 100 s).
    budgetMs: Math.max(10, int(env.AI_ASSIST_BUDGET_S, 90)) * 1000,
    backups: backupsConfig(env),
  };
}

const NIM = 'https://integrate.api.nvidia.com/v1/';
const OPENROUTER = 'https://openrouter.ai/api/v1/';
/** Backups, tried in this order when the main provider fails: NVIDIA NIM, then OpenRouter. Each is off without
 *  its key; OpenRouter also needs a model. Several models (comma-separated) are tried in order. */
function backupsConfig(env) {
  if (env.AI_ASSIST_BACKUPS === 'off') return [];
  const list = [];
  const add = (provider, key, baseUrl, models, tier, timeoutS) => {
    if (!key) return;
    for (const model of String(models || '').split(',').map(x => x.trim()).filter(Boolean)) list.push({
      provider, key, model, baseUrl: String(baseUrl).replace(/\/*$/, '/'),
      // A free backup may keep what it is sent, like a free main key: demo audits only, unless set to paid.
      tier: tier === 'paid' ? 'paid' : 'free',
      timeoutMs: Math.max(5, int(timeoutS, 80)) * 1000, retries: 0, retryMs: 0, reasoning: '',
    });
  };
  add('NVIDIA NIM', env.NVIDIA_NIM_KEY, env.NVIDIA_NIM_BASE_URL || NIM, env.NVIDIA_NIM_MODEL || 'minimaxai/minimax-m3.1-flash',
    env.NVIDIA_NIM_TIER, env.NVIDIA_NIM_TIMEOUT_S);
  add('OpenRouter', env.OPENROUTER_API_KEY, env.OPENROUTER_BASE_URL || OPENROUTER, env.OPENROUTER_MODEL, env.OPENROUTER_TIER, env.OPENROUTER_TIMEOUT_S);
  return list;
}

// The provider's own error text, short and on one line, for the log.
function providerMessage(text) {
  let m = String(text || '');
  try { const d = JSON.parse(m); const e = Array.isArray(d) ? d[0]?.error : d?.error; if (e) m = [e.status, e.message].filter(Boolean).join(' '); } catch {}
  return m.replace(/\s+/g, ' ').slice(0, 300) || '(no text)';
}

export class AssistError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); }
}

// ---------- counting (table ai_assist_log in lib/db.js; `called` = the provider was asked) ----------
// The day as people here count it (India time); the cap resets at local midnight.
const IST = 5.5 * 3600e3;
export const dayStart = (now = Date.now()) => Math.floor((now + IST) / 864e5) * 864e5 - IST;
const callsToday = (db, now, auditId) => auditId
  ? db.prepare('SELECT COUNT(*) AS n FROM ai_assist_log WHERE called = 1 AND at >= ? AND audit_id = ?').get(dayStart(now), auditId).n
  : db.prepare('SELECT COUNT(*) AS n FROM ai_assist_log WHERE called = 1 AND at >= ?').get(dayStart(now)).n;
const lastByUser = new Map();

/** Whether this audit may be sent to the AI under the server's settings, and why not. */
export function assistAllowed(cfg, audit) {
  if (!cfg.on) return { ok: false, reason: 'Real-time AI is not switched on on this server.' };
  if (cfg.tier === 'free') return audit.synthetic ? { ok: true } : { ok: false, reason: 'This server uses a free AI key, which may keep what it is sent: only demo audits can use real-time AI.' };
  return aiOpen(audit) ? { ok: true } : { ok: false, reason: 'AI access to this audit is off (or its time ran out). Ask the AR Super Admin to turn it on.' };
}

export function assistStatus(db, cfg, audit, user, now = Date.now()) {
  const allowed = audit ? assistAllowed(cfg, audit) : { ok: cfg.on, reason: cfg.on ? '' : 'Real-time AI is not switched on on this server.' };
  const wait = Math.max(0, (lastByUser.get(user.id) || 0) + cfg.userGapMs - now);
  return {
    enabled: cfg.on, provider: cfg.provider, model: cfg.on ? cfg.model : null, tier: cfg.tier, demo_only: cfg.tier === 'free',
    backups: cfg.on ? cfg.backups.filter(b => !audit || backupAllowed(b, audit)).map(b => ({ provider: b.provider, model: b.model })) : [],
    allowed: allowed.ok, reason: allowed.reason || '',
    today: { used: callsToday(db, now), max: cfg.dailyMax, audit_used: audit ? callsToday(db, now, audit.id) : null, audit_max: cfg.auditDailyMax },
    wait_s: Math.ceil(wait / 1000), resets: 'midnight India time',
  };
}

const backupAllowed = (b, audit) => b.tier === 'paid' || !!audit.synthetic;
// Failures of the provider itself, where another provider may well answer.
const FALLBACK_ON = /^(unavailable|timeout|quota|quota_minute|billing|key|model|provider|empty|format)$/;

// ---------- the provider ----------
/** A provider's refusal, in plain words: quota used up, billing, the key, the model, or down. */
export function classifyProviderError(status, text) {
  const t = String(text || '');
  const perMinute = /per\s?minute|PerMinute|RPM|TPM|temporarily|retry shortly/i.test(t);
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(t)) {
    if (/billing/i.test(t) && !perMinute) return billing();
    return perMinute
      ? new AssistError(429, 'quota_minute', 'Too many AI requests in the last minute (the AI service\'s own limit). Wait a minute and try again.', { retry_s: 60 })
      : new AssistError(429, 'quota', 'The AI service\'s quota for this key is used up for now (free tier). It refills over the day; the daily count restarts at 1:30 pm India time. Try again later, or ask an Admin about a paid key.');
  }
  if (status === 402 || /billing|payment|BILLING_DISABLED|insufficient (funds|balance|credit)/i.test(t)) return billing();
  if (status === 401 || status === 403 || /API[_ ]?key|API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED|invalid authentication/i.test(t))
    return new AssistError(503, 'key', 'The AI service refused this server\'s key (not valid, expired or not allowed for this model). An Admin needs to check the AI key.');
  if (status === 404 || /model.*(not found|does not exist|not supported)/i.test(t))
    return new AssistError(503, 'model', 'The AI model set on this server is not available from the AI service. An Admin needs to check the model name.');
  if (status === 400) return new AssistError(502, 'provider', 'The AI service could not take this request. Try a shorter request; if it keeps happening, tell an Admin.');
  return new AssistError(503, 'unavailable', 'The AI service is not answering right now. Try again in a minute.');
  function billing() {
    return new AssistError(402, 'billing', 'The AI service refused the request because of billing: the key\'s Google project has no working billing, or this model is not free for it. An Admin needs to check billing for the AI key.');
  }
}

async function chat(cfg, messages, schema, name, fetchImpl = fetch, deadline = Infinity) {
  const body = { model: cfg.model, messages, response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } } };
  if (cfg.reasoning) body.reasoning_effort = cfg.reasoning;
  // A busy model answers 500/503 now and then and is fine a moment later, so those (and a
  // dropped connection) are tried again a couple of times before the person sees an error.
  // What the provider said is logged (never the key or the prompt), so a failure can be read later.
  const tries = 1 + cfg.retries;
  let r, text;
  const timedOut = () => new AssistError(504, 'timeout', 'The AI service took too long to answer. Try again, or ask for less at once.');
  for (let n = 1; ; n++) {
    let netErr = null;
    const waitMs = Math.min(cfg.timeoutMs, deadline - Date.now());
    if (waitMs < 3000) throw timedOut();
    try {
      r = await fetchImpl(`${cfg.baseUrl}chat/completions`, {
        method: 'POST', signal: AbortSignal.timeout(waitMs),
        headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      text = await r.text();
    } catch (e) {
      if (e?.name === 'TimeoutError') {
        console.warn(`ai-assist: ${cfg.model} timed out after ${Math.round(waitMs / 1000)} s`);
        throw timedOut();
      }
      netErr = e;
    }
    if (!netErr && r.ok) break;
    const why = netErr ? `network: ${netErr.cause?.code || netErr.message}` : `HTTP ${r.status}: ${providerMessage(text)}`;
    const retry = n < tries && (netErr || r.status >= 500) && deadline - Date.now() > cfg.retryMs * n + 5000;
    console.warn(`ai-assist: ${cfg.model} failed (try ${n} of ${tries}${retry ? ', trying again' : ''}) ${why}`);
    if (!retry) {
      if (netErr) throw new AssistError(503, 'unavailable', 'The AI service could not be reached from this server. Try again in a minute.');
      throw classifyProviderError(r.status, text);
    }
    await new Promise(res => setTimeout(res, cfg.retryMs * n));
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new AssistError(502, 'provider', 'The AI service sent an answer this server could not read.'); }
  // Some OpenAI-compatible layers wrap an error in a 200.
  const err = Array.isArray(data) ? data[0]?.error : data?.error;
  if (err) {
    console.warn(`ai-assist: ${cfg.model} answered with an error: ${providerMessage(JSON.stringify({ error: err }))}`);
    throw classifyProviderError(Number(err.code) || 500, JSON.stringify(err));
  }
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (!content) throw new AssistError(502, 'empty', choice?.finish_reason === 'length'
    ? 'The AI\'s answer was cut off (too long). Ask for less at once.' : 'The AI gave no answer. Try rewording the request.');
  let parsed;
  try { parsed = JSON.parse(String(content).replace(/^```(?:json)?\s*|\s*```$/g, '')); }
  catch { throw new AssistError(502, 'format', 'The AI\'s answer was not in the expected form. Try again.'); }
  return { parsed, usage: data.usage || {}, model: data.model || cfg.model };
}

// ---------- what the AI is given ----------
const RULES = `You help an AR Enterprise energy auditor write an energy assessment report. You see ONE plant, under a code name.
Rules, all of them:
1. Never type a number, a number in words, a percentage or an amount of money. Every figure is a fact reference written exactly as [[F.<fact id>]], using only the fact ids given. Do not put a unit after a reference, and do not write "about" before one.
2. Equipment tags such as M-01 are names and may be written. Standard names (IEC 60034-30-1, IS 1180, IE3, BEE) are fine.
3. Never name the company, the site, a place or a person. Say "the plant".
4. Use only the facts, candidate findings and chart series given. If they do not support an answer, say so in one sentence instead of guessing.
5. Write plain, formal British English in short sentences: what was measured, what it means, what to do, and the benefit.`;

const ASK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['note', 'text', 'recos', 'charts'],
  properties: {
    note: { type: 'string', description: 'One line for the engineer: what this answer covers.' },
    text: { type: 'string', description: 'The analysis paragraph(s) for the chapter; empty if the request asks only for recommendations or a chart.' },
    recos: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['equipment', 'title', 'observation', 'recommendation', 'priority'],
      properties: { equipment: { type: 'string', description: 'Equipment tag, or empty' }, title: { type: 'string' }, observation: { type: 'string' },
        recommendation: { type: 'string' }, priority: { type: 'string', enum: ['high', 'medium', 'low'] } } } },
    charts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['series', 'type', 'title', 'caption'],
      properties: { series: { type: 'array', items: { type: 'string' } }, type: { type: 'string', enum: ['bar', 'line'] },
        title: { type: 'string' }, caption: { type: 'string' } } } },
  },
};
const INSIGHT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['insights'],
  properties: { insights: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['chapter', 'title', 'text', 'level'],
    properties: { chapter: { type: 'string', description: 'The chapter id the insight belongs to' }, title: { type: 'string' },
      text: { type: 'string' }, level: { type: 'string', enum: ['high', 'medium', 'low'] } } } } },
};

/** The facts the AI gets for one chapter (or the strongest of every chapter), already masked. */
function chapterPack(m, chapter) {
  const pick = (list, n) => list.slice(0, n);
  if (chapter !== 'all') {
    return { chapter, facts: pick(m.facts.filter(f => f.module === chapter), 220), candidates: pick(m.candidates.filter(c => c.module === chapter), 30),
      series: pick(m.series.filter(s => s.module === chapter).map(s => ({ id: s.id, label: s.label, unit: s.unit, kind: s.kind, types: s.types })), 12) };
  }
  // The whole audit: flagged facts and candidate findings first, then a few per chapter.
  const per = new Map();
  const facts = [];
  const sorted = [...m.facts].sort((a, b) => (b.flag === 'bad') - (a.flag === 'bad') || (b.flag === 'watch') - (a.flag === 'watch'));
  for (const f of sorted) { const n = per.get(f.module) || 0; if (n < 25) { per.set(f.module, n + 1); facts.push(f); } if (facts.length >= 300) break; }
  return { chapter: 'all', facts, candidates: pick(m.candidates, 60), series: [] };
}

// Report Studio's own save of the report, joined from its pieces (for this audit's names in it).
function readReportState(db, auditId) {
  const main = db.prepare(`SELECT id, payload FROM records WHERE audit_id = ? AND app = 'report' AND kind = 'report' ORDER BY saved_at DESC LIMIT 1`).get(auditId);
  if (!main) return null;
  try {
    const p = JSON.parse(main.payload);
    const ids = Array.isArray(p.parts) ? p.parts : Array.from({ length: Math.max(0, (p.n || 1) - 1) }, (_, i) => `${main.id}-p${i + 1}`);
    const parts = [p.c || ''];
    for (const id of ids) {
      const part = db.prepare("SELECT payload FROM records WHERE id = ? AND kind = 'report_part'").get(id);
      parts.push(part ? JSON.parse(part.payload).c || '' : '');
    }
    return JSON.parse(parts.join(''));
  } catch { return null; }
}
function readSheet(db, auditId) {
  const r = db.prepare(`SELECT payload, version, saved_at FROM records WHERE audit_id = ? AND app = 'report' AND kind = 'report_facts'
    ORDER BY saved_at DESC LIMIT 1`).get(auditId);
  if (!r) return null;
  try { return { ...JSON.parse(r.payload), _version: r.version, _saved: r.saved_at }; } catch { return null; }
}

// ---------- one question ----------
/**
 * kind 'ask': { chapter, text, focus, request_id } -> suggestions answering the request.
 * kind 'insights': { chapter } ('all' for the whole audit) -> insight items.
 */
export async function runAssist(db, { cfg, audit, user, kind, input, ip, now = Date.now(), fetchImpl }) {
  let served = { provider: cfg.provider, model: cfg.model };
  const log = (fields) => db.prepare(`INSERT INTO ai_assist_log (at, user_id, audit_id, kind, chapter, ask_hash, model, called, ok, code, ms, prompt_tokens, answer_tokens, suggestion_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(now, user.id, audit.id, kind, input.chapter || null, fields.hash || null, served.model,
    fields.called ? 1 : 0, fields.ok ? 1 : 0, fields.code || null, fields.ms ?? null, fields.pt ?? null, fields.at ?? null, fields.suggestion || null);
  const refuse = (status, code, message, extra) => { log({ code }); throw new AssistError(status, code, message, extra); };

  const allowed = assistAllowed(cfg, audit);
  if (!allowed.ok) refuse(403, 'not_allowed', allowed.reason);
  const sheet = readSheet(db, audit.id);
  if (!sheet) refuse(409, 'no_sheet', 'Report Studio has not saved this report\'s figures yet. Save the report once, then ask again.');
  const m = maskFacts(sheet, { exact: !!audit.synthetic });
  const chapters = new Map(m.modules.map(x => [x.id, x.title]));
  const chapter = String(input.chapter || '');
  if (kind === 'ask' && !chapters.has(chapter)) refuse(400, 'chapter', 'This chapter has no figures in the saved report yet. Save the report, then ask again.');
  if (kind === 'insights' && chapter !== 'all' && !chapters.has(chapter)) refuse(400, 'chapter', 'This chapter has no figures in the saved report yet.');
  const request = kind === 'ask' ? String(input.text || '').trim().slice(0, 1200) : '';
  if (kind === 'ask' && request.length < 8) refuse(400, 'request', 'Write a little more for the AI to work from.');

  // The same question on the same saved figures today: the earlier answer, without asking again.
  const hash = crypto.createHash('sha256').update(JSON.stringify([kind, chapter, request, input.focus || '', sheet._version, audit.id])).digest('hex');
  const same = db.prepare('SELECT suggestion_id FROM ai_assist_log WHERE ask_hash = ? AND ok = 1 AND suggestion_id IS NOT NULL AND at >= ? ORDER BY at DESC LIMIT 1')
    .get(hash, dayStart(now));
  if (same) {
    const still = db.prepare("SELECT payload FROM records WHERE id = ? AND kind = 'ai_suggestion'").get(same.suggestion_id);
    if (still && !JSON.parse(still.payload)._deleted) {
      if (kind === 'ask' && input.request_id) addAnswer(db, same.suggestion_id, String(input.request_id), audit.id);
      log({ hash, ok: true, code: 'reused', suggestion: same.suggestion_id });
      return { ok: true, reused: true, suggestion: same.suggestion_id, items: JSON.parse(still.payload).items.length };
    }
  }

  // Limits: this person's pace, this audit's day, this server's day.
  const last = lastByUser.get(user.id) || 0;
  if (now - last < cfg.userGapMs) refuse(429, 'slow_down', `Please wait ${Math.ceil((last + cfg.userGapMs - now) / 1000)} seconds before the next AI request.`, { retry_s: Math.ceil((last + cfg.userGapMs - now) / 1000) });
  if (callsToday(db, now) >= cfg.dailyMax) refuse(429, 'cap', `This server's AI limit for today (${cfg.dailyMax} requests) is used up. It starts again at midnight India time.`);
  if (callsToday(db, now, audit.id) >= cfg.auditDailyMax) refuse(429, 'cap_audit', `This audit's AI limit for today (${cfg.auditDailyMax} requests) is used up. It starts again at midnight India time.`);

  const handle = plantHandle(audit.id);
  const pack = chapterPack(m, chapter);
  const feedback = (Array.isArray(sheet.feedback) ? sheet.feedback : []).filter(f => !chapter || chapter === 'all' || f.module === chapter)
    .slice(-8).map(f => String(f.reason || '').slice(0, 300)).filter(Boolean);
  const focus = kind === 'ask' && input.focus ? pack.series.find(s => s.id === input.focus) : null;
  const slot = `chapter:${chapter}`;
  const hasSlot = (sheet.slots || []).some(s => s.id === slot);
  const task = kind === 'ask'
    ? `Answer the engineer's request for the chapter "${chapters.get(chapter)}" (id ${chapter}).` +
      (hasSlot ? ' Put any analysis paragraph in "text".' : ' This chapter has no analysis paragraph slot: leave "text" empty and answer with recommendations or charts.') +
      ' Give recommendations only when the request asks for them or the facts clearly call for them (at most four). Propose a chart only from the series given (at most two).'
    : chapter === 'all'
      ? 'Give the most useful insights for the whole audit (at most six), strongest first: what stands out, why it matters, what to look at. Each names its chapter id.'
      : `Give the most useful insights for the chapter "${chapters.get(chapter)}" (id ${chapter}), at most five, strongest first: what stands out, why it matters, what to look at. Use chapter id ${chapter} for each.`;
  const userMsg = JSON.stringify({
    plant: handle, report_type: m.report_type, task,
    ...(kind === 'ask' ? { request, focus_series: focus ? focus.id : undefined } : {}),
    chapters: [...chapters].map(([id, title]) => ({ id, title })),
    facts: pack.facts.map(f => ({ id: f.id, chapter: f.module, equipment: f.equipment, label: f.label, value: f.value, unit: f.unit, flag: f.flag })),
    candidate_findings: pack.candidates.map(c => ({ chapter: c.module, equipment: c.equipment, hint: c.hint, facts: c.facts })),
    chart_series: pack.series,
    earlier_rejections: feedback.length ? feedback : undefined,
  });

  // Fail closed: nothing of this audit's identity leaves, the engineer's own words included.
  const terms = forSheet(sensitiveTerms(db, audit.id, readReportState(db, audit.id)), sheet, RULES + ' ' + task);
  const outHit = leaks(userMsg, terms);
  if (outHit.length) {
    logActivity(db, { userId: user.id, action: 'ai.assist_blocked', target: audit.id, detail: `${kind}: ${outHit.join(', ')}`, ip });
    refuse(422, 'blocked', kind === 'ask'
      ? 'Your request names the plant, a person, or a number of this plant, which may not be sent to the AI. Reword it without them (refer to equipment by its tag).'
      : 'The report\'s figures contain something that may not be sent to the AI. It has been logged; tell an Admin.');
  }

  lastByUser.set(user.id, now);
  const messages = [{ role: 'system', content: RULES }, { role: 'user', content: userMsg }];
  const t0 = Date.now();
  let usage = { prompt_tokens: 0, completion_tokens: 0 }, model = cfg.model;
  const deadline = t0 + cfg.budgetMs;
  const backups = cfg.backups.filter(b => backupAllowed(b, audit));
  // With a backup waiting, the main provider gets less time, so the backup still has enough.
  const main = backups.length ? { ...cfg, timeoutMs: Math.min(cfg.timeoutMs, 25000), retries: Math.min(cfg.retries, 1) } : cfg;
  let current = main;
  const schemaArgs = kind === 'ask' ? [ASK_SCHEMA, 'chapter_answer'] : [INSIGHT_SCHEMA, 'insights'];
  const ask = async (msgs) => {
    let r;
    for (let i = backups.indexOf(current); ; i++) {
      try { r = await chat(current, msgs, ...schemaArgs, fetchImpl, deadline); break; }
      catch (e) {
        const next = backups[i + 1];
        if (!(e instanceof AssistError) || !FALLBACK_ON.test(e.code) || !next || deadline - Date.now() < 15000) {
          if (current !== main && main.firstError) throw new AssistError(main.firstError.status, main.firstError.code,
            `${main.firstError.message} The backup AI (${current.provider}) did not answer either: ${e.message}`, { retry_s: main.firstError.retry_s });
          throw e;
        }
        if (current === main) main.firstError = e;
        console.warn(`ai-assist: ${current.model} failed (${e.code}); asking the backup ${next.provider} ${next.model}`);
        current = next;
      }
    }
    usage = { prompt_tokens: usage.prompt_tokens + (r.usage.prompt_tokens || 0), completion_tokens: usage.completion_tokens + (r.usage.completion_tokens || 0) };
    model = r.model;
    served = { provider: current.provider, model: current.model };
    return r.parsed;
  };
  const finish = (fields) => log({ hash, called: true, ms: Date.now() - t0, pt: usage.prompt_tokens, at: usage.completion_tokens, ...fields });

  let check;
  try {
    let answer = await ask(messages);
    check = kind === 'ask' ? checkAsk(answer, sheet, terms, chapter, hasSlot) : checkInsights(answer, sheet, terms, chapters, chapter);
    if (!check.ok) {
      // One more go, with the reasons: the rules are strict and small models slip.
      answer = await ask([...messages, { role: 'assistant', content: JSON.stringify(answer) },
        { role: 'user', content: `That answer broke the rules:\n- ${check.errors.slice(0, 12).join('\n- ')}\nSend the whole answer again, corrected.` }]);
      check = kind === 'ask' ? checkAsk(answer, sheet, terms, chapter, hasSlot) : checkInsights(answer, sheet, terms, chapters, chapter);
    }
  } catch (e) {
    finish({ code: e.code || 'error' });
    if (e instanceof AssistError) throw e;
    throw new AssistError(503, 'unavailable', 'The AI request failed. Try again in a minute.');
  }
  if (!check.ok) {
    finish({ code: 'invalid' });
    throw new AssistError(422, 'invalid', 'The AI\'s answer broke the report rules twice (for example a typed number), so it was not kept. Try rewording the request.',
      { problems: check.errors.slice(0, 5) });
  }

  // Saved like the connector's drafts: Report Studio's own values in place of the references.
  const facts = sheet.facts || [];
  const items = check.items(facts);
  const id = `ai-${audit.id}-${now.toString(36)}${crypto.randomBytes(2).toString('hex')}`.replace(/[^A-Za-z0-9-]/g, '-');
  const note = check.note && !leaks(check.note, terms).length ? check.note.slice(0, 200) : '';
  const payload = { schema: 'ares-ai-suggestion/v1', at: now, by: user.name, client: `${served.provider} (${model})`, source: 'assist', purpose: kind, chapter,
    note, facts_version: sheet._version, items, ...(kind === 'ask' && input.request_id ? { answers: [String(input.request_id).slice(0, 80)] } : {}) };
  db.prepare(`INSERT INTO records (id, audit_id, app, user_id, updated_by, device_id, kind, tag, taken_at, saved_at, synced_at, version, payload)
    VALUES (?, ?, 'report', ?, ?, 'ai-assist', 'ai_suggestion', NULL, ?, ?, ?, 1, ?)`).run(id, audit.id, user.id, user.id, now, now, now, JSON.stringify(payload));
  finish({ ok: true, suggestion: id });
  logActivity(db, { userId: user.id, action: kind === 'ask' ? 'ai.assist_answered' : 'ai.assist_insights', target: audit.id,
    detail: `${chapter} · ${items.length} item(s) · ${model} · ${usage.prompt_tokens}+${usage.completion_tokens} tokens`, ip });
  publish(db, { audit_id: audit.id, app: 'report', what: 'ai' });
  return { ok: true, suggestion: id, items: items.length, model, provider: served.provider, backup: served.provider !== cfg.provider || served.model !== cfg.model,
    ms: Date.now() - t0, tokens: usage };
}

function addAnswer(db, suggestionId, requestId, auditId) {
  const r = db.prepare("SELECT payload, version FROM records WHERE id = ? AND kind = 'ai_suggestion'").get(suggestionId);
  if (!r) return;
  const p = JSON.parse(r.payload);
  if ((p.answers || []).includes(requestId)) return;
  p.answers = [...(p.answers || []), requestId];
  const now = Date.now();
  db.prepare('UPDATE records SET payload = ?, version = version + 1, saved_at = ?, synced_at = ? WHERE id = ?').run(JSON.stringify(p), now, now, suggestionId);
  publish(db, { audit_id: auditId, app: 'report', what: 'ai' });
}

/** An "ask" answer against the rules: the chapter's slot, recommendations and charts of this chapter. */
function checkAsk(a, sheet, terms, chapter, hasSlot) {
  const text = String(a?.text || '').trim();
  const draft = {
    sections: text && hasSlot ? [{ slot: `chapter:${chapter}`, text }] : [],
    recos: (Array.isArray(a?.recos) ? a.recos : []).slice(0, 4).map(r => ({ module: chapter, equipment: String(r.equipment || '').trim() || undefined,
      title: r.title, observation: r.observation, recommendation: r.recommendation, priority: r.priority })),
    charts: (Array.isArray(a?.charts) ? a.charts : []).slice(0, 2).map(c => ({ module: chapter, series: c.series, type: c.type, title: c.title, caption: c.caption })),
  };
  const errors = [];
  if (text && !hasSlot) errors.push('"text" must be empty: this chapter has no analysis paragraph; answer with recommendations or charts.');
  const r = checkDraft(draft, sheet, terms);
  errors.push(...r.errors);
  return {
    ok: errors.length === 0, errors, note: String(a?.note || ''),
    items: facts => [
      ...r.draft.sections.map((s, i) => ({ id: `s${i}`, type: 'text', slot: s.slot, module: chapter, text: resolveRefs(s.text, facts), source: s.text, facts: s.facts })),
      ...r.draft.recos.map((x, i) => ({ id: `r${i}`, type: 'reco', module: x.module, equipment: x.equipment, priority: x.priority,
        title: resolveRefs(x.title, facts), observation: resolveRefs(x.observation, facts), recommendation: resolveRefs(x.recommendation, facts), facts: x.facts })),
      ...r.draft.charts.map((x, i) => ({ id: `c${i}`, type: 'chart', module: x.module, series: x.series, chart: x.type,
        title: resolveRefs(x.title, facts), caption: resolveRefs(x.caption, facts) })),
    ],
  };
}

/** Insights: short notes for the engineer (not printed unless they use one), each with its chapter. */
function checkInsights(a, sheet, terms, chapters, chapter) {
  const errors = [];
  const list = (Array.isArray(a?.insights) ? a.insights : []).slice(0, chapter === 'all' ? 6 : 5);
  if (!list.length) errors.push('Give at least one insight.');
  const factIds = new Set((sheet.facts || []).map(f => f.id));
  const tags = [...new Set([...(sheet.facts || []).map(f => f.equipment), ...(sheet.candidates || []).map(c => c.equipment)]
    .filter(t => t && /\d/.test(t)).map(String))].sort((x, y) => y.length - x.length);
  const out = [];
  list.forEach((x, i) => {
    const mod = chapter === 'all' ? String(x.chapter || '') : chapter;
    if (!chapters.has(mod)) { errors.push(`insights[${i}].chapter "${x.chapter}" is not a chapter of this report.`); return; }
    const t1 = checkText(`insights[${i}].title`, x.title, factIds, terms, tags);
    const t2 = checkText(`insights[${i}].text`, x.text, factIds, terms, tags);
    errors.push(...t1.errors, ...t2.errors);
    if (String(x.title || '').length > 160) errors.push(`insights[${i}].title: at most 160 characters.`);
    out.push({ module: mod, title: String(x.title || ''), text: String(x.text || ''), level: ['high', 'medium', 'low'].includes(x.level) ? x.level : 'medium',
      facts: [...new Set([...t1.used, ...t2.used])] });
  });
  return {
    ok: errors.length === 0, errors, note: '',
    items: facts => out.map((x, i) => ({ id: `i${i}`, type: 'insight', module: x.module, level: x.level,
      title: resolveRefs(x.title, facts), text: resolveRefs(x.text, facts), source: x.text, facts: x.facts })),
  };
}
