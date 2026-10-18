export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const fail = (status, message, code) => { throw new HttpError(status, message, code); };

export function securityHeaders(res, secure) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function readJson(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const type = req.headers['content-type'] || '';
    if (!type.startsWith('application/json')) return reject(new HttpError(415, 'Send JSON.'));
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limitBytes) {
        reject(new HttpError(413, 'Request is too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Tiny router: add(method, '/api/users/:id', handler, { public, device, allowPasswordChange, bodyLimit })
export function createRouter() {
  const routes = [];
  return {
    add(method, pattern, handler, opts = {}) {
      const keys = [];
      const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
      routes.push({ method, re, keys, handler, opts });
    },
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = pathname.match(r.re);
        if (m) {
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          return { handler: r.handler, opts: r.opts, params };
        }
      }
      return null;
    },
  };
}

// Input helpers: trim and bound strings; reject anything unexpected.
export function str(v, { field, min = 1, max = 120, pattern } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min || s.length > max) fail(400, `${field} must be ${min}-${max} characters.`);
  if (pattern && !pattern.test(s)) fail(400, `${field} is not in the right format.`);
  return s;
}

export function oneOf(v, list, field) {
  if (!list.includes(v)) fail(400, `${field} is not valid.`);
  return v;
}
