// What must never reach the AI about one audit: the report connector masks these in everything it
// sends out and refuses a result that still holds one. Kept here, beside the data, so the connector
// does not guess at what identifies a company. (The older /mcp connector has its own list in
// lib/mcp-guard.js; the single words rule and the list of common words are shared with it.)
//
//   company  the company as written anywhere: registered name, the names the apps saved
//   places   plant, area, address, district, pincode
//   people   everyone with an ARES account, the advisors, and contact people in a company profile
//   ids      numbers that identify: MSME, GSTIN, consumer / meter / account numbers, phones, e-mails
//   words    the single words of the names above (at least four letters, not an everyday word)
import { COMMON } from './mcp-guard.js';

// "unit" alone is left out on purpose: it is as often a unit of measure (kVA) as the name of a unit.
const NAME_KEY = /^(company|client|plant|site|factory|firm|organisation|organization)(_?name)?$|companyname|plantname|sitename|unit_?name|factory_?name/i;
const PLACE_KEY = /^(area|address|addr\d?|street|landmark|locality|village|taluka|district|city|pincode|pin|location)$|address/i;
const PERSON_KEY = /contact|person|owner|proprietor|director|manager|representative|\bpoc\b|prepared_?by|checked_?by|auditor/i;
const ID_KEY = /consumer|meter_?(no|number|id)|account|gstin|msme|udyam|\bcin\b|\bpan\b|service_?(no|number)|connection|phone|mobile|e-?mail|website/i;
const SKIP_KEY = /dataurl|img|image|photo|logo|payload_b64/i;

const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
// A typed name: some letters, and not just one everyday word ("Plant", "Unit", "kVA", "Yes").
const isName = v => { const s = clean(v).toLowerCase(); return /[a-z]{2}/.test(s) && s.length >= 4 && !(COMMON.has(s) || /^[a-z]{1,4}$/.test(s) && !/\s/.test(s)); };

export function aiTerms(db, auditId) {
  const company = new Set(), places = new Set(), people = new Set(), ids = new Set();
  const put = (set, v, min = 3) => { const s = clean(v); if (s.length >= min && s.length <= 160) set.add(s); };

  const a = db.prepare(`SELECT c.name AS client, c.msme_no, s.name AS site, s.district, s.pincode, s.industry_tag
    FROM audits au JOIN sites s ON s.id = au.site_id JOIN clients c ON c.id = s.client_id WHERE au.id = ?`).get(auditId);
  if (!a) return null;
  put(company, a.client); put(places, a.site); put(places, a.district); put(ids, a.pincode, 6); put(ids, a.msme_no, 5); put(ids, a.industry_tag, 4);

  for (const u of db.prepare('SELECT name, phone, email, login_id FROM users').all()) { put(people, u.name); put(ids, u.phone, 6); put(ids, u.email, 5); put(ids, u.login_id, 4); }
  for (const f of db.prepare('SELECT name, email FROM faculty').all()) { put(people, f.name); put(ids, f.email, 5); }

  // What the team typed about the company: each app's company profile, the Ledger's bill settings,
  // and Report Studio's own report. Only fields whose name says what they hold are taken.
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 5) return;
    for (const [k, v] of Object.entries(o)) {
      if (SKIP_KEY.test(k)) continue;
      if (v && typeof v === 'object') { walk(v, depth + 1); continue; }
      if (typeof v !== 'string' && typeof v !== 'number') continue;
      if (ID_KEY.test(k)) put(ids, v, 5);
      else if (!isName(v)) continue;
      else if (NAME_KEY.test(k)) put(company, v);
      else if (PERSON_KEY.test(k)) put(people, v);
      else if (PLACE_KEY.test(k)) put(/^(pincode|pin)$/i.test(k) ? ids : places, v, /^(pincode|pin)$/i.test(k) ? 6 : 3);
    }
  };
  const rows = db.prepare(`SELECT kind, payload FROM records WHERE audit_id = ?
    AND kind IN ('company_profile', 'ledger_bills', 'ledger_baseline', 'report') ORDER BY saved_at DESC LIMIT 60`).all(auditId);
  for (const r of rows) {
    let p; try { p = JSON.parse(r.payload); } catch { continue; }
    if (r.kind === 'report') continue; // stored in parts as a string; its company page repeats the profile
    walk(r.kind === 'company_profile' ? p : { cfg: p.cfg, company: p.company, meters: p.meters });
  }

  // A number is always matched whole; a name also by its single words, so "Navrang" alone is caught
  // when "Navrang Dyeing Works Pvt. Ltd." is registered.
  const words = new Set();
  for (const set of [company, places, people]) for (const s of set) {
    for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 4 && !COMMON.has(w) && !/^\d+$/.test(w)) words.add(w);
  }
  const list = set => [...set].sort((x, y) => y.length - x.length);
  return { company: list(company), places: list(places), people: list(people), ids: list(ids), words: list(words) };
}
