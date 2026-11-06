// Energy Ledger: every figure in one place, used by the screens, the report, the Excel file and the
// tests, so they can never disagree. No browser or network here. Report Studio keeps its own engine and is
// fed the same raw inputs; test/smoke.mjs checks this one against the team's bill workbook.
//
// THE BILL (the team's "bills analysis" format; a yellow cell there is what is read off the bill)
//   billing demand  = max(actual MD, min billing % of contract demand, the tariff's floor)
//   demand charge   = slabs up to the contract demand + excess kVA x excess rate
//                     HTP-1: 500 kVA @ 150, next 500 @ 260, rest @ 475, above contract @ 555
//   energy charge   = rate x units          fuel surcharge = FPPA rate x units + Variable FPPAS
//                     Variable FPPAS (from Sep 2026) = % of demand + energy + base fuel, as printed
//                     The rate is the one on the bill, else the tariff order's for this month's
//                     billing demand: the whole month's units take the one slab rate.
//   PF adjustment   = energy charge x -(PF - 0.95) x 0.5    above 0.95 (rebate)
//                     0 from 0.90 to 0.95;  (0.90 - PF) below 0.90;  0.05 + (0.85 - PF) x 2 below 0.85
//   night rebate    = -(night rate x night units)     EHV = -(EHV % x energy charge)
//   TOU             = TOU rate x TOU units
//   TOU discount    = as printed on the bill, else TOU discount units x rate per kVA (always money off)
//   duty            = rate x total consumption charge, or 1 to 3 duty lines (cfg.edTypes): each line has
//                     its kWh, consumption charge, rate and amount. Lines must add up to the bill.
//   differences     = two checks. Consumption: printed total consumption charge - worked out.
//                     Bill: bill printed - (consumption charge + duty). Near zero says all is well.
//
// BASELINE   1 TOE = 10,000,000 kcal; 1 kWh = 860 kcal. Specific figures for a period are total over
//            total, never the mean of the months.
// GHG        Scope 1 = fuel x factor + the activity lines in Scope 1.
//            Scope 2 = grid kWh x CEA factor for the year (tCO2/MWh = kg/kWh).
//            On-site solar and the like carry no grid emission.

export const KCAL_PER_KWH = 860;
export const KCAL_PER_TOE = 1e7;
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const FUEL_UNITS = [
  { v: 'kg', per: 'kg', mult: 1 }, { v: 'Ton', per: 'kg', mult: 1000 },
  { v: 'Litre', per: 'litre', mult: 1 }, { v: 'SCM', per: 'SCM', mult: 1 },
];
export const fuelUnit = v => FUEL_UNITS.find(u => u.v === v) || FUEL_UNITS[0];
export const SEC_BASIS = [{ v: 1, t: 'per unit' }, { v: 1000, t: 'per 1,000 units' }, { v: 100000, t: 'per lakh units' }];

/** A number, or null for empty, text or infinity. Indian commas are fine. */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ---------- months ----------
export const monthKey = (y, m) => `${y}-${m < 10 ? '0' : ''}${m}`;
export const monthLabel = (y, m) => `${MONTHS[m - 1]}-${String(y).slice(2)}`;
/** Reads "Apr-25", "Apr 2025", "April 2025", "2025-04", "Apr-2025", "04/2025". */
export function parseMonth(s) {
  if (s instanceof Date) return { y: s.getFullYear(), m: s.getMonth() + 1 };
  s = String(s || '').trim();
  let m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m) return { y: +m[1], m: +m[2] };
  m = /^(\d{1,2})[/-](\d{4})$/.exec(s);
  if (m) return { y: +m[2], m: +m[1] };
  m = /^([A-Za-z]{3,9})[\s\-,.']*(\d{2,4})$/.exec(s);
  if (m) {
    const i = MONTHS.findIndex(x => x.toLowerCase() === m[1].slice(0, 3).toLowerCase());
    if (i >= 0) return { y: +m[2] < 100 ? 2000 + +m[2] : +m[2], m: i + 1 };
  }
  return null;
}
/** The financial year of a month: April 2025 to March 2026 is "2025-26". */
export function fyOf({ y, m }) {
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}
/** The twelve months of "2025-26" or "FY2025-26". */
export function fyMonths(fy) {
  const y = parseInt(String(fy).replace(/\D/g, '').slice(0, 4), 10);
  return Array.from({ length: 12 }, (_, i) => { const m = ((3 + i) % 12) + 1; return { y: m >= 4 ? y : y + 1, m }; });
}

// ---------- blank records ----------
export const blankBills = () => ({
  schema: 'ares-ledger-bills/v1',
  cfg: {
    discom: '', consumerNo: '', contractDemand: null, tariff: 'HTP-1',
    minBillingPct: 0.85, slabKva: 500, slab1Rate: 150, slab2Rate: 260, excessRate: 555,
    nightRebateRate: 0, ehvPct: 0.01, touRate: 0.85, touDiscRate: 0, dutyRate: 0.15, pfTarget: 0.999,
    supplier: '', supplyVolt: '11 / 22 kV', sets: [], otherName: '', otherOrder: '', edTypes: 1, edRate2: 0.1, edRate3: null,
  },
  rows: [],
});
export const blankBaseline = () => ({
  schema: 'ares-ledger-baseline/v1',
  months: [], prodUnit: 'Metre', secBasis: 1, production: {}, grid: {}, gridAuto: {}, elecSources: [], fuels: [],
  water: {}, waterSource: 'GIDC Water', note: '',
});
export const blankGhg = () => ({
  schema: 'ares-ledger-ghg/v1',
  fy: '', basis: 'average', crossBorder: true, gridEF: null, cea: null, defra: null,
  meterName: 'ABT meter', site: '', lines: [], reOffset: null, reOffsetSince: '', scope3Note: '', inventoryLink: '',
});

