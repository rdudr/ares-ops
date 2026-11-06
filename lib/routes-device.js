import { fail, str } from './http.js';
import { logSyncIssues } from './audit-status.js';
import { reconcileTasks } from './tasks.js';
import { tx, logActivity } from './db.js';
import { APP_CODES, SECTORS, WORK_TYPES, STATES } from './apps.js';
import { createAudit, currentFy, auditProfile } from './audits.js';
import { linkPhotosOfRecord } from './photo-links.js';
import { hashPassword, verifyPassword, passwordProblem } from './security.js';
import { checkCredentials, createSession, hasApp, isManager, auditAccess, CLOSED_AUDIT } from './auth.js';
import { takeLaunchCode } from './launch.js';
import { openStream, publish } from './events.js';

const RECORD_ID = /^[A-Za-z0-9-]{8,64}$/;
const MAX_PAYLOAD = 256 * 1024;
const PULL_LIMIT = 1000;
const BACKFILL_LIMIT = 5000;
// A phone's clock may run at most this far ahead of the server. Anything later is refused
// instead of quietly winning every conflict.
const CLOCK_SKEW = 5 * 60 * 1000;

export const normaliseTag = t => (t == null ? null : String(t).trim().replace(/\s+/g, ' ').slice(0, 60) || null);

