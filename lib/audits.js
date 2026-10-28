// Creating an audit: one function for the Console and the field apps, so ids, industry tags and the
// activity log are the same whichever side started it.
import { fail, str, oneOf } from './http.js';
import { logActivity } from './db.js';
import { SECTORS } from './apps.js';
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

/**
 * Creates client (or reuses client_id), site (or reuses site_id) and audit. Call inside tx().
 * With `reuseByName`, a client and plant already registered under the same names are reused, so
 * two engineers starting the same plant from their phones do not make two clients.
 */
export function createAudit(db, b, { actorId, status = 'draft', reuseByName = false, ip, action = 'audit.created' }) {
  const now = Date.now();
  const fy = str(b.fy, { field: 'Financial year', min: 9, max: 9, pattern: /^FY\d{4}-\d{2}$/ });
  const title = str(b.title, { field: 'Audit title', max: 120 });

  let clientId = b.client_id ? String(b.client_id) : null;
  let sector;
  if (clientId) {
    const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId) || fail(400, 'Client not found.');
    sector = c.sector;
  } else {
    const name = str(b.client_name, { field: 'Company name', max: 120 });
    sector = oneOf(b.sector, Object.keys(SECTORS), 'Sector');
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
    const cluster = str(b.cluster, { field: 'Cluster code', min: 3, max: 3, pattern: /^[A-Za-z]{3}$/ }).toUpperCase();
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
  db.prepare('INSERT INTO audits (id, site_id, fy, title, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, siteId, fy, title, status, now, actorId);
  logActivity(db, { userId: actorId, action, target: id, ip });
  return id;
}