// ---------- tariff orders ----------
// public/ledger-tariffs.json holds the orders. Choosing a supplier and category copies that category's
// rates, order by order, into the company's cfg.sets, so a finished report never changes when a new
// order arrives, and each bill uses the order in force for its month.
const ym = p => p.y * 100 + p.m;
const ymOfEffective = s => { const [y, m] = String(s).split('-').map(Number); return y * 100 + m; };

/** Every order of this supplier that has this category, newest first. */
export function ordersFor(tariffs, supplier, category) {
  const group = tariffs.suppliers.find(s => s.code === supplier)?.group;
  return tariffs.orders.filter(o => o.group === group && o.categories[category])
    .sort((a, b) => ymOfEffective(b.effective) - ymOfEffective(a.effective))
    .map(({ categories, ...o }) => ({ ...o, cat: categories[category] }));
}
export function categoriesFor(tariffs, supplier) {
  const group = tariffs.suppliers.find(s => s.code === supplier)?.group;
  const out = new Map();
  for (const o of tariffs.orders) if (o.group === group) for (const [code, c] of Object.entries(o.categories)) if (!out.has(code)) out.set(code, c.name);
  return [...out].map(([code, name]) => ({ code, name }));
}
/** Puts the supplier's rates on this connection, and keeps the plain fields Report Studio reads in step. */
export function applyTariff(cfg, tariffs) {
  cfg.sets = ordersFor(tariffs, cfg.supplier, cfg.tariff);
  cfg.supplyVolt ||= '11 / 22 kV';
  const s = cfg.sets[0];
  if (!s) return cfg;
  const c = s.cat, sl = c.demand.slabs;
  Object.assign(cfg, {
    discom: tariffs.suppliers.find(x => x.code === cfg.supplier)?.name || cfg.discom,
    minBillingPct: c.minPct, slabKva: sl[0][0], slab1Rate: sl[0][1], slab2Kva: sl[1]?.[0] ?? null, slab2Rate: sl[1]?.[1] ?? 0, slab3Rate: sl[2]?.[1] ?? null, excessRate: c.demand.excess,
    touRate: c.tou ? c.tou.byDemand[c.tou.byDemand.length - 1][1] : 0, touDiscRate: c.touDiscount?.rate ?? 0,
    ehvPct: (c.voltage?.find(v => v[0] === cfg.supplyVolt)?.[1] ?? 0) / 100,
  });
  return cfg;
}
/** The rates typed by hand: "Others", or a company saved before tariff orders were added. */
function handRates(cfg) {
  const s1 = num(cfg.slabKva) || 0, r3 = num(cfg.slab3Rate), s2 = num(cfg.slab2Kva);
  const e1 = num(cfg.eRate1), e2 = num(cfg.eRate2), e3 = num(cfg.eRate3), eL1 = num(cfg.eLimit1), eL2 = num(cfg.eLimit2);
  const energy = e1 === null ? null : eL1 === null ? { flat: e1 }
    : { byDemand: [[eL1, e1], ...(e2 !== null ? [[eL2, e2]] : []), ...(e3 !== null ? [[null, e3]] : [])].map((v, i, a) => (i === a.length - 1 ? [null, v[1]] : v)) };
  return {
    slabs: [[s1, num(cfg.slab1Rate) || 0], ...(r3 !== null && s2 ? [[s2, num(cfg.slab2Rate) || 0], [null, r3]] : [[null, num(cfg.slab2Rate) || 0]])],
    excess: num(cfg.excessRate) || 0, minPct: num(cfg.minBillingPct) ?? 0.85, minDemand: 0, energy,
    tou: [[null, num(cfg.touRate) || 0]], disc: num(cfg.touDiscRate) || 0, pfRebate: num(cfg.pfRebate) ?? 0.5, rebate: num(cfg.ehvPct) || 0,
    reactive: num(cfg.reactiveRate) || 0, roundUp: false, set: null,
  };
}
/** The rates in force for a month: the order that month falls under, or the rates typed by hand. */
export function ratesFor(cfg, month) {
  const sets = cfg.sets || [];
  if (!sets.length) return handRates(cfg);
  const when = month ? ym(month) : Infinity;
  const set = sets.find(s => ymOfEffective(s.effective) <= when) || sets[sets.length - 1];
  const c = set.cat;
  return {
    slabs: c.demand.slabs, excess: c.demand.excess, minPct: c.minPct, minDemand: c.minDemand || 0, energy: c.energy,
    tou: c.tou ? c.tou.byDemand : [[null, 0]], disc: c.touDiscount?.rate ?? 0, pfRebate: c.pfRebate ?? 0.5, pfUnit: c.pfUnit || null,
    rebate: (c.voltage?.find(v => v[0] === (cfg.supplyVolt || '11 / 22 kV'))?.[1] ?? 0) / 100, reactive: c.reactive || 0, roundUp: true, set,
  };
}
const slabRate = (list, kva) => (list.find(([upto]) => upto === null || kva <= upto) || list[list.length - 1])[1];
/** The charge for this many kVA through slabs of [up to kVA, rate]. */
function throughSlabs(kva, slabs) {
  let from = 0, total = 0;
  for (const [upto, rate] of slabs) {
    const top = upto === null ? kva : Math.min(kva, upto);
    if (top > from) total += (top - from) * rate;
    if (upto === null || kva <= upto) break;
    from = upto;
  }
  return total;
}
function demandChargeAt(kva, rates, cd) {
  if (kva === null) return null;
  const over = rates.excess > 0 && cd ? Math.max(0, kva - cd) : 0;
  return throughSlabs(kva - over, rates.slabs) + over * rates.excess;
}
function billingDemandAt(md, cd, rates) {
  if (md === null && !cd) return null;
  const v = Math.max(md || 0, cd ? cd * rates.minPct : 0, md === null ? 0 : rates.minDemand);
  // The order says steps of 0.5, but the DISCOM bills whole kVA: 85% of 350 kVA is billed as 298.
  return rates.roundUp ? Math.ceil(v) : v;
}
/** Ahmedabad's PF adjustment: paise per unit for each 1% of power factor, not a share of the energy charge. */
function pfByUnits(pf, kwh, u) {
  if (pf === null || kwh === null) return null;
  const pts = v => Math.round(v * 1e6) / 1e4;
  if (pf < 0.9) return pts(0.9 - pf) * u.penalty * kwh;
  return -(pts(Math.min(pf, 0.95) - 0.9) * u.mid + pts(Math.max(pf, 0.95) - 0.95) * u.top) * kwh;
}
/** The energy charge from the order: one slab rate for the whole month, or Torrent's two blocks. */
function energyFrom(rates, bd, kwh) {
  const e = rates.energy;
  if (!e || kwh === null) return null;
  if (e.flat !== undefined) return { rate: e.flat, amount: e.flat * kwh };
  if (e.byDemand) { const rate = slabRate(e.byDemand, bd || 0); return { rate, amount: rate * kwh }; }
  const first = Math.min(kwh, e.blocks.perKva * (bd || 0));
  const amount = first * e.blocks.first + (kwh - first) * e.blocks.rest;
  return { rate: kwh ? amount / kwh : e.blocks.first, amount };
}

