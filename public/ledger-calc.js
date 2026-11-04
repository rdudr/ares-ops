// Energy Ledger: every figure in one place, used by the screens, the report, the Excel file and the
// tests, so they can never disagree. No browser or network here. Report Studio keeps its own engine and is
// fed the same raw inputs; test/smoke.mjs checks this one against the team's bill workbook.
//
// THE BILL (the team's "bills analysis" format; a yellow cell there is what is read off the bill)
//   billing demand  = max(actual MD, min billing % of contract demand)
//   demand charge   = slabs up to the contract demand + excess kVA x excess rate
//                     HTP-1: 500 kVA @ 150, next @ 260, above contract @ 555
//   energy charge   = rate x units          fuel surcharge = FPPA rate x units
//   PF adjustment   = energy charge x -(PF - 0.95) x 0.5    above 0.95 (rebate)
//                     0 from 0.90 to 0.95;  (0.90 - PF) below 0.90;  0.05 + (0.85 - PF) x 2 below 0.85
//   night rebate    = -(night rate x night units)     EHV = -(EHV % x energy charge)
//   TOU             = TOU rate x TOU units
//   TOU discount    = as printed on the bill, else TOU discount units x rate per kVA (always money off)
//   duty            = duty % x total consumption charge
//   difference      = bill printed - total worked out. Near zero says the bill was read properly.
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

// ---------- bills ----------
export function demandCharge(kva, cfg, cd) {
  if (kva === null) return null;
  const excessRate = num(cfg.excessRate) || 0;
  const inSlabs = excessRate > 0 && cd ? Math.min(kva, cd) : kva;
  const slab = num(cfg.slabKva) || 0;
  const base = Math.min(inSlabs, slab) * (num(cfg.slab1Rate) || 0) + Math.max(0, inSlabs - slab) * (num(cfg.slab2Rate) || 0);
  const excess = excessRate > 0 && cd ? Math.max(0, kva - cd) * excessRate : 0;
  return base + excess;
}
export function pfPct(pf) {
  if (pf === null) return null;
  if (pf > 0.95) return -(pf - 0.95) * 0.5;
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
    let eRate = num(r.energyRate), fRate = num(r.fppaRate);
    if (kwh && eRate === null && num(r.energyCharge) !== null) eRate = +(num(r.energyCharge) / kwh).toFixed(2);
    if (kwh && fRate === null && num(r.fuelSurcharge) !== null) fRate = +(num(r.fuelSurcharge) / kwh).toFixed(2);
    const night = num(r.todNight), tou = num(r.todPeak);
    const billingDemand = md === null && minBD === null ? null : Math.max(md || 0, minBD || 0);
    const demand = demandCharge(billingDemand, cfg, cd);
    const energy = kwh !== null && eRate !== null ? eRate * kwh : null;
    const fuel = kwh !== null && fRate !== null ? fRate * kwh : null;
    const pct = pfPct(pf);
    const pfAdj = pct !== null && energy !== null ? pct * energy : null;
    const nightRebate = night === null ? null : -(num(cfg.nightRebateRate) || 0) * night;
    const ehv = energy === null ? null : -(num(cfg.ehvPct) || 0) * energy;
    const touCharge = tou === null ? null : (num(cfg.touRate) || 0) * tou;
    // Printed on the bill it is taken as printed; DISCOMs show it as a rebate or a credit, with or
    // without a minus sign, so the sign is dropped and it is taken off once.
    const printed = num(r.touDiscount), discUnits = num(r.touDiscUnits);
    const touDiscount = printed !== null ? -Math.abs(printed) : discUnits !== null ? -Math.abs(discUnits * (num(cfg.touDiscRate) || 0)) : null;
    const parts = [demand, energy, fuel, pfAdj, nightRebate, ehv, touCharge, touDiscount];
    const totalCons = parts.some(v => v !== null) ? parts.reduce((a, v) => a + (v || 0), 0) : null;
    const duty = totalCons === null ? null : (num(cfg.dutyRate) || 0) * totalCons;
    const totalBill = totalCons === null ? null : totalCons + duty;
    // Above-contract kVA: what it cost, and what the same kVA would have cost inside the contract.
    const overKva = cd !== null && billingDemand !== null ? Math.max(0, billingDemand - cd) : 0;
    const excessExtra = overKva * Math.max(0, (num(cfg.excessRate) || 0) - (num(cfg.slab2Rate) || 0));
    return {
      id: r.id, month: r.month, parsed: parseMonth(r.month), verified: !!r.verified, kwh, bill, rate: kwh && bill !== null ? bill / kwh : null,
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
    total: Object.fromEntries(['kwh', 'bill', 'demand', 'energy', 'fuel', 'pfAdj', 'nightRebate', 'ehv', 'touCharge', 'touDiscount', 'totalCons', 'duty', 'totalBill', 'night', 'tou', 'discUnits', 'excessExtra'].map(k => [k, total(k)])),
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
  out.demandAdvice = adviseDemand(out);
  return out;
}

/** The contract demand (in 25 kVA steps) that costs least for the bills in hand, against today's. */
export function adviseDemand(c) {
  const { cd, cfg, live } = c;
  const mds = live.map(r => r.md).filter(v => v !== null);
  if (cd === null || !mds.length) return null;
  const pct = num(cfg.minBillingPct) ?? 0.85;
  const costAt = kva => live.reduce((a, r) => (r.md === null ? a : a + demandCharge(Math.max(r.md, kva * pct), cfg, kva)), 0);
  const top = Math.ceil(Math.max(...mds) / 25) * 25;
  const low = Math.max(25, Math.floor(Math.min(...mds) / 25) * 25);
  const today = costAt(cd);
  let best = { kva: cd, cost: today };
  // 25 kVA steps; a coarser step if a misread figure makes the range huge, so this stays quick.
  const span = Math.max(top, cd) - low, step = Math.max(25, Math.ceil(span / 400 / 25) * 25);
  for (let kva = low; kva <= Math.max(top, cd); kva += step) {
    const cost = costAt(kva);
    if (cost < best.cost - 0.5) best = { kva, cost };
  }
  return { current: cd, today, suggested: best.kva, cost: best.cost, saving: today - best.cost, months: mds.length };
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
    if (c.minPF !== null && c.minPF < 0.95) out.push({ tone: 'warn', tag: 'PF', text: `Power factor fell to ${c.minPF.toFixed(3)}. Below 0.95 the rebate is lost, and below 0.90 a penalty starts.` });
    else if (c.avg.pf !== null) out.push({ tone: 'good', tag: 'PF', text: `Power factor stayed at ${c.minPF.toFixed(3)} or better, earning a rebate of ${inr(Math.abs(c.total.pfAdj || 0))}.` });
    if (c.rebates.tou) out.push({ tone: 'good', tag: 'TOU', text: `TOU discount earned: ${inr(c.rebates.tou)}.` });
    if (c.total.touCharge) out.push({ tone: 'warn', tag: 'TOU', text: `${fmt.pct(c.touShare)} of units fell in peak hours and cost ${inr(c.total.touCharge)} extra. Moving a load out of those hours saves this rate on each unit moved.` });
  }
  if (g.missingFactors?.length) out.push({ tone: 'bad', tag: 'GHG', text: `No emission factor is set for ${g.missingFactors.join(', ')}.` });
  if (b.months && !b.hasProd) out.push({ tone: 'warn', tag: 'Baseline', text: 'No production entered yet, so specific consumption and emission intensity cannot be worked out.' });
  return out;
}
