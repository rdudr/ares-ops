// Which audits the AI report connectors may read.
// A demo audit always may. A real company's audit only while the Super Admin's "AI access" is on:
// it lasts AI_ACCESS_DAYS from when it was turned on and ends at once when the audit is published or
// archived, so a forgotten switch never leaves a client's data open.
import { CLOSED_AUDIT } from './auth.js';

export const AI_ACCESS_DAYS = 3;
export const AI_ACCESS_MS = AI_ACCESS_DAYS * 24 * 60 * 60 * 1000;

// `a` needs synthetic, status and ai_until.
export const aiOpen = (a, now = Date.now()) =>
  !!a && (!!a.synthetic || (Number(a.ai_until) > now && !CLOSED_AUDIT.has(a.status)));

// When a real audit's access ends (null when it is not on).
export const aiUntil = (a, now = Date.now()) =>
  a && !a.synthetic && Number(a.ai_until) > now && !CLOSED_AUDIT.has(a.status) ? Number(a.ai_until) : null;
