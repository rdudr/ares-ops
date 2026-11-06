// Energy Ledger for the demo company: electricity bills, energy baseline and GHG inputs, saved as the
// Ledger page saves them (app "ledger", kinds ledger_bills / ledger_baseline / ledger_ghg). All figures
// are invented. Factors are real: the grid factor from the CEA version on this server, fuel and other
// factors from the DEFRA 2026 set (public/ledger-factors.json), coal on an Indian GCV.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fail } from './http.js';
import { logActivity } from './db.js';
import { ceaCurrent } from './cea.js';
import { billCalc } from '../public/ledger-calc.js';

const FACTORS = JSON.parse(fs.readFileSync(new URL('../public/ledger-factors.json', import.meta.url), 'utf8'));
const KCAL_PER_KWH = 860;
const uid = () => crypto.randomUUID().slice(0, 8);
const factor = (g, n, u) => {
  const i = FACTORS.items.find(q => q.g === g && q.n === n && q.u === u);
  if (!i) throw new Error(`No DEFRA factor ${g} / ${n} / ${u}`);
  return i.v;
};
// FY 2025-26, April to March, as the Ledger keys them.
const MONTHS = Array.from({ length: 12 }, (_, i) => { const m = ((3 + i) % 12) + 1; return { y: m >= 4 ? 2025 : 2026, m }; });
const key = p => `${p.y}-${p.m < 10 ? '0' : ''}${p.m}`;
const label = p => `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][p.m - 1]}-${String(p.y).slice(2)}`;

/** The demo's twelve bills: the same units, PF and demand as its Report Studio bills (lib/demo.js). */
export function demoBillRows() {
  return MONTHS.map((p, i) => {
    const kwh = Math.round(205000 + 18000 * Math.sin(i / 2) + (i === 4 ? 22000 : 0));
    const pf = [0.97, 0.96, 0.93, 0.92, 0.95, 0.97, 0.98, 0.97, 0.94, 0.96, 0.97, 0.91][i];
    const md = [520, 548, 575, 590, 612, 560, 535, 520, 515, 530, 545, 580][i];
    const er = 4.6, fppa = 2.1, energy = kwh * er, fuel = kwh * fppa, demand = Math.max(md, 0.85 * 600) * 475, duty = (energy + fuel + demand) * 0.15;
    const tou = Math.round(kwh * 0.28), night = Math.round(kwh * 0.31), touDisc = Math.round(night * 0.4);
    return {
      id: uid(), month: label(p), kwh, net: Math.round(energy + fuel + demand + duty - touDisc), pf, actualMD: md,
      energyRate: er, fppaRate: fppa, todNight: night, todPeak: tou, touDiscount: touDisc,
      energyCharge: Math.round(energy), fuelSurcharge: Math.round(fuel), verified: true, source: 'demo',
    };
  });
}

