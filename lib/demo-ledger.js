// Energy Ledger records for the demo company (lib/demo.js): twelve months of bills, the energy
// baseline and the GHG inventory, laid out exactly as the Ledger page saves them
// (public/ledger-calc.js), so the Ledger, its PDF and Report Studio all have every case to show.
//
// Cases in the figures, all invented:
//  Bills     PF rebate months (above 0.95), a neutral month, PF penalty months (below 0.90);
//            demand above the 600 kVA contract (excess-demand charge) in the peak summer months;
//            a light-load Diwali shutdown month billed at the 85 % minimum demand; ToD night and
//            peak units every month, ToU discounts printed on some bills; one bill not yet verified.
//  Baseline  production in metres every month except the shutdown month (no intensity then);
//            grid kWh from the bills; rooftop solar; coal (boiler), natural gas (stenter) and diesel
//            (DG set, only in the months the grid failed); water every month.
//  GHG       CEA grid factor (Version on the server), mobile diesel, refrigerant top-up, Scope 3 lines.
import crypto from 'node:crypto';
import { SEED } from './cea.js';

const uid = () => crypto.randomUUID().slice(0, 8);
const recordId = (kind, auditId) => `led-${kind.replace('ledger_', '')}-${auditId}`.replace(/[^A-Za-z0-9-]/g, '-');

// April 2025 to March 2026 (FY2025-26).
const MONTHS = Array.from({ length: 12 }, (_, i) => { const m = ((3 + i) % 12) + 1; return { y: m >= 4 ? 2025 : 2026, m }; });
const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const key = ({ y, m }) => `${y}-${m < 10 ? '0' : ''}${m}`;
const label = ({ y, m }) => `${NAMES[m - 1]}-${y}`;

//                Apr     May     Jun     Jul     Aug     Sep     Oct     Nov(shut) Dec     Jan     Feb     Mar
const KWH =     [214000, 236500, 248900, 231200, 226400, 219800, 207300, 96400,   201900, 210600, 205100, 222700];
const PF =      [0.981,  0.962,  0.947,  0.884,  0.958,  0.972,  0.976,  0.862,   0.951,  0.969,  0.974,  0.893];
const MD =      [562,    618,    655,    604,    588,    571,    548,    298,     536,    552,    559,    597];
const NIGHT_PCT = [0.31, 0.30, 0.29, 0.30, 0.31, 0.32, 0.33, 0.44, 0.32, 0.31, 0.31, 0.30];
const PROD =    [412000, 448500, 466000, 431000, 425800, 418200, 396500, null,    389000, 404700, 398300, 427900];
const COAL_T =  [118, 129, 133, 124, 121, 119, 112, 31, 110, 116, 114, 123];
const GAS_SCM = [21400, 23300, 24100, 22200, 21900, 21500, 20300, 5200, 19800, 20900, 20500, 22100];
const DG_L =    [0, 380, 1240, 610, 0, 0, 0, 0, 0, 0, 0, 290];          // grid failures in summer and March
const SOLAR =   [41800, 44600, 36900, 28700, 30200, 36400, 39100, 37800, 34600, 35900, 39800, 43700];
const WATER_KL = [9100, 9850, 10200, 9400, 9300, 9150, 8700, 2600, 8500, 8900, 8750, 9450];

