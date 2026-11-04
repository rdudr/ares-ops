// The CEA CO2 Baseline Database: the versions the Energy Ledger knows, and the watch for a new one.
//
// CEA publishes one version a year. Every company's GHG record keeps the version and factor it was
// worked out with, so an old report never changes by itself.
//
// HOW A NEW VERSION ARRIVES
//   1. Once a day (and on "Check now") checkCea() reads CEA's public version page. The server only
//      compares the version number with the newest one held here.
//   2. A newer number shows as a notice on the Energy Ledger and on the Console Overview, and goes
//      into the activity log. Nothing changes by itself: the factors of a new version are read from
//      its User Guide by a person, because a wrong grid factor would quietly change every report.
//   3. The Super Admin adds the version on the Energy Ledger page (Appendix C, Tables A and B).
//      From then on it is offered to every company, and a company on an older version is told so.
// See docs/ENERGY-LEDGER.md.
import { logActivity } from './db.js';

export const CEA_PAGE = 'https://cea.nic.in/cdm-co2-baseline-view?mappingId=234&lang=en';
const DAY = 24 * 3600 * 1000;

// Version 22.0, User Guide of August 2026, Appendix C. Table B includes cross-border transfers and is
// the one the guide's summary (Table S) quotes; Table A excludes them. Build margin is the same in both.
const b = (fy, average, om, bm, cm) => ({ fy, cross_border: true, average, om, bm, cm });
const a = (fy, average, om, bm, cm) => ({ fy, cross_border: false, average, om, bm, cm });
export const SEED = {
  version: '22.0', published: 'August 2026',
  guide_url: 'https://cea.nic.in/api/cdm-report-version/view-pdf/en/82',
  db_url: 'https://cea.nic.in/api/cdm-report-version/view-pdf/en/83',
  rows: [
    b('2021-22', 0.711, 0.960, 0.869, 0.915), b('2022-23', 0.716, 0.971, 0.867, 0.919), b('2023-24', 0.727, 0.961, 0.552, 0.757),
    b('2024-25', 0.710, 0.961, 0.512, 0.736), b('2025-26', 0.675, 0.963, 0.446, 0.705),
    a('2021-22', 0.715, 0.968, 0.869, 0.918), a('2022-23', 0.719, 0.977, 0.867, 0.922), a('2023-24', 0.729, 0.964, 0.552, 0.758),
    a('2024-25', 0.712, 0.965, 0.512, 0.738), a('2025-26', 0.678, 0.969, 0.446, 0.708),
  ],
};

export function migrateCea(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS cea_versions (
      version   TEXT PRIMARY KEY,
      published TEXT,
      rows      TEXT NOT NULL,
      guide_url TEXT,
      db_url    TEXT,
      added_by  TEXT,
      added_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cea_watch (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      checked_at INTEGER,
      ok         INTEGER NOT NULL DEFAULT 0,
      latest     TEXT,
      error      TEXT,
      told       TEXT
    );`);
  db.prepare('INSERT OR IGNORE INTO cea_versions (version, published, rows, guide_url, db_url, added_by, added_at) VALUES (?, ?, ?, ?, ?, NULL, ?)')
    .run(SEED.version, SEED.published, JSON.stringify(SEED.rows), SEED.guide_url, SEED.db_url, Date.now());
  db.prepare('INSERT OR IGNORE INTO cea_watch (id) VALUES (1)').run();
}

const asVersion = r => ({ version: r.version, published: r.published, rows: JSON.parse(r.rows), guide_url: r.guide_url, db_url: r.db_url, added_at: r.added_at });
export const versionNumber = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

export function ceaVersions(db) {
  return db.prepare('SELECT * FROM cea_versions').all().map(asVersion).sort((x, y) => versionNumber(y.version) - versionNumber(x.version));
}
export const ceaCurrent = db => ceaVersions(db)[0];

export function ceaStatus(db) {
  const w = db.prepare('SELECT * FROM cea_watch WHERE id = 1').get();
  const current = ceaCurrent(db);
  return {
    page_url: CEA_PAGE, current: current.version, published: current.published,
    checked_at: w.checked_at, ok: !!w.ok, latest: w.latest, error: w.error,
    newer: !!w.latest && versionNumber(w.latest) > versionNumber(current.version),
  };
}

/** The highest "Version N.N" named on CEA's page, or null when the page no longer reads as expected. */
export function latestOnPage(html) {
  const found = [...String(html).matchAll(/Version\s+(\d{1,3}(?:\.\d{1,2})?)\b/gi)].map(m => m[1]);
  if (!found.length) return null;
  return found.sort((x, y) => versionNumber(y) - versionNumber(x))[0];
}

/** One look at CEA's page. Never throws: a failed look is kept and shown, so silence never reads as "no new version". */
export async function checkCea(db, { fetchImpl = fetch } = {}) {
  const now = Date.now();
  try {
    const res = await fetchImpl(CEA_PAGE, { headers: { 'User-Agent': 'ARES-Console (AR Energy Services)' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`CEA answered ${res.status}`);
    const latest = latestOnPage(await res.text());
    if (!latest) throw new Error('No version number found on the CEA page; its layout may have changed.');
    db.prepare('UPDATE cea_watch SET checked_at = ?, ok = 1, latest = ?, error = NULL WHERE id = 1').run(now, latest);
    const told = db.prepare('SELECT told FROM cea_watch WHERE id = 1').get().told;
    if (versionNumber(latest) > versionNumber(ceaCurrent(db).version) && told !== latest) {
      db.prepare('UPDATE cea_watch SET told = ? WHERE id = 1').run(latest);
      logActivity(db, { userId: null, action: 'cea.new_version', target: 'CEA', detail: `CDM-CO2 Baseline Database Version ${latest} is out; the Console holds ${ceaCurrent(db).version}` });
    }
  } catch (e) {
    db.prepare('UPDATE cea_watch SET checked_at = ?, ok = 0, error = ? WHERE id = 1').run(now, String(e.message || e).slice(0, 200));
  }
  return ceaStatus(db);
}

/** The daily look, started once by the running server. */
export function watchCea(db) {
  const look = () => checkCea(db).catch(err => console.error('CEA check', err));
  setTimeout(look, 60_000).unref();
  setInterval(look, DAY).unref();
}
