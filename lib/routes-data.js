// File store (photos, thermal images, scans, instrument files) and the per-audit read API used by
// PostMan, the dashboard and the AI services.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fail, readRaw } from './http.js';
import { logActivity } from './db.js';
import { APP_CODES } from './apps.js';
import { auditAccess, isManager, CLOSED_AUDIT } from './auth.js';
import { PULL_COLUMNS, asRecord, normaliseTag } from './routes-device.js';
import { linkFileToRecord } from './photo-links.js';

const FILE_ID = /^[A-Za-z0-9-]{8,64}$/;
const MAX_FILE = 25 * 1024 * 1024;
const MAX_CHUNK = 4 * 1024 * 1024;
const KINDS = ['photo', 'thermal', 'scan', 'instrument_file'];
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Allowed types and how to recognise the real content, so a renamed file cannot slip through.
const TYPES = {
  'image/jpeg': b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': b => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  'image/heic': b => b.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|mif1|msf1|hevc)$/.test(b.toString('latin1', 8, 12)),
  'application/pdf': b => b.toString('latin1', 0, 5) === '%PDF-',
  [XLSX]: b => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04,
  'text/csv': b => !b.subarray(0, 8192).includes(0),
};

const publicFile = f => ({
  id: f.id, audit_id: f.audit_id, app: f.app, equipment_tag: f.equipment_tag, kind: f.kind, pair_id: f.pair_id,
  caption: f.caption, taken_at: f.taken_at, uploaded_by: f.uploaded_by, uploaded_by_name: f.uploaded_by_name ?? undefined,
  mime: f.mime, size: f.size, sha256: f.sha256, status: f.status, received: f.received,
  original_name: f.original_name, created_at: f.created_at, completed_at: f.completed_at,
  url: f.status === 'ready' ? `/api/files/${f.id}` : null,
  // Where it belongs and where it was taken.
  record_id: f.record_id ?? null, record_kind: f.record_kind ?? null, field: f.field ?? null, captured_in: f.captured_in ?? null,
  location: f.lat != null && f.lng != null ? {
    lat: f.lat, lng: f.lng, accuracy_m: f.accuracy_m ?? null,
    map_url: `https://www.google.com/maps/search/?api=1&query=${f.lat},${f.lng}`,
  } : null,
});

