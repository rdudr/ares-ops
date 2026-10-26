# Sync API for the ARES field apps

Every field app (Plant Survey, Compressed Air, Pumps, Cooling, …) talks to the server in the same
way. The idea: **the phone never waits for the network and nobody merges files by hand.** Records go
into a local queue and are pushed to the cloud automatically when online; the same call brings back
what the rest of the team has added.

All requests and responses are JSON. App codes: `survey`, `textile`, `air`, `pump`, `cool`,
`heat`, `power`, `bills`, `solar`, `report`.

## 1. Sign in

`POST /api/device/login`

```json
{ "login_id": "ravi.k", "password": "…", "app": "air", "device_id": "a stable ID for this phone" }
```

Returns `token`, `user`, `must_change_pw` and the `audits` this person may work on. Keep the token in
the app's secure storage and send it on every call as `Authorization: Bearer <token>`.
The token lasts 7 days.

If `must_change_pw` is true, show a "set your password" screen and call
`POST /api/device/change-password` with `{ "current": "…", "next": "…" }` before anything else.

## 2. Sync (push, then pull — one call)

`POST /api/sync`

```json
{
  "since": 1792300000000,
  "records": [
    {
      "id": "uuid made on the phone",
      "audit_id": "AU-2627-0001",
      "kind": "compressor",
      "tag": "C-01",
      "taken_at": 1792290000000,
      "saved_at": 1792290500000,
      "base_version": 2,
      "payload": { "…": "the app's own fields, named as in its Excel export" }
    }
  ],
  "sessions": [
    { "id": "uuid", "audit_id": "AU-2627-0001", "started_at": 1792280000000, "ended_at": 1792295000000, "records": 6 }
  ]
}
```

- `since` is the `next_since` from the previous sync (0 the first time).
- Send at most 500 records per call; send the rest in the next call.
- `tag` is the equipment tag. Spaces are tidied on the server (`"  C   01 "` becomes `"C 01"`) and
  tags are unique per audit and app, ignoring upper/lower case.
- `base_version` is the `version` the phone had when the person started editing an existing
  record (leave it out for a new record). Send it: it is what decides conflicts fairly. Without it
  the server falls back to "the later `saved_at` wins".
- Phone clocks: `taken_at` and `saved_at` more than 5 minutes ahead of the server are refused with a
  message asking the person to turn on automatic date and time.
- `sessions` are the work log: open one when the person starts collecting, close it (`ended_at`)
  when they stop. Send an open session with `ended_at: null` to show them as "working now".

Response:

```json
{
  "results": [{ "id": "…", "status": "stored | updated | unchanged | conflict | refused", "version": 3, "reason": "…", "server": { } }],
  "records": [ { "id": "…", "tag": "…", "version": 3, "recorded_by": "name", "updated_by_name": "name", "payload": { } } ],
  "backfilled_audits": ["AU-2627-0004"],
  "more": false,
  "next_since": 1792300123456,
  "server_time": 1792300123456
}
```

- Remove `stored`, `updated` and `unchanged` records from the local queue, and keep the returned
  `version` as the record's new `base_version`.
- `conflict`: someone else saved this record since the phone's copy. `server` holds their version.
  Show both to the person and let them choose; to keep theirs, send it again with
  `base_version` = the server's `version`. Nothing is discarded silently.
- `refused`: show the `reason` (tag already recorded by someone, audit closed, clock ahead, not
  assigned) so they can correct it. Published and archived audits refuse all new data.
- `backfilled_audits`: audits this person was added to since the last sync. Their older records
  are included in `records` even though they were saved before `since`.
- Save every record in `records` locally, matched by `id` (insert or replace). This is how Person 2
  sees Person 1's data.
- If `more` is true, call again straight away with the new `next_since`.

## 3. Photos and files

Photos, thermal images, scans and instrument files go to the file store, not inside records.
Accepted: JPEG, PNG, WebP, HEIC, PDF, Excel `.xlsx` and CSV, up to 25 MB. The content is checked on
arrival, so a renamed file of another type is refused.

1. **Announce:** `POST /api/files`

   ```json
   { "id": "uuid made on the phone", "audit_id": "AU-2627-0001", "kind": "thermal",
     "equipment_tag": "C-01", "pair_id": "uuid shared by the thermal and normal photo",
     "caption": "Compressor C-01 motor, hot spot on terminal box", "taken_at": 1792290000000,
     "mime": "image/jpeg", "size": 834221, "sha256": "hex of the whole file", "name": "IMG_0042.jpg" }
   ```

   `kind` is `photo`, `thermal`, `scan` or `instrument_file`. The **caption must say what the image
   shows**. The answer says how many bytes the server already has (`file.received`); if the same
   file is already stored for this audit it is `ready` straight away.
2. **Send the bytes** in pieces of up to 4 MB:
   `PUT /api/files/<id>/content?offset=<file.received>` with `Content-Type: application/octet-stream`.
   A wrong offset returns 409 with the right one, so an interrupted upload simply resumes.
   When the last piece arrives the server checks the sha256 and the file type, and the file
   becomes `ready`.
3. **Status:** `GET /api/files/<id>/status`. **Download:** `GET /api/files/<id>` (people assigned to
   the audit, and managers).

## 4. When access is removed

Any call can return 403 with one of these `code` values. Stop syncing, keep the local data, and
show the message to the person:

| code | meaning |
|---|---|
| `status_hold` | Access is on hold |
| `status_revoked` | Access has been removed |
| `app_revoked` / `no_app_access` | Not allowed to use this app |
| `password_change_required` | Must set own password first |

A 401 (`signed_out`) means the token expired or was ended: show the sign-in screen.

## 5. When to sync

On app open, when the network comes back, after saving a record (debounced a few seconds), and every
few minutes while the app is open. Show "waiting to sync: N" so people know nothing is lost.
