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
      "payload": { "…": "the app's own fields" }
    }
  ],
  "sessions": [
    { "id": "uuid", "audit_id": "AU-2627-0001", "started_at": 1792280000000, "ended_at": 1792295000000, "records": 6 }
  ]
}
```

- `since` is the `next_since` from the previous sync (0 the first time).
- Send at most 500 records per call; send the rest in the next call.
- `sessions` are the work log: open one when the person starts collecting, close it (`ended_at`)
  when they stop. Send an open session with `ended_at: null` to show them as "working now".

Response:

```json
{
  "results": [{ "id": "…", "status": "stored | updated | kept_server | refused", "reason": "…" }],
  "records": [ { "id": "…", "tag": "…", "recorded_by": "name", "payload": { } } ],
  "more": false,
  "next_since": 1792300123456,
  "server_time": 1792300123456
}
```

- Remove `stored`, `updated` and `kept_server` records from the local queue.
- Show `refused` records to the person with the reason (e.g. a tag already recorded by someone
  else) so they can correct it.
- Save every record in `records` locally, matched by `id` (insert or replace). This is how Person 2
  sees Person 1's data.
- If `more` is true, call again straight away with the new `next_since`.

## 3. When access is removed

Any call can return 403 with one of these `code` values. Stop syncing, keep the local data, and
show the message to the person:

| code | meaning |
|---|---|
| `status_hold` | Access is on hold |
| `status_revoked` | Access has been removed |
| `app_revoked` / `no_app_access` | Not allowed to use this app |
| `password_change_required` | Must set own password first |

A 401 (`signed_out`) means the token expired or was ended: show the sign-in screen.

## 4. When to sync

On app open, when the network comes back, after saving a record (debounced a few seconds), and every
few minutes while the app is open. Show "waiting to sync: N" so people know nothing is lost.
