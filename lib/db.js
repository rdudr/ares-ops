import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// All times are stored as milliseconds since epoch (INTEGER).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  login_id      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  phone         TEXT,
  role          TEXT NOT NULL CHECK (role IN ('super_admin','head','engineer')),
  employment    TEXT NOT NULL DEFAULT 'staff' CHECK (employment IN ('staff','freelancer')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','hold','revoked')),
  pw_hash       TEXT NOT NULL,
  must_change_pw INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER,
  last_login_at INTEGER,
  created_at    INTEGER NOT NULL,
  created_by    TEXT
);

CREATE TABLE IF NOT EXISTS app_access (
  user_id    TEXT NOT NULL REFERENCES users(id),
  app        TEXT NOT NULL,
  granted_by TEXT,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, app)
);

CREATE TABLE IF NOT EXISTS clients (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sector     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sites (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES clients(id),
  name         TEXT NOT NULL,
  cluster      TEXT NOT NULL,
  industry_tag TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audits (
  id         TEXT PRIMARY KEY,
  site_id    TEXT NOT NULL REFERENCES sites(id),
  fy         TEXT NOT NULL,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS assignments (
  user_id     TEXT NOT NULL REFERENCES users(id),
  audit_id    TEXT NOT NULL REFERENCES audits(id),
  assigned_by TEXT,
  assigned_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, audit_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  audit_id   TEXT NOT NULL REFERENCES audits(id),
  app        TEXT,
  title      TEXT NOT NULL,
  assignee   TEXT REFERENCES users(id),
  status     TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','running','done')),
  due_at     INTEGER,
  started_at INTEGER,
  done_at    INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT
);

-- Field data sent by the apps. id is the UUID made on the phone.
CREATE TABLE IF NOT EXISTS records (
  id        TEXT PRIMARY KEY,
  audit_id  TEXT NOT NULL REFERENCES audits(id),
  app       TEXT NOT NULL,
  user_id   TEXT NOT NULL REFERENCES users(id),   -- who first recorded it
  updated_by TEXT REFERENCES users(id),           -- who saved the latest version
  device_id TEXT,
  kind      TEXT,
  tag       TEXT,
  taken_at  INTEGER NOT NULL,
  saved_at  INTEGER NOT NULL,
  synced_at INTEGER NOT NULL,
  version   INTEGER NOT NULL DEFAULT 1,
  payload   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS records_audit_app ON records (audit_id, app, synced_at);
CREATE INDEX IF NOT EXISTS records_user ON records (user_id, taken_at);

CREATE TABLE IF NOT EXISTS record_versions (
  record_id TEXT NOT NULL,
  version   INTEGER NOT NULL,
  user_id   TEXT NOT NULL,
  saved_at  INTEGER NOT NULL,
  payload   TEXT NOT NULL,
  PRIMARY KEY (record_id, version)
);

-- Photos, thermal images, scans and instrument files. Content lives at
-- <files dir>/<audit_id>/<sha256>; a file is usable once status = 'ready'.
CREATE TABLE IF NOT EXISTS files (
  id            TEXT PRIMARY KEY,                -- UUID made on the phone (safe to retry)
  audit_id      TEXT NOT NULL REFERENCES audits(id),
  app           TEXT NOT NULL,
  equipment_tag TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('photo','thermal','scan','instrument_file','logo','site')),
  pair_id       TEXT,                            -- links a thermal image to its normal photo
  caption       TEXT,                            -- what the image shows
  taken_at      INTEGER,
  uploaded_by   TEXT NOT NULL REFERENCES users(id),
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  received      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','ready')),
  original_name TEXT,
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS files_audit ON files (audit_id, app, status);

-- Time spent collecting data, logged by each app.
CREATE TABLE IF NOT EXISTS work_sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  app        TEXT NOT NULL,
  audit_id   TEXT REFERENCES audits(id),
  device_id  TEXT,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  records    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS work_user ON work_sessions (user_id, started_at);

-- Login sessions. Only a hash of the token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  kind         TEXT NOT NULL CHECK (kind IN ('web','device')),
  app          TEXT,
  device_id    TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

-- Append-only activity log.
CREATE TABLE IF NOT EXISTS activity (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  user_id TEXT,
  action  TEXT NOT NULL,
  target  TEXT,
  detail  TEXT,
  ip      TEXT
);
CREATE TRIGGER IF NOT EXISTS activity_no_update BEFORE UPDATE ON activity
  BEGIN SELECT RAISE(ABORT, 'activity log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS activity_no_delete BEFORE DELETE ON activity
  BEGIN SELECT RAISE(ABORT, 'activity log is append-only'); END;
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Additive changes to databases created by an older version.
function migrate(db) {
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
  // When a phone last reported an open work session (it does so on every sync).
  if (!has('work_sessions', 'last_seen_at')) db.exec('ALTER TABLE work_sessions ADD COLUMN last_seen_at INTEGER');
  // Photo details: the record and field it was taken for (linked from the record's photo reference),
  // where it was taken (GPS, when the phone allowed it) and the app screen it was taken on.
  for (const [col, type] of [['record_id', 'TEXT'], ['record_kind', 'TEXT'], ['field', 'TEXT'], ['lat', 'REAL'],
    ['lng', 'REAL'], ['accuracy_m', 'REAL'], ['captured_in', 'TEXT']]) {
    if (!has('files', col)) db.exec(`ALTER TABLE files ADD COLUMN ${col} ${type}`);
  }
  // Company and plant details asked when an audit is started (Audits > New audit, Report Studio, the apps):
  // the MSME (Udyam) number belongs to the company, the location and contract demand to the plant,
  // the type of work to the audit. The apps fill their company profile from these.
  if (!has('clients', 'msme_no')) db.exec('ALTER TABLE clients ADD COLUMN msme_no TEXT');
  for (const [col, type] of [['district', 'TEXT'], ['state', 'TEXT'], ['pincode', 'TEXT'], ['contract_demand_kva', 'REAL']]) {
    if (!has('sites', col)) db.exec(`ALTER TABLE sites ADD COLUMN ${col} ${type}`);
  }
  if (!has('audits', 'work_type')) db.exec('ALTER TABLE audits ADD COLUMN work_type TEXT');
  // Finalising an audit: when, by whom, and the final report file.
  for (const [col, type] of [['finalized_at', 'INTEGER'], ['finalized_by', 'TEXT'], ['report_file_id', 'TEXT']]) {
    if (!has('audits', col)) db.exec(`ALTER TABLE audits ADD COLUMN ${col} ${type}`);
  }
  // AR profile cards: what the Team page shows and what the report's "assessment team" uses.
  // photo is a small JPEG/PNG/WebP data URL (checked and size-capped in routes-console.js).
  for (const [col, type] of [['position', 'TEXT'], ['qualification', 'TEXT'], ['experience', 'TEXT'], ['email', 'TEXT'],
    ['photo', 'TEXT'], ['in_report', 'INTEGER NOT NULL DEFAULT 1'], ['report_order', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!has('users', col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
  }
  // Company logo and site photograph (kinds 'logo' and 'site'): SQLite cannot change a CHECK, so the
  // files table is rebuilt once with the wider list, every row and column kept as it was.
  const filesSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'files'").get()?.sql || '';
  if (filesSql && !filesSql.includes("'logo'")) {
    const newSql = filesSql
      .replace(/CREATE TABLE (IF NOT EXISTS )?"?files"?/, 'CREATE TABLE files_new')
      .replace("'instrument_file')", "'instrument_file','logo','site')");
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      tx(db, () => {
        db.exec(newSql);
        db.exec('INSERT INTO files_new SELECT * FROM files');
        db.exec('DROP TABLE files');
        db.exec('ALTER TABLE files_new RENAME TO files');
        db.exec('CREATE INDEX IF NOT EXISTS files_audit ON files (audit_id, app, status)');
      });
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
  // AI report connector (lib/mcp.js): which audits are demo data, personal tokens, and every call.
  if (!has('audits', 'synthetic')) db.exec('ALTER TABLE audits ADD COLUMN synthetic INTEGER NOT NULL DEFAULT 0');
  // Which build of the app saved each version of a record ("v0.1.9 Android", "v0.1.9 web",
  // "Console"); empty for saves made before apps reported it.
  if (!has('records', 'app_version')) db.exec('ALTER TABLE records ADD COLUMN app_version TEXT');
  if (!has('record_versions', 'app_version')) db.exec('ALTER TABLE record_versions ADD COLUMN app_version TEXT');
  // Saves the Console refused or that clashed with a teammate's, shown on the audit page until
  // the same record saves later or someone marks them solved (lib/audit-status.js).
  db.exec(`CREATE TABLE IF NOT EXISTS sync_issues (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_id    TEXT NOT NULL,
    app         TEXT NOT NULL,
    user_id     TEXT REFERENCES users(id),
    record_id   TEXT NOT NULL,
    tag         TEXT,
    kind        TEXT,
    status      TEXT NOT NULL CHECK (status IN ('refused','conflict')),
    reason      TEXT NOT NULL,
    app_version TEXT,
    first_at    INTEGER NOT NULL,
    last_at     INTEGER NOT NULL,
    count       INTEGER NOT NULL DEFAULT 1,
    resolved_at INTEGER,
    resolved_by TEXT REFERENCES users(id),
    resolution  TEXT
  );
  CREATE INDEX IF NOT EXISTS sync_issues_open ON sync_issues (audit_id, resolved_at);
  CREATE INDEX IF NOT EXISTS sync_issues_record ON sync_issues (record_id, app, resolved_at);`);
  // The audit process (lib/stages.js): each company's stage, its history, the post audit, and each
  // person's role on an audit (team lead, field engineer, report writer).
  for (const [col, type] of [['stage', 'TEXT'], ['stage_at', 'INTEGER'], ['post_audit_status', 'TEXT'], ['post_audit_note', 'TEXT'], ['post_audit_at', 'INTEGER']]) {
    if (!has('audits', col)) db.exec(`ALTER TABLE audits ADD COLUMN ${col} ${type}`);
  }
  if (!has('assignments', 'role')) db.exec("ALTER TABLE assignments ADD COLUMN role TEXT NOT NULL DEFAULT 'field'");
  db.exec(`CREATE TABLE IF NOT EXISTS audit_stage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, audit_id TEXT NOT NULL, from_stage TEXT, to_stage TEXT NOT NULL,
    at INTEGER NOT NULL, by_user TEXT REFERENCES users(id), note TEXT);
  CREATE INDEX IF NOT EXISTS audit_stage_log_audit ON audit_stage_log (audit_id, at);`);
  // Tasks tied to the process and the data (lib/tasks.js): the stage a task belongs to, where it came
  // from (process, data entry, by hand), the key of a process task, a data-entry target and kind.
  for (const [col, type] of [['stage', 'TEXT'], ['source', "TEXT NOT NULL DEFAULT 'manual'"], ['auto_key', 'TEXT'], ['target', 'INTEGER'],
    ['record_kind', 'TEXT'], ['note', 'TEXT'], ['done_note', 'TEXT']]) {
    if (!has('tasks', col)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${type}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS tasks_auto ON tasks (audit_id, auto_key) WHERE auto_key IS NOT NULL');
  // Audits made before stages existed get one from their status and data.
  db.exec(`UPDATE audits SET stage_at = COALESCE(finalized_at, created_at), stage = CASE
      WHEN status IN ('archived','published') THEN 'completed'
      WHEN status = 'approved' THEN 'final'
      WHEN status = 'review' THEN 'approval'
      WHEN status = 'processing' THEN 'processing'
      WHEN EXISTS (SELECT 1 FROM records r WHERE r.audit_id = audits.id AND r.kind = 'report') THEN 'draft'
      WHEN EXISTS (SELECT 1 FROM records r WHERE r.audit_id = audits.id AND r.kind NOT IN ('company_profile','report','report_part','report_facts'))
        THEN CASE WHEN work_type = 'walkthrough' THEN 'walkthrough' ELSE 'detailed' END
      ELSE 'initiated' END
    WHERE stage IS NULL`);
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_tokens (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id),
      audit_id     TEXT NOT NULL REFERENCES audits(id),
      token_hash   TEXT NOT NULL UNIQUE,
      label        TEXT,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at   INTEGER
    );
    CREATE TABLE IF NOT EXISTS mcp_log (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id TEXT NOT NULL,
      user_id  TEXT NOT NULL,
      audit_id TEXT NOT NULL,
      tool     TEXT NOT NULL,
      bytes    INTEGER NOT NULL,
      sha256   TEXT NOT NULL,
      blocked  INTEGER NOT NULL DEFAULT 0,
      ok       INTEGER NOT NULL DEFAULT 1,
      at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mcp_log_audit ON mcp_log (audit_id, at);`);
  // Associated faculty: shown on the Team page and in the report's team, but they have no login.
  // Filled once from lib/faculty-seed.json (the AR audit website's team) when the table is made.
  const hadFaculty = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'faculty'").get();
  if (!hadFaculty) {
    db.exec(`CREATE TABLE faculty (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      position     TEXT,
      department   TEXT,
      email        TEXT,
      photo        TEXT,
      in_report    INTEGER NOT NULL DEFAULT 1,
      report_order INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      created_by   TEXT
    )`);
    const seedFile = new URL('./faculty-seed.json', import.meta.url);
    if (existsSync(seedFile)) {
      const { faculty = [] } = JSON.parse(readFileSync(seedFile, 'utf8'));
      const ins = db.prepare(`INSERT INTO faculty (id, name, position, department, email, photo, in_report, report_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`);
      for (const f of faculty) ins.run(f.id, f.name, f.position || null, f.department || null, f.email || null, f.photo || null, f.report_order || 0, Date.now());
    }
  }
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function logActivity(db, { userId = null, action, target = null, detail = null, ip = null }) {
  db.prepare('INSERT INTO activity (at, user_id, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Date.now(), userId, action, target, detail == null ? null : String(detail), ip);
}
