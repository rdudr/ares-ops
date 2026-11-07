// The AI report connector: a remote MCP server (Streamable HTTP, stateless, JSON responses) at
// POST /mcp. An engineer adds it to Claude as a custom connector with a personal token made in the
// Console for ONE audit. Claude can then read that audit's cleaned facts sheet, pick findings and
// charts, and save a draft back as "AI suggestions", which Report Studio shows for accept / reject.
//
// Privacy (see lib/mcp-guard.js): the AI is given only the facts sheet Report Studio saves for it, field
// by field from an allow-list, under a random plant handle; every result is scanned for this
// audit's names, address, numbers and people and blocked if one is found; the AI never writes a
// figure (fact references only); nothing prints until an engineer accepts it in Report Studio.
//
// Off switches: MCP_CONNECTOR=off (whole connector); only audits marked "demo" are served unless
// MCP_REAL_DATA=on, and then values go out as bands, never exact.
//
// The protocol is implemented here directly (JSON-RPC 2.0 over one POST, no sessions), so the
// Console needs no web framework for it. Protocol revisions understood: see VERSIONS.
import crypto from 'node:crypto';
import { HttpError, readJson } from './http.js';
import { hashToken, newToken, randomId, rateLimiter } from './security.js';
import { logActivity } from './db.js';
import { publish } from './events.js';
import { SECTORS } from './apps.js';
import { aiOpen } from './ai-access.js';
import { plantHandle, sensitiveTerms, forSheet, leaks, maskFacts, checkDraft, resolveRefs } from './mcp-guard.js';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const TOKEN_DAYS = 30;
const callLimit = rateLimiter(240, 10 * 60 * 1000);
export const mcpEnabled = () => (process.env.MCP_CONNECTOR || 'on') !== 'off';
const realAllowed = () => process.env.MCP_REAL_DATA === 'on';

const INSTRUCTIONS = `You are helping a AR energy auditor (AR Energy Services) write one energy assessment report.
You see ONE plant, under a code name. You never see, and must never ask for or guess, the company's name, address, people, bills or photos.
Work like this: get_overview, then get_report_outline, get_facts and get_candidates for the chapter you are asked about, and get_chart_options for charts.
Every figure in your text must be a fact reference written exactly as [[F.<fact id>]] (from get_facts). Never type a number, a number in words, or a unit after a reference; the server fills in Report Studio's own value and unit when the draft is saved.
Standard names are fine (IEEE 519, IEC 61000-4-30, IS 1180, IE3, 3-phase, BEE Table 5-1).
Call validate_draft and fix every error it reports, then save_draft. Saved drafts go to the engineer as suggestions; nothing is printed until they accept it.
Write in plain, formal British English, as an energy audit report: observation, then recommendation, then the benefit.`;

const TOOLS = [
  { name: 'get_overview', title: 'Audit overview',
    description: 'The plant this connector is for (code name only), the kind of report, and which chapters have data.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'get_report_outline', title: 'Report outline',
    description: 'The chapters of the report and the text slots you may fill, with which are empty. Also the house style rules.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'get_facts', title: 'Facts',
    description: 'The figures of the report (Report Studio\'s own values) with their ids, for one chapter or all. Refer to a figure in your text only as [[F.<id>]].',
    inputSchema: { type: 'object', properties: { module: { type: 'string', description: 'Chapter id from get_overview, e.g. bills, motors, lux' }, page: { type: 'integer', minimum: 1 } }, additionalProperties: false } },
  { name: 'get_candidates', title: 'Candidate findings',
    description: 'Findings worked out by the field apps\' own rules (for example under-loaded motors, low ILER, dryer below the BEE range), each with the facts behind it. Choose and rank them; do not invent new figures.',
    inputSchema: { type: 'object', properties: { module: { type: 'string' } }, additionalProperties: false } },
  { name: 'get_chart_options', title: 'Chart options',
    description: 'Data series that Report Studio can draw as charts (monthly or per equipment), and which chart types each allows. A chart you propose is drawn by Report Studio from its own data.',
    inputSchema: { type: 'object', properties: { module: { type: 'string' } }, additionalProperties: false } },
  { name: 'validate_draft', title: 'Check a draft',
    description: 'Checks a draft without saving it. Returns every problem with where it is, so you can fix them all at once.',
    inputSchema: { $ref: '#/$defs/draftArgs', $defs: {} } },
  { name: 'save_draft', title: 'Save draft as suggestions',
    description: 'Saves the draft as AI suggestions for the engineer in Report Studio (they accept or reject each item). Refused unless the draft passes validate_draft.',
    inputSchema: {}, annotations: { destructiveHint: false, idempotentHint: false } },
];
const DRAFT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['draft'],
  properties: {
    note: { type: 'string', description: 'One line for the engineer: what this draft covers.' },
    draft: {
      type: 'object', additionalProperties: false,
      properties: {
        sections: { type: 'array', items: { type: 'object', required: ['slot', 'text'], additionalProperties: false,
          properties: { slot: { type: 'string', description: 'Slot id from get_report_outline' }, text: { type: 'string' } } } },
        recos: { type: 'array', items: { type: 'object', required: ['module', 'title', 'observation', 'recommendation'], additionalProperties: false,
          properties: { module: { type: 'string' }, equipment: { type: 'string', description: 'Equipment tag, e.g. M-01' }, title: { type: 'string' },
            observation: { type: 'string' }, recommendation: { type: 'string' }, priority: { type: 'string', enum: ['high', 'medium', 'low'] } } } },
        charts: { type: 'array', items: { type: 'object', required: ['module', 'series', 'title'], additionalProperties: false,
          properties: { module: { type: 'string' }, series: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4 },
            type: { type: 'string', enum: ['bar', 'line'] }, title: { type: 'string' }, caption: { type: 'string' } } } },
      },
    },
  },
};
TOOLS.find(t => t.name === 'validate_draft').inputSchema = DRAFT_SCHEMA;
TOOLS.find(t => t.name === 'save_draft').inputSchema = DRAFT_SCHEMA;
for (const t of TOOLS) if (t.name !== 'save_draft') t.annotations = { readOnlyHint: true };