export function demoLedgerRecords(auditId, recordedBy) {
  const contract = 600;
  const rows = MONTHS.map((p, i) => {
    const kwh = KWH[i], pf = PF[i], md = MD[i];
    const energyRate = 4.55, fppaRate = 2.1;
    const night = Math.round(kwh * NIGHT_PCT[i]), peak = Math.round(kwh * 0.27);
    // What the DISCOM printed: worked out the same way the Ledger checks it, with small rounding
    // on most bills and one bill (August) that differs, so the "difference" column has something to show.
    const billingDemand = Math.max(md, contract * 0.85);
    const inSlabs = Math.min(billingDemand, contract);
    const demand = Math.min(inSlabs, 500) * 150 + Math.max(0, inSlabs - 500) * 260 + Math.max(0, billingDemand - contract) * 555;
    const energy = kwh * energyRate, fuel = kwh * fppaRate;
    const pfAdj = (pf > 0.95 ? -(pf - 0.95) * 0.5 : pf >= 0.9 ? 0 : 0.9 - pf) * energy;
    const tou = 0.85 * peak, touDiscount = i % 3 === 0 ? Math.round(night * 0.43) : null;
    const cons = demand + energy + fuel + pfAdj - 0.01 * energy + tou - (touDiscount || 0);
    const net = Math.round(cons * 1.15) + (i === 4 ? 18450 : 0);
    return {
      id: uid(), month: label(p), kwh, net, pf, actualMD: md, energyRate, fppaRate, todNight: night, todPeak: peak,
      touDiscount, kvah: Math.round(kwh / pf), verified: i !== 11, note: i === 7 ? 'Diwali shutdown, 19 days' : i === 4 ? 'Bill higher than worked out: arrears line' : '',
    };
  });
  const bills = {
    schema: 'ares-ledger-bills/v1',
    cfg: {
      discom: 'DGVCL (demo)', consumerNo: 'DEMO-0000-0001', contractDemand: contract, tariff: 'HTP-1',
      minBillingPct: 0.85, slabKva: 500, slab1Rate: 150, slab2Rate: 260, excessRate: 555,
      nightRebateRate: 0, ehvPct: 0.01, touRate: 0.85, touDiscRate: 0.43, dutyRate: 0.15, pfTarget: 0.999,
    },
    rows,
  };

  const solarId = uid(), coalId = uid(), gasId = uid(), dgId = uid();
  const per = arr => Object.fromEntries(MONTHS.map((p, i) => [key(p), arr[i]]).filter(([, v]) => v !== null && v !== 0));
  const baseline = {
    schema: 'ares-ledger-baseline/v1',
    months: MONTHS.map(p => ({ ...p })), prodUnit: 'Metre', secBasis: 1000,
    production: per(PROD),
    grid: per(KWH), gridAuto: Object.fromEntries(MONTHS.map(p => [key(p), true])),
    elecSources: [{ id: solarId, name: 'Rooftop solar 300 kWp', values: per(SOLAR) }],
    fuels: [
      { id: coalId, name: 'Coal (Indonesian)', unit: 'Ton', gcv: 4200, ef: 2396, values: per(COAL_T), autoName: false },
      { id: gasId, name: 'Natural gas', unit: 'SCM', gcv: 8500, ef: 2.04, values: per(GAS_SCM), autoName: false },
      { id: dgId, name: 'Diesel (DG set)', unit: 'Litre', gcv: 8600, ef: 2.66, values: per(DG_L), autoName: false },
    ],
    water: per(WATER_KL), waterSource: 'GIDC Water',
    note: 'Demo figures. November 2025: Diwali shutdown, no production; the DG set ran in May, June, July and March when the grid failed.',
  };

  const fy = '2025-26';
  const row = SEED.rows.find(r => r.fy === fy && r.cross_border);
  const ghg = {
    schema: 'ares-ledger-ghg/v1',
    fy, basis: 'average', crossBorder: true, gridEF: row.average,
    cea: { version: SEED.version, published: SEED.published, fy: row.fy, wantedFy: fy, exact: true, guide_url: SEED.guide_url, rows: SEED.rows },
    defra: null, meterName: 'ABT meter', site: 'Demo Unit 1, Sachin GIDC',
    lines: [
      { id: uid(), type: 'mobile', name: 'Diesel, company trucks and forklifts', qty: 14200, unit: 'litre', ef: 2.66 },
      { id: uid(), type: 'fugitive', name: 'R-32 refrigerant top-up (split ACs)', qty: 18, unit: 'kg', ef: 675 },
      { id: uid(), type: 'fugitive', name: 'R-134a top-up (chiller)', qty: 42, unit: 'kg', ef: 1430 },
      { id: uid(), type: 'scope3', name: 'Water supply', qty: 105900, unit: 'm³', ef: 0.177 },
      { id: uid(), type: 'scope3', name: 'Waste to landfill', qty: 86, unit: 'tonne', ef: 520 },
      { id: uid(), type: 'scope3', name: 'Hotel stay, auditors', qty: 14, unit: 'room-night', ef: 21.6 },
    ],
    reOffset: null, reOffsetSince: '', scope3Note: 'Demo lines: water, waste and business travel only.', inventoryLink: '',
  };
  const meta = { recordedBy, createdAt: new Date().toISOString() };
  return [
    { id: recordId('ledger_bills', auditId), app: 'ledger', kind: 'ledger_bills', tag: null, payload: { ...bills, ...meta } },
    { id: recordId('ledger_baseline', auditId), app: 'ledger', kind: 'ledger_baseline', tag: null, payload: { ...baseline, ...meta } },
    { id: recordId('ledger_ghg', auditId), app: 'ledger', kind: 'ledger_ghg', tag: null, payload: { ...ghg, ...meta } },
  ];
}
