// Live updates: the apps and the Console keep one open connection (server-sent events) and are told
// the moment an audit's data changes, so they sync straight away instead of polling. An event only
// says WHAT changed (audit, app, records or files); the data itself still comes through the normal,
// checked calls (/api/sync, /api/audits/:id/data), so nothing private travels on this channel.
//
//   event: change   data: {"audit_id":"AU-2627-0007","app":"motor","what":"records","at":1792300000000}
//
// Each connection is re-checked every heartbeat: an ended session or a paused person is cut off.
import { auditAccess, WEB_IDLE_MS } from './auth.js';
import { hashToken } from './security.js';

const HEARTBEAT_MS = 25_000;
const MAX_TOTAL = 400;
const MAX_PER_USER = 6;
const subs = new Set();

/** Open a live stream for a signed-in person (auth from the router). */
export function openStream(db, req, res, auth, { token }) {
  if (subs.size >= MAX_TOTAL) { res.writeHead(503, { 'Retry-After': '30' }); return res.end(); }
  const mine = [...subs].filter(s => s.user.id === auth.user.id);
  if (mine.length >= MAX_PER_USER) mine[0].close(); // the oldest of this person's tabs/devices gives way
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.write(`retry: 5000\nevent: ready\ndata: {"at":${Date.now()}}\n\n`);
  const tokenHash = token ? hashToken(token) : null;
  const sub = {
    user: auth.user, res,
    close: () => { clearInterval(beat); subs.delete(sub); if (!res.writableEnded) res.end(); },
  };
  const beat = setInterval(() => {
    // Still allowed? (session not ended, person still active)
    const now = Date.now();
    const ok = tokenHash
      && db.prepare(`SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
                     WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'
                       AND (s.kind = 'device' OR s.last_seen_at > ?)`).get(tokenHash, now, now - WEB_IDLE_MS);
    if (!ok) return sub.close();
    res.write(`: ${Date.now()}\n\n`);
  }, HEARTBEAT_MS);
  beat.unref();
  req.on('close', sub.close);
  subs.add(sub);
}

/** Tell everyone who may see this audit that its data changed. */
export function publish(db, { audit_id, app = null, what = 'records' }) {
  if (!audit_id || !subs.size) return;
  const line = `event: change\ndata: ${JSON.stringify({ audit_id, app, what, at: Date.now() })}\n\n`;
  const allowed = new Map();
  for (const s of subs) {
    if (!allowed.has(s.user.id)) allowed.set(s.user.id, !!auditAccess(db, s.user, audit_id));
    if (allowed.get(s.user.id)) s.res.write(line);
  }
}

export const liveCount = () => subs.size;