export function demoLedgerPayloads(db) {
  const bills = {
    schema: 'ares-ledger-bills/v1',
    cfg: {
      discom: 'DGVCL', consumerNo: 'DEMO-0000-0000', contractDemand: 600, tariff: 'HTP-1',
      minBillingPct: 0.85, slabKva: 500, slab1Rate: 150, slab2Rate: 260, excessRate: 555,
      nightRebateRate: 0.4, ehvPct: 0.01, touRate: 0.85, touDiscRate: 0, dutyRate: 0.15, pfTarget: 0.999,
    },
    rows: demoBillRows(),
    note: 'Demo bills (invented).',
  };
  // Each bill amount is what the Ledger works out from this tariff, so the bills agree with it; one
  // (Dec-25) is ₹18,500 off on purpose (over the 0.5% the Ledger allows), to show the "does not agree with the tariff" check.
  const worked = billCalc(bills).rows;
  bills.rows.forEach((r, i) => { const off = r.month === 'Dec-25'; r.net = Math.round(worked[i].totalBill) + (off ? 18500 : 0); if (off) r.verified = false; });

  // Baseline: grid units from the bills, rooftop solar, coal and furnace oil for the boiler and the
  // thermic fluid heater, diesel for the DG set, and water.
  const per = (fn) => Object.fromEntries(MONTHS.map((p, i) => [key(p), fn(i, p)]));
  const coalGcv = 4200; // kcal/kg, Indian imported-blend coal at the plant
  const coal = {
    id: uid(), name: 'Coal', unit: 'Ton', gcv: coalGcv, pick: 'Coal (industrial)|tonnes', factorName: 'Coal (industrial)', basis: 'energy',
    ef: +((factor('Fuels', 'Coal (industrial)', 'kWh (Gross CV)') * coalGcv * 1000) / KCAL_PER_KWH).toFixed(1),
    source: `${FACTORS.short}, kWh gross CV basis at plant GCV`, autoName: false,
    values: per(i => Math.round(165 + 20 * Math.sin(i / 2) + (i === 4 ? 18 : 0))),
  };
  const fo = {
    id: uid(), name: 'Furnace oil', unit: 'Ton', gcv: 10050, pick: 'Fuel oil|tonnes', factorName: 'Fuel oil', basis: 'mass',
    ef: factor('Fuels', 'Fuel oil', 'tonnes'), source: FACTORS.short, autoName: false,
    values: per(i => +(11.5 + 1.5 * Math.cos(i / 3)).toFixed(1)),
  };
  const diesel = {
    id: uid(), name: 'Diesel (DG set)', unit: 'Litre', gcv: 8600, pick: 'Diesel (average biofuel blend)|litres', factorName: 'Diesel (average biofuel blend)', basis: 'mass',
    ef: factor('Fuels', 'Diesel (average biofuel blend)', 'litres'), source: FACTORS.short, autoName: false,
    values: per(i => [900, 1400, 2600, 3100, 1800, 700, 500, 400, 600, 800, 900, 1200][i]),
  };
  const bills12 = bills.rows;
  const baseline = {
    schema: 'ares-ledger-baseline/v1',
    months: MONTHS.map(p => ({ y: p.y, m: p.m })),
    prodUnit: 'Metre', secBasis: 1000,
    production: per(i => Math.round(1080000 + 90000 * Math.sin(i / 2) + (i === 4 ? 110000 : 0))),
    grid: Object.fromEntries(MONTHS.map((p, i) => [key(p), bills12[i].kwh])),
    gridAuto: Object.fromEntries(MONTHS.map(p => [key(p), true])),
    elecSources: [{ id: uid(), name: 'Rooftop solar (250 kWp)', values: per(i => [33500, 34800, 27600, 24100, 25300, 29800, 33900, 32400, 30200, 31800, 34600, 36100][i]) }],
    fuels: [coal, fo, diesel],
    water: per(i => Math.round(9200 + 700 * Math.sin(i / 2))),
    waterSource: 'GIDC Water',
    note: 'Demo baseline (invented). Grid units come from the bills.',
  };

  // GHG: CEA grid factor for FY 2025-26 (or the newest the version has), Table B (with cross-border transfers).
  const cea = ceaCurrent(db);
  const table = (cea?.rows || []).filter(r => r.cross_border).sort((a, b) => a.fy.localeCompare(b.fy));
  const row = table.find(r => r.fy === '2025-26') || table[table.length - 1] || null;
  const water = Object.values(baseline.water).reduce((a, v) => a + v, 0);
  const coalT = Object.values(coal.values).reduce((a, v) => a + v, 0), foT = Object.values(fo.values).reduce((a, v) => a + v, 0);
  // A line picked from the DEFRA list, as the GHG screen stores it (pick = its itemKey: group|name|unit|option).
  const line = (type, name, qty, [g, n, u]) => {
    const i = FACTORS.items.find(q => q.g === g && q.n === n && q.u === u);
    if (!i) throw new Error(`No DEFRA factor ${g} / ${n} / ${u}`);
    return { id: uid(), type, name, qty, unit: i.u, ef: i.v, source: FACTORS.short, pick: `${i.g}|${i.n}|${i.u}|${i.o}` };
  };
  const ghg = {
    schema: 'ares-ledger-ghg/v1',
    fy: '2025-26', basis: 'average', crossBorder: true,
    gridEF: row ? row.average : null,
    cea: row ? { version: cea.version, published: cea.published, fy: row.fy, wantedFy: '2025-26', exact: row.fy === '2025-26', guide_url: cea.guide_url || null, rows: cea.rows } : null,
    defra: { short: FACTORS.short, source: FACTORS.source, version: FACTORS.version, year: FACTORS.year, url: FACTORS.url },
    meterName: 'ABT meter', site: 'Demo Unit 1, Sachin GIDC',
    lines: [
      line('mobile', 'Diesel forklifts', 3600, ['Fuels', 'Diesel (average biofuel blend)', 'litres']),
      line('fugitive', 'R410A top-up (split ACs)', 14, ['Refrigerants and gases', 'R410A', 'kg']),
      line('fugitive', 'HFC-32 top-up (package AC)', 6, ['Refrigerants and gases', 'HFC-32', 'kg']),
      line('scope3', 'Well-to-tank: coal', coalT, ['Well-to-tank of fuels', 'Coal (industrial)', 'tonnes']),
      line('scope3', 'Well-to-tank: furnace oil', +foT.toFixed(1), ['Well-to-tank of fuels', 'Fuel oil', 'tonnes']),
      line('scope3', 'Water supply', water, ['Water supply', 'Water supply', 'cubic metres']),
      line('scope3', 'Water treatment', Math.round(water * 0.8), ['Water treatment', 'Water treatment', 'cubic metres']),
      line('scope3', 'Hotel stays (audit team)', 9, ['Hotel stay', 'India', 'Room per night']),
    ],
    reOffset: null, reOffsetSince: '', scope3Note: 'Demo Scope 3 lines (invented quantities).', inventoryLink: '',
  };
  return { ledger_bills: bills, ledger_baseline: baseline, ledger_ghg: ghg };
}