/**
 * Electricity duty for one month. One rate: rate x consumption charge, or the amount printed.
 * Two or three rates: each line carries its own kWh. A line left without kWh takes what remains of the
 * month's units; a charge left empty is shared by units, as the bills do; an amount left empty is
 * charge x rate. Whatever is typed is checked against the month: problems name what does not add up.
 */
export function dutyFor(r, cfg, kwh, totalCons) {
  const n = Math.min(3, Math.max(1, num(cfg.edTypes) || 1));
  // 15, 15% and .15 all mean the same rate. The month's own rate wins over the connection's.
  const share = v => (v === null ? null : v > 1 ? v / 100 : v);
  const rateOf = i => share(num(r[`edRate${i}`]) ?? (i === 1 ? num(cfg.dutyRate) : num(cfg[`edRate${i}`])));
  const printed = num(r.duty), problems = [];
  if (totalCons === null) return { n, lines: [], duty: null, problems };
  // Duty goes on the consumption charge printed on the bill, when it was read or typed.
  const base = num(r.totConsBilled) ?? totalCons;
  if (n === 1) {
    const amount = printed ?? (rateOf(1) ?? 0) * base;
    return { n, lines: [{ i: 1, kwh, charge: base, rate: rateOf(1) ?? 0, amount }], duty: amount, problems };
  }
  // A line's kWh, or its charges alone: charges and units go together on these bills.
  const given = Array.from({ length: n }, (_, k) => {
    const typed = num(r[`edKwh${k + 1}`]), charge = num(r[`edCharge${k + 1}`]);
    return typed ?? (charge !== null && kwh && base ? Math.round((kwh * charge) / base) : null);
  });
  const blanks = given.filter(v => v === null).length;
  if (blanks === n) {
    const amount = printed ?? (rateOf(1) ?? 0) * base;
    return { n, lines: [], duty: amount, problems: [`${n} duty rates chosen: enter 1: Charges or 1: kWh`] };
  }
  const sumGiven = given.reduce((a, v) => a + (v || 0), 0);
  const kwhs = given.map(v => (v === null ? (blanks === 1 && kwh !== null ? kwh - sumGiven : null) : v));
  // A charge left empty is shared by units, and one left empty beside typed ones takes what remains.
  const typedCharges = kwhs.map((_, idx) => num(r[`edCharge${idx + 1}`]));
  const chargeBlanks = typedCharges.filter(v => v === null).length, chargeTyped = typedCharges.reduce((a, v) => a + (v || 0), 0);
  const lines = kwhs.map((k, idx) => {
    const i = idx + 1, rate = rateOf(i);
    const charge = typedCharges[idx] ?? (chargeBlanks === 1 ? base - chargeTyped : k !== null && kwh ? (base * k) / kwh : null);
    const amount = num(r[`edAmt${i}`]) ?? (charge === null || rate === null ? null : charge * rate);
    if (rate === null && num(r[`edAmt${i}`]) === null) problems.push(`line ${i} has no ED rate`);
    return { i, kwh: k, charge, rate, amount };
  });
  const sum = key => lines.reduce((a, l) => a + (l[key] || 0), 0);
  if (kwh !== null && Math.abs(sum('kwh') - kwh) > 1) problems.push(`duty kWh add to ${Math.round(sum('kwh'))}, the bill has ${Math.round(kwh)}`);
  if (Math.abs(sum('charge') - base) > 5) problems.push(`duty charges add to ${Math.round(sum('charge'))}, the consumption charge is ${Math.round(base)}`);
  for (const l of lines) if (l.charge !== null && l.amount !== null && l.rate !== null && Math.abs(l.charge * l.rate - l.amount) > 2) problems.push(`line ${l.i}: rate ${l.rate} x charge ${Math.round(l.charge)} is not the amount ${l.amount}`);
  const duty = sum('amount');
  if (printed !== null && Math.abs(printed - duty) > 2) problems.push(`duty lines add to ${duty.toFixed(2)}, the bill shows ${printed.toFixed(2)}`);
  return { n, lines, duty, problems };
}