// ---------- tokens (made on the audit page of the Console) ----------
export function createToken(db, { user, auditId, label }) {
  const raw = `kmcp_${newToken()}`;
  const id = randomId('MT', 6);
  const now = Date.now();
  db.prepare(`INSERT INTO mcp_tokens (id, user_id, audit_id, token_hash, label, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, user.id, auditId, hashToken(raw), label || null, now, now + TOKEN_DAYS * 864e5);
  return { id, token: raw, expires_at: now + TOKEN_DAYS * 864e5 };
}
function tokenFor(db, raw) {
  if (!/^kmcp_[A-Za-z0-9_-]{30,}$/.test(raw)) return null;
  const t = db.prepare(`SELECT t.*, u.name AS user_name, u.status AS user_status FROM mcp_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ?`).get(hashToken(raw));
  if (!t || t.revoked_at || t.expires_at < Date.now() || t.user_status !== 'active') return null;
  return t;
}

// ---------- the facts sheet (saved by Report Studio with the report) ----------
function readSheet(db, auditId) {
  const r = db.prepare(`SELECT payload, version, saved_at FROM records WHERE audit_id = ? AND app = 'report' AND kind = 'report_facts'
    ORDER BY saved_at DESC LIMIT 1`).get(auditId);
  if (!r) return null;
  try { return { ...JSON.parse(r.payload), _version: r.version, _saved: r.saved_at }; } catch { return null; }
}
function readReportState(db, auditId) {
  const main = db.prepare(`SELECT id, payload FROM records WHERE audit_id = ? AND app = 'report' AND kind = 'report' ORDER BY saved_at DESC LIMIT 1`).get(auditId);
  if (!main) return null;
  try {
    const p = JSON.parse(main.payload);
    const parts = [p.c || ''];
    for (let i = 1; i < (p.n || 1); i++) {
      const part = db.prepare("SELECT payload FROM records WHERE id = ? AND kind = 'report_part'").get(`${main.id}-p${i}`);
      parts.push(part ? JSON.parse(part.payload).c || '' : '');
    }
    return JSON.parse(parts.join(''));
  } catch { return null; }
}

// ---------- the tools ----------
function context(db, tok) {
  const audit = db.prepare(`SELECT au.id, au.status, au.synthetic, au.ai_until, c.sector FROM audits au JOIN sites s ON s.id = au.site_id
    JOIN clients c ON c.id = s.client_id WHERE au.id = ?`).get(tok.audit_id);
  if (!audit) throw new ToolError('This audit no longer exists.');
  if (!aiOpen(audit) && !realAllowed()) throw new ToolError('AI access to this audit is off (or its time ran out). Ask the AR Super Admin to turn it on.');
  const sheet = readSheet(db, audit.id);
  const exact = !!audit.synthetic;
  return { audit, sheet, exact, handle: plantHandle(audit.id) };
}
class ToolError extends Error {}
const needSheet = c => { if (!c.sheet) throw new ToolError('Report Studio has not saved this report yet. Ask the engineer to open the audit in Report Studio once (it saves the facts sheet), then try again.'); };
const byModule = (list, m) => (m ? list.filter(x => x.module === m) : list);

const HOUSE_STYLE = [
  'Formal report English; plain words; short sentences.',
  'Each recommendation: observation (what was measured), recommendation (what to do), and the benefit.',
  'Refer to the plant as "the plant" and to equipment by its tag (M-01, Office, first floor).',
  'Every figure as [[F.<id>]]; no typed numbers, no numbers in words, no units after a reference, no "about".',
];

// The connector's own wording: never a reason to block a result.
const FIXED_TEXT = () => [INSTRUCTIONS, HOUSE_STYLE.join(' '), JSON.stringify(TOOLS), 'demo audit exact values real audit values as bands only plant code'].join(' ');

const RUN = {
  get_overview(db, c) {
    needSheet(c);
    const m = maskFacts(c.sheet, { exact: c.exact });
    return {
      plant: c.handle, sector: c.exact ? (SECTORS[c.audit.sector] || 'industry') : undefined, report_type: m.report_type,
      data: c.exact ? 'demo audit: exact values' : 'real audit: values as bands only',
      chapters: m.modules.filter(x => x.enabled || x.records).map(x => ({ id: x.id, title: x.title, enabled: x.enabled, records: x.records ?? undefined,
        facts: m.facts.filter(f => f.module === x.id).length, candidates: m.candidates.filter(k => k.module === x.id).length,
        series: m.series.filter(s => s.module === x.id).length })),
      empty_text_slots: m.slots.filter(s => !s.filled).length,
      facts_saved: new Date(c.sheet._saved).toISOString(),
    };
  },
  get_report_outline(db, c) {
    needSheet(c);
    const m = maskFacts(c.sheet, { exact: c.exact });
    return { plant: c.handle, report_type: m.report_type, chapters: m.modules, text_slots: m.slots, house_style: HOUSE_STYLE };
  },
  get_facts(db, c, a) {
    needSheet(c);
    const m = maskFacts(c.sheet, { exact: c.exact });
    const all = byModule(m.facts, a.module);
    const page = Math.max(1, Number(a.page) || 1), size = 200;
    return { plant: c.handle, module: a.module || 'all', page, pages: Math.max(1, Math.ceil(all.length / size)), facts: all.slice((page - 1) * size, page * size),
      how_to_cite: 'Write [[F.<id>]] where the figure goes.' };
  },
  get_candidates(db, c, a) {
    needSheet(c);
    const m = maskFacts(c.sheet, { exact: c.exact });
    return { plant: c.handle, candidates: byModule(m.candidates, a.module) };
  },
  get_chart_options(db, c, a) {
    needSheet(c);
    const m = maskFacts(c.sheet, { exact: c.exact });
    return { plant: c.handle, series: byModule(m.series, a.module),
      how_to_use: 'Propose a chart in save_draft as {module, series:[ids], type:"bar"|"line", title, caption}. Report Studio draws it from its own data.' };
  },
  validate_draft(db, c, a, terms) {
    needSheet(c);
    const r = checkDraft(a.draft, c.sheet, terms);
    return { ok: r.ok, errors: r.errors, counts: { sections: r.draft.sections.length, recos: r.draft.recos.length, charts: r.draft.charts.length } };
  },
  save_draft(db, c, a, terms, tok) {
    needSheet(c);
    const r = checkDraft(a.draft, c.sheet, terms);
    if (!r.ok) return { ok: false, saved: false, errors: r.errors, next: 'Fix these and call save_draft again.' };
    const facts = c.sheet.facts || [];
    const items = [];
    r.draft.sections.forEach((s, i) => items.push({ id: `s${i}`, type: 'text', slot: s.slot, text: resolveRefs(s.text, facts), source: s.text, facts: s.facts }));
    r.draft.recos.forEach((x, i) => items.push({ id: `r${i}`, type: 'reco', module: x.module, equipment: x.equipment, priority: x.priority,
      title: resolveRefs(x.title, facts), observation: resolveRefs(x.observation, facts), recommendation: resolveRefs(x.recommendation, facts), facts: x.facts }));
    r.draft.charts.forEach((x, i) => items.push({ id: `c${i}`, type: 'chart', module: x.module, series: x.series, chart: x.type,
      title: resolveRefs(x.title, facts), caption: resolveRefs(x.caption, facts) }));
    const now = Date.now();
    const id = `ai-${c.audit.id}-${now.toString(36)}`.replace(/[^A-Za-z0-9-]/g, '-');
    const note = a.note ? String(a.note).slice(0, 200) : '';
    const payload = { schema: 'ares-ai-suggestion/v1', at: now, by: tok.user_name, token_label: tok.label || null, client: 'MCP connector',
      note: leaks(note, terms).length ? '' : note, facts_version: c.sheet._version, items };
    db.prepare(`INSERT INTO records (id, audit_id, app, user_id, updated_by, device_id, kind, tag, taken_at, saved_at, synced_at, version, payload)
      VALUES (?, ?, 'report', ?, ?, 'mcp', 'ai_suggestion', NULL, ?, ?, ?, 1, ?)`).run(id, c.audit.id, tok.user_id, tok.user_id, now, now, now, JSON.stringify(payload));
    publish(db, { audit_id: c.audit.id, app: 'report' });
    return { ok: true, saved: true, suggestion: id, items: items.length,
      next: 'Tell the engineer to open Report Studio > AI suggestions for this audit and accept or reject each item. Nothing is printed until accepted.' };
  },
};

// ---------- the endpoint ----------
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handleOne(db, tok, msg, terms, ip) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Invalid request.');
  const { id, method, params = {} } = msg;
  const isNote = id === undefined;
  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ares-report', title: 'AR report connector', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      } };
    }
    case 'notifications/initialized': case 'notifications/cancelled': return null;
    case 'ping': return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      const name = params.name, args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      const run = RUN[name];
      if (!run) return rpcError(id, -32602, `Unknown tool: ${name}`);
      let out, isError = false, blocked = 0;
      try {
        const c = context(db, tok);
        if (c.sheet) terms = forSheet(terms, c.sheet, FIXED_TEXT());
        out = run(db, c, args, terms, tok);
      } catch (e) {
        if (!(e instanceof ToolError)) { console.error('mcp tool', name, e); out = { error: 'The connector could not do that just now.' }; }
        else out = { error: e.message };
        isError = true;
      }
      let text = JSON.stringify(out, null, 1);
      // Fail closed: nothing of this audit's identity leaves, whatever produced it.
      const hit = leaks(text, terms);
      if (hit.length) { blocked = 1; isError = true; out = { error: 'Blocked by the privacy guard: this result contained data that may not leave the AR server. It has been logged.' }; text = JSON.stringify(out); }
      const bytes = Buffer.byteLength(text);
      db.prepare('INSERT INTO mcp_log (token_id, user_id, audit_id, tool, bytes, sha256, blocked, ok, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(tok.id, tok.user_id, tok.audit_id, name, bytes, crypto.createHash('sha256').update(text).digest('hex'), blocked, isError ? 0 : 1, Date.now());
      if (blocked) logActivity(db, { userId: tok.user_id, action: 'mcp.blocked', target: tok.audit_id, detail: `${name}: ${hit.join(', ')}`, ip });
      if (name === 'save_draft' && out.saved) logActivity(db, { userId: tok.user_id, action: 'mcp.draft_saved', target: tok.audit_id, detail: out.suggestion, ip });
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], structuredContent: out, isError } };
    }
    default:
      return isNote ? null : rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** POST /mcp (GET answers 405: this server sends no streams). */
export async function handleMcp(db, req, res, ip) {
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  if (!mcpEnabled()) return send(503, { error: 'The AR report connector is switched off.' });
  if (req.method !== 'POST') return send(405, { error: 'Use POST.' }, { Allow: 'POST' });
  const auth = String(req.headers.authorization || '');
  const raw = auth.replace(/^Bearer\s+/i, '').trim() || String(req.headers['x-ares-token'] || '').trim();
  const tok = tokenFor(db, raw);
  if (!tok) return send(401, { error: 'A valid AR connector token is needed (ARES Console > the audit > AI report connector).' }, { 'WWW-Authenticate': 'Bearer realm="ares-report"' });
  if (!callLimit(tok.id)) return send(429, { error: 'Too many calls; wait a few minutes.' }, { 'Retry-After': '120' });
  let body;
  try { body = await readJson(req, 128 * 1024); } catch (e) { if (e instanceof HttpError) return send(e.status, rpcError(null, -32700, e.message)); throw e; }
  db.prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), tok.id);
  const terms = sensitiveTerms(db, tok.audit_id, readReportState(db, tok.audit_id));
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.slice(0, 20).map(m => handleOne(db, tok, m, terms, ip)))).filter(Boolean);
    return out.length ? send(200, out) : send(202);
  }
  const out = await handleOne(db, tok, body, terms, ip);
  return out ? send(200, out) : send(202);
}
