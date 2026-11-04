// Creating an audit: one function for the Console and the field apps, so ids, industry tags and the
// activity log are the same whichever side started it. The company and plant details asked at the
// start (plant type, district, state, pincode, contract demand, MSME number, type of work) are kept
// here once and every app reads them back (auditProfile), so nobody types the company twice.
import { fail, str, oneOf } from './http.js';
import { logActivity } from './db.js';
import { SECTORS, WORK_TYPES, STATES } from './apps.js';
import { randomId } from './security.js';

export function fyCode(fy) {
  const m = /^FY(\d{4})-(\d{2})$/.exec(fy);
  return m[1].slice(2) + m[2];
}

/** The Indian financial year (April to March) a date falls in, as FY2026-27. */
export function currentFy(now = Date.now()) {
  const d = new Date(now + 5.5 * 3600e3); // IST
  const start = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `FY${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const blank = v => v == null || String(v).trim() === '';

/**
 * The optional details, checked. Missing ones stay missing (older app builds do not send them);
 * what is given must be well formed.
 */
export function readDetails(b) {
  const d = {};
  if (!blank(b.district)) d.district = str(b.district, { field: 'District', max: 80 });
  if (!blank(b.state)) {
    const s = String(b.state).trim();
    d.state = STATES.find(x => x.toLowerCase() === s.toLowerCase()) || fail(400, 'State is not one of the Indian states or union territories.');
  }
  if (!blank(b.pincode)) d.pincode = str(b.pincode, { field: 'Pincode', min: 6, max: 6, pattern: /^[1-9]\d{5}$/ });
  if (!blank(b.contract_demand_kva)) {
    const n = Number(b.contract_demand_kva);
    if (!Number.isFinite(n) || n <= 0 || n > 1e6) fail(400, 'Contract demand must be a number of kVA.');
    d.contract_demand_kva = Math.round(n * 100) / 100;
  }
  if (!blank(b.msme_no)) d.msme_no = str(b.msme_no, { field: 'MSME (Udyam) number', max: 40 }).toUpperCase();
  if (!blank(b.work_type)) d.work_type = oneOf(b.work_type, Object.keys(WORK_TYPES), 'Type of work');
  return d;
}

function applyDetails(db, { clientId, siteId, auditId }, d) {
  if (d.msme_no !== undefined && clientId) db.prepare('UPDATE clients SET msme_no = ? WHERE id = ?').run(d.msme_no, clientId);
  for (const k of ['district', 'state', 'pincode', 'contract_demand_kva']) {
    if (d[k] !== undefined && siteId) db.prepare(`UPDATE sites SET ${k} = ? WHERE id = ?`).run(d[k], siteId);
  }
  if (d.work_type !== undefined && auditId) db.prepare('UPDATE audits SET work_type = ? WHERE id = ?').run(d.work_type, auditId);
}

/**
 * Creates client (or reuses client_id), site (or reuses site_id) and audit. Call inside tx().
 * With `reuseByName`, a client and plant already registered under the same names are reused, so
 * two engineers starting the same plant from their phones do not make two clients.
 */
// A 3-letter cluster code from a district or town: its first letter, then its next consonants
// (Surat SRT, Ankleshwar ANK, Ahmedabad AHM, Vadodara VDD). Only used in the public industry tag.
export function clusterFrom(place) {
  const letters = String(place || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!letters) return 'GEN';
  let code = letters[0];
  for (const ch of letters.slice(1)) { if (code.length === 3) break; if (!'AEIOU'.includes(ch)) code += ch; }
  for (const ch of letters.slice(1)) { if (code.length === 3) break; if ('AEIOU'.includes(ch)) code += ch; }
  return code.padEnd(3, 'X');
}

export function createAudit(db, b, { actorId, status = 'draft', reuseByName = false, ip, action = 'audit.created' }) {
  const now = Date.now();
  const fy = str(b.fy, { field: 'Financial year', min: 9, max: 9, pattern: /^FY\d{4}-\d{2}$/ });
  const details = readDetails(b);
  const title = blank(b.title) && details.work_type ? WORK_TYPES[details.work_type] : str(b.title, { field: 'Audit title', max: 120 });

  let clientId = b.client_id ? String(b.client_id) : null;
  let sector;
  if (clientId) {
    const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId) || fail(400, 'Client not found.');
    sector = c.sector;
  } else {
    const name = str(b.client_name, { field: 'Company name', max: 120 });
    sector = oneOf(b.sector, Object.keys(SECTORS), 'Plant type');
    const existing = reuseByName && db.prepare('SELECT id, sector FROM clients WHERE lower(name) = lower(?)').get(name);
    if (existing) {
      clientId = existing.id;
      sector = existing.sector;
    } else {
      clientId = randomId('CL');
      db.prepare('INSERT INTO clients (id, name, sector, created_at) VALUES (?, ?, ?, ?)').run(clientId, name, sector, now);
    }
  }

  let siteId = b.site_id ? String(b.site_id) : null;
  if (siteId) {
    db.prepare('SELECT 1 FROM sites WHERE id = ? AND client_id = ?').get(siteId, clientId) || fail(400, 'Site not found for this client.');
  } else {
    const siteName = str(b.site_name, { field: 'Plant name', max: 120 });
    // The cluster code is typed by an app that asks for it; otherwise it is made from the district.
    const cluster = b.cluster ? str(b.cluster, { field: 'Cluster code', min: 3, max: 3, pattern: /^[A-Za-z]{3}$/ }).toUpperCase() : clusterFrom(b.district);
    const existing = reuseByName && db.prepare('SELECT id FROM sites WHERE client_id = ? AND lower(name) = lower(?)').get(clientId, siteName);
    if (existing) {
      siteId = existing.id;
    } else {
      // Public industry tag: sector + cluster + next free number. Never derived from the name.
      const prefix = `${sector}-${cluster}-`;
      const last = db.prepare('SELECT industry_tag FROM sites WHERE industry_tag LIKE ? ORDER BY industry_tag DESC LIMIT 1').get(prefix + '%');
      const n = last ? parseInt(last.industry_tag.slice(prefix.length), 10) + 1 : 1;
      siteId = randomId('ST');
      db.prepare('INSERT INTO sites (id, client_id, name, cluster, industry_tag, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(siteId, clientId, siteName, cluster, prefix + String(n).padStart(3, '0'), now);
    }
  }

  const count = db.prepare('SELECT COUNT(*) AS n FROM audits WHERE fy = ?').get(fy).n;
  const id = `AU-${fyCode(fy)}-${String(count + 1).padStart(4, '0')}`;
  db.prepare("INSERT INTO audits (id, site_id, fy, title, status, created_at, created_by, stage, stage_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'setup', ?)")
    .run(id, siteId, fy, title, status, now, actorId, now);
  applyDetails(db, { clientId, siteId, auditId: id }, details);
  logActivity(db, { userId: actorId, action, target: id, ip });
  return id;
}

/** Correct the details of an existing audit (Console: audit page > Edit details). Call inside tx(). */
export function updateAuditDetails(db, auditId, b, { actorId, ip }) {
  const a = db.prepare('SELECT au.id, au.site_id, s.client_id FROM audits au JOIN sites s ON s.id = au.site_id WHERE au.id = ?').get(auditId)
    || fail(404, 'Audit not found.');
  const d = readDetails(b);
  if (!blank(b.client_name)) db.prepare('UPDATE clients SET name = ? WHERE id = ?').run(str(b.client_name, { field: 'Company name', max: 120 }), a.client_id);
  if (!blank(b.site_name)) db.prepare('UPDATE sites SET name = ? WHERE id = ?').run(str(b.site_name, { field: 'Plant name', max: 120 }), a.site_id);
  if (!blank(b.sector)) db.prepare('UPDATE clients SET sector = ? WHERE id = ?').run(oneOf(b.sector, Object.keys(SECTORS), 'Plant type'), a.client_id);
  if (!blank(b.fy)) db.prepare('UPDATE audits SET fy = ? WHERE id = ?').run(str(b.fy, { field: 'Financial year', min: 9, max: 9, pattern: /^FY\d{4}-\d{2}$/ }), auditId);
  if (d.work_type && blank(b.title)) db.prepare('UPDATE audits SET title = ? WHERE id = ?').run(WORK_TYPES[d.work_type], auditId);
  if (!blank(b.title)) db.prepare('UPDATE audits SET title = ? WHERE id = ?').run(str(b.title, { field: 'Audit title', max: 120 }), auditId);
  applyDetails(db, { clientId: a.client_id, siteId: a.site_id, auditId }, d);
  // Cleared on purpose: an empty value sent for an optional detail removes it.
  for (const k of ['contract_demand_kva', 'district', 'pincode']) if (b[k] === '') db.prepare(`UPDATE sites SET ${k} = NULL WHERE id = ?`).run(a.site_id);
  if (b.msme_no === '') db.prepare('UPDATE clients SET msme_no = NULL WHERE id = ?').run(a.client_id);
  logActivity(db, { userId: actorId, action: 'audit.details', target: auditId, ip });
}

/**
 * Everything an app or Report Studio needs to set up the company for an audit. Only for people on the
 * audit (the caller checks): they are at the plant and know its name.
 */
export function auditProfile(db, auditId) {
  const r = db.prepare(`SELECT au.id, au.fy, au.title, au.work_type, au.status, s.name AS plant_name, s.cluster, s.industry_tag,
      s.district, s.state, s.pincode, s.contract_demand_kva, c.name AS company_name, c.sector, c.msme_no
    , (SELECT f.id FROM files f WHERE f.audit_id = au.id AND f.kind = 'logo' AND f.status = 'ready' ORDER BY f.created_at DESC LIMIT 1) AS logo_file_id
    FROM audits au JOIN sites s ON s.id = au.site_id JOIN clients c ON c.id = s.client_id WHERE au.id = ?`).get(auditId);
  if (!r) return null;
  return {
    audit_id: r.id, company_name: r.company_name, plant_name: r.plant_name,
    plant_type: r.sector, plant_type_name: SECTORS[r.sector] || r.sector,
    district: r.district || '', state: r.state || '', pincode: r.pincode || '',
    fy: r.fy, work_type: r.work_type || '', work_type_name: WORK_TYPES[r.work_type] || r.title,
    contract_demand_kva: r.contract_demand_kva ?? null, msme_no: r.msme_no || '',
    industry_tag: r.industry_tag, cluster: r.cluster, status: r.status, logo_file_id: r.logo_file_id || null,
  };
}
