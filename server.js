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

const here = path.dirname(fileURLToPath(import.meta.url));

const config = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '127.0.0.1',
  dbFile: process.env.DB_FILE || path.join(here, 'data', 'ares.db'),
  // Set both to 1 on the real server, behind HTTPS (e.g. Nginx or Hostinger's proxy).
  secureCookies: process.env.SECURE_COOKIES === '1',
  trustProxy: process.env.TRUST_PROXY === '1',
};

const COOKIE = config.secureCookies ? '__Host-ares' : 'ares';

export function createServer(db) {
  const setupCode = crypto.randomBytes(6).toString('hex').toUpperCase();
  const router = createRouter();
  registerConsoleRoutes(router, { setupCode });
  registerDeviceRoutes(router);

  const files = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    '/logo.png': ['logo.png', 'image/png'],
  };

  const server = http.createServer(async (req, res) => {
    securityHeaders(res, config.secureCookies);
    const url = new URL(req.url, 'http://localhost');
    const ip = (config.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;

    try {
      if (!url.pathname.startsWith('/api/')) {
        const f = req.method === 'GET' && files[url.pathname];
        if (!f) throw new HttpError(404, 'Not found.');
        res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': 'no-cache' });
        return res.end(readFileSync(path.join(here, 'public', f[0])));
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

      if (opts.device) {
        // Field apps: bearer token, re-checked against status and app access on every call.
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        ctx.auth = loadSession(db, token, 'device');
        if (!ctx.auth) throw new HttpError(401, 'Please sign in again.', 'signed_out');
      } else if (!opts.public) {
        // Console: cookie session for Super Admin / Head only.
        if (req.method !== 'GET') checkSameOrigin(req);
        ctx.auth = loadSession(db, parseCookies(req.headers.cookie)[COOKIE], 'web');
        if (!ctx.auth) throw new HttpError(401, 'Please sign in.', 'signed_out');
        if (!isManager(ctx.auth.user)) throw new HttpError(403, 'Not allowed.');
        if (ctx.auth.user.must_change_pw && !opts.allowPasswordChange) {
          throw new HttpError(403, 'Please set your own password first.', 'password_change_required');
        }
      } else if (req.method !== 'GET' && !url.pathname.startsWith('/api/device/')) {
        checkSameOrigin(req);
      }

      const out = await match.handler(ctx);
      if (!res.headersSent) sendJson(res, 200, out ?? { ok: true });
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) {
        if (err.status === 404 && !url.pathname.startsWith('/api/')) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('Not found');
        }
        return sendJson(res, err.status, { error: err.message, code: err.code });
      }
      console.error(new Date().toISOString(), req.method, url.pathname, err);
      sendJson(res, 500, { error: 'Something went wrong on the server.' });
    }
  });

  return { server, setupCode };
}

// Console requests must come from the console itself (blocks cross-site form posts).
function checkSameOrigin(req) {
  if (req.headers['x-ares'] !== '1') throw new HttpError(403, 'Request blocked.');
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Request blocked.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
