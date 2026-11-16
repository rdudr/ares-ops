// The report draft written with the AI, and its review (docs/REPORT_DRAFT.md).
//
//   The report connector (mcp.arenergyservices.in) saves a draft here, section by section.
//   People accept, edit or reject each section on the audit's page in the Console.
//   An Admin approves the report by moving the audit from Review to Approved.
//   Only then is the final PDF printed, from the accepted text alone; before that every PDF is
//   stamped DRAFT. The PDF is kept with the audit's files, never handed to the AI.
//
// The connector signs in as the engineer with an "AI" app sign-in (lib/auth.js isAi): it reaches
// only audits whose AI access is on, can save drafts but can never accept, edit, reject or approve.
import { fail } from './http.js';
import { tx, logActivity } from './db.js';
import { auditAccess, isAi, createSession, CLOSED_AUDIT, hasApp } from './auth.js';
import { aiOpen, aiUntil } from './ai-access.js';
import { canMove } from './stages.js';
import { publish } from './events.js';
import { hashToken } from './security.js';
import { scopeOf, seesAudit } from './scope.js';
import { REPORT_CONNECTOR_ADDRESS } from './mcp.js';

export const REPORT_TEMPLATES = ['walkthrough', 'detailed'];
const SECTION_ID = /^[a-z][a-z0-9_]{1,40}$/;
const REF_ID = /^[TCPF]\.[^\s[\]]{1,120}$/;
// Once an Admin has approved, the text is frozen: to change it the audit goes back to Review.
const FROZEN_STAGE = new Set(['approved', 'published']);
const MAX_SECTIONS = 40, MAX_BLOCKS = 80, MAX_TEXT = 20000;
const REF = /\[\[\s*([^\]]+?)\s*\]\]/g;

const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

/** A section's blocks, reduced to the fields the report uses. Anything else is refused or dropped. */
export function cleanBlocks(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_BLOCKS) fail(400, `A section needs 1 to ${MAX_BLOCKS} blocks.`);
  return list.map((b, i) => {
    const where = `Block ${i + 1}`;
    if (!b || typeof b !== 'object' || Array.isArray(b)) fail(400, `${where} is not valid.`);
    const text = (v, max = MAX_TEXT, what = 'text') => {
      if (typeof v !== 'string' || !v.trim() || v.length > max) fail(400, `${where}: ${what} is missing or too long.`);
      return v;
    };
    const opt = (v, max) => (v == null || v === '' ? '' : text(v, max));
    const ids = (v, letter) => {
      if (!Array.isArray(v) || !v.length || v.length > 60 || v.some(x => typeof x !== 'string' || !REF_ID.test(x) || x[0] !== letter)) fail(400, `${where}: its ${letter}. references are not valid.`);
      return v;
    };
    const fact = v => (v == null || v === '' ? null : ids([v], 'F')[0]);
    switch (b.type) {
      case 'text': return { type: 'text', text: text(b.text) };
      case 'list': {
        if (!Array.isArray(b.items) || !b.items.length || b.items.length > 80) fail(400, `${where}: a list needs 1 to 80 items.`);
        return { type: 'list', ordered: b.ordered !== false, items: b.items.map(x => text(x, 4000, 'a list item')) };
      }
      case 'table': return { type: 'table', id: ids([b.id], 'T')[0] };
      case 'charts': return { type: 'charts', ids: ids(b.ids, 'C') };
      case 'photos': return { type: 'photos', ids: ids(b.ids, 'P'), layout: b.layout === 'pairs' ? 'pairs' : 'grid', ...(b.caption ? { caption: text(b.caption, 500, 'caption') } : {}) };
      case 'recommendations': {
        if (!Array.isArray(b.items) || !b.items.length || b.items.length > 40) fail(400, `${where}: 1 to 40 recommendations.`);
        return { type: 'recommendations', items: b.items.map(r => {
          if (!r || typeof r !== 'object') fail(400, `${where}: a recommendation is not valid.`);
          return {
            title: text(r.title, 300, 'a recommendation title'), observation: opt(r.observation, 4000), measure: opt(r.measure, 4000),
            term: r.term === 'short' || r.term === 'long' ? r.term : null,
            saving: fact(r.saving), investment: fact(r.investment), payback: fact(r.payback),
            // A reviewer can leave one recommendation out of the report without rejecting the section.
            ...(r.dropped ? { dropped: true } : {}),
          };
        }) };
      }
      default: return fail(400, `${where}: unknown kind of block.`);
    }
  });
}

