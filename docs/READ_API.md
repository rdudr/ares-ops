# Read API: one audit's data (draft v0)

For Report Studio, the Console dashboard and the AI services (summaries, report drafts, the per-audit
chatbot). **Status: draft v0, to be agreed with the AI side before anyone builds on it.** The shape is
marked by `schema`; any breaking change bumps it to `v1`.

## Request

`GET /api/audits/<audit_id>/data` — optionally `?app=pump` for one app.

Sign in either way:

- **Console session** (Super Admin or Head Member): sees every app of every audit.
- **App token** from `POST /api/device/login`, sent as `Authorization: Bearer <token>`:
  - a token for the `report` app (Report Studio / Report Studio, the AI services) sees every app of the
    audits that person may use;
  - any other app's token sees only its own app.

Permission is the same as for sync: managers see every audit, everyone else only the audits they
are assigned to. Anything else returns 404.

## Response

```json
{
  "schema": "ares.audit-data/v0",
  "generated_at": 1792653650000,
  "audit": {
    "id": "AU-2627-0001", "title": "Detailed energy audit", "fy": "FY2026-27", "status": "in_field", "stage": "processing",
    "work_type": "walkthrough", "synthetic": false, "ai_access": false,
    "industry_tag": "TX-SRT-001", "sector": "TX", "cluster": "SRT", "site_name": "Unit 1",
    "client_name": "only for managers"
  },
  "apps": {
    "pump": [
      {
        "id": "uuid", "audit_id": "AU-2627-0001", "app": "pump", "kind": "pump_test", "tag": "P-01",
        "taken_at": 1792290000000, "saved_at": 1792290500000, "synced_at": 1792300000000, "version": 2,
        "user_id": "U-…", "recorded_by": "name", "updated_by": "U-…", "updated_by_name": "name",
        "payload": { "the app's fields, named as in its Excel export": "…" }
      }
    ]
  },
  "files": [
    {
      "id": "uuid", "audit_id": "AU-2627-0001", "app": "air", "kind": "thermal", "equipment_tag": "C-01",
      "pair_id": "uuid", "caption": "Compressor C-01 motor, hot spot on terminal box",
      "taken_at": 1792290000000, "uploaded_by": "U-…", "uploaded_by_name": "name",
      "mime": "image/jpeg", "size": 834221, "sha256": "…", "url": "/api/files/<id>"
    }
  ]
}
```

- With the report connector's AI sign-in the call answers `403 ai_access_off` unless the audit's AI
  access is on, and the response adds `sensitive`: what the connector must mask (`lib/ai-terms.js`,
  `docs/REPORT_DRAFT.md`).
- Records are sorted by app, kind, tag and time. `payload` is exactly what the app synced.
- Fetch a file's bytes with `GET <url>` using the same sign-in.
- For column-style access inside the database (dashboard queries), see the per-app views in
  `lib/views.sql`.

## AI drafts

The report draft written with Claude has its own routes and review: `docs/REPORT_DRAFT.md`.
