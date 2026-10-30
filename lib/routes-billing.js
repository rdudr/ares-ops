import crypto from 'node:crypto';
import { HttpError, parseCookies } from './http.js';
import { loadSession, createSession, hasApp, WEB_MAX_MS } from './auth.js';
import { logActivity } from './db.js';
import { hashToken } from './security.js';

// GST Billing (billing.arenergyservices.in) is the open-source Free GST Billing Software, run on
// this server behind the ARES sign-in. Caddy asks /api/billing/check before every request to that
// site (forward_auth). Without a billing session, the person is sent to the Console, which hands
// a one-time code back to the billing site; that code becomes a billing session there.
// The two sessions are separate cookies on separate hosts, so neither can be used for the other.

const CODE_MS = 60 * 1000;
// Super Admins, and Admins who were given GST Billing (app code 'bills').
const mayBill = (db, u) => u.role === 'super_admin' || (u.role === 'head' && hasApp(db, u, 'bills'));
const codes = new Map(); // one-time code -> { userId, next, exp }

// A path on the billing site only (no other host, no protocol-relative URL).
const safeNext = n => (typeof n === 'string' && /^\/(?![/\\])/.test(n) && n.length < 2000 ? n : '/');

function redirect(res, to) {
  res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
  res.end();
}

export function registerBillingRoutes(router, { consoleCookie, secureCookies, billingHost, consoleUrl }) {
  const COOKIE = secureCookies ? '__Host-ares-bills' : 'ares-bills';
  const billingSession = (db, req) => {
    const a = loadSession(db, parseCookies(req.headers.cookie)[COOKIE], 'web');
    return a && a.session.app === 'bills' && mayBill(db, a.user) ? a : null;
  };
  const hostOf = req => String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();

  // Caddy's forward_auth: 2xx lets the request through to the billing app.
  router.add('GET', '/api/billing/check', ({ db, req, res }) => {
    let a = null;
    try { a = billingSession(db, req); } catch { a = null; } // on hold / revoked: same as signed out
    if (a) {
      res.writeHead(204, { 'X-ARES-User': encodeURIComponent(a.user.name) });
      return res.end();
    }
    const uri = String(req.headers['x-forwarded-uri'] || '/');
    const page = req.headers['sec-fetch-mode'] === 'navigate' || /text\/html/.test(req.headers.accept || '');
    if (!page || uri.startsWith('/api/')) throw new HttpError(401, 'Please sign in again: reload the page.', 'signed_out');
    return redirect(res, `${consoleUrl}/api/billing/sso?next=${encodeURIComponent(safeNext(uri))}`);
  }, { public: true });

  // On the Console host: signed in to the Console -> one-time code -> back to the billing site.
  router.add('GET', '/api/billing/sso', ({ db, req, res, query, ip }) => {
    if (hostOf(req) === billingHost) throw new HttpError(404, 'Not found.');
    const next = safeNext(query.get('next'));
    const a = loadSession(db, parseCookies(req.headers.cookie)[consoleCookie], 'web');
    if (!a || a.session.app) return redirect(res, '/#/billing');
    if (!mayBill(db, a.user)) throw new HttpError(403, 'You have not been given GST Billing. A Super Admin can give it to you.');
    const now = Date.now();
    for (const [k, v] of codes) if (v.exp < now) codes.delete(k);
    const code = crypto.randomBytes(24).toString('base64url');
    codes.set(code, { userId: a.user.id, next, exp: now + CODE_MS });
    logActivity(db, { userId: a.user.id, action: 'billing.opened', ip });
    return redirect(res, `https://${billingHost}/_ares/enter?code=${code}`);
  }, { public: true });

  // On the billing host (Caddy maps /_ares/enter here): the code becomes a billing session.
  router.add('GET', '/api/billing/enter', ({ db, req, res, query }) => {
    if (hostOf(req) !== billingHost) throw new HttpError(404, 'Not found.');
    const c = codes.get(String(query.get('code') || ''));
    codes.delete(String(query.get('code') || ''));
    if (!c || c.exp < Date.now()) return redirect(res, `${consoleUrl}/api/billing/sso`);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(c.userId);
    if (!user || user.status !== 'active' || !mayBill(db, user)) throw new HttpError(403, 'Not allowed.');
    const token = createSession(db, user, { kind: 'web', app: 'bills' });
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${WEB_MAX_MS / 1000}${secureCookies ? '; Secure' : ''}`);
    return redirect(res, c.next);
  }, { public: true });

  // Sign out of the billing site only (the Console session is untouched).
  router.add('GET', '/api/billing/signout', ({ db, req, res }) => {
    if (hostOf(req) !== billingHost) throw new HttpError(404, 'Not found.');
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ? AND app = 'bills'").run(hashToken(token));
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookies ? '; Secure' : ''}`);
    return redirect(res, `${consoleUrl}/#/overview`);
  }, { public: true });
}
