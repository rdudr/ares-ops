import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './lib/db.js';
import { HttpError, createRouter, securityHeaders, sendJson, readJson, parseCookies } from './lib/http.js';
import { loadSession, isManager, WEB_MAX_MS } from './lib/auth.js';
import { registerConsoleRoutes } from './lib/routes-console.js';
import { registerDeviceRoutes } from './lib/routes-device.js';
import { registerDataRoutes } from './lib/routes-data.js';
import { registerRecordRoutes } from './lib/routes-records.js';
import { registerBillingRoutes } from './lib/routes-billing.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const dbFile = process.env.DB_FILE || path.join(here, 'data', 'ares.db');
const config = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '127.0.0.1',
  dbFile,
  filesDir: process.env.FILES_DIR || path.join(path.dirname(dbFile), 'files'),
  // Set both to 1 on the real server, behind HTTPS (e.g. Caddy or Nginx).
  secureCookies: process.env.SECURE_COOKIES === '1',
  trustProxy: process.env.TRUST_PROXY === '1',
  // Web origins of the AR field apps allowed to call the app API from a browser or phone webview.
  // Only routes that need an app (bearer) token answer them; Console cookie routes never do.
  appOrigins: (process.env.APP_ORIGINS || 'https://localhost,capacitor://localhost,http://localhost:3000')
    .split(',').map(o => o.trim()).filter(Boolean),
  // GST Billing site (see lib/routes-billing.js) and the Console address it sends people to.
  billingHost: process.env.BILLING_HOST || 'billing.arenergyservices.in',
  consoleUrl: process.env.CONSOLE_URL || 'https://ops.arenergyservices.in',
};

const APP_API = /^\/api\/(device\/|sync$|files(\/|$)|audits\/[^/]+\/data$)/;

// Exact origins from APP_ORIGINS, plus any https://<name>.arenergyservices.in (where AR app web builds live).
function allowedAppOrigin(origin) {
  if (!origin) return false;
  if (config.appOrigins.includes(origin)) return true;
  return /^https:\/\/[a-z0-9-]+\.arenergyservices\.in$/.test(origin);
}

const COOKIE = config.secureCookies ? '__Host-ares' : 'ares';

export function createServer(db, { filesDir = config.filesDir } = {}) {
  const setupCode = crypto.randomBytes(6).toString('hex').toUpperCase();
  const router = createRouter();
  registerConsoleRoutes(router, { setupCode });
  registerDeviceRoutes(router);
  registerDataRoutes(router, { filesDir });
  registerRecordRoutes(router, { filesDir });
  registerBillingRoutes(router, { consoleCookie: COOKIE, secureCookies: config.secureCookies, billingHost: config.billingHost, consoleUrl: config.consoleUrl });

  const files = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    '/logo.png': ['logo.png', 'image/png'],
  };

  const server = http.createServer(async (req, res) => {
    securityHeaders(res, config.secureCookies);
    let url = null;
    try {
      // Parsed inside the try: a malformed request line must get a 400, not crash the process.
      try { url = new URL(req.url, 'http://localhost'); } catch { throw new HttpError(400, 'Bad request.'); }
      const ip = (config.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;

      if (!url.pathname.startsWith('/api/')) {
        const f = req.method === 'GET' && files[url.pathname];
        if (!f) throw new HttpError(404, 'Not found.');
        res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': 'no-cache' });
        return res.end(readFileSync(path.join(here, 'public', f[0])));
      }

      if (APP_API.test(url.pathname) && allowedAppOrigin(req.headers.origin)) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Vary', 'Origin');
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Methods': 'GET, POST, PUT',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Access-Control-Max-Age': '600',
          });
          return res.end();
        }
      }

      const match = router.match(req.method, url.pathname);
      if (!match) throw new HttpError(404, 'Not found.');
      const opts = match.opts;
      const ctx = {
        db, req, res, ip, params: match.params, query: url.searchParams,
        body: () => readJson(req, opts.bodyLimit || 256 * 1024),
        setSessionCookie: token => res.setHeader('Set-Cookie',
          `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${WEB_MAX_MS / 1000}${config.secureCookies ? '; Secure' : ''}`),
        clearSessionCookie: () => res.setHeader('Set-Cookie',
          `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${config.secureCookies ? '; Secure' : ''}`),
      };

      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const deviceAuth = () => {
        const a = loadSession(db, bearer, 'device');
        if (!a) throw new HttpError(401, 'Please sign in again.', 'signed_out');
        return { ...a, via: 'device' };
      };
      const consoleAuth = () => {
        // Console: cookie session for Super Admin / Head only. Automatic refreshes send
        // X-ARES-Background and do not count as activity for the 30-minute idle timeout.
        if (req.method !== 'GET') checkSameOrigin(req);
        const a = loadSession(db, parseCookies(req.headers.cookie)[COOKIE], 'web', { touch: req.headers['x-ares-background'] !== '1' });
        // A GST Billing session (app 'bills') is not a Console session.
        if (!a || a.session.app) throw new HttpError(401, 'Please sign in.', 'signed_out');
        if (!isManager(a.user)) throw new HttpError(403, 'Not allowed.');
        if (a.user.must_change_pw && !opts.allowPasswordChange) {
          throw new HttpError(403, 'Please set your own password first.', 'password_change_required');
        }
        return { ...a, via: 'web' };
      };

      if (opts.device) ctx.auth = deviceAuth();
      else if (opts.auth === 'either') {
        ctx.auth = bearer ? deviceAuth() : consoleAuth();
        if (ctx.auth.user.must_change_pw) throw new HttpError(403, 'Please set your own password first.', 'password_change_required');
      }
      else if (!opts.public) ctx.auth = consoleAuth();
      else if (req.method !== 'GET' && !url.pathname.startsWith('/api/device/')) checkSameOrigin(req);

      const out = await match.handler(ctx);
      if (!res.headersSent) sendJson(res, 200, out ?? { ok: true });
    } catch (err) {
      if (res.headersSent) return res.end();
      const api = url ? url.pathname.startsWith('/api/') : true;
      if (err instanceof HttpError) {
        if (err.status === 404 && !api) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('Not found');
        }
        return sendJson(res, err.status, { error: err.message, code: err.code });
      }
      console.error(new Date().toISOString(), req.method, url?.pathname, err);
      sendJson(res, 500, { error: 'Something went wrong on the server.' });
    }
  });
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return { server, setupCode };
}

// Console requests must come from the console itself (blocks cross-site form posts).
function checkSameOrigin(req) {
  if (req.headers['x-ares'] !== '1') throw new HttpError(403, 'Request blocked.');
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try { host = new URL(origin).host; } catch { throw new HttpError(403, 'Request blocked.'); }
  if (host !== req.headers.host) throw new HttpError(403, 'Request blocked.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Log and keep serving rather than letting one stray promise take the whole service down.
  process.on('unhandledRejection', err => console.error(new Date().toISOString(), 'unhandled rejection', err));
  const db = openDb(config.dbFile);
  const { server, setupCode } = createServer(db);
  // Remove expired sessions every hour.
  setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600000).unref();
  server.listen(config.port, config.host, () => {
    console.log(`ARES Console running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
    if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
      console.log('\nFirst run: no accounts yet. Open the Console and create the Super Admin.');
      console.log(`One-time setup code: ${setupCode}\n`);
    }
  });
}