/** Saves the three Ledger records on a demo audit. Refuses a non-demo audit or one that already has them. */
export function createDemoLedger(db, actor, auditId, { ip } = {}) {
  const a = db.prepare('SELECT id, synthetic FROM audits WHERE id = ?').get(auditId) || fail(404, 'Audit not found.');
  if (!a.synthetic) fail(400, 'Ledger demo data goes only on a demo audit.');
  const payloads = demoLedgerPayloads(db);
  const now = Date.now();
  const ins = db.prepare(`INSERT INTO records (id, audit_id, app, user_id, updated_by, device_id, kind, tag, taken_at, saved_at, synced_at, version, payload)
    VALUES (?, ?, 'ledger', ?, ?, 'demo', ?, NULL, ?, ?, ?, 1, ?)`);
  for (const [kind, payload] of Object.entries(payloads)) {
    const id = `led-${kind.replace('ledger_', '')}-${a.id}`.replace(/[^A-Za-z0-9-]/g, '-');
    if (db.prepare('SELECT 1 FROM records WHERE id = ?').get(id)) fail(409, `This audit already has ${kind}.`);
    ins.run(id, a.id, actor.id, actor.id, kind, now, now, now, JSON.stringify(payload));
  }
  logActivity(db, { userId: actor.id, action: 'ledger.demo_created', target: a.id, ip });
  return { bills: payloads.ledger_bills.rows.length, baseline_months: payloads.ledger_baseline.months.length, ghg_lines: payloads.ledger_ghg.lines.length, grid_ef: payloads.ledger_ghg.gridEF, cea: payloads.ledger_ghg.cea?.version || null };
}