/** Every reference a section makes, so an edit cannot point at a figure, table or photo that is not there. */
function refsOf(blocks) {
  const facts = new Set(), other = new Set();
  const scan = s => { for (const m of String(s || '').matchAll(REF)) (m[1].startsWith('F.') ? facts : other).add(m[1]); };
  for (const b of blocks) {
    if (b.type === 'text') scan(b.text);
    else if (b.type === 'list') b.items.forEach(scan);
    else if (b.type === 'photos') scan(b.caption);
    else if (b.type === 'recommendations') for (const r of b.items) {
      scan(r.title); scan(r.observation); scan(r.measure);
      for (const k of ['saving', 'investment', 'payback']) if (r[k]) facts.add(r[k]);
    }
  }
  return { facts, other };
}

function checkRefs(blocks, context) {
  const known = context.facts || {};
  const { facts, other } = refsOf(blocks);
  for (const f of facts) if (!(f.slice(2) in known)) fail(400, `[[${f}]] is not a figure of this audit. Pick a figure from the list.`);
  for (const o of other) if (o !== 'COMPANY' && o !== 'SITE') fail(400, `[[${o}]] is not known. Only figures ([[F.…]]), [[COMPANY]] and [[SITE]] go in text.`);
  for (const b of blocks) {
    if (b.type === 'table' && !(context.tables || {})[b.id]) fail(400, `Table ${b.id} is not in this audit.`);
    if (b.type === 'charts') for (const id of b.ids) if (!(context.charts || {})[id]) fail(400, `Chart ${id} is not in this audit.`);
    if (b.type === 'photos') for (const id of b.ids) if (!(context.photos || {})[id]) fail(400, `Photo ${id} is not in this audit.`);
  }
}

/** The values and titles the Console shows in place of the references. Sent by the connector with each save. */
function cleanContext(c) {
  const out = { facts: {}, tables: {}, charts: {}, photos: {}, company: '', site: '' };
  if (!c || typeof c !== 'object') return out;
  const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : v == null ? '' : String(v).slice(0, n));
  const each = (o, max, fn) => { let n = 0; for (const [k, v] of Object.entries(o && typeof o === 'object' ? o : {})) { if (++n > max || k.length > 120 || !v || typeof v !== 'object') continue; fn(k, v); } };
  each(c.facts, 3000, (k, v) => { out.facts[k] = { label: s(v.label, 160), display: s(v.display, 80) }; });
  each(c.tables, 300, (k, v) => { out.tables[k] = { title: s(v.title, 200), rows: Number(v.rows) || 0 }; });
  each(c.charts, 300, (k, v) => { out.charts[k] = { title: s(v.title, 200) }; });
  each(c.photos, 2000, (k, v) => { out.photos[k] = { caption: s(v.caption, 300), kind: s(v.kind, 20), file_id: /^[A-Za-z0-9-]{8,64}$/.test(v.file_id || '') ? v.file_id : null }; });
  out.company = s(c.company, 200); out.site = s(c.site, 200);
  return out;
}