// GPS from the phone, kept only when it is a real position.
function location(b) {
  const lat = Number(b.lat), lng = Number(b.lng), acc = b.accuracy_m == null ? null : Number(b.accuracy_m);
  if (b.lat == null || b.lng == null || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return [null, null, null];
  return [lat, lng, acc !== null && Number.isFinite(acc) && acc >= 0 ? Math.round(acc) : null];
}

// A device token reads only its own app's data; Report Studio (`report`) and the Console read all apps.
function readableApps(auth) {
  if (auth.via === 'web' || auth.session.app === 'report') return null; // null = every app
  return [auth.session.app];
}

const opt = (v, max) => (v == null || v === '' ? null : String(v).trim().slice(0, max) || null);

export function registerDataRoutes(router, { filesDir }) {
  const finalPath = f => path.join(filesDir, f.audit_id, f.sha256);
  const partPath = f => path.join(filesDir, '.uploading', `${f.id}.part`);

  // 1. Announce a file. Calling it again with the same id resumes the upload.
  router.add('POST', '/api/files', async ({ db, body, auth, ip }) => {
    const b = await body();
    const user = auth.user;
    if (user.must_change_pw) fail(403, 'Please set your own password first.', 'password_change_required');
    const id = String(b.id || '');
    if (!FILE_ID.test(id)) fail(400, 'File ID is missing or not valid.');
    const audit = auditAccess(db, user, b.audit_id);
    if (!audit) fail(403, 'You are not assigned to this audit.');
    if (CLOSED_AUDIT.has(audit.status)) fail(409, 'This audit is closed and can no longer be changed.');
    if (!KINDS.includes(b.kind)) fail(400, `Kind must be one of: ${KINDS.join(', ')}.`);
    if (!TYPES[b.mime]) fail(415, 'Only photos (JPEG, PNG, WebP, HEIC), PDF, Excel (.xlsx) and CSV files are accepted.');
    const size = Number(b.size);
    if (!Number.isInteger(size) || size < 1 || size > MAX_FILE) fail(413, 'Files must be between 1 byte and 25 MB.');
    const sha = String(b.sha256 || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha)) fail(400, 'sha256 of the file is required.');
    const takenAt = b.taken_at == null ? null : Number(b.taken_at);
    if (takenAt !== null && !Number.isFinite(takenAt)) fail(400, 'taken_at is not valid.');

    const existing = db.prepare('SELECT * FROM files WHERE id = ?').get(id);
    if (existing) {
      if (existing.uploaded_by !== user.id || existing.sha256 !== sha || existing.size !== size) fail(409, 'File ID already used for a different file.');
      return { file: publicFile(existing) };
    }
    const app = auth.via === 'device' ? auth.session.app : (APP_CODES.has(b.app) ? b.app : fail(400, 'Unknown app.'));
    const now = Date.now();
    // Same content already stored for this audit: no need to send the bytes again.
    const dup = db.prepare("SELECT 1 FROM files WHERE audit_id = ? AND sha256 = ? AND status = 'ready'").get(audit.id, sha);
    const [lat, lng, acc] = location(b);
    db.prepare(`INSERT INTO files (id, audit_id, app, equipment_tag, kind, pair_id, caption, taken_at, uploaded_by, mime, size, sha256,
                received, status, original_name, created_at, completed_at, lat, lng, accuracy_m, captured_in)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, audit.id, app, normaliseTag(b.equipment_tag), b.kind, opt(b.pair_id, 64), opt(b.caption, 500), takenAt, user.id,
        b.mime, size, sha, dup ? size : 0, dup ? 'ready' : 'uploading', opt(b.name, 200), now, dup ? now : null, lat, lng, acc, opt(b.captured_in, 120));
    linkFileToRecord(db, { id, audit_id: audit.id });
    if (dup) logActivity(db, { userId: user.id, action: 'file.uploaded', target: audit.id, detail: `${b.kind} ${id} (already stored)`, ip });
    return { file: publicFile(db.prepare('SELECT * FROM files WHERE id = ?').get(id)) };
  }, { auth: 'either' });

  // 2. Send the bytes in chunks of up to 4 MB: PUT /api/files/:id/content?offset=<bytes already sent>
  router.add('PUT', '/api/files/:id/content', async ({ db, req, auth, params, query, ip }) => {
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(params.id) || fail(404, 'File not found.');
    if (f.uploaded_by !== auth.user.id) fail(403, 'Only the person uploading this file can send its content.');
    if (f.status === 'ready') return { file: publicFile(f) };
    const offset = Number(query.get('offset'));
    if (offset !== f.received) fail(409, `Resume from byte ${f.received}.`, 'wrong_offset');
    const chunk = await readRaw(req, MAX_CHUNK);
    if (!chunk.length) fail(400, 'Empty chunk.');
    if (f.received + chunk.length > f.size) fail(400, 'More bytes than the announced size.');
    fs.mkdirSync(path.dirname(partPath(f)), { recursive: true, mode: 0o700 });
    fs.appendFileSync(partPath(f), chunk, { mode: 0o600 });
    const received = f.received + chunk.length;
    if (received < f.size) {
      db.prepare('UPDATE files SET received = ? WHERE id = ?').run(received, f.id);
      return { file: publicFile({ ...f, received }) };
    }
    // Complete: check the checksum and that the content really is the declared type.
    const data = fs.readFileSync(partPath(f));
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    if (sha !== f.sha256 || !TYPES[f.mime](data)) {
      fs.rmSync(partPath(f), { force: true });
      db.prepare('UPDATE files SET received = 0 WHERE id = ?').run(f.id);
      fail(422, sha !== f.sha256 ? 'The file arrived damaged (checksum mismatch). Please send it again.' : `The content is not a valid ${f.mime} file.`);
    }
    fs.mkdirSync(path.dirname(finalPath(f)), { recursive: true, mode: 0o700 });
    if (fs.existsSync(finalPath(f))) fs.rmSync(partPath(f));
    else fs.renameSync(partPath(f), finalPath(f));
    db.prepare("UPDATE files SET received = ?, status = 'ready', completed_at = ? WHERE id = ?").run(received, Date.now(), f.id);
    logActivity(db, { userId: auth.user.id, action: 'file.uploaded', target: f.audit_id, detail: `${f.kind} ${f.id}`, ip });
    return { file: publicFile(db.prepare('SELECT * FROM files WHERE id = ?').get(f.id)) };
  }, { auth: 'either' });

  router.add('GET', '/api/files/:id/status', ({ db, auth, params }) => {
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(params.id) || fail(404, 'File not found.');
    if (f.uploaded_by !== auth.user.id && !auditAccess(db, auth.user, f.audit_id)) fail(404, 'File not found.');
    return { file: publicFile(f) };
  }, { auth: 'either' });

  // 3. Download: managers, and people assigned to the file's audit.
  router.add('GET', '/api/files/:id', ({ db, res, auth, params, ip }) => {
    const f = db.prepare("SELECT * FROM files WHERE id = ? AND status = 'ready'").get(params.id);
    const apps = readableApps(auth);
    if (!f || !auditAccess(db, auth.user, f.audit_id) || (apps && !apps.includes(f.app))) fail(404, 'File not found.');
    const inline = f.mime.startsWith('image/') || f.mime === 'application/pdf';
    res.writeHead(200, {
      'Content-Type': f.mime,
      'Content-Length': f.size,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${(f.original_name || f.id).replace(/[^\w.-]/g, '_')}"`,
      'Content-Security-Policy': 'sandbox',
      'Cache-Control': 'private, max-age=3600',
    });
    if (auth.via === 'web') logActivity(db, { userId: auth.user.id, action: 'file.downloaded', target: f.audit_id, detail: f.id, ip });
    fs.createReadStream(finalPath(f)).pipe(res);
  }, { auth: 'either' });

  // 4. Everything stored for one audit: records per app plus file details.
  //    Contract: docs/READ_API.md (draft v0, to be agreed with the AI/report side).
  router.add('GET', '/api/audits/:id/data', ({ db, auth, params, query }) => {
    const audit = auditAccess(db, auth.user, params.id);
    if (!audit) fail(404, 'Audit not found.');
    const site = db.prepare('SELECT s.name, s.cluster, s.industry_tag, c.name AS client_name, c.sector FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.id = ?').get(audit.site_id);
    const allowedApps = readableApps(auth);
    let apps = query.get('app') ? [query.get('app')] : null;
    if (apps && !APP_CODES.has(apps[0])) fail(400, 'Unknown app.');
    if (allowedApps) apps = apps ? apps.filter(a => allowedApps.includes(a)) : allowedApps;
    const appFilter = apps ? ` AND r.app IN (${apps.map(() => '?').join(',') || "''"})` : '';
    const records = db.prepare(`SELECT ${PULL_COLUMNS} WHERE r.audit_id = ?${appFilter} ORDER BY r.app, r.kind, r.tag, r.taken_at`)
      .all(audit.id, ...(apps || [])).map(asRecord);
    const byApp = {};
    for (const r of records) (byApp[r.app] ||= []).push(r);
    const fileFilter = apps ? ` AND f.app IN (${apps.map(() => '?').join(',') || "''"})` : '';
    const files = db.prepare(`SELECT f.*, u.name AS uploaded_by_name FROM files f JOIN users u ON u.id = f.uploaded_by
                              WHERE f.audit_id = ? AND f.status = 'ready'${fileFilter} ORDER BY f.app, f.equipment_tag, f.taken_at`)
      .all(audit.id, ...(apps || [])).map(publicFile);
    return {
      schema: 'ares.audit-data/v0',
      generated_at: Date.now(),
      audit: {
        id: audit.id, title: audit.title, fy: audit.fy, status: audit.status,
        industry_tag: site.industry_tag, sector: site.sector, cluster: site.cluster, site_name: site.name,
        client_name: isManager(auth.user) ? site.client_name : undefined,
      },
      apps: byApp,
      files,
    };
  }, { auth: 'either' });
}
