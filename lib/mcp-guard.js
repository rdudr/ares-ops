// The privacy guard of the AI report connector (lib/mcp.js). Everything the AI is sent passes
// through here, and so does everything it sends back.
//
//  1. Allow-list, not block-list: the AI is only ever given the "facts sheet" Report Studio saves for it
//     (record kind report_facts), field by field from ALLOWED below. It never reads the apps'
//     records, the report itself, bills, photos or the database.
//  2. Fail closed: before a result leaves, it is scanned for this audit's own names, address,
//     numbers and people (sensitiveTerms). A hit blocks the whole result and is logged.
//  3. The AI never writes a figure: its text may refer to numbers only as [[F.id]] fact references,
//     which the server fills in with Report Studio's own value when the draft is saved (checkDraft).
import crypto from 'node:crypto';

/** A random-looking but stable handle for the plant: what the AI calls it instead of its name. */
export function plantHandle(auditId) {
  const h = crypto.createHash('sha256').update(`ares-mcp:${auditId}`).digest();
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return 'PLANT-' + Array.from(h.subarray(0, 4), b => A[b % A.length]).join('');
}

// Words that are not names on their own (so "Textiles" in a company name does not block the word
// "textile" everywhere). Whole names, addresses and numbers are always checked.
const COMMON = new Set(('private limited pvt ltd llp industries industry company co corporation corp enterprises enterprise ' +
  'textiles textile mills mill works plant unit units factory pharma chemicals chemical foods food engineering ' +
  'gujarat india road street nagar area estate gidc phase plot shed near opp opposite floor main the and of ' +
  'district city town village taluka state sector block lane society park complex mr mrs ms dr shri smt ' +
  'test tester engineer team admin head member field staff project assistant fellow manager professor').split(' '));

const clean = v => String(v ?? '').trim();

/**
 * Everything about this audit that must never reach the AI: whole names, addresses and numbers
 * ("phrases", always blocked) and the single words of names ("words", blocked unless they are part
 * of the report's own vocabulary; see forSheet).
 */
export function sensitiveTerms(db, auditId, reportState) {
  const out = new Set();
  const wordSet = new Set();
  const add = (v, { words = true } = {}) => {
    const s = clean(v);
    if (s.length < 3) return;
    out.add(s.toLowerCase());
    const digits = s.replace(/[\s-]/g, '');
    if (/^\+?\d{6,}$/.test(digits)) out.add(digits);                // phone / consumer / pincode as one run
    if (words) for (const w of s.toLowerCase().split(/[^a-z0-9@.]+/)) if (w.length >= 4 && !COMMON.has(w)) wordSet.add(w);
  };
  const a = db.prepare(`SELECT c.name AS client, c.msme_no, s.name AS site, s.district, s.pincode, s.industry_tag, s.cluster
    FROM audits au JOIN sites s ON s.id = au.site_id JOIN clients c ON c.id = s.client_id WHERE au.id = ?`).get(auditId) || {};
  add(a.client); add(a.site); add(a.district); add(a.pincode); add(a.msme_no); add(a.industry_tag, { words: false });
  // Everyone in the Console, and anyone named in the report (our team and the plant's).
  for (const u of db.prepare('SELECT name, phone, email, login_id FROM users').all()) { add(u.name); add(u.phone); add(u.email); add(u.login_id, { words: false }); }
  for (const f of db.prepare('SELECT name, email FROM faculty').all()) { add(f.name); add(f.email); }
  const s = reportState || {};
  const co = s.company || {};
  for (const k of ['name', 'addr1', 'addr2', 'district', 'pincode', 'website', 'phone', 'mail', 'poc', 'dept']) add(co[k]);
  const pr = s.production || {};
  for (const k of ['website', 'phone', 'mail', 'factoryAddress']) add(pr[k]);
  for (const p of [...(s.team?.plant || []), ...(s.team?.iea || [])]) add(p?.name);
  // Consumer, meter, account and tax numbers wherever the bills keep them.
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 4) return;
    for (const [k, v] of Object.entries(o)) {
      if (/consumer|meter|account|gstin|msme|cin\b|pan\b|service.?no|connection/i.test(k) && (typeof v === 'string' || typeof v === 'number')) add(v, { words: false });
      else if (v && typeof v === 'object' && !/dataUrl|img|image|photo/i.test(k)) walk(v, depth + 1);
    }
  };
  walk(s.bills); walk(s.billCfg);
  out.delete('');
  return { phrases: [...out], words: [...wordSet].filter(w => !out.has(w) || w.includes(' ')) };
}

