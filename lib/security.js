import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// scrypt cost parameters. N=2^15 takes ~100 ms per check, which slows down guessing.
const N = 32768, R = 8, P = 1, KEYLEN = 64, MAXMEM = 96 * 1024 * 1024;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [algo, n, r, p, salt, hash] = String(stored).split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM });
  return crypto.timingSafeEqual(key, expected);
}

// Used when the login ID does not exist, so the response takes the same time either way.
const DUMMY_HASH = await hashPassword(crypto.randomBytes(12).toString('hex'));
export const dummyVerify = pw => verifyPassword(pw, DUMMY_HASH);

export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 200) return 'Password is too long.';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Use both letters and numbers.';
  return null;
}

// Temporary password shown once to the admin. No look-alike characters (0/O, 1/l/I).
const TEMP_CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function tempPassword() {
  let out = '';
  for (let i = 0; i < 12; i++) out += TEMP_CHARS[crypto.randomInt(TEMP_CHARS.length)];
  // Guarantee a digit so it passes passwordProblem.
  return out.slice(0, 11) + String(2 + crypto.randomInt(8));
}

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');

const ID_CHARS = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export function randomId(prefix, len = 5) {
  let s = '';
  for (let i = 0; i < len; i++) s += ID_CHARS[crypto.randomInt(ID_CHARS.length)];
  return `${prefix}-${s}`;
}

// Simple in-memory limiter: at most `max` hits per key within `windowMs`.
export function rateLimiter(max, windowMs) {
  const hits = new Map();
  return key => {
    const now = Date.now();
    const list = (hits.get(key) || []).filter(t => now - t < windowMs);
    list.push(now);
    hits.set(key, list);
    if (hits.size > 10000) for (const [k, v] of hits) if (now - v[v.length - 1] > windowMs) hits.delete(k);
    return list.length <= max;
  };
}