// ---------- bills ----------
export function demandCharge(kva, cfg, cd) { return demandChargeAt(kva, handRates(cfg), cd); }
export function pfPct(pf, rebate = 0.5) {
  if (pf === null) return null;
  if (pf > 0.95) return -(pf - 0.95) * rebate;
  if (pf >= 0.90) return 0;
  if (pf >= 0.85) return 0.90 - pf;
  return 0.05 + (0.85 - pf) * 2;
}

const sumOf = list => (list.length ? list.reduce((a, b) => a + b, 0) : null);

export function billCalc(bills) {
  const cfg = bills.cfg;
  const cd = num(cfg.contractDemand);
  const minBD = cd === null ? null : cd * (num(cfg.minBillingPct) ?? 0.85);
  const rows = (bills.rows || []).map(r => {
    const kwh = num(r.kwh), bill = num(r.net), pf = num(r.pf), md = num(r.actualMD);
    const parsed = parseMonth(r.month), rates = ratesFor(cfg, parsed);
    // A contract changed during the year: this month's own figure, else the connection's.
    const cdHere = num(r.contract) ?? cd;
    let eRate = num(r.energyRate), fRate = num(r.fppaRate);
    if (kwh && eRate === null && num(r.energyCharge) !== null) eRate = +(num(r.energyCharge) / kwh).toFixed(2);
    if (kwh && fRate === null && num(r.fuelSurcharge) !== null) fRate = +(num(r.fuelSurcharge) / kwh).toFixed(2);
    const night = num(r.todNight), tou = num(r.todPeak);
    const billingDemand = billingDemandAt(md, cdHere, rates);
    const demand = demandChargeAt(billingDemand, rates, cdHere);
    const fromOrder = energyFrom(rates, billingDemand, kwh);
    const rateGap = eRate !== null && fromOrder ? eRate - fromOrder.rate : null;
    const energy = kwh !== null && eRate !== null ? eRate * kwh : fromOrder ? fromOrder.amount : null;
    if (eRate === null && fromOrder) eRate = +fromOrder.rate.toFixed(4);
    // From September 2026 the bills add Variable FPPAS: a percentage on demand + energy + base fuel.
    const baseFuel = kwh !== null && fRate !== null ? fRate * kwh : null;
    const fppasVar = num(r.fppasVar) ?? (num(r.fppasPct) !== null && baseFuel !== null && energy !== null ? ((demand || 0) + energy + baseFuel) * (num(r.fppasPct) > 1 ? num(r.fppasPct) / 100 : num(r.fppasPct)) : null);
    const fuel = baseFuel === null ? null : baseFuel + (fppasVar || 0);
    if (fppasVar && kwh) fRate = +(fuel / kwh).toFixed(4); // the blended rate, so the bill table still adds up
    const byUnits = rates.pfUnit ? pfByUnits(pf, kwh, rates.pfUnit) : null;
    const pct = rates.pfUnit ? (byUnits !== null && energy ? byUnits / energy : null) : pfPct(pf, rates.pfRebate);
    const pfAdj = rates.pfUnit ? byUnits : pct !== null && energy !== null ? pct * energy : null;
    const nightRebate = night === null ? null : -(num(cfg.nightRebateRate) || 0) * night;
    const ehv = energy === null ? null : -rates.rebate * energy;
    const touRate = slabRate(rates.tou, billingDemand || 0);
    const touCharge = tou === null ? null : touRate * tou;
    // Printed on the bill it is taken as printed; DISCOMs show it as a rebate or a credit, with or
    // without a minus sign, so the sign is dropped and it is taken off once.
    const printed = num(r.touDiscount), discUnits = num(r.touDiscUnits);
    const touDiscount = printed ? -Math.abs(printed) : discUnits !== null ? -Math.abs(discUnits * rates.disc) : printed;
    const kvarh = num(r.kvarh), reactive = kvarh === null ? null : kvarh * rates.reactive;
    const parts = [demand, energy, fuel, pfAdj, nightRebate, ehv, touCharge, touDiscount, reactive];
    const totalCons = parts.some(v => v !== null) ? parts.reduce((a, v) => a + (v || 0), 0) : null;
    const ed = dutyFor(r, cfg, kwh, totalCons), duty = ed.duty;
    // The bill's own consumption charge, when printed: a small slip in it shows in its own column.
    const totalBill = totalCons === null ? null : (num(r.totConsBilled) ?? totalCons) + duty;
    // Above-contract kVA: what it cost, and what the same kVA would have cost inside the contract.
    const overKva = cdHere !== null && billingDemand !== null ? Math.max(0, billingDemand - cdHere) : 0;
    const topRate = rates.slabs[rates.slabs.length - 1][1];
    const excessExtra = overKva * Math.max(0, rates.excess - (cdHere ? slabRate(rates.slabs, cdHere) : topRate));
    // Demand paid for and not used: the month sat below the minimum share of the contract.
    const unusedKva = md !== null && billingDemand !== null ? Math.max(0, billingDemand - md) : 0;
    return {
      id: r.id, month: r.month, parsed, rates, cd: cdHere, dutyRate: duty !== null && totalCons ? duty / totalCons : num(cfg.dutyRate) || 0, fppasVar, edLines: ed.lines, edProblems: ed.problems, edExempt: num(r.edExempt) || 0, consBilled: num(r.totConsBilled), diffCons: num(r.totConsBilled) !== null && totalCons !== null ? num(r.totConsBilled) - totalCons : null, tariffERate: fromOrder ? fromOrder.rate : null, rateGap, reactive, kvarh, touRate, discRate: rates.disc, ehvPct: rates.rebate, nightRate: num(cfg.nightRebateRate) || 0, unusedKva,
      verified: !!r.verified, kwh, bill, rate: kwh && bill !== null ? bill / kwh : null,
      pf, md, billingDemand, demand, eRate, energy, fRate, fuel, pct, pfAdj, night, nightPct: kwh && night !== null ? night / kwh : null,
      nightRebate, ehv, tou, touPct: kwh && tou !== null ? tou / kwh : null, touCharge, discUnits, touDiscount, totalCons, duty, totalBill,
      diff: bill !== null && totalBill !== null ? bill - totalBill : null, overKva, excessExtra, hasData: kwh !== null,
    };
  });
  const live = rows.filter(r => r.hasData);
  const col = k => live.map(r => r[k]).filter(v => v !== null && v !== undefined);
  const total = k => sumOf(col(k));
  const mean = k => (col(k).length ? total(k) / col(k).length : null);
  const mds = col('md'), pfs = col('pf');
  const n = live.length;
  const out = {
    cfg, cd, minBD, rows, live, months: n, verified: live.filter(r => r.verified).length,
    total: Object.fromEntries(['kwh', 'bill', 'demand', 'energy', 'fuel', 'fppasVar', 'pfAdj', 'nightRebate', 'ehv', 'touCharge', 'touDiscount', 'totalCons', 'duty', 'totalBill', 'night', 'tou', 'discUnits', 'excessExtra'].map(k => [k, total(k)])),
    avg: { kwh: mean('kwh'), bill: mean('bill'), pf: mean('pf'), md: mean('md') },
    maxMD: mds.length ? Math.max(...mds) : null, minPF: pfs.length ? Math.min(...pfs) : null,
    overMonths: live.filter(r => r.overKva > 0).length,
  };
  out.blended = out.total.kwh ? (out.total.bill || 0) / out.total.kwh : null;
  // 720 hours in a billing month, as in the team's workbook (24 x 30).
  out.loadFactor = out.avg.md && out.avg.pf ? out.avg.kwh / (out.avg.md * out.avg.pf * 720) : null;
  out.nightShare = out.total.kwh && out.total.night !== null ? out.total.night / out.total.kwh : null;
  out.touShare = out.total.kwh && out.total.tou !== null ? out.total.tou / out.total.kwh : null;
  // Money the plant earned back: every rebate and discount on the bills, as a positive figure.
  const earned = k => Math.max(0, -(out.total[k] || 0));
  out.rebates = { pf: earned('pfAdj'), ehv: earned('ehv'), night: earned('nightRebate'), tou: earned('touDiscount') };
  out.rebates.total = out.rebates.pf + out.rebates.ehv + out.rebates.night + out.rebates.tou;
  // What the orders did to these bills.
  out.orders = [...new Map(live.filter(r => r.rates.set).map(r => [r.rates.set.id, r.rates.set])).values()]
    .map(s => ({ ...s, months: live.filter(r => r.rates.set?.id === s.id).map(r => r.month) }));
  out.contractChanges = live.filter((r, i) => i && r.cd !== null && live[i - 1].cd !== null && r.cd !== live[i - 1].cd).map((r, i) => ({ month: r.month, from: live[live.indexOf(r) - 1].cd, to: r.cd }));
  out.pfPenalty = live.reduce((a, r) => a + Math.max(0, r.pfAdj || 0), 0);
  out.pfPenaltyMonths = live.filter(r => (r.pfAdj || 0) > 0).length;
  out.rateIssues = live.filter(r => r.rateGap !== null && Math.abs(r.rateGap) >= 0.005);
  out.unusedMonths = live.filter(r => r.unusedKva > 0).length;
  out.unusedCost = live.reduce((a, r) => a + (r.demand === null || !r.unusedKva ? 0 : r.demand - demandChargeAt(r.billingDemand - r.unusedKva, r.rates, r.cd)), 0);
  out.touDiscMissing = live.filter(r => r.rates.set && r.rates.disc > 0 && num(r.tou) !== null && r.discUnits === null && r.touDiscount === null).length;
  out.reactive = total('reactive');
  // Months just above an energy slab: the units cost the higher rate because of a little demand.
  out.slabEdge = live.flatMap(r => {
    const e = r.rates.energy?.byDemand;
    if (!e || r.billingDemand === null || r.kwh === null) return [];
    const i = e.findIndex(([upto]) => upto === null || r.billingDemand <= upto);
    if (i < 1 || r.billingDemand > e[i - 1][0] * 1.1) return [];
    return [{ month: r.month, limit: e[i - 1][0], saving: (e[i][1] - e[i - 1][1]) * r.kwh }];
  });
  out.demandAdvice = adviseDemand(out);
  return out;
}