/**
 * The terms to scan with, for a facts sheet: single words that the report's own vocabulary uses
 * (chapter titles, figure labels, the connector's fixed wording) are dropped, so a company called
 * "Shree Motors" does not block the word "motors" everywhere. Whole names are still blocked.
 */
export function forSheet(terms, sheet, fixedText = '') {
  const vocab = new Set();
  const take = t => { for (const w of String(t || '').toLowerCase().split(/[^a-z0-9]+/)) if (w) vocab.add(w); };
  take(fixedText);
  for (const m of sheet?.modules || []) take(m.title);
  for (const f of sheet?.facts || []) take(f.label);
  for (const x of sheet?.series || []) take(x.label);
  for (const x of sheet?.slots || []) take(x.label);
  return { phrases: terms.phrases, words: terms.words.filter(w => !vocab.has(w)) };
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/;
const PHONE = /(?<!\d)(?:\+91[\s-]?)?[6-9]\d{9}(?!\d)/;

/** Terms of this audit found in a text that is about to leave the server (empty: safe to send). */
export function leaks(text, terms) {
  const t = String(text).toLowerCase();
  const found = [];
  const list = Array.isArray(terms) ? terms : [...(terms?.phrases || []), ...(terms?.words || [])];
  for (const term of list) {
    if (/^\d+$/.test(term)) { if (new RegExp(`(?<!\\d)${term}(?!\\d)`).test(t.replace(/[\s-]/g, ''))) found.push('a number of this plant'); }
    else if (term.length >= 4 && new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(t)) found.push('a name of this plant');
  }
  if (EMAIL.test(text)) found.push('an e-mail address');
  if (GSTIN.test(text)) found.push('a GSTIN');
  if (PHONE.test(text)) found.push('a phone number');
  return [...new Set(found)];
}

// ---------- what of the facts sheet may go out ----------
const ID = /^[A-Za-z0-9._:-]{1,80}$/;
const short = (v, n = 80) => clean(v).slice(0, n);
const numOrNull = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A value as a band (real audits, once allowed): 1-2-5 steps, percentages in tens. */
export function band(v, unit) {
  if (v === null) return null;
  if (unit === '%') { const lo = Math.floor(v / 10) * 10; return `${lo}–${lo + 10} %`; }
  if (v === 0) return '0';
  const sign = v < 0 ? '−' : '', a = Math.abs(v);
  const p = 10 ** Math.floor(Math.log10(a));
  const steps = [1, 2, 5, 10].map(x => x * p);
  const i = steps.findIndex(x => a < x);
  const lo = steps[Math.max(0, i - 1)], hi = steps[i];
  const f = x => x.toLocaleString('en-IN');
  return `${sign}${f(lo)}–${f(hi)}${unit ? ` ${unit}` : ''}`;
}

/**
 * The facts sheet as the AI may see it: only listed fields, short strings, and (for a real audit)
 * values as bands. Candidate texts lose their digits on real audits.
 */
export function maskFacts(sheet, { exact }) {
  const s = sheet || {};
  const show = (v, unit, display) => (exact ? (display ? short(display, 40) : v) : band(v, unit));
  return {
    report_type: s.reportType === 'walkthrough' ? 'walkthrough' : 'detailed',
    modules: (s.modules || []).filter(m => ID.test(m.id)).map(m => ({ id: m.id, title: short(m.title), enabled: !!m.enabled, records: numOrNull(m.records) })),
    slots: (s.slots || []).filter(x => ID.test(x.id)).map(x => ({ id: x.id, label: short(x.label), module: short(x.module, 40), filled: !!x.filled })),
    facts: (s.facts || []).filter(f => ID.test(f.id)).map(f => ({
      id: f.id, module: short(f.module, 40), equipment: short(f.equipment, 40) || undefined, label: short(f.label),
      unit: short(f.unit, 16) || undefined, value: show(numOrNull(f.value), short(f.unit, 16), f.display),
      rank: numOrNull(f.rank) ?? undefined, flag: ['good', 'watch', 'bad'].includes(f.flag) ? f.flag : undefined,
    })),
    series: (s.series || []).filter(x => ID.test(x.id)).map(x => ({
      id: x.id, module: short(x.module, 40), label: short(x.label), unit: short(x.unit, 16) || undefined,
      kind: x.kind === 'monthly' ? 'monthly' : 'equipment', types: (x.types || ['bar']).filter(t => ['bar', 'line'].includes(t)),
      points: exact ? (x.points || []).slice(0, 60).map(p => ({ x: short(p.x, 40), y: numOrNull(p.y) })) : (x.points || []).length,
    })),
    candidates: (s.candidates || []).filter(c => ID.test(c.id)).slice(0, 80).map(c => ({
      id: c.id, module: short(c.module, 40), equipment: short(c.equipment, 40) || undefined,
      hint: exact ? short(c.text, 400) : short(c.text, 400).replace(/\d[\d,.]*/g, '#'),
      facts: (c.facts || []).filter(x => ID.test(x)).slice(0, 12),
    })),
  };
}

// ---------- what the AI sends back ----------
const REF = /\[\[F\.([A-Za-z0-9._:-]{1,80})\]\]/g;
// Standard names and section numbers that contain digits but are not figures.
const ALLOWED_DIGITS = [
  /\bIEC\s?\d{4,5}(-\d+)*(-\d+)?\b/gi, /\bIEEE\s?\d{3,4}\b/gi, /\bIS\s?\d{3,5}(\s?\(Part\s?\d+\))?(:\d{4})?\b/gi, /\bISO\s?\d{3,5}\b/gi,
  /\bEN\s?\d{5}\b/gi, /\bIE[1-5]\b/g, /\b[1-3]-phase\b/gi, /\b(single|three)[- ]phase\b/gi, /\bR-?\d{2,3}[A-Z]?\b/g,
  /\bCO2\b/g, /\bPM2\.5\b/g, /\bScope\s[1-3]\b/gi, /\bBEE\s\d-star\b/gi, /\b[1-5]-star\b/gi, /\b(Table|Annexure|Annex|Section|Figure)[\s-]\d+(\.\d+)*(-\d+)?\b/gi,
  /\bT[58]\b/g, /\b24\s?x\s?7\b/gi, /\bClass\s?\d(\.\d)?\b/gi, /\bVFD\b/g, /\bIP\d{2}\b/g,
];
const NUMBER_WORDS = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|lakh|lakhs|crore|crores|million|half|double|twice|triple|thrice|quarter|percent|dozen)\b/i;

