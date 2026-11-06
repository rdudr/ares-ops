// Energy Ledger: a company's electricity bills, energy baseline and GHG inputs, entered in the Console.
// One record per company per kind (app "ledger"), versioned like every record, and read from
// /api/audits/<id>/data with the rest of the audit. Docs: docs/ENERGY-LEDGER.md.
// Who: Super Admins, and Admins given Energy Ledger in Team & access, on the audits they may see.
import { fail } from './http.js';
import { tx, logActivity } from './db.js';
import { auditAccess, CLOSED_AUDIT } from './auth.js';
import { syncStamp } from './routes-device.js';
import { newVersion } from './routes-records.js';
import { publish } from './events.js';
import { aiStatus } from './ai.js';
import { scopeOf, seesApp, seesAudit } from './scope.js';
import { ceaCurrent, ceaStatus, ceaVersions, checkCea, versionNumber } from './cea.js';

export const LEDGER_KINDS = ['ledger_bills', 'ledger_baseline', 'ledger_ghg'];
const recordId = (kind, auditId) => `led-${kind.replace('ledger_', '')}-${auditId}`.replace(/[^A-Za-z0-9-]/g, '-');

const FY = /^\d{4}-\d{2}$/;
const factor = v => typeof v === 'number' && v >= 0 && v < 3;

// Energy Ledger is given per person, like an app: nobody else reaches any of it.
function mayUse(db, user) {
  const scope = scopeOf(db, user);
  if (!seesApp(scope, 'ledger')) fail(403, 'You do not have Energy Ledger.');
  return scope;
}