/**
 * The bills as they would have been at another contract demand. Demand charges follow, and with an
 * order behind them so do the energy and TOU rates, which change with the slab of the billing demand.
 */
export function demandAt(c, kva) {
  const rows = c.live.filter(r => r.md !== null).map(r => {
    const today = r.demand || 0, bd = billingDemandAt(r.md, kva, r.rates);
    const demand = demandChargeAt(bd, r.rates, kva);
    const e = r.rates.energy, slabbed = e?.byDemand && r.billingDemand !== null && r.kwh !== null;
    const energyDiff = slabbed ? (slabRate(e.byDemand, bd) - slabRate(e.byDemand, r.billingDemand)) * r.kwh : 0;
    const touDiff = r.tou ? (slabRate(r.rates.tou, bd) - slabRate(r.rates.tou, r.billingDemand || 0)) * r.tou : 0;
    return { month: r.month, md: r.md, today, bd, over: Math.max(0, bd - kva), demand, energyDiff, touDiff, cost: demand + energyDiff + touDiff };
  });
  const cost = rows.reduce((a, r) => a + r.cost, 0), today = rows.reduce((a, r) => a + r.today, 0);
  return { kva, rows, cost, today, saving: today - cost, months: rows.length };
}
/** The contract demand (in 25 kVA steps) that costs least for the bills in hand, against today's. */
export function adviseDemand(c) {
  const { cd, live } = c;
  const mds = live.map(r => r.md).filter(v => v !== null);
  if (cd === null || !mds.length) return null;
  const top = Math.ceil(Math.max(...mds) / 25) * 25;
  const low = Math.max(25, Math.floor(Math.min(...mds) / 25) * 25);
  const here = demandAt(c, cd);
  let best = here;
  // 25 kVA steps; a coarser step if a misread figure makes the range huge, so this stays quick.
  const span = Math.max(top, cd) - low, step = Math.max(25, Math.ceil(span / 400 / 25) * 25);
  for (let kva = low; kva <= Math.max(top, cd); kva += step) {
    const at = demandAt(c, kva);
    if (at.cost < best.cost - 0.5) best = at;
  }
  return { current: cd, today: here.today, suggested: best.kva, cost: best.cost, saving: here.today - best.cost, months: mds.length, rows: best.rows };
}

