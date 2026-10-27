import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
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
  kind          TEXT NOT NULL CHECK (kind IN ('photo','thermal','scan','instrument_file')),
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