function cleanSettings(x) {
  const out = {};
  if (!x || typeof x !== 'object') return out;
  if (x.cover === 'geda' || x.cover === 'commercial') out.cover = x.cover;
  if (typeof x.cover_photo === 'string' && REF_ID.test(x.cover_photo) && x.cover_photo[0] === 'P') out.cover_photo = x.cover_photo;
  if (Array.isArray(x.highlights)) {
    out.highlights = x.highlights.slice(0, 3).filter(h => h && typeof h.fact === 'string' && REF_ID.test(h.fact) && h.fact[0] === 'F' && typeof h.label === 'string' && h.label.trim())
      .map(h => ({ fact: h.fact, label: h.label.slice(0, 80) }));
  }
  return out;
}

/** A draft started before this audit was (an older company once had the same code) is never this
 *  company's report: it is removed before anything reads or extends it. */
export function dropOlderDraft(db, audit) {
  const d = db.prepare('SELECT created_at FROM report_drafts WHERE audit_id = ?').get(audit.id);
  if (!d || !audit.created_at || d.created_at >= audit.created_at) return false;
  tx(db, () => {
    db.prepare('DELETE FROM report_draft_sections WHERE audit_id = ?').run(audit.id);
    db.prepare('DELETE FROM report_drafts WHERE audit_id = ?').run(audit.id);
    logActivity(db, { userId: null, action: 'report_draft.dropped', target: audit.id, detail: 'draft older than the audit (an earlier company with this code)' });
  });
  return true;
}

/** The draft of one audit with its review state; null when none has been saved. */
export function readDraft(db, audit, { withOriginal = false } = {}) {
  const d = db.prepare(`SELECT d.*, u.name AS updated_by_name FROM report_drafts d LEFT JOIN users u ON u.id = d.updated_by WHERE d.audit_id = ?`).get(audit.id);
  if (!d) return null;
  const rows = db.prepare(`SELECT s.*, p.name AS proposed_by_name, r.name AS reviewed_by_name FROM report_draft_sections s
    LEFT JOIN users p ON p.id = s.proposed_by LEFT JOIN users r ON r.id = s.reviewed_by WHERE s.audit_id = ? ORDER BY s.position, s.section_id`).all(audit.id);
  const counts = { pending: 0, accepted: 0, rejected: 0 };
  for (const r of rows) counts[r.status]++;
  const frozen = FROZEN_STAGE.has(audit.stage) || CLOSED_AUDIT.has(audit.status);
  return {
    template: d.template, settings: parse(d.settings, {}), context: parse(d.context, {}), note: d.note || '',
    created_at: d.created_at, updated_at: d.updated_at, updated_by_name: d.updated_by_name || null,
    sections: rows.map(r => ({
      id: r.section_id, position: r.position, title: r.title, blocks: parse(r.blocks, []), status: r.status, edited: !!r.edited,
      comment: r.comment || '', revision: r.revision, proposed_by_name: r.proposed_by_name, proposed_at: r.proposed_at,
      reviewed_by_name: r.reviewed_by_name || null, reviewed_at: r.reviewed_at || null,
      ...(withOriginal && r.edited ? { ai_blocks: parse(r.ai_blocks, []) } : {}),
    })),
    counts, frozen,
    // The final report: the Admin has approved (stage Approved) and every section is accepted.
    final_ok: audit.stage === 'approved' && !CLOSED_AUDIT.has(audit.status) && rows.length > 0 && counts.pending === 0 && counts.rejected === 0,
    pdf: d.pdf_file_id ? { file_id: d.pdf_file_id, final: !!d.pdf_final, at: d.pdf_at, pages: d.pdf_pages, note: d.pdf_note || '', url: `/api/files/${d.pdf_file_id}` } : null,
  };
}

/** The final PDF of the approved draft, if one was printed: what Publish attaches when no file is given. */
export function finalReportFile(db, auditId) {
  const d = db.prepare('SELECT pdf_file_id FROM report_drafts WHERE audit_id = ? AND pdf_final = 1').get(auditId);
  return d ? d.pdf_file_id : null;
}