// ---------- baseline ----------
const fuelToe = (f, q) => { const g = num(f.gcv); return q === null || g === null ? null : (q * fuelUnit(f.unit).mult * g) / KCAL_PER_TOE; };

export function baselineCalc(b) {
  const basis = num(b.secBasis) || 1;
  const rows = (b.months || []).map(p => {
    const key = monthKey(p.y, p.m);
    const prod = num(b.production[key]), grid = num(b.grid[key]), water = num(b.water[key]);
    const sources = (b.elecSources || []).map(s => ({ id: s.id, name: s.name, kwh: num(s.values?.[key]) }));
    let elecKwh = grid;
    for (const s of sources) if (s.kwh !== null) elecKwh = (elecKwh || 0) + s.kwh;
    const elecToe = elecKwh === null ? null : (elecKwh * KCAL_PER_KWH) / KCAL_PER_TOE;
    const fuels = (b.fuels || []).map(f => { const qty = num(f.values?.[key]); return { id: f.id, name: f.name, unit: f.unit, qty, toe: fuelToe(f, qty) }; });
    const toes = fuels.map(f => f.toe).filter(v => v !== null);
    const thermalToe = toes.length ? sumOf(toes) : null;
    const per = prod && prod > 0 ? prod / basis : null;
    const totalToe = elecToe === null && thermalToe === null ? null : (elecToe || 0) + (thermalToe || 0);
    return {
      key, y: p.y, m: p.m, label: monthLabel(p.y, p.m), prod, grid, sources, elecKwh, elecToe, fuels, thermalToe, totalToe, water,
      secKwh: per && elecKwh !== null ? elecKwh / per : null, secThermal: per && thermalToe !== null ? thermalToe / per : null,
      secTotal: per && totalToe !== null ? totalToe / per : null, secWater: per && water !== null ? water / per : null,
      hasData: grid !== null || fuels.some(f => f.qty !== null) || water !== null,
    };
  });
  const s = pick => { const v = rows.map(pick).filter(x => x !== null && x !== undefined); return v.length ? sumOf(v) : null; };
  const n = rows.filter(r => r.hasData).length;
  const T = {
    prod: s(r => r.prod), grid: s(r => r.grid), elecKwh: s(r => r.elecKwh), elecToe: s(r => r.elecToe),
    thermalToe: s(r => r.thermalToe), totalToe: s(r => r.totalToe), water: s(r => r.water),
    sources: (b.elecSources || []).map((x, i) => ({ id: x.id, name: x.name, kwh: s(r => r.sources[i].kwh) })),
    fuels: (b.fuels || []).map((f, i) => ({ id: f.id, name: f.name, unit: f.unit, qty: s(r => r.fuels[i].qty), toe: s(r => r.fuels[i].toe) })),
  };
  const per = T.prod && T.prod > 0 ? T.prod / basis : null;
  T.secKwh = per && T.elecKwh !== null ? T.elecKwh / per : null;
  T.secThermal = per && T.thermalToe !== null ? T.thermalToe / per : null;
  T.secTotal = per && T.totalToe !== null ? T.totalToe / per : null;
  T.secWater = per && T.water !== null ? T.water / per : null;
  const unit = b.prodUnit || 'unit';
  return { rows, total: T, months: n, basis, unit, basisLabel: basis === 1 ? unit : basis === 1000 ? `1,000 ${unit}` : `lakh ${unit}`, hasProd: !!(T.prod && T.prod > 0) };
}

/** Grid kWh from the bills into the baseline: adds the month, and fills a cell a person has not typed over. */
export function billsIntoBaseline(billsPayload, b) {
  let changed = false;
  for (const r of billsPayload.rows || []) {
    const p = parseMonth(r.month), kwh = num(r.kwh);
    if (!p || kwh === null) continue;
    const key = monthKey(p.y, p.m);
    if (!b.months.some(q => q.y === p.y && q.m === p.m)) { b.months.push(p); changed = true; }
    if (num(b.grid[key]) === null || b.gridAuto?.[key]) {
      if (b.grid[key] !== kwh) { b.grid[key] = kwh; changed = true; }
      (b.gridAuto ||= {})[key] = true;
    }
  }
  if (changed) b.months.sort((a, c) => a.y - c.y || a.m - c.m);
  return changed;
}

