// Console (managers): correct or remove a record from the web, finalise an audit once its report
// is made, and download everything about one company audit as a ZIP for the office's own records.
// Edits and removals are new versions (the old one is kept in record_versions) with a fresh sync
// stamp, so every phone on the audit picks them up on its next sync.
import fs from 'node:fs';
import path from 'node:path';
import { fail } from './http.js';
import { tx, logActivity } from './db.js';
import { APPS } from './apps.js';
import { CLOSED_AUDIT } from './auth.js';
import { normaliseTag, syncStamp } from './routes-device.js';
import { buildZip } from './zip.js';

const appName = code => APPS.find(a => a.code === code)?.name || code;
const safe = s => String(s ?? '').replace(/[^\w.\- ()&]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'item';
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf', 'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx' };

function csv(rows) {
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const cell = v => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n');
}

function loadRecord(db, id) {
  const rec = db.prepare('SELECT r.*, au.status AS audit_status FROM records r JOIN audits au ON au.id = r.audit_id WHERE r.id = ?').get(id);
  if (!rec) fail(404, 'Record not found.');
  if (CLOSED_AUDIT.has(rec.audit_status)) fail(409, 'This audit is finalised. Reopen it to change its data.');
  return rec;
}

function newVersion(db, rec, userId, payload, tag) {
  db.prepare('INSERT INTO record_versions (record_id, version, user_id, saved_at, payload) VALUES (?, ?, ?, ?, ?)')
    .run(rec.id, rec.version, rec.updated_by || rec.user_id, rec.saved_at, rec.payload);
  const now = Date.now();
  db.prepare('UPDATE records SET updated_by = ?, tag = ?, saved_at = ?, synced_at = ?, version = ?, payload = ? WHERE id = ?')
    .run(userId, tag, now, syncStamp(db), rec.version + 1, JSON.stringify(payload), rec.id);
  return rec.version + 1;
}

export function registerRecordRoutes(router, { filesDir }) {
  // Correct a record from the Console. Body: { payload: {...}, tag?: string|null }.
  router.add('PUT', '/api/records/:id', async ({ db, body, auth, params, ip }) => {
    const b = await body();
    if (!b.payload || typeof b.payload !== 'object' || Array.isArray(b.payload)) fail(400, 'The record data must be an object.');
    if (b.payload._deleted) fail(400, 'Use Remove to delete a record.');
    return tx(db, () => {
      const rec = loadRecord(db, params.id);
      const tag = b.tag === undefined ? rec.tag : normaliseTag(b.tag);
      if (tag) {
        const clash = db.prepare('SELECT id FROM records WHERE audit_id = ? AND app = ? AND lower(tag) = lower(?) AND id != ?').get(rec.audit_id, rec.app, tag, rec.id);
        if (clash) fail(409, `Tag "${tag}" is already used by another record in this audit.`);
      }
      const version = newVersion(db, rec, auth.user.id, b.payload, tag);
      logActivity(db, { userId: auth.user.id, action: 'record.edited', target: rec.audit_id, detail: `${rec.app} ${rec.kind} ${rec.id}`, ip });
      return { ok: true, version };
    });
  });

  // Remove a record: phones delete it on their next sync; the old versions stay on the server.
  router.add('DELETE', '/api/records/:id', ({ db, auth, params, ip }) => tx(db, () => {
    const rec = loadRecord(db, params.id);
    if (JSON.parse(rec.payload)._deleted) return { ok: true };
    newVersion(db, rec, auth.user.id, { _deleted: true }, null);
    logActivity(db, { userId: auth.user.id, action: 'record.removed', target: rec.audit_id, detail: `${rec.app} ${rec.kind} ${rec.id}`, ip });
    return { ok: true };
  }));

  // Finalise: the report is made. The audit leaves the running lists (Console and apps), its data
  // is kept and locked. Body: { report_file_id?: string } (the final report, uploaded first).
  router.add('POST', '/api/audits/:id/finalise', async ({ db, body, auth, params, ip }) => {
    const b = await body();
    return tx(db, () => {
      const a = db.prepare('SELECT * FROM audits WHERE id = ?').get(params.id) || fail(404, 'Audit not found.');
      let reportId = null;
      if (b.report_file_id) {
        const f = db.prepare("SELECT id FROM files WHERE id = ? AND audit_id = ? AND status = 'ready'").get(String(b.report_file_id), a.id);
        if (!f) fail(400, 'The report file was not found for this audit.');
        reportId = f.id;
      }
      db.prepare("UPDATE audits SET status = 'archived', finalized_at = ?, finalized_by = ?, report_file_id = COALESCE(?, report_file_id) WHERE id = ?")
        .run(Date.now(), auth.user.id, reportId, a.id);
      logActivity(db, { userId: auth.user.id, action: 'audit.finalised', target: a.id, ip });
      return { ok: true };
    });
  });

  router.add('POST', '/api/audits/:id/reopen', ({ db, auth, params, ip }) => {
    const r = db.prepare("UPDATE audits SET status = 'in_field', finalized_at = NULL, finalized_by = NULL WHERE id = ?").run(params.id);
    if (!r.changes) fail(404, 'Audit not found.');
    logActivity(db, { userId: auth.user.id, action: 'audit.reopened', target: params.id, ip });
    return { ok: true };
  });

  // Everything for one company audit in one ZIP: the company details, every app's records (CSV
  // per kind, plus JSON), every photo and file with an index of what each shows, and the report.
  router.add('GET', '/api/audits/:id/export.zip', ({ db, res, auth, params, ip }) => {
    const a = db.prepare(`SELECT au.*, s.name AS site_name, s.industry_tag, s.cluster, c.name AS client_name, c.sector, u.name AS finalized_by_name
      FROM audits au JOIN sites s ON s.id = au.site_id JOIN clients c ON c.id = s.client_id LEFT JOIN users u ON u.id = au.finalized_by
      WHERE au.id = ?`).get(params.id) || fail(404, 'Audit not found.');
    const records = db.prepare(`SELECT r.*, u.name AS recorded_by, ub.name AS updated_by_name FROM records r
      JOIN users u ON u.id = r.user_id LEFT JOIN users ub ON ub.id = r.updated_by
      WHERE r.audit_id = ? ORDER BY r.app, r.kind, r.tag, r.taken_at`).all(a.id)
      .map(r => ({ ...r, payload: JSON.parse(r.payload) })).filter(r => !r.payload._deleted);
    const files = db.prepare(`SELECT f.*, u.name AS uploaded_by_name FROM files f JOIN users u ON u.id = f.uploaded_by
      WHERE f.audit_id = ? AND f.status = 'ready' ORDER BY f.app, f.taken_at`).all(a.id);
    // India time, as the office reads it.
    const when = t => (t ? `${new Date(t + 5.5 * 3600e3).toISOString().replace('T', ' ').slice(0, 16)} IST` : '');
    const entries = [];

    const profiles = records.filter(r => r.kind === 'company_profile');
    entries.push({ name: 'Company.json', data: JSON.stringify({
      audit: { id: a.id, title: a.title, fy: a.fy, status: a.status, industry_tag: a.industry_tag, finalised_at: when(a.finalized_at), finalised_by: a.finalized_by_name || null },
      company: { name: a.client_name, plant: a.site_name, sector: a.sector, cluster: a.cluster },
      profiles_by_app: Object.fromEntries(profiles.map(p => [appName(p.app), p.payload])),
    }, null, 2) });

    const byApp = new Map();
    for (const r of records) if (r.kind !== 'company_profile') {
      if (!byApp.has(r.app)) byApp.set(r.app, []);
      byApp.get(r.app).push(r);
    }
    for (const [app, list] of byApp) {
      const folder = `Apps/${safe(appName(app))}`;
      const kinds = [...new Set(list.map(r => r.kind))];
      for (const kind of kinds) {
        const rows = list.filter(r => r.kind === kind).map(r => ({
          record_id: r.id, tag: r.tag, taken_at: when(r.taken_at), recorded_by: r.recorded_by, last_saved: when(r.saved_at),
          last_saved_by: r.updated_by_name || r.recorded_by, version: r.version, ...r.payload,
        }));
        entries.push({ name: `${folder}/${safe(kind)}.csv`, data: csv(rows) });
      }
      entries.push({ name: `${folder}/all-records.json`, data: JSON.stringify(list.map(r => ({ id: r.id, kind: r.kind, tag: r.tag, taken_at: r.taken_at, recorded_by: r.recorded_by, version: r.version, payload: r.payload })), null, 2) });
    }

    const index = [];
    const used = new Set();
    for (const f of files) {
      const isReport = f.id === a.report_file_id;
      const base = isReport ? `Report/${safe(f.original_name || 'Final report')}`
        : `Files/${safe(appName(f.app))}/${safe([f.equipment_tag, f.record_kind, f.kind].filter(Boolean).join(' '))}_${f.id.slice(0, 8)}`;
      let name = /\.\w{2,4}$/.test(base) ? base : `${base}.${EXT[f.mime] || 'bin'}`;
      while (used.has(name)) name = name.replace(/(\.\w+)$/, '_$1');
      used.add(name);
      const p = path.join(filesDir, f.audit_id, f.sha256);
      if (!fs.existsSync(p)) continue;
      entries.push({ name, data: fs.readFileSync(p), date: new Date(f.taken_at || f.created_at) });
      index.push({ file: name, app: appName(f.app), kind: isReport ? 'final report' : f.kind, caption: f.caption, record_kind: f.record_kind,
        equipment_tag: f.equipment_tag, field: f.field, taken_at: when(f.taken_at), taken_by: f.uploaded_by_name, screen: f.captured_in,
        location: f.lat != null ? `${f.lat}, ${f.lng}` : '', map: f.lat != null ? `https://www.google.com/maps/search/?api=1&query=${f.lat},${f.lng}` : '' });
    }
    if (index.length) entries.push({ name: 'Files/index.csv', data: csv(index) });

    entries.push({ name: 'README.txt', data: '﻿' + [
      `${a.client_name} — ${a.site_name}`,
      `Audit ${a.id} · ${a.title} · ${a.fy} · industry tag ${a.industry_tag}`,
      a.finalized_at ? `Finalised ${when(a.finalized_at)}${a.finalized_by_name ? ` by ${a.finalized_by_name}` : ''}` : `Status: ${a.status} (not finalised)`,
      `Downloaded ${when(Date.now())} from the ARES Console, AR Energy Services.`,
      '',
      'Company.json        company and plant details, as saved in each app',
      'Apps/<app>/<kind>.csv  every record, one row each (open in Excel)',
      'Apps/<app>/all-records.json  the same data, complete',
      'Files/              photos and instrument files; Files/index.csv says what each shows, who took it, when and where',
      'Report/             the final report, when one was attached at finalising',
    ].join('\r\n') });

    const zip = buildZip(entries);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': zip.length,
      'Content-Disposition': `attachment; filename="${safe(`${a.client_name} ${a.site_name} ${a.id}`).replace(/ /g, '_')}.zip"`,
      'Cache-Control': 'no-store',
    });
    res.end(zip);
    logActivity(db, { userId: auth.user.id, action: 'audit.exported', target: a.id, ip });
  });
}