export function registerReportRoutes(router, { connector } = {}) {
  const open = (db, auth, id) => {
    const audit = auditAccess(db, auth.user, id);
    if (!audit) fail(404, 'Audit not found.');
    if (isAi(auth) && !aiOpen(audit)) fail(403, 'AI access to this audit is off.', 'ai_access_off');
    dropOlderDraft(db, audit);
    return audit;
  };
  const notFrozen = audit => {
    if (CLOSED_AUDIT.has(audit.status)) fail(409, 'This audit is finished; its report can no longer be changed.');
    if (FROZEN_STAGE.has(audit.stage)) fail(409, 'The report is approved. To change it, an Admin sends the audit back to Review first.', 'report_approved');
  };

  // Report Studio in the Console menu: every audit this person sees, with how far its report draft is.
  router.add('GET', '/api/report-drafts', ({ db, auth }) => {
    const scope = scopeOf(db, auth.user);
    const n = st => `(SELECT COUNT(*) FROM report_draft_sections x WHERE x.audit_id = au.id${st ? ` AND x.status = '${st}'` : ''})`;
    const rows = db.prepare(`SELECT au.id, au.title, au.fy, au.status, au.stage, au.synthetic, au.ai_until, au.created_at,
        s.name AS site_name, s.industry_tag, c.name AS client_name,
        d.template, d.created_at AS draft_created_at, d.updated_at AS draft_updated_at, d.pdf_final, d.pdf_at,
        (SELECT name FROM users WHERE id = d.updated_by) AS draft_updated_by,
        ${n()} AS sections, ${n('accepted')} AS accepted, ${n('pending')} AS pending, ${n('rejected')} AS rejected
      FROM audits au JOIN sites s ON s.id = au.site_id JOIN clients c ON c.id = s.client_id
      LEFT JOIN report_drafts d ON d.audit_id = au.id
      WHERE au.status != 'archived'
      ORDER BY COALESCE(d.updated_at, au.created_at) DESC`).all().filter(a => seesAudit(scope, a.id));
    return {
      connector_address: REPORT_CONNECTOR_ADDRESS(),
      can_connect: hasApp(db, auth.user, 'report'),   // the connector signs in as the app "report"
      // A draft older than its audit belongs to an earlier company with this code: never shown (dropOlderDraft).
      audits: rows.map(({ ai_until, ...a }) => {
        const stale = a.draft_created_at && a.created_at && a.draft_created_at < a.created_at;
        return { ...a, synthetic: !!a.synthetic, ai_access: aiOpen({ ...a, ai_until }), ai_until: aiUntil({ ...a, ai_until }),
          ...(stale ? { template: null, sections: 0, accepted: 0, pending: 0, rejected: 0, draft_updated_at: null, pdf_final: 0 } : {}) };
      }),
    };
  });

  // The draft with its review state. For the Console, the connector and (later) Report Studio.
  router.add('GET', '/api/audits/:id/report-draft', ({ db, auth, params }) => {
    const audit = open(db, auth, params.id);
    const human = !isAi(auth);
    return {
      audit: { id: audit.id, stage: audit.stage || 'setup', status: audit.status, ai_access: aiOpen(audit), synthetic: !!audit.synthetic },
      draft: readDraft(db, audit, { withOriginal: human }),
      can: { review: human, discard: human && canMove(db, auth.user, audit.id), print: human && !!connector?.url },
    };
  }, { auth: 'either', ai: true });

  // The connector saves the sections the AI wrote. Accepted text is never overwritten by the AI.
  router.add('PUT', '/api/audits/:id/report-draft', async ({ db, auth, params, body, ip }) => {
    if (!isAi(auth)) fail(403, 'Drafts are saved by the AI report connector.');
    const audit = open(db, auth, params.id);
    notFrozen(audit);
    const b = await body();
    if (!REPORT_TEMPLATES.includes(b.template)) fail(400, 'Unknown report template.');
    if (!Array.isArray(b.sections) || !b.sections.length || b.sections.length > MAX_SECTIONS) fail(400, `Send 1 to ${MAX_SECTIONS} sections.`);
    const context = cleanContext(b.context);
    const sections = b.sections.map((s, i) => {
      if (!s || typeof s !== 'object' || !SECTION_ID.test(String(s.id || ''))) fail(400, `Section ${i + 1} has no valid id.`);
      const blocks = cleanBlocks(s.blocks);
      checkRefs(blocks, context);
      return { id: s.id, title: String(s.title || s.id).slice(0, 160), position: Number.isInteger(s.position) ? s.position : i, blocks: JSON.stringify(blocks) };
    });
    if (new Set(sections.map(s => s.id)).size !== sections.length) fail(400, 'A section appears twice.');
    const now = Date.now(), uid = auth.user.id;
    const result = tx(db, () => {
      const have = db.prepare('SELECT template FROM report_drafts WHERE audit_id = ?').get(audit.id);
      if (have && have.template !== b.template) {
        const kept = db.prepare("SELECT COUNT(*) AS n FROM report_draft_sections WHERE audit_id = ? AND status = 'accepted'").get(audit.id).n;
        if (kept) fail(409, `This audit already has a ${have.template} report with accepted sections. An Admin discards that draft in the Console before another kind of report is started.`, 'other_template');
        db.prepare('DELETE FROM report_draft_sections WHERE audit_id = ?').run(audit.id);
      }
      const settings = JSON.stringify(cleanSettings(b.settings)), note = b.note ? String(b.note).slice(0, 300) : null;
      if (have) db.prepare('UPDATE report_drafts SET template = ?, settings = ?, context = ?, note = COALESCE(?, note), updated_by = ?, updated_at = ?, pdf_final = 0 WHERE audit_id = ?')
        .run(b.template, settings, JSON.stringify(context), note, uid, now, audit.id);
      else db.prepare('INSERT INTO report_drafts (audit_id, template, settings, context, note, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(audit.id, b.template, settings, JSON.stringify(context), note, uid, now, uid, now);
      const saved = [], kept = [];
      for (const s of sections) {
        const cur = db.prepare('SELECT status, revision FROM report_draft_sections WHERE audit_id = ? AND section_id = ?').get(audit.id, s.id);
        if (cur && cur.status === 'accepted') { kept.push(s.id); continue; }
        if (cur) db.prepare(`UPDATE report_draft_sections SET title = ?, position = ?, blocks = ?, ai_blocks = ?, status = 'pending', edited = 0, comment = NULL,
            revision = ?, proposed_by = ?, proposed_at = ?, reviewed_by = NULL, reviewed_at = NULL WHERE audit_id = ? AND section_id = ?`)
          .run(s.title, s.position, s.blocks, s.blocks, cur.revision + 1, uid, now, audit.id, s.id);
        else db.prepare(`INSERT INTO report_draft_sections (audit_id, section_id, position, title, blocks, ai_blocks, proposed_by, proposed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(audit.id, s.id, s.position, s.title, s.blocks, s.blocks, uid, now);
        saved.push(s.id);
      }
      return { saved, kept };
    });
    if (result.saved.length) {
      logActivity(db, { userId: uid, action: 'report.draft_saved', target: audit.id, detail: `${b.template}: ${result.saved.join(', ')}`, ip });
      publish(db, { audit_id: audit.id, app: 'report', what: 'report' });
    }
    return { ok: true, ...result, draft: readDraft(db, db.prepare('SELECT * FROM audits WHERE id = ?').get(audit.id)) };
  }, { device: true, ai: true, bodyLimit: 2 * 1024 * 1024 });

  // A person accepts, edits, rejects or reopens one section. Never the AI.
  router.add('POST', '/api/audits/:id/report-draft/sections/:sid', async ({ db, auth, params, body, ip }) => {
    if (isAi(auth)) fail(403, 'Only people review the report.');
    const audit = open(db, auth, params.id);
    notFrozen(audit);
    const b = await body();
    const row = db.prepare('SELECT * FROM report_draft_sections WHERE audit_id = ? AND section_id = ?').get(audit.id, params.sid) || fail(404, 'Section not found.');
    const now = Date.now(), uid = auth.user.id;
    const set = (sql, ...args) => db.prepare(`UPDATE report_draft_sections SET ${sql}, reviewed_by = ?, reviewed_at = ? WHERE audit_id = ? AND section_id = ?`).run(...args, uid, now, audit.id, row.section_id);
    // Two people on the same section: the second is told, instead of silently undoing the first.
    if (b.revision != null && Number(b.revision) !== row.revision) fail(409, 'This section was changed by someone else just now. Reload and look again.', 'stale');
    switch (b.action) {
      case 'accept': set("status = 'accepted', comment = NULL"); break;
      case 'reject': {
        const why = typeof b.comment === 'string' ? b.comment.trim().slice(0, 1000) : '';
        if (why.length < 3) fail(400, 'Say what is wrong, so it can be put right.');
        set("status = 'rejected', comment = ?", why);
        break;
      }
      case 'reopen': set("status = 'pending'"); break;
      case 'edit': {
        const blocks = cleanBlocks(b.blocks);
        const d = db.prepare('SELECT context FROM report_drafts WHERE audit_id = ?').get(audit.id);
        checkRefs(blocks, parse(d?.context, {}));
        set("blocks = ?, edited = 1, status = 'accepted', comment = NULL, revision = revision + 1", JSON.stringify(blocks));
        break;
      }
      default: fail(400, 'Unknown action.');
    }
    // The text changed: a PDF printed before no longer stands for it.
    db.prepare('UPDATE report_drafts SET updated_by = ?, updated_at = ?, pdf_final = 0 WHERE audit_id = ?').run(uid, now, audit.id);
    logActivity(db, { userId: uid, action: `report.section_${b.action === 'edit' ? 'edited' : `${b.action}ed`}`, target: audit.id, detail: row.section_id, ip });
    publish(db, { audit_id: audit.id, app: 'report', what: 'report' });
    return { ok: true, draft: readDraft(db, audit, { withOriginal: true }) };
  }, { auth: 'either', bodyLimit: 1024 * 1024 });

  // Throw the draft away (to start another kind of report, or over). The audit lead, an Admin or a Super Admin.
  router.add('DELETE', '/api/audits/:id/report-draft', ({ db, auth, params, ip }) => {
    if (isAi(auth)) fail(403, 'Only people discard a draft.');
    const audit = open(db, auth, params.id);
    notFrozen(audit);
    if (!canMove(db, auth.user, audit.id)) fail(403, 'Only the audit lead, an Admin or a Super Admin discards the draft.');
    tx(db, () => {
      db.prepare('DELETE FROM report_draft_sections WHERE audit_id = ?').run(audit.id);
      db.prepare('DELETE FROM report_drafts WHERE audit_id = ?').run(audit.id);
    });
    logActivity(db, { userId: auth.user.id, action: 'report.draft_discarded', target: audit.id, ip });
    publish(db, { audit_id: audit.id, app: 'report', what: 'report' });
    return { ok: true };
  }, { auth: 'either' });

  // The connector printed a PDF and stored it with the audit's files: remember which one it is.
  // "final" is believed only if this server itself finds the report approved and fully accepted.
  router.add('POST', '/api/audits/:id/report-draft/pdf', async ({ db, auth, params, body, ip }) => {
    const audit = open(db, auth, params.id);
    const b = await body();
    const f = db.prepare("SELECT id, mime, uploaded_by FROM files WHERE id = ? AND audit_id = ? AND status = 'ready'").get(String(b.file_id || ''), audit.id);
    if (!f || f.mime !== 'application/pdf' || f.uploaded_by !== auth.user.id) fail(400, 'The report file was not found for this audit.');
    const draft = readDraft(db, audit) || fail(409, 'There is no draft for this audit.');
    const final = !!b.final;
    if (final && !draft.final_ok) fail(409, 'The report is not approved: only a draft can be stored.', 'not_approved');
    db.prepare('UPDATE report_drafts SET pdf_file_id = ?, pdf_final = ?, pdf_at = ?, pdf_pages = ?, pdf_note = ? WHERE audit_id = ?')
      .run(f.id, final ? 1 : 0, Date.now(), Number.isInteger(b.pages) ? b.pages : null, b.note ? String(b.note).slice(0, 1000) : null, audit.id);
    logActivity(db, { userId: auth.user.id, action: final ? 'report.final_printed' : 'report.draft_printed', target: audit.id, detail: f.id, ip });
    publish(db, { audit_id: audit.id, app: 'report', what: 'report' });
    return { ok: true, final };
  }, { device: true, ai: true });

  // One line for each thing the connector sent to the AI: who, which audit, which tool, how much.
  // The same table as the older /mcp connector, so the audit page shows both in one list.
  router.add('POST', '/api/ai/log', async ({ db, auth, body, ip }) => {
    if (!isAi(auth)) fail(403, 'Only the AI report connector writes this log.');
    const b = await body();
    const audit = b.audit_id ? auditAccess(db, auth.user, b.audit_id) : null;
    const tool = String(b.tool || '').replace(/[^a-z_]/g, '').slice(0, 40) || fail(400, 'Which tool?');
    const sha = /^[0-9a-f]{64}$/.test(String(b.sha256 || '')) ? b.sha256 : '0'.repeat(64);
    db.prepare('INSERT INTO mcp_log (token_id, user_id, audit_id, tool, bytes, sha256, blocked, ok, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`rs:${auth.tokenHash.slice(0, 12)}`, auth.user.id, audit ? audit.id : '-', tool, Math.max(0, Number(b.bytes) || 0), sha, b.blocked ? 1 : 0, b.ok === false ? 0 : 1, Date.now());
    if (b.blocked) logActivity(db, { userId: auth.user.id, action: 'mcp.blocked', target: audit ? audit.id : null, detail: `${tool} (report connector)`, ip });
    return { ok: true };
  }, { device: true, ai: true });

  // "Print the PDF" in the Console: the connector prints it for the person who clicked, with a
  // sign-in of theirs that lasts five minutes. Nothing goes to the AI on this path.
  router.add('POST', '/api/audits/:id/report-draft/print', async ({ db, auth, params, ip }) => {
    if (auth.via !== 'web') fail(403, 'This is for the Console.');
    const audit = open(db, auth, params.id);
    if (!connector?.url || !connector?.key) fail(503, 'Printing from the Console is not set up on this server. Ask for the PDF in Claude instead.');
    readDraft(db, audit) || fail(409, 'There is no draft to print yet.');
    const token = createSession(db, auth.user, { kind: 'device', app: 'report', deviceId: 'console-print' });
    try {
      db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() + 5 * 60 * 1000, hashToken(token));
      let r;
      try {
        r = await fetch(`${connector.url}/internal/print`, {
          method: 'POST', signal: AbortSignal.timeout(180_000),
          headers: { 'Content-Type': 'application/json', 'X-Report-Key': connector.key },
          body: JSON.stringify({ audit_id: audit.id, token }),
        });
      } catch { fail(502, 'The report printer did not answer. Try again in a minute.'); }
      const out = await r.json().catch(() => ({}));
      if (!r.ok) fail(r.status === 409 || r.status === 400 ? r.status : 502, out.error || 'The report could not be printed.');
      logActivity(db, { userId: auth.user.id, action: 'report.print_asked', target: audit.id, detail: out.final ? 'final' : 'draft', ip });
      return { ok: true, final: !!out.final, pages: out.pages || null, problems: out.problems || [], draft: readDraft(db, db.prepare('SELECT * FROM audits WHERE id = ?').get(audit.id), { withOriginal: true }) };
    } finally {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    }
  });
}
