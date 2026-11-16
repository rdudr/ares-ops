# The report draft written with Claude, and its review

One report connector (repo `report_studio_ares`, `https://mcp.arenergyservices.in/mcp`) reads an audit,
lets Claude write the report, and saves the draft here. People review it on the audit's page in the
Console. Only an approved report prints as final. Code: `lib/routes-report.js`; tables
`report_drafts` and `report_draft_sections` (`lib/db.js`).

```
Claude ──(connector)──► PUT  /api/audits/:id/report-draft          saved, section by section, status "pending"
People (Console) ─────► POST /api/audits/:id/report-draft/sections/:sid   accept | edit | reject | reopen
Admin (Console) ──────► POST /api/audits/:id/stage {to: "approved"}       approves the report
Claude or Console ────► the connector prints: final only if approved and every section accepted,
                        otherwise stamped DRAFT; the PDF is stored with the audit's files
Publish ──────────────► POST /api/audits/:id/stage {to: "published"}      attaches the final PDF by itself
```

## Who may do what

| | AI sign-in (the connector) | People (Console, or a `report` app sign-in) |
|---|---|---|
| Read the draft and its review state | yes, audits with AI access on | yes |
| Save sections | yes; accepted sections are never overwritten | no |
| Accept, edit, reject, reopen a section | no | yes |
| Discard the whole draft | no | audit lead, Admin, Super Admin |
| Approve (Review → Approved) | no | Admin, Super Admin (`lib/stages.js`) |
| Store a printed PDF | yes, as file kind `scan`, PDF only | — |

Once the audit is **Approved** the text is frozen for everyone: to change a word, an Admin sends the
audit back to Review (with a reason). Any change to a section clears the "final" mark of a PDF
printed before it.

## The AI sign-in

The connector signs people in with `POST /api/device/login` and `"app": "report", "ai": true`
(`docs/SYNC_API.md`). That session (`sessions.ai = 1`) is held by this server, not by the connector:

- it reaches only routes marked `ai: true` in the router (`server.js`): `/api/device/me`,
  `/api/device/logout`, the read API, file download and the PDF upload, the draft routes and
  `/api/ai/log`. Anything else answers `403 ai_session` (no sync, no profile, no Console routes);
- each of those serves only audits whose AI access is on (`lib/ai-access.js`: demo audits, or a real
  audit for three days after the Super Admin turns it on, never once published or archived);
- `/api/device/me` lists only those audits.

## Draft format

```json
{
  "template": "walkthrough" | "detailed",
  "note": "one line for the reviewers",
  "settings": { "cover": "geda" | "commercial", "cover_photo": "P.<id>", "highlights": [{ "fact": "F.<id>", "label": "…" }] },
  "context": { "company": "…", "site": "…", "facts": { "<id>": { "label": "…", "display": "…" } },
               "tables": { "T.<id>": { "title": "…", "rows": 4 } }, "charts": { "C.<id>": { "title": "…" } },
               "photos": { "P.<id>": { "caption": "…", "kind": "photo" | "thermal", "file_id": "<ARES file id>" } } },
  "sections": [{ "id": "summary", "title": "Executive summary", "position": 1, "blocks": [ … ] }]
}
```

Blocks are the connector's "report-draft v1" blocks: `text`, `list`, `table`, `charts`, `photos`,
`recommendations` (a reviewer may set `"dropped": true` on one recommendation to leave it out).
Figures in text are references `[[F.<id>]]`; `[[COMPANY]]` and `[[SITE]]` stand for the names.
`context` is what the Console shows in place of the references (exact values and real names); it
comes from the connector with each save and never goes to the AI. Every reference in a section,
whether saved or edited, must exist in `context`, so an edit cannot point at a figure that is not
in the audit.

`GET /api/audits/:id/report-draft` returns `{ audit, draft, can }`; `draft` holds the sections
with `status`, `edited`, `comment` (why rejected), `revision`, and for people `ai_blocks` (what
Claude wrote) when a section was edited; `counts`, `frozen`, `final_ok` (approved and every section
accepted) and `pdf` (the last printed PDF: `file_id`, `final`, `pages`, `note`).

## Printing from the Console

"Print the final PDF" / "Print a draft PDF" on the audit's page calls
`POST /api/audits/:id/report-draft/print`. ARES makes a five-minute app sign-in for the person who
clicked and calls the connector at `REPORT_CONNECTOR_URL/internal/print` with the shared
`REPORT_CONNECTOR_KEY`; the connector answers only on the loopback address. Without both settings the
button is hidden and people ask Claude for the PDF instead. Settings (in the ARES service
environment, e.g. `/etc/ares-apps/console.env`):

```
REPORT_CONNECTOR_URL=http://127.0.0.1:8790
REPORT_CONNECTOR_KEY=<the same random value as RS_INTERNAL_KEY of the connector>
```

## The call log

The connector writes one line for every result it sends to Claude to `POST /api/ai/log` (who, which
audit, which tool, size, SHA-256; blocked results flagged). They go to `mcp_log`, the same table as
the older connector, and show on the audit's page under "What Claude asked for". A result that cannot
be logged is not sent.

## What the AI must never see

The read API adds `sensitive` for an AI sign-in only (`lib/ai-terms.js`): the company's names, places,
people (everyone with an ARES account and the advisors), identifying numbers (MSME, consumer and meter
numbers, pincode, phones, e-mails) and the single distinctive words of those names. The connector
masks all of them in every result and refuses a result that still holds one.

## The older connector

`/mcp` on `ops.` and `api.` (`lib/mcp.js`, personal tokens) is retired: it answers `410` with the new
address. `MCP_CONNECTOR=on` brings it back as it was.