// ---------- CEA grid factor ----------
/** The CEA factor of a financial year. A year CEA has not published yet takes the newest it has, and says so. */
export function ceaFactor(cea, fy, basis = 'average', crossBorder = true) {
  if (!cea || !cea.rows?.length) return null;
  const table = cea.rows.filter(r => r.cross_border === !!crossBorder).sort((a, b) => a.fy.localeCompare(b.fy));
  if (!table.length) return null;
  const exact = table.find(r => r.fy === fy);
  const row = exact || table[table.length - 1];
  return { value: row[basis], fy: row.fy, exact: !!exact, version: cea.version, published: cea.published, basis };
}
export const CEA_BASIS = { average: 'Weighted average', om: 'Operating margin (OM)', bm: 'Build margin (BM)', cm: 'Combined margin (CM)' };

/** "CEA CO2 Baseline Database Version 22.0 (Aug 2026), FY 2025-26, weighted average": printed wherever the factor is. */
export function ceaLabel(g) {
  if (!g?.cea) return 'CEA CO2 Baseline Database (version not set)';
  return `CEA CO2 Baseline Database Version ${g.cea.version} (${g.cea.published}), FY ${g.cea.fy}, ${(CEA_BASIS[g.basis] || 'weighted average').toLowerCase()}${g.crossBorder === false ? ', excluding cross-border transfers' : ''}`;
}

// ---------- GHG ----------
export function lineTonnes(l) {
  const q = num(l.qty), ef = num(l.ef);
  return q === null || ef === null ? null : (q * ef) / 1000;
}
export function ghgCalc(baselineC, baseline, g) {
  const ef = num(g.gridEF);
  const fuels = (baseline.fuels || []).map((f, i) => {
    const e = num(f.ef), qty = baselineC.total.fuels[i]?.qty ?? null;
    return { id: f.id, name: f.name, unit: f.unit, qty, ef: e, t: e === null || qty === null ? null : (qty * e) / 1000 };
  });
  const lines = (g.lines || []).map(l => ({ ...l, t: lineTonnes(l) }));
  const lineSum = pred => lines.filter(pred).reduce((a, l) => a + (l.t || 0), 0);
  const fuelT = fuels.reduce((a, f) => a + (f.t || 0), 0);
  const mobile = lineSum(l => l.type === 'mobile'), fugitive = lineSum(l => l.type === 'fugitive'), process = lineSum(l => l.type === 'process');
  const s1 = fuelT + mobile + fugitive + process;
  const gross2 = ((baselineC.total.grid || 0) * (ef || 0)) / 1000;
  const offset = num(g.reOffset) || 0;
  const s2 = gross2 - offset;
  const s3 = lineSum(l => l.type === 'scope3');
  const total12 = s1 + s2;
  const months = baselineC.rows.map(r => {
    const byFuel = r.fuels.map((f, i) => { const e = fuels[i].ef; return e === null || f.qty === null ? null : (f.qty * e) / 1000; });
    const fm = byFuel.reduce((a, v) => a + (v || 0), 0);
    const s2m = ((r.grid || 0) * (ef || 0)) / 1000;
    const per = r.prod && r.prod > 0 ? r.prod / baselineC.basis : null;
    return { key: r.key, label: r.label, byFuel, s1: fm, s2: s2m, total: fm + s2m, intensity: per ? (fm + s2m) / per : null };
  });
  const per = baselineC.total.prod && baselineC.total.prod > 0 ? baselineC.total.prod / baselineC.basis : null;
  const onSite = baselineC.total.sources.filter(s => s.kwh);
  return {
    fuels, lines, fuelT, mobile, fugitive, process, s1, gross2, offset, s2, s3, total12, total: total12 + s3, months,
    intensity: per ? total12 / per : null, gridEF: ef, gridKwh: baselineC.total.grid || 0,
    onSite: onSite.map(s => ({ name: s.name, kwh: s.kwh, avoided: ef === null ? null : (s.kwh * ef) / 1000 })),
    missingFactors: fuels.filter(f => f.ef === null && f.qty).map(f => f.name),
  };
}

/** A new order is probably out: the year has moved on and the newest order held is from an earlier one. */
export function tariffDue(tariffs, now = new Date()) {
  const y = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  const late = now.getFullYear() * 100 + now.getMonth() + 1 >= y * 100 + 5;
  const held = Math.max(...tariffs.orders.map(o => ymOfEffective(o.effective)));
  return late && held < y * 100 + 4 ? `The newest tariff order held is from ${Math.floor(held / 100)}. Read the GERC orders for FY ${y}-${String(y + 1).slice(2)} and add them.` : null;
}

