// One-time launch codes: the Console opens an app already signed in, with no second login screen.
// Someone signed in to the Console asks for a code for one app (POST /api/launch); the app is
// opened with ?launch=<code> and swaps it for its own app sign-in (POST /api/device/launch), as
// if the person had typed their password there. A code is random, kept only as a hash, works
// once, for that person and that app only, and expires after a minute.
import { newToken, hashToken } from './security.js';

const LIFE_MS = 60 * 1000;
const codes = new Map(); // hash of code -> { userId, app, exp }

function prune(now) {
  for (const [k, c] of codes) if (c.exp < now) codes.delete(k);
}

export function issueLaunchCode(userId, app) {
  const now = Date.now();
  prune(now);
  const code = newToken();
  codes.set(hashToken(code), { userId, app, exp: now + LIFE_MS });
  return { code, expires_in: LIFE_MS / 1000 };
}

// The code's person, or null when it is unknown, used, expired or for another app.
export function takeLaunchCode(code, app) {
  const key = hashToken(String(code || ''));
  const c = codes.get(key);
  codes.delete(key);
  if (!c || c.exp < Date.now() || c.app !== app) return null;
  return c.userId;
}