/** Checks one text: returns problems, and the fact ids it uses. */
function checkText(where, text, factIds, terms, tags = []) {
  const errors = [];
  const used = [];
  const t = String(text || '');
  if (!t.trim()) return { errors: [`${where}: is empty.`], used };
  if (t.length > 4000) errors.push(`${where}: is longer than 4000 characters.`);
  let rest = t.replace(REF, (_, id) => { used.push(id); if (!factIds.has(id)) errors.push(`${where}: [[F.${id}]] is not a fact of this audit. Use an id from get_facts.`); return ' '; });
  // This audit's own equipment tags (M-01, TR-2) are names, not figures.
  for (const tag of tags) rest = rest.split(tag).join(' ');
  for (const re of ALLOWED_DIGITS) rest = rest.replace(re, ' ');
  const stray = rest.match(/\d[\d,.]*/);
  if (stray) errors.push(`${where}: "${stray[0]}" is a number typed by hand. Every figure must be a fact reference such as [[F.bill.kwh.total]] from get_facts; write the sentence around it.`);
  const word = rest.match(NUMBER_WORDS);
  if (word) errors.push(`${where}: "${word[0]}" states a quantity in words. Use a fact reference, or say it without a quantity.`);
  if (/(about|approximately|approx\.?|around|nearly|almost|roughly|~)\s*\[\[F\./i.test(t)) errors.push(`${where}: do not round a fact ("about [[F…]]"); the fact is already shown at the right precision.`);
  if (/\[\[F\.[^\]]+\]\]\s?(%|kwh|kw|kva|rs|₹|inr|lux|°c|tr|cfm|bar|m3|t\b)/i.test(t)) errors.push(`${where}: do not type a unit after a fact reference; the fact carries its own unit.`);
  const leak = leaks(t, terms);
  if (leak.length) errors.push(`${where}: contains ${leak.join(', ')}. Refer to the plant only as "the plant".`);
  return { errors, used };
}

export const DRAFT_LIMITS = { sections: 30, recos: 30, charts: 12 };

/**
 * Checks a draft against the facts sheet. Returns { ok, errors[], draft } where draft is the
 * cleaned draft (only known fields).
 */
export function checkDraft(raw, sheet, terms) {
  const errors = [];
  const d = raw && typeof raw === 'object' ? raw : {};
  const factIds = new Set((sheet.facts || []).map(f => f.id));
  const slotIds = new Set((sheet.slots || []).map(s => s.id));
  const modules = new Set((sheet.modules || []).map(m => m.id));
  const series = new Map((sheet.series || []).map(s => [s.id, s]));
  const tags = [...new Set([...(sheet.facts || []).map(f => f.equipment), ...(sheet.candidates || []).map(c => c.equipment),
    ...(sheet.series || []).flatMap(x => (x.points || []).map(p => p.x))].filter(t => t && /\d/.test(t)).map(String))].sort((a, b) => b.length - a.length);
  const chk = (w, t) => checkText(w, t, factIds, terms, tags);
  const out = { sections: [], recos: [], charts: [] };
  const arr = (v, name) => { if (v === undefined) return []; if (!Array.isArray(v)) { errors.push(`${name} must be a list.`); return []; } if (v.length > DRAFT_LIMITS[name]) errors.push(`${name}: at most ${DRAFT_LIMITS[name]}.`); return v.slice(0, DRAFT_LIMITS[name]); };

  arr(d.sections, 'sections').forEach((s, i) => {
    const where = `sections[${i}]`;
    if (!slotIds.has(s?.slot)) { errors.push(`${where}.slot "${s?.slot}" is not a text slot of this report (see get_report_outline).`); return; }
    const r = chk(`${where}.text`, s.text);
    errors.push(...r.errors);
    out.sections.push({ slot: s.slot, text: String(s.text || ''), facts: r.used });
  });
  arr(d.recos, 'recos').forEach((r, i) => {
    const where = `recos[${i}]`;
    if (!modules.has(r?.module)) { errors.push(`${where}.module "${r?.module}" is not a chapter of this report.`); return; }
    const used = [];
    for (const k of ['title', 'observation', 'recommendation']) {
      const c = chk(`${where}.${k}`, r[k]);
      errors.push(...c.errors); used.push(...c.used);
    }
    if (r.title && String(r.title).length > 160) errors.push(`${where}.title: at most 160 characters.`);
    const eq = r.equipment ? String(r.equipment).slice(0, 40) : '';
    if (eq && leaks(eq, terms).length) errors.push(`${where}.equipment: not an equipment tag of this audit.`);
    out.recos.push({ module: r.module, equipment: eq || null, title: String(r.title || ''), observation: String(r.observation || ''),
      recommendation: String(r.recommendation || ''), priority: ['high', 'medium', 'low'].includes(r.priority) ? r.priority : 'medium', facts: [...new Set(used)] });
  });
  arr(d.charts, 'charts').forEach((c, i) => {
    const where = `charts[${i}]`;
    if (!modules.has(c?.module)) { errors.push(`${where}.module "${c?.module}" is not a chapter of this report.`); return; }
    const ids = Array.isArray(c.series) ? c.series.slice(0, 4) : [];
    if (!ids.length) errors.push(`${where}.series: give one to four series ids from get_chart_options.`);
    for (const id of ids) if (!series.has(id)) errors.push(`${where}.series: "${id}" is not a series of this audit.`);
    const type = c.type === 'line' ? 'line' : 'bar';
    for (const id of ids) { const s = series.get(id); if (s && s.types && !s.types.includes(type)) errors.push(`${where}: series "${id}" cannot be drawn as a ${type} chart (allowed: ${s.types.join(', ')}).`); }
    for (const k of ['title', 'caption']) {
      if (!c[k]) { if (k === 'title') errors.push(`${where}.title is needed.`); continue; }
      const r = chk(`${where}.${k}`, c[k]); errors.push(...r.errors);
    }
    out.charts.push({ module: c.module, series: ids, type, title: String(c.title || ''), caption: String(c.caption || '') });
  });
  if (!out.sections.length && !out.recos.length && !out.charts.length && !errors.length) errors.push('The draft is empty: give sections, recos or charts.');
  return { ok: errors.length === 0, errors: errors.slice(0, 40), draft: out };
}

/** Puts Report Studio's own values in place of the fact references (only on this server, when saving). */
export function resolveRefs(text, facts) {
  const byId = new Map(facts.map(f => [f.id, f]));
  return String(text).replace(REF, (_, id) => {
    const f = byId.get(id);
    if (!f) return '';
    if (f.display) return f.display;
    const v = typeof f.value === 'number' ? f.value.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : String(f.value ?? '');
    return f.unit ? `${v} ${f.unit}` : v;
  });
}