/** What the figures say, in plain words, worst first. Tone is good, warn or bad. */
export function findings(c, b, g, fmt) {
  const out = [];
  const inr = v => fmt.money(v);
  if (c.months) {
    const off = c.live.filter(r => r.diff !== null && Math.abs(r.diff) > Math.max(100, (r.bill || 0) * 0.005));
    if (off.length) out.push({ tone: 'bad', tag: 'Check', text: `${off.length} bill${off.length > 1 ? 's do' : ' does'} not agree with the tariff worked out: ${off.map(r => r.month).join(', ')}. A figure was misread or a tariff value differs for this plant.` });
    if (c.months > c.verified) out.push({ tone: 'warn', tag: 'Verify', text: `${c.months - c.verified} of ${c.months} bills are not yet verified against the bill by a person.` });
    if (c.overMonths) {
      const a = c.demandAdvice;
      out.push({ tone: 'bad', tag: 'Demand', text: `Demand went above the contract of ${fmt.n(c.cd)} kVA in ${c.overMonths} of ${c.months} months, to ${fmt.n(c.maxMD)} kVA. That cost ${inr(c.total.excessExtra)} more than the same kVA inside the contract.${a && a.saving > 0 ? ` A contract of ${fmt.n(a.suggested)} kVA would have saved ${inr(a.saving)} on demand charges over these ${a.months} months, before any deposit or fee for the change.` : ''}` });
    } else if (c.demandAdvice && c.demandAdvice.saving > 0) {
      const a = c.demandAdvice;
      out.push({ tone: 'warn', tag: 'Demand', text: `Highest demand was ${fmt.n(c.maxMD)} kVA against a contract of ${fmt.n(c.cd)} kVA. A contract of ${fmt.n(a.suggested)} kVA would have saved ${inr(a.saving)} over these ${a.months} months.` });
    }
    const edBad = c.live.filter(r => r.edProblems.length);
    if (edBad.length) out.push({ tone: 'bad', tag: 'Duty', text: `Electricity duty does not match on ${edBad.length} bill${edBad.length > 1 ? 's' : ''}: ${edBad.map(r => `${r.month} (${r.edProblems.join('; ')})`).join(', ')}.` });
    const exempt = c.live.reduce((a, r) => a + r.edExempt, 0);
    if (exempt) out.push({ tone: 'good', tag: 'Duty', text: `Electricity duty is exempted${c.cfg.edExemptUpto ? ` up to ${c.cfg.edExemptUpto}` : ''}: ${inr(exempt)} not charged on these bills. Budget for it when the exemption ends.` });
    const split = (num(c.cfg.edTypes) || 1) === 1 ? c.live.filter(r => !r.edExempt && num(c.cfg.dutyRate) && Math.abs(r.dutyRate - num(c.cfg.dutyRate)) > 0.001) : [];
    if (split.length) out.push({ tone: 'warn', tag: 'Duty', text: `Electricity duty on ${split.length} bill${split.length > 1 ? 's' : ''} is not the plain ${fmt.pct(num(c.cfg.dutyRate))}: ${split.map(r => `${r.month} ${fmt.pct(r.dutyRate)}`).join(', ')}. If the bill has more than one ED rate, choose 2 or 3 duty rates on the Bills tab.` });
    if (c.rateIssues.length) out.push({ tone: 'bad', tag: 'Tariff', text: `The energy rate on ${c.rateIssues.length} bill${c.rateIssues.length > 1 ? 's differs' : ' differs'} from the tariff order for that month's billing demand: ${c.rateIssues.map(r => `${r.month} (${r.eRate.toFixed(2)} on the bill, ${r.tariffERate.toFixed(2)} in the order)`).join(', ')}. Check the bill or the category chosen.` });
    if (c.contractChanges.length) out.push({ tone: 'warn', tag: 'Demand', text: `The contract demand changed during these bills: ${c.contractChanges.map(x => `${fmt.n(x.from)} to ${fmt.n(x.to)} kVA in ${x.month}`).join(', ')}.` });
    if (c.pfPenalty > 0) out.push({ tone: 'bad', tag: 'Penalty', text: `Power factor penalty of ${inr(c.pfPenalty)} in ${c.pfPenaltyMonths} month${c.pfPenaltyMonths > 1 ? 's' : ''}: 1% of the energy charge for each 1% below 90%, 2% for each 1% below 85%.` });
    if (c.slabEdge.length) { const t = c.slabEdge.reduce((a, s) => a + s.saving, 0); out.push({ tone: 'warn', tag: 'Tariff', text: `In ${c.slabEdge.length} month${c.slabEdge.length > 1 ? 's' : ''} the billing demand was just above the ${fmt.n(c.slabEdge[0].limit)} kVA energy slab. Holding it to ${fmt.n(c.slabEdge[0].limit)} kVA would have saved ${inr(t)} on the energy rate alone.` }); }
    if (c.unusedMonths) out.push({ tone: 'warn', tag: 'Demand', text: `In ${c.unusedMonths} month${c.unusedMonths > 1 ? 's' : ''} actual demand stayed below the minimum billing demand, paying ${inr(c.unusedCost)} for kVA not used.` });
    if (c.touDiscMissing) out.push({ tone: 'warn', tag: 'TOU', text: `${c.touDiscMissing} bill${c.touDiscMissing > 1 ? 's have' : ' has'} no TOU discount entered, though the order gives one. Enter the discount units from the bill.` });
    if (c.minPF !== null && c.minPF < 0.95) out.push({ tone: 'warn', tag: 'PF', text: `Power factor fell to ${c.minPF.toFixed(3)}. Below 0.95 the rebate is lost, and below 0.90 a penalty starts.` });
    else if (c.avg.pf !== null) out.push({ tone: 'good', tag: 'PF', text: `Power factor stayed at ${c.minPF.toFixed(3)} or better, earning a rebate of ${inr(Math.abs(c.total.pfAdj || 0))}.` });
    if (c.rebates.tou) out.push({ tone: 'good', tag: 'TOU', text: `TOU discount earned: ${inr(c.rebates.tou)}.` });
    if (c.total.touCharge) out.push({ tone: 'warn', tag: 'TOU', text: `${fmt.pct(c.touShare)} of units fell in peak hours and cost ${inr(c.total.touCharge)} extra. Moving a load out of those hours saves this rate on each unit moved.` });
  }
  if (g.missingFactors?.length) out.push({ tone: 'bad', tag: 'GHG', text: `No emission factor is set for ${g.missingFactors.join(', ')}.` });
  if (b.months && !b.hasProd) out.push({ tone: 'warn', tag: 'Baseline', text: 'No production entered yet, so specific consumption and emission intensity cannot be worked out.' });
  return out;
}
