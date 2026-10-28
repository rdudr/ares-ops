// Photos taken in a field app reach the server as files; the record they belong to (a panel, a
// motor, a compressor …) holds a reference to them, "ares-photo:<file id>", in one of its fields.
// The two can arrive in either order (a photo may upload before or after its record syncs), so
// each side links itself to the other: the file gets the record's id, kind, field and equipment tag.
export const PHOTO_REF = /ares-photo:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

/** Every photo reference in a payload, with the field it sits in ("photoPath", "photos[2]" …). */
export function photoRefs(payload, path = '') {
  const out = [];
  if (typeof payload === 'string') {
    for (const m of payload.matchAll(PHOTO_REF)) out.push({ id: m[1], field: path || null });
  } else if (Array.isArray(payload)) {
    payload.forEach((v, i) => out.push(...photoRefs(v, `${path}[${i}]`)));
  } else if (payload && typeof payload === 'object') {
    for (const [k, v] of Object.entries(payload)) out.push(...photoRefs(v, path ? `${path}.${k}` : k));
  }
  return out;
}

const LINK = `UPDATE files SET record_id = ?, record_kind = ?, field = ?, equipment_tag = COALESCE(equipment_tag, ?)
              WHERE id = ? AND audit_id = ?`;

/** After a record is stored: link the photos it refers to. */
export function linkPhotosOfRecord(db, rec) {
  const payload = typeof rec.payload === 'string' ? JSON.parse(rec.payload) : rec.payload;
  if (payload?._deleted) return;
  for (const ref of photoRefs(payload)) {
    db.prepare(LINK).run(rec.id, rec.kind ?? null, ref.field, rec.tag ?? null, ref.id, rec.audit_id);
  }
}

/** After a file is announced: link it to the record already referring to it, if that came first. */
export function linkFileToRecord(db, file) {
  const rec = db.prepare(`SELECT id, audit_id, kind, tag, payload FROM records
                          WHERE audit_id = ? AND payload LIKE ? ORDER BY saved_at DESC LIMIT 1`)
    .get(file.audit_id, `%ares-photo:${file.id}%`);
  if (!rec) return;
  const ref = photoRefs(JSON.parse(rec.payload)).find(r => r.id === file.id);
  db.prepare(LINK).run(rec.id, rec.kind, ref?.field ?? null, rec.tag, file.id, file.audit_id);
}