// Each sync gets its own strictly increasing stamp, so a phone's `since` never skips or
// repeats a record, even when two syncs land in the same millisecond.
let lastStamp = null;
export function syncStamp(db) {
  if (lastStamp === null) lastStamp = db.prepare('SELECT MAX(synced_at) AS m FROM records').get().m || 0;
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

export function myAudits(db, user) {
  // logo_file_id: the company's logo (Audits > New audit), shown beside the company in every app.
  const cols = `SELECT au.id, au.title, au.fy, au.status, au.work_type, au.synthetic, s.name AS site_name, s.industry_tag,
    (SELECT f.id FROM files f WHERE f.audit_id = au.id AND f.kind = 'logo' AND f.status = 'ready' ORDER BY f.created_at DESC LIMIT 1) AS logo_file_id`;
  return isManager(user)
    ? db.prepare(`${cols}, NULL AS assigned_at FROM audits au JOIN sites s ON s.id = au.site_id
                  WHERE au.status NOT IN ('published','archived') ORDER BY au.created_at DESC`).all()
      .filter(a => auditAccess(db, user, a.id))
    // Finalised audits leave the apps' lists for everyone (their data stays on the server).
    : db.prepare(`${cols}, a.assigned_at FROM audits au JOIN sites s ON s.id = au.site_id
                  JOIN assignments a ON a.audit_id = au.id WHERE a.user_id = ? AND au.status NOT IN ('published','archived')
                  ORDER BY au.created_at DESC`).all(user.id);
}

export const PULL_COLUMNS = `r.id, r.audit_id, r.app, r.kind, r.tag, r.taken_at, r.saved_at, r.synced_at, r.version, r.payload,
       r.user_id, u.name AS recorded_by, r.updated_by, ub.name AS updated_by_name
  FROM records r JOIN users u ON u.id = r.user_id LEFT JOIN users ub ON ub.id = r.updated_by`;
export const asRecord = r => ({ ...r, payload: JSON.parse(r.payload) });

function requireReady(user) {
  if (user.must_change_pw) fail(403, 'Please set your own password first.', 'password_change_required');
}

export function registerDeviceRoutes(router) {
  // Field app sign-in. Same Login ID and password for every app; access is checked per app.
  router.add('POST', '/api/device/login', async ({ db, body, ip }) => {
    const b = await body();
    const app = String(b.app || '');
    if (!APP_CODES.has(app)) fail(400, 'Unknown app.');
    const deviceId = b.device_id ? str(b.device_id, { field: 'Device ID', max: 80 }) : null;
    const user = await checkCredentials(db, b.login_id, b.password, ip);
    if (!hasApp(db, user, app)) {
      logActivity(db, { userId: user.id, action: 'login.refused', target: app, detail: 'no access to app', ip });
      fail(403, 'You do not have access to this app. Please contact your admin.', 'no_app_access');
    }
    const token = createSession(db, user, { kind: 'device', app, deviceId });
    logActivity(db, { userId: user.id, action: 'login.app', target: app, detail: deviceId, ip });
    return {
      token,
      user: { id: user.id, name: user.name, login_id: user.login_id },
      must_change_pw: !!user.must_change_pw,
      audits: user.must_change_pw ? [] : myAudits(db, user),
    };
  }, { public: true });

  // Opened from the Console: swap the one-time launch code (lib/launch.js) for an app sign-in.
  router.add('POST', '/api/device/launch', async ({ db, body, ip }) => {
    const b = await body();
    const app = String(b.app || '');
    if (!APP_CODES.has(app)) fail(400, 'Unknown app.');
    const deviceId = b.device_id ? str(b.device_id, { field: 'Device ID', max: 80 }) : null;
    const userId = takeLaunchCode(b.code, app);
    const user = userId && db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || user.status !== 'active') {
      logActivity(db, { userId: user ? user.id : null, action: 'launch.refused', target: app, detail: 'code unknown, used, expired or person not active', ip });
      fail(401, 'This link has expired. Please open the app again from ARES Console.', 'launch_expired');
    }
    if (user.must_change_pw) fail(403, 'Please set your own password in ARES Console first.', 'password_change_required');
    const token = createSession(db, user, { kind: 'device', app, deviceId });
    logActivity(db, { userId: user.id, action: 'login.launch', target: app, detail: deviceId, ip });
    return {
      token,
      user: { id: user.id, name: user.name, login_id: user.login_id, role: user.role },
      must_change_pw: false,
      audits: myAudits(db, user),
    };
  }, { public: true });

  router.add('POST', '/api/device/change-password', async ({ db, body, auth, ip }) => {
    const b = await body();
    if (!(await verifyPassword(String(b.current || ''), auth.user.pw_hash))) fail(400, 'Current password is not correct.');
    const problem = passwordProblem(b.next);
    if (problem) fail(400, problem);
    if (b.next === b.current) fail(400, 'Choose a password different from the current one.');
    db.prepare('UPDATE users SET pw_hash = ?, must_change_pw = 0 WHERE id = ?').run(await hashPassword(b.next), auth.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(auth.user.id, auth.tokenHash);
    logActivity(db, { userId: auth.user.id, action: 'password.changed', target: auth.session.app, ip });
    return { ok: true };
  }, { device: true });

  // What the "Start a new audit" form needs: the sector list and this financial year.
  router.add('GET', '/api/device/audit-options', ({ auth }) => {
    requireReady(auth.user);
    return { sectors: SECTORS, work_types: WORK_TYPES, states: STATES, fy: currentFy() };
  }, { device: true });

  // An engineer on site starts an audit from the app: company + plant + sector + cluster. The
  // audit is created "in field" and assigned to them, so they can record straight away; managers
  // see it in the Console (activity log: audit.created_in_app) and can add the rest of the team.
  router.add('POST', '/api/device/audits', async ({ db, body, auth, ip }) => {
    requireReady(auth.user);
    const b = await body();
    const input = {
      client_name: b.client_name, site_name: b.site_name, sector: b.sector, cluster: b.cluster,
      title: b.title || (b.work_type ? '' : 'Energy audit'), fy: b.fy || currentFy(),
      district: b.district, state: b.state, pincode: b.pincode, contract_demand_kva: b.contract_demand_kva,
      msme_no: b.msme_no, work_type: b.work_type,
    };
    const id = tx(db, () => {
      const auditId = createAudit(db, input, { actorId: auth.user.id, status: 'in_field', reuseByName: true, ip, action: 'audit.created_in_app' });
      db.prepare('INSERT OR IGNORE INTO assignments (user_id, audit_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?)')
        .run(auth.user.id, auditId, auth.user.id, Date.now());
      return auditId;
    });
    return { audit_id: id, audits: myAudits(db, auth.user) };
  }, { device: true });

  // The company as registered for an audit (Audits > New audit): every app fills its company
  // profile from this, so the company is typed once. For people on the audit.
  router.add('GET', '/api/device/audit-profile', ({ db, auth, query }) => {
    requireReady(auth.user);
    const a = auditAccess(db, auth.user, query.get('audit_id'));
    if (!a) fail(404, 'Audit not found.');
    return { profile: auditProfile(db, a.id) };
  }, { device: true });

  // Plant details already known for an audit, from any AR app, so a second app (or a second
  // engineer) picks "use existing company" instead of typing the name and address again.
  router.add('GET', '/api/device/company-profiles', ({ db, auth, query }) => {
    requireReady(auth.user);
    const audit = auditAccess(db, auth.user, query.get('audit_id'));
    if (!audit) fail(404, 'Audit not found.');
    const site = db.prepare('SELECT s.name, c.name AS client_name FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.id = ?').get(audit.site_id);
    const FIELDS = ['companyName', 'area', 'district', 'state', 'pincode', 'overallConsumption'];
    const profiles = db.prepare(`SELECT r.app, r.saved_at, r.payload, ub.name AS saved_by FROM records r
        LEFT JOIN users ub ON ub.id = COALESCE(r.updated_by, r.user_id)
        WHERE r.audit_id = ? AND r.kind = 'company_profile' ORDER BY r.saved_at DESC`).all(audit.id)
      .map(r => {
        const p = JSON.parse(r.payload);
        if (p._deleted) return null;
        return { app: r.app, saved_at: r.saved_at, saved_by: r.saved_by, profile: Object.fromEntries(FIELDS.filter(f => p[f] != null && p[f] !== '').map(f => [f, p[f]])) };
      })
      .filter(p => p && p.profile.companyName);
    return { audit_id: audit.id, site: { name: site.name, client_name: site.client_name }, profiles };
  }, { device: true });

  // Sign out from an app: this app pass stops working at once (the person's other devices are not touched).
  router.add('POST', '/api/device/logout', ({ db, auth, ip }) => {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(auth.tokenHash);
    logActivity(db, { userId: auth.user.id, action: 'logout.app', target: auth.session.app, ip });
    return { ok: true };
  }, { device: true });

  // Live updates for the apps: an open stream that says when an audit's data changed.
  router.add('GET', '/api/device/events', ({ db, req, res, auth, sessionToken }) => {
    requireReady(auth.user);
    openStream(db, req, res, auth, { token: sessionToken });
  }, { device: true });

  router.add('GET', '/api/device/me', ({ db, auth }) => {
    requireReady(auth.user);
    return {
      user: { id: auth.user.id, name: auth.user.name, login_id: auth.user.login_id, role: auth.user.role },
      app: auth.session.app,
      audits: myAudits(db, auth.user),
    };
  }, { device: true });

  // One call does both directions: push this phone's queue, then pull what changed for the team.
  router.add('POST', '/api/sync', async ({ db, req, body, auth, ip }) => {
    const b = await body();
    const build = appBuild(req.headers['x-ares-app']);
    const user = auth.user;
    requireReady(user);
    const app = auth.session.app;
    const now = syncStamp(db);
    const incoming = Array.isArray(b.records) ? b.records : [];
    const sessions = Array.isArray(b.sessions) ? b.sessions : [];
    if (incoming.length > 500 || sessions.length > 200) fail(413, 'Send at most 500 records per sync.');
    const auditCache = new Map();
    const audit = id => {
      if (!auditCache.has(id)) auditCache.set(id, auditAccess(db, user, id));
      return auditCache.get(id);
    };

    const results = tx(db, () => incoming.map(r => pushRecord(db, user, app, r, now, audit, build)));

    tx(db, () => {
      for (const w of sessions) {
        if (typeof w?.id !== 'string' || !RECORD_ID.test(w.id)) continue;
        const startedAt = Number(w.started_at);
        const endedAt = w.ended_at == null ? null : Number(w.ended_at);
        if (!Number.isFinite(startedAt) || startedAt > now + CLOCK_SKEW) continue;
        if (endedAt !== null && (!Number.isFinite(endedAt) || endedAt < startedAt || endedAt > now + CLOCK_SKEW)) continue;
        const auditId = w.audit_id ? String(w.audit_id) : null;
        if (auditId && !audit(auditId)) continue;
        const existing = db.prepare('SELECT user_id FROM work_sessions WHERE id = ?').get(w.id);
        if (existing && existing.user_id !== user.id) continue;
        db.prepare(`INSERT INTO work_sessions (id, user_id, app, audit_id, device_id, started_at, ended_at, records, last_seen_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, records = excluded.records, last_seen_at = excluded.last_seen_at`)
          .run(w.id, user.id, app, auditId, auth.session.device_id, startedAt, endedAt === null ? null : Math.min(endedAt, now),
            Math.max(0, Math.floor(Number(w.records) || 0)), now);
      }
    });

    // Refused and clashing saves are kept for the audit page; a record that saves closes its own.
    tx(db, () => logSyncIssues(db, { user, app, build, incoming, results,
      audit: id => db.prepare('SELECT 1 FROM audits WHERE id = ?').get(id) }));

    const count = st => results.filter(r => r.status === st).length;
    const saved = count('stored') + count('updated');
    // Live updates: everyone working on these audits syncs straight away (lib/events.js).
    const touched = new Set(incoming.filter((r, i) => ['stored', 'updated'].includes(results[i]?.status)).map(r => String(r.audit_id)));
    for (const auditId of touched) publish(db, { audit_id: auditId, app, what: 'records' });
    // Data-entry targets reached and process tasks the new data finishes close at once.
    if (touched.size) tx(db, () => { for (const auditId of touched) reconcileTasks(db, auditId); });
    if (saved || count('refused') || count('conflict')) {
      logActivity(db, { userId: user.id, action: 'sync', target: app, detail: `${saved} saved, ${count('conflict')} conflicts, ${count('refused')} refused · ${build ? `app ${build}` : 'app version not reported (older app)'}`, ip });
    }

    // Pull: everything changed since the phone's last sync, for its audits and this app.
    // An audit this person was added to after their last sync is sent in full (back-fill),
    // so they also get the records made before they joined it.
    const since = Number(b.since) || 0;
    const mine = myAudits(db, user);
    const isNew = a => since > 0 && a.assigned_at != null && a.assigned_at > since;
    const normal = mine.filter(a => !isNew(a)).map(a => a.id);
    const backfill = mine.filter(isNew).map(a => a.id);
    const inList = ids => ids.map(() => '?').join(',');
    let changed = [];
    if (normal.length) {
      changed = db.prepare(`SELECT ${PULL_COLUMNS}
        WHERE r.app = ? AND r.synced_at > ? AND r.audit_id IN (${inList(normal)})
        ORDER BY r.synced_at LIMIT ?`).all(app, since, ...normal, PULL_LIMIT + 1).map(asRecord);
    }
    const more = changed.length > PULL_LIMIT;
    if (more) changed.pop();
    if (backfill.length) {
      const seen = new Set(changed.map(r => r.id));
      const old = db.prepare(`SELECT ${PULL_COLUMNS}
        WHERE r.app = ? AND r.audit_id IN (${inList(backfill)}) ORDER BY r.synced_at LIMIT ?`)
        .all(app, ...backfill, BACKFILL_LIMIT).map(asRecord);
      for (const r of old) if (!seen.has(r.id)) changed.push(r);
    }
    return {
      results,
      records: changed,
      backfilled_audits: backfill,
      more,
      // Next `since`. When the list was cut short, step back one stamp so the rest of that
      // sync's batch is fetched (re-pulling a record is harmless: the phone matches it by ID).
      next_since: more ? changed[PULL_LIMIT - 1].synced_at - 1 : Math.max(since, now),
      server_time: now,
    };
  }, { device: true, bodyLimit: 8 * 1024 * 1024 });
}

/**
 * The app build that made a request, from the X-ARES-App header the field apps send
 * ("<app code> <version> <platform>"): "v0.1.9 Android", "v0.1.9 web". Null when absent or odd.
 */
export function appBuild(header) {
  const m = /^[a-z]{2,12} (\d{1,4}(?:\.\d{1,6}){1,3}|dev) (android|ios|web)$/.exec(String(header || '').trim());
  if (!m) return null;
  return `${m[1] === 'dev' ? 'dev build' : `v${m[1]}`} ${m[2] === 'web' ? 'web' : m[2] === 'ios' ? 'iOS' : 'Android'}`;
}

function pushRecord(db, user, app, r, now, audit, build = null) {
  const id = typeof r?.id === 'string' ? r.id : '';
  const refuse = reason => ({ id, status: 'refused', reason });
  if (!RECORD_ID.test(id)) return refuse('Record ID is missing or not valid.');
  if (r.app && r.app !== app) return refuse('Record belongs to a different app.');
  const a = audit(String(r.audit_id || ''));
  if (!a) return refuse('You are not assigned to this audit.');
  if (CLOSED_AUDIT.has(a.status)) return refuse('This audit is closed (published or archived) and can no longer be changed.');
  const takenAt = Number(r.taken_at), savedAt = Number(r.saved_at);
  if (!Number.isFinite(takenAt) || !Number.isFinite(savedAt)) return refuse('Record times are missing.');
  if (savedAt > now + CLOCK_SKEW || takenAt > now + CLOCK_SKEW) {
    return refuse('The clock on this phone is ahead of the real time. Turn on automatic date and time, then sync again.');
  }
  if (!r.payload || typeof r.payload !== 'object') return refuse('Record has no data.');
  const payload = JSON.stringify(r.payload);
  if (payload.length > MAX_PAYLOAD) return refuse('Record is too large.');
  const tag = normaliseTag(r.tag);
  const kind = r.kind == null ? null : String(r.kind).slice(0, 40);
  const saved = Math.min(savedAt, now); // never store a time later than the server's

  const existing = db.prepare('SELECT * FROM records WHERE id = ?').get(id);
  if (existing && (existing.app !== app || existing.audit_id !== a.id)) return refuse('Record ID already used elsewhere.');

  if (tag) {
    const clash = db.prepare(`SELECT r.id, u.name FROM records r JOIN users u ON u.id = r.user_id
                              WHERE r.audit_id = ? AND r.app = ? AND lower(r.tag) = lower(?) AND r.id != ?`)
      .get(a.id, app, tag, id);
    if (clash) return refuse(`Tag "${tag}" is already recorded by ${clash.name}.`);
  }

  if (!existing) {
    db.prepare(`INSERT INTO records (id, audit_id, app, user_id, updated_by, device_id, kind, tag, taken_at, saved_at, synced_at, version, payload, app_version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(id, a.id, app, user.id, user.id, r.device_id ? String(r.device_id).slice(0, 80) : null, kind, tag, takenAt, saved, now, payload, build);
    linkPhotosOfRecord(db, { id, audit_id: a.id, kind, tag, payload });
    return { id, status: 'stored', version: 1 };
  }

  // A resend of exactly what the server already has (e.g. a retry after a dropped connection).
  if (existing.payload === payload && existing.tag === tag && existing.kind === kind) {
    return { id, status: 'unchanged', version: existing.version };
  }

  // Edit rule. With base_version (the version the phone started editing from): accepted only if
  // nobody else saved in between. Without it: the later save wins. Either way, a losing edit comes
  // back as a conflict carrying the server's copy, never silently dropped.
  // A record saved over and over in a short time is two copies of an app handing it back and forth
  // (as happened with two compressors, 1,200 versions in 13 minutes): refused until it calms down,
  // and shown on the audit page as a sync problem.
  const recent = db.prepare('SELECT COUNT(*) AS n FROM record_versions WHERE record_id = ? AND saved_at > ?').get(id, now - 120000).n;
  if (recent >= 15) return refuse('Saved too often in two minutes, probably from two copies of the app open at once. Keep one open and save again in a minute.');

  const base = r.base_version == null ? null : Number(r.base_version);
  const accept = base !== null && Number.isFinite(base) ? base === existing.version : saved > existing.saved_at;
  if (!accept) {
    const server = asRecord(db.prepare(`SELECT ${PULL_COLUMNS} WHERE r.id = ?`).get(id));
    return {
      id, status: 'conflict', version: existing.version,
      reason: `Changed by ${server.updated_by_name || server.recorded_by} since you started editing.`,
      server,
    };
  }
  db.prepare('INSERT INTO record_versions (record_id, version, user_id, saved_at, payload, app_version) VALUES (?, ?, ?, ?, ?, ?)')
    .run(existing.id, existing.version, existing.updated_by || existing.user_id, existing.saved_at, existing.payload, existing.app_version);
  db.prepare('UPDATE records SET updated_by = ?, kind = ?, tag = ?, taken_at = ?, saved_at = ?, synced_at = ?, version = ?, payload = ?, app_version = ? WHERE id = ?')
    .run(user.id, kind, tag, takenAt, saved, now, existing.version + 1, payload, build, id);
  linkPhotosOfRecord(db, { id, audit_id: a.id, kind, tag, payload });
  return { id, status: 'updated', version: existing.version + 1 };
}