export function registerLedgerRoutes(router) {
  // ---- CEA versions and the watch ----
  router.add('GET', '/api/ledger/cea', ({ db, auth }) => { mayUse(db, auth.user); return { ...ceaStatus(db), versions: ceaVersions(db) }; }, { background: true });
  router.add('POST', '/api/ledger/cea/check', async ({ db, auth }) => { mayUse(db, auth.user); return { ...(await checkCea(db)), versions: ceaVersions(db) }; });

  // A new version, typed by the Super Admin from Appendix C of its User Guide.
  router.add('POST', '/api/ledger/cea/versions', async ({ db, body, auth, ip }) => {
    if (auth.user.role !== 'super_admin') fail(403, 'Only the Super Admin can add a CEA version.');
    const b = await body();
    const version = String(b.version || '').trim();
    if (!/^\d{1,3}\.\d{1,2}$/.test(version)) fail(400, 'Give the version as a number, like 23.0.');
    if (versionNumber(version) <= versionNumber(ceaCurrent(db).version)) fail(409, `Version ${version} is not newer than ${ceaCurrent(db).version}.`);
    const published = String(b.published || '').trim().slice(0, 40);
    if (!published) fail(400, 'Give the month it was published, like August 2027.');
    const rows = Array.isArray(b.rows) ? b.rows : [];
    if (!rows.length) fail(400, 'Enter the factors for at least one year.');
    const clean = rows.map(r => {
      const fy = String(r.fy || '').trim();
      if (!FY.test(fy)) fail(400, `"${fy}" is not a financial year like 2026-27.`);
      for (const k of ['average', 'om', 'bm', 'cm']) if (!factor(r[k])) fail(400, `FY ${fy}: ${k} must be a factor in tCO2/MWh.`);
      return { fy, cross_border: !!r.cross_border, average: r.average, om: r.om, bm: r.bm, cm: r.cm };
    });
    if (!clean.some(r => r.cross_border)) fail(400, 'Include Table B, the factors with cross-border transfers: the Ledger uses it by default.');
    const https = u => (/^https:\/\//.test(String(u || '')) ? String(u).slice(0, 300) : null);
    db.prepare('INSERT INTO cea_versions (version, published, rows, guide_url, db_url, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(version, published, JSON.stringify(clean), https(b.guide_url), https(b.db_url), auth.user.id, Date.now());
    logActivity(db, { userId: auth.user.id, action: 'cea.version_added', target: 'CEA', detail: `Version ${version}`, ip });
    return { ...ceaStatus(db), versions: ceaVersions(db) };
  });

  // ---- companies ----
  // How far each company has got, for the menu page.
  router.add('GET', '/api/ledger/summary', ({ db, auth }) => {
    const scope = mayUse(db, auth.user);
    const rows = db.prepare(`SELECT audit_id, kind, payload, version, saved_at FROM records WHERE app = 'ledger' AND kind IN ('ledger_bills','ledger_baseline','ledger_ghg')`).all();
    const out = {};
    for (const r of rows) {
      if (!seesAudit(scope, r.audit_id)) continue;
      const p = JSON.parse(r.payload);
      if (p._deleted) continue;
      const s = (out[r.audit_id] ||= { saved_at: 0 });
      s.saved_at = Math.max(s.saved_at, r.saved_at);
      if (r.kind === 'ledger_bills') { const live = (p.rows || []).filter(x => x.kwh !== null && x.kwh !== undefined && x.kwh !== ''); s.bills = live.length; s.verified = live.filter(x => x.verified).length; }
      if (r.kind === 'ledger_baseline') s.baseline = (p.months || []).length;
      if (r.kind === 'ledger_ghg') s.cea = p.cea?.version || null;
    }
    return { companies: out };
  }, { background: true });

  router.add('GET', '/api/ledger/company/:audit', ({ db, auth, params }) => {
    mayUse(db, auth.user);
    const audit = auditAccess(db, auth.user, params.audit);
    if (!audit) fail(404, 'Audit not found.');
    const records = {};
    for (const kind of LEDGER_KINDS) {
      const r = db.prepare('SELECT r.id, r.version, r.saved_at, r.payload, u.name AS by_name FROM records r LEFT JOIN users u ON u.id = COALESCE(r.updated_by, r.user_id) WHERE r.id = ?').get(recordId(kind, audit.id));
      if (r) { const payload = JSON.parse(r.payload); if (!payload._deleted) records[kind] = { version: r.version, saved_at: r.saved_at, by: r.by_name, payload }; }
    }
    return { audit: { id: audit.id, status: audit.status, fy: audit.fy, closed: CLOSED_AUDIT.has(audit.status) }, records, cea: ceaCurrent(db), watch: ceaStatus(db), ai: aiStatus() };
  });

  // Save one part. base_version is the version the page started from: a stale page is refused and
  // told to reload, rather than quietly overwriting what a team-mate saved.
  router.add('PUT', '/api/ledger/company/:audit/:kind', async ({ db, body, auth, params, ip }) => {
    mayUse(db, auth.user);
    if (!LEDGER_KINDS.includes(params.kind)) fail(404, 'Not found.');
    const b = await body();
    if (!b.payload || typeof b.payload !== 'object' || Array.isArray(b.payload) || b.payload._deleted) fail(400, 'The data must be an object.');
    return tx(db, () => {
      const audit = auditAccess(db, auth.user, params.audit);
      if (!audit) fail(404, 'Audit not found.');
      if (CLOSED_AUDIT.has(audit.status)) fail(409, 'This audit is finalised. Reopen it to change its data.');
      const id = recordId(params.kind, audit.id);
      const rec = db.prepare('SELECT * FROM records WHERE id = ?').get(id);
      let version = 1;
      if (rec) {
        if (Number(b.base_version) !== rec.version) fail(409, 'A team-mate saved this part after you opened it. Reload to see their changes.', 'stale');
        version = newVersion(db, rec, auth.user.id, b.payload, null);
      } else {
        if (b.base_version) fail(409, 'This part has changed. Reload the page.', 'stale');
        const now = syncStamp(db);
        db.prepare(`INSERT INTO records (id, audit_id, app, user_id, updated_by, device_id, kind, tag, taken_at, saved_at, synced_at, version, payload)
          VALUES (?, ?, 'ledger', ?, ?, 'console', ?, NULL, ?, ?, ?, 1, ?)`).run(id, audit.id, auth.user.id, auth.user.id, params.kind, now, now, now, JSON.stringify(b.payload));
      }
      logActivity(db, { userId: auth.user.id, action: 'ledger.saved', target: audit.id, detail: params.kind, ip });
      publish(db, { audit_id: audit.id, app: 'ledger', what: 'records' });
      return { ok: true, version };
    });
  }, { bodyLimit: 256 * 1024 });
}
