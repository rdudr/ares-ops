// AI reading of electricity bills for Report Studio (docs/SYNC_API.md §6).
//
// Report Studio reads a bill with OCR first. When OCR cannot read it (a photo, a scan at an angle, a
// layout it does not know), Report Studio can ask the Console to have Claude read it. The figures come
// back as suggestions: Report Studio fills only empty fields and a person still checks and verifies
// every one against the bill on screen.
//
// Off unless the server is set up for it: ANTHROPIC_API_KEY in /etc/ares-apps/console.env and
// AI_BILL_READING=on. The key never leaves this server. Report Studio also asks for the client's consent
// per report before any bill is sent. Nothing is stored by the Console: the bill goes to the API,
// the figures come back, and only "ai.bill_read" (who, which audit, size) goes to the activity log.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = { 'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'application/pdf': 'document' };

// The fields of Report Studio's bill screen (src/p15_bills.js BILL_FIELDS), each a number or null.
const NUMBER_FIELDS = {
  kwh: 'Total units consumed in the month, kWh',
  net: 'Total bill amount payable, rupees',
  pf: 'Power factor (for example 0.98)',
  actualMD: 'Actual (recorded) maximum demand, kVA',
  energyRate: 'Energy charge rate, rupees per kWh',
  fppaRate: 'Fuel / FPPA surcharge rate, rupees per kWh',
  todNight: 'Night (off-peak) units, kWh',
  todPeak: 'Time-of-use / peak units, kWh',
  touDiscount: 'Time-of-use / ToD discount, rupees',
  contract: 'Contract demand, kVA',
  billingDemand: 'Billing demand as billed, kVA',
  kvah: 'Apparent energy, kVAh',
  energyCharge: 'Energy charge as billed, rupees',
  demandCharge: 'Demand charge as billed, rupees',
  fuelSurcharge: 'Fuel surcharge as billed, rupees',
  duty: 'Electricity duty as billed, rupees',
  rebate: 'Rebate or discount, rupees (positive number)',
  other: 'Other charges, rupees',
};
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['month', ...Object.keys(NUMBER_FIELDS)],
  properties: {
    month: { type: ['string', 'null'], description: 'Billing month as "Mon YYYY", for example "Apr 2026"' },
    ...Object.fromEntries(Object.entries(NUMBER_FIELDS).map(([k, d]) => [k, { type: ['number', 'null'], description: d }])),
  },
};
const PROMPT = `This is an Indian electricity (DISCOM) bill for an industrial consumer. Read the figures listed in the output schema from it.
- Give each figure exactly as printed on the bill, as a plain number: no commas, units or currency signs.
- Use null for any figure the bill does not show. Do not work figures out from others, and do not guess.
- If the bill covers several months or several sheets, read the current billing month only.`;

let client = null;
export function aiStatus() {
  const on = process.env.AI_BILL_READING === 'on' && !!process.env.ANTHROPIC_API_KEY;
  return { bill_reading: on, model: on ? MODEL : null };
}

export async function readBill({ mime, base64 }) {
  if (!aiStatus().bill_reading) {
    const e = new Error('AI reading of bills is not switched on for this server.'); e.status = 503; throw e;
  }
  const kind = TYPES[mime];
  if (!kind) { const e = new Error('Only JPEG, PNG, WebP photos and PDF bills can be read.'); e.status = 415; throw e; }
  if (!base64 || base64.length > MAX_BYTES * 1.37) { const e = new Error('The bill must be under 8 MB.'); e.status = 413; throw e; }
  client ||= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 120_000, maxRetries: 2 });
  let response;
  try {
  response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: kind, source: { type: 'base64', media_type: mime, data: base64 } },
        { type: 'text', text: PROMPT },
      ],
    }],
  });
  } catch (err) {
    // The AI service's own errors are never passed through as they are: a 401 from it would
    // read to Report Studio as "your ARES Console sign-in ended".
    const e = new Error(
      err instanceof Anthropic.RateLimitError ? 'The AI reader is busy. Please try again in a minute.'
      : err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError ? 'The AI reader is not set up correctly on the server (its key was refused).'
      : err instanceof Anthropic.BadRequestError ? 'The AI reader could not take this file. Try a clearer photo or a PDF.'
      : err instanceof Anthropic.APIError ? 'The AI reader is not available right now. Please try again later.'
      : 'The AI reader could not be reached. Please try again later.');
    e.status = err instanceof Anthropic.RateLimitError ? 503 : 502;
    e.cause = err;
    throw e;
  }
  if (response.stop_reason === 'refusal') {
    const e = new Error('The AI could not read this bill. Please type the figures from the image.'); e.status = 422; throw e;
  }
  if (response.stop_reason === 'max_tokens') {
    const e = new Error('The AI reply was cut short. Please try again.'); e.status = 502; throw e;
  }
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  let fields;
  try { fields = JSON.parse(text); } catch { const e = new Error('The AI reply could not be read. Please try again.'); e.status = 502; throw e; }
  // Keep only the known fields, numbers as numbers.
  const out = {};
  if (typeof fields.month === 'string' && fields.month.trim()) out.month = fields.month.trim().slice(0, 20);
  for (const k of Object.keys(NUMBER_FIELDS)) {
    const v = fields[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return { fields: out, model: response.model };
}
