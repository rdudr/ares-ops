// A demo company for testing and training: one audit, marked as demo (synthetic), with records in
// every AR app that cover every case the reporting tool (Report Studio) prints. Made by the Super
// Admin from the server (a node script calling createDemoAudit); it never touches another audit. All names, numbers and
// people in it are invented.
//
// What it covers, app by app:
//  ARES        two grid inputs (one with high harmonics), solar, PCC and MCC panels, clamp and PQ
//             machine readings (DOL, star-delta, VFD; light and heavy loads), six APFC stages (OK, derated, failed, MCB off)
//  MLA        normal, under-loaded, over-loaded, unbalanced three-phase, single-phase, VFD fan;
//             a 24-hour long-term monitoring session on the compressor motor (load / unload, night stop)
//  Pump EFF   good, fair and poor transit-time tests (two with friction loss), a Doppler test
//  AC/AHU     split AC (poor), package AC (good), AHU by wet bulb; VCS chiller; cooling towers good/poor
//  Xmer-Eff   field-test transformer (BEE example), a certificate-method one with harmonics, and a
//             low-loss star-rated one (IS 1180 level 3 or better)
//  Lighting   urgent, review and good areas; task / non-task diversity; fluorescent and LED
//  Dryers     steam spray (BEE Table 7-4), thermic-fluid stenter below the typical range, electric batch tray, contact drum on
//             condensate, fuel-fired rotary with a full heat and mass balance
//  Thermo-X   coal and furnace oil; a boiler (direct and indirect tests) and a thermic fluid heater
//             below 70 % (hot flue gas, high excess air)
//  JET-Eff    uninsulated jet with a passing trap and a poor pump, an insulated jet, a cooling jet
//  A-CMP      screw with a pump-up test, reciprocating with a FAD test, VFD screw on load / unload
//  AI-PQA     a PQ recording on the main input (joined to the diagram by its recording ID)
//  Report Studio    twelve months of electricity bills (PF dips, demand near contract, ToD)
//  Energy Ledger    the same bills, an energy baseline (production, grid, solar, coal, furnace oil, DG diesel, water)
//             and GHG inputs (CEA grid factor, DEFRA fuel, refrigerant, forklift and Scope 3 lines)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createAudit } from './audits.js';
import { linkPhotosOfRecord } from './photo-links.js';
import { demoPhoto, demoThermal, demoLogo, demoSite } from './demo-images.js';
import { createDemoLedger } from './demo-ledger.js';

// MLA's long-term monitoring session, made once with MLA's own importer (lib/pq-import.ts) from an
// invented 24-hour, 5-minute log of the compressor motor.
const MONITORING = JSON.parse(fs.readFileSync(new URL('./demo-monitoring.json', import.meta.url), 'utf8'));

const r = (v, d = 2) => Number(v.toFixed(d));
const iso = () => new Date().toISOString();

export function createDemoAudit(db, actor, { ip, filesDir } = {}) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const companyName = `Demo Textiles Pvt. Ltd. (demo ${stamp})`;
  const auditId = createAudit(db, {
    client_name: companyName, site_name: 'Demo Unit 1, Sachin GIDC', sector: 'TX', title: 'Detailed energy audit', fy: 'FY2025-26',
    district: 'Surat', state: 'Gujarat', pincode: '394230', contract_demand_kva: 600, msme_no: 'UDYAM-GJ-22-0000000', work_type: 'detailed',
  }, { actorId: actor.id, status: 'in_field', ip, action: 'audit.demo_created' });
  db.prepare('UPDATE audits SET synthetic = 1 WHERE id = ?').run(auditId);
  db.prepare("INSERT OR IGNORE INTO assignments (user_id, audit_id, assigned_at, assigned_by, role) VALUES (?, ?, ?, ?, 'lead')").run(actor.id, auditId, Date.now(), actor.id);

  const now = Date.now();
  let n = 0;
  const recs = [];
  const add = (app, kind, payload, tag) => {
    const id = payload.id || crypto.randomUUID();
    recs.push({ id, app, kind, tag: tag || null, payload: { ...payload, id, recordedBy: payload.recordedBy ?? actor.name, createdAt: payload.createdAt ?? iso() }, t: now - (n++) * 60000 });
    return id;
  };
  // Pictures: stored like any upload (files/<audit>/<sha256>), listed in the files table with the
  // equipment tag, so the Console's photo grid and Report Studio's report both show them.
  const files = [];
  const pic = (app, tag, kind, caption, bytes, pairId = null) => {
    const id = crypto.randomUUID();
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    files.push({ id, app, tag, kind, caption: `${caption} (demo picture)`, bytes, sha, pairId });
    return id;
  };
  const ref = id => `ares-photo:${id}`;
  /** A photo and its thermal image, paired; returns the two ids. */
  const pair = (app, tag, what, hot) => {
    const p = crypto.randomUUID();
    return [pic(app, tag, 'photo', `${tag}: ${what}`, demoPhoto(tag), p), pic(app, tag, 'thermal', `${tag}: thermal image`, demoThermal(tag, hot), p)];
  };
  if (filesDir) { pic('report', null, 'logo', 'Company logo', demoLogo()); pic('report', null, 'site', 'Main gate', demoSite()); }

  const profile = { companyName, area: 'Sachin GIDC', district: 'Surat', state: 'Gujarat', pincode: '394230', overallConsumption: 210000, updatedAt: iso() };
  // JET-Eff works out its savings from cost figures on its company page.
  const extra = { textile: { evaporationRatio: 4.5, fuelCost: 9, unitRate: 8, insulationCost: 1800, pumpInvestmentCost: 85000, trapReplacementCost: 12000 } };
  for (const code of ['survey', 'motor', 'pump', 'cool', 'xmer', 'light', 'dryer', 'heat', 'textile', 'air'])
    recs.push({ id: `cp-${code}-${auditId}`.replace(/[^A-Za-z0-9-]/g, '-'), app: code, kind: 'company_profile', tag: null, payload: { ...profile, ...(extra[code] || {}) }, t: now });

  // ---------------- ARES ----------------
  const phase = (v, i, uthd, ithd) => ({ v1: v, v2: v - 2, v3: v + 1, i1: i, i2: r(i * 0.97), i3: r(i * 1.02), uthd1: uthd, uthd2: r(uthd + 0.2), uthd3: r(uthd - 0.1), ithd1: ithd, ithd2: r(ithd + 0.6), ithd3: r(ithd - 0.4) });
  add('survey', 'energy_source', { name: 'Grid (DGVCL)', sourceType: 'Main Grid', pf: 0.96, totalPower: 520, ...phase(415, 760, 2.4, 9.5) }, 'Grid (DGVCL)');
  add('survey', 'energy_source', { name: 'Rooftop solar 250 kWp', sourceType: 'Solar', pf: 0.99, totalPower: 180, ...phase(416, 255, 1.9, 4.2) }, 'Rooftop solar 250 kWp');
  const fp = (tag, what) => filesDir ? ref(pic('survey', tag, 'photo', `${tag}: ${what}`, demoPhoto(tag))) : null;
  const z1 = add('survey', 'zone', { photo: fp('TR-1', 'main input'), name: 'TR-1', ...phase(415, 520, 2.1, 9.5), pf: 0.93, measuredKw: 340, measuredKva: 365, totalPower: 340, recordingNameId: 'REC-DEMO-01', pqName: 'TR-1 incomer', description: 'Main incomer, 1000 kVA transformer' }, 'TR-1');
  const z2 = add('survey', 'zone', { photo: fp('TR-2', 'main input'), name: 'TR-2', ...phase(411, 410, 6.2, 14.6), pf: 0.88, measuredKw: 255, measuredKva: 290, totalPower: 255, recordingNameId: 'REC-DEMO-02', description: 'Process incomer: VFD-heavy, high harmonics' }, 'TR-2');
  const p1 = add('survey', 'panel', { photo: fp('PCC-1', 'panel'), zoneId: z1, name: 'PCC-1', type: 'PCC', ...phase(414, 300, 2.3, 9.8), pf: 0.91, measuredKw: 200, measuredKva: 220, totalPower: 200 }, 'PCC-1');
  const p2 = add('survey', 'panel', { photo: fp('PCC-2', 'panel'), zoneId: z2, name: 'PCC-2', type: 'PCC', ...phase(410, 260, 6.0, 15.2), pf: 0.87, measuredKw: 160, measuredKva: 184, totalPower: 160 }, 'PCC-2');
  const m1 = add('survey', 'panel', { photo: fp('MCC-1A', 'panel'), zoneId: z1, pccId: p1, name: 'MCC-1A', type: 'MCC', ...phase(412, 120, 2.6, 11), pf: 0.88, measuredKw: 80, measuredKva: 91, totalPower: 80 }, 'MCC-1A');
  const m2 = add('survey', 'panel', { photo: fp('MCC-2A', 'panel'), zoneId: z2, pccId: p2, name: 'MCC-2A', type: 'MCC', ...phase(409, 140, 6.4, 18.5), pf: 0.84, measuredKw: 92, measuredKva: 110, totalPower: 92 }, 'MCC-2A');
  const mach = (areaId, tag, starter, rated, kw, pf, extra = {}) => add('survey', 'machine', {
    areaId, machineTag: tag, starterType: starter, ratedKw: rated, voltage: 412, current: r(kw * 1000 / (1.732 * 412 * pf), 1), pf, measuredKw: kw,
    calculatedPower: kw, loadFactor: r(kw / rated, 3), entryType: 'CLAMP', createdById: actor.id, photo: fp(tag, 'machine'), ...extra }, tag);
  mach(m1, 'BLOWER-1', 'DOL', 22, 19.8, 0.84);
  mach(m1, 'PUMP-3', 'SD', 15, 4.6, 0.65, { description: 'Lightly loaded: 31 %' });
  mach(m1, 'COMP-1', 'SD', 37, 33, 0.86);
  mach(p1, 'LIGHTING DB', 'DOL', 30, 18, 0.95, { description: 'Fed directly from PCC-1' });
  mach(m2, 'JET-FAN-1', 'VFD', 30, 21, 0.92, { vfdFrequency: 42, entryType: 'PQ', pqName: 'JET-FAN-1 drive', recordingNameId: 'REC-DEMO-03', ...phase(409, 34, 6.8, 38) });
  mach(m2, 'STENTER-DR', 'VFD', 45, 38, 0.9, { vfdFrequency: 48 });
  mach(m2, 'WINDER-2', 'DOL', 7.5, 7.9, 0.86, { description: 'Running slightly over its rating' });
  mach(p2, 'ETP PUMP', 'DOL', 11, 6.2, 0.78);
  // APFC remarks use ARES's own choices: OK, Not OK, Derate, MCB off, NOT posible.
  [[1, 25, 34.5, 'OK'], [2, 25, 34.1, 'OK'], [3, 50, 68.8, 'OK'], [4, 50, 51.2, 'Derate', 'Draws 74 % of rated current: capacitor derated'],
    [5, 50, 3.1, 'Not OK', 'Draws almost no current: capacitor failed'], [6, 100, 0, 'MCB off', 'MCB found off during the survey']].forEach(([st, kvar, i, remark, description]) =>
    add('survey', 'apfc', { stage: st, ratedCapacitorValue: kvar, voltage: 415, iR: i, iY: r(i * 0.98), iB: r(i * 1.01), zoneId: z1, remark, description: description || null }, `APFC stage ${st}`));

  // ---------------- MLA ----------------
  const motor = (tag, app_, rated, extra) => add('motor', 'motor', {
    motorTag: tag, application: app_, department: 'Processing', make: 'Demo Motors', ratedKw: rated, powerUnit: 'kW', ratedVoltage: 415,
    ratedCurrent: r(rated * 1000 / (1.732 * 415 * 0.85 * 0.9), 1), ratedRpm: 1470, ratedPf: 0.85, poles: 4, gridFreq: 50, insulationClass: 'F',
    effMode: 'IE', ieClass: 'IE2', starterType: 'DOL', phaseMode: '3P', auditHours: 20, auditDays: 330, auditTariff: 8, upgradeTargetIE: 'IE3',
    includeThermalReport: true, includeAuditReport: true, motorTemp: 62, refTemp: 35, createdById: actor.id, thermalImageNo: `IR_${tag.slice(0, 4)}`,
    ...(filesDir ? (() => { const [ph, th] = pair('motor', tag, 'motor', (extra.motorTemp || 62) > 80 ? 0.95 : 0.55);
      return { nameplatePhoto: ref(pic('motor', tag, 'photo', `${tag}: name-plate`, demoPhoto(`${tag} plate`))), equipmentPhoto: ref(ph), thermalPhoto: ref(th) }; })() : {}), ...extra }, tag);
  motor('M-01 ETP pump', 'Pump', 15, { voltage: 410, current: 9, pf: 0.62, observation: 'Oversized for the duty' });
  motor('M-02 ID fan', 'Fan / Blower', 22, { voltage: 412, current: 33, pf: 0.84 });
  motor('M-03 Winder', 'Conveyor', 7.5, { voltage: 408, current: 15.1, pf: 0.87, motorTemp: 88, observation: 'Hot body: check ventilation' });
  const m04 = motor('M-04 Air compressor', 'Compressor', 37, { phaseMode: '3P_UNBAL', v1: 405, v2: 418, v3: 398, i1: 60, i2: 55, i3: 63, pf: 0.86, ieClass: 'IE3' });
  motor('M-05 Lab pump', 'Pump', 1.1, { phaseMode: '1P', ratedVoltage: 230, voltage: 228, current: 6.4, pf: 0.78, poles: 2, ratedRpm: 2850 });
  motor('M-06 Stenter fan', 'Fan / Blower', 30, { starterType: 'VFD', vfdFreq: 42, vfdEff: 0.97, vfdLoadType: 'quadratic', voltage: 409, current: 34, pf: 0.92, ieClass: 'IE3' });

  add('motor', 'monitoring_session', { ...MONITORING, motorId: m04, notes: 'Demo: 24-hour log on the compressor motor; unloaded a third of the time, stopped 1 am to 5 am' }, 'M-04 Air compressor');

  // ---------------- Pump EFF ----------------
  const pump = (tag, extra) => { if (filesDir) pair('pump', tag, 'pump set', 0.6); return add('pump', 'pump_test', { pumpTag: tag, location: 'Pump house', make: 'Demo Pumps', motorEfficiency: 90, ...extra }, tag); };
  pump('P-01 Process water', { method: 'TRANSIT', ratedHead: 32, ratedFlow: 120, measuredFlowM3h: 112, pipePeriphery: 520, pipeThickness: 6, dischargePressure: 3.4, suctionPressure: 0.3, inputPowerKw: 16.5 });
  pump('P-02 Cooling water', { method: 'TRANSIT', ratedHead: 25, ratedFlow: 300, measuredFlowM3h: 190, pipePeriphery: 800, pipeThickness: 8, dischargePressure: 2.1, suctionPressure: 0, inputPowerKw: 31, motorEfficiency: 92,
    pipeType: 'Cast Iron - 30 years old', hwCoefficient: 90, straightLengthM: 120, fittings: { elbow_90: 8, gate_34: 1, check_conv: 1, butterfly_open: 2 }, valveOpenPct: 60, description: 'Discharge valve throttled to 60 %: old cast-iron line' });
  pump('P-04 Boiler feed', { method: 'TRANSIT', ratedHead: 60, ratedFlow: 12, typeSize: 'Multistage 40x32', measuredFlowM3h: 11.5, pipePeriphery: 160, pipeThickness: 3.5, dischargePressure: 6.1, suctionPressure: 0.2, inputPowerKw: 2.8, motorEfficiency: 89,
    pipeType: 'Coated Steel - new', hwCoefficient: 137, straightLengthM: 45, fittings: { elbow_90: 6, gate_open: 2, check_conv: 1, tee_run: 1 }, description: 'Well matched to its duty: good efficiency' });
  pump('P-03 ETP transfer', { method: 'DOPPLER', ratedHead: 18, ratedFlow: 60, measuredVelocity: 1.6, pipePeriphery: 330, pipeThickness: 5, dischargePressure: 1.6, suctionPressure: 0.1, inputPowerKw: 6.2, ratedPowerHp: 10 });

  // ---------------- AC, AHU & Chiller ----------------
  const cp = tag => (filesDir ? ref(pair('cool', tag, 'unit', 0.5)[0]) : null);
  add('cool', 'air_unit', { photo: cp('AC-01 Admin split'), tag: 'AC-01 Admin split', category: 'AC', unitType: 'SPLIT', humidityMode: 'RH', ratedTr: 2, velocities: [1.6, 1.8, 1.5], suctionArea: 0.12, returnDbt: 27, returnHum: 58, supplyDbt: 17, supplyHum: 88, phase: 1, kw: 2.9, location: 'Admin office' }, 'AC-01 Admin split');
  add('cool', 'air_unit', { photo: cp('AC-02 Lab package'), tag: 'AC-02 Lab package', category: 'AC', unitType: 'PACKAGE', humidityMode: 'RH', ratedTr: 8.5, velocities: [2.4, 2.6, 2.2, 2.5, 2.3], suctionArea: 0.6, returnDbt: 26, returnHum: 55, supplyDbt: 14, supplyHum: 90, phase: 3, kw: 9.8, location: 'Quality lab' }, 'AC-02 Lab package');
  add('cool', 'air_unit', { photo: cp('AHU-01 Weaving'), tag: 'AHU-01 Weaving', category: 'AHU', unitType: 'AHU', humidityMode: 'WBT', ratedTr: 20, velocities: [2.8, 3.0, 2.9], suctionArea: 1.2, returnDbt: 27, returnHum: 19.5, supplyDbt: 15, supplyHum: 13.8, phase: 3, kw: 5.5, location: 'Weaving' }, 'AHU-01 Weaving');
  add('cool', 'chiller', { photo: cp('CH-01'), tag: 'CH-01', chillerType: 'VCS', ratedTr: 200, compressorKw: 140, totalKw: 168, waterFlowCmh: 100, inletTemp: 12, outletTemp: 7, specificHeat: 1 }, 'CH-01');
  add('cool', 'cooling_tower', { photo: cp('CT-01'), tag: 'CT-01', ratedTr: 400, inletTemp: 36, outletTemp: 28.5, airDbt: 35, airRh: 40, noOfCells: 2, cellsOnline: 2, waterFlowCmh: 300, fanVelocities: [6, 7, 6.5], fanSizeMode: 'DIAMETER', fanSize: 4, hubSize: 1, tdsMakeup: 300, tdsCirculating: 1500 }, 'CT-01');
  add('cool', 'cooling_tower', { photo: cp('CT-02 Old'), tag: 'CT-02 Old', ratedTr: 150, inletTemp: 38, outletTemp: 35.5, airDbt: 36, airRh: 45, noOfCells: 1, cellsOnline: 1, waterFlowCmh: 120, fanVelocities: [4.2, 4.6, 4.4], fanSizeMode: 'DIAMETER', fanSize: 2.4, hubSize: 0.6, tdsMakeup: 320, tdsCirculating: 2600 }, 'CT-02 Old');

  // ---------------- Xmer-Eff ----------------
  const xBase = { phases: 3, frequency: 50, hvConnection: 'Delta', lvConnection: 'Star', coreMaterial: 'CRGO', windingMaterial: 'Copper', refTemp: 75, rMode: 'phase',
    coldTemp: 30, hoursEnergised: 8760, hoursOnLoad: 7200, tariff: 8, eddyFactor: 0.1, windingQ: 1.7, basis: 'BEE', harmonics: [],
    accuracy: { vrms: 0.5, vavg: 0.5, f: 0.01, inl: 1, wnl: 5, r2: 0.5, r1: 0.5, vsc: 0.5, is1: 1, wsc: 5 }, createdById: actor.id };
  const xp = (tag, hot) => (filesDir ? (() => { const [ph, th] = pair('xmer', tag, 'transformer', hot); return { nameplatePhoto: ref(pic('xmer', tag, 'photo', `${tag}: name-plate`, demoPhoto(`${tag} plate`))), equipmentPhoto: ref(ph), thermalPhoto: ref(th), thermalImageNo: `IR_${tag}` }; })() : {});
  add('xmer', 'transformer', { ...xBase, ...xp('TR-1', 0.5), tag: 'TR-1', location: 'Main substation', make: 'Demo Transformers', ratingKva: 800, hvV: 6600, lvV: 400, impedancePct: 5, method: 'test',
    nlVrms: 429, nlVavg: 403, nlFreq: 50, nlCurrent: 9.96, nlPower: 1960, r2: 0.00111, r1: 1.03, ambientTemp: 30, scVoltage: 36.6, scCurrent: 2.78, scP1: 44.3, scP2: 44.3, scP3: 44.3,
    loadCurrent: 590, loadVoltage: 412, loadFreq: 50, loadKw: 340, loadPf: 0.93, windingTemp: 62 }, 'TR-1');
  add('xmer', 'transformer', { ...xBase, ...xp('TR-2', 0.9), tag: 'TR-2', location: 'Process substation', make: 'Demo Transformers', ratingKva: 630, hvV: 11000, lvV: 433, impedancePct: 4.5, method: 'certificate',
    certNoLoadW: 1450, certLoadLossW: 7600, loadCurrent: 400, loadVoltage: 411, loadFreq: 50, loadKw: 255, loadPf: 0.88, windingTemp: 70,
    harmonics: [{ h: 3, pct: 6 }, { h: 5, pct: 22 }, { h: 7, pct: 12 }, { h: 11, pct: 6 }, { h: 13, pct: 4 }] }, 'TR-2');

  add('xmer', 'transformer', { ...xBase, ...xp('TR-3', 0.4), tag: 'TR-3', location: 'Utility block', make: 'Demo Transformers', ratingKva: 250, hvV: 11000, lvV: 433, impedancePct: 4.5, method: 'certificate',
    certNoLoadW: 290, certLoadLossW: 2050, loadCurrent: 200, loadVoltage: 415, loadFreq: 50, loadKw: 136, loadPf: 0.95, windingTemp: 55 }, 'TR-3');

  // ---------------- Lighting ----------------
  const area = (tag, extra) => add('light', 'lighting_area', { tag, ...(filesDir ? { areaPhoto: ref(pic('light', tag, 'photo', `${tag}: area`, demoPhoto(tag))),
      fixturePhoto: ref(pic('light', tag, 'photo', `${tag}: light fitting`, demoPhoto(`${tag} fitting`))), luxPhoto: ref(pic('light', tag, 'photo', `${tag}: lux grid`, demoPhoto(`${tag} grid`))) } : {}), gridAccuracy: 5, taskPoints: [], nonTaskPoints: [], fixtures: [], powerMode: 'fixtures', hoursPerYear: 3000, tariff: 8, accLux: 5, accPower: 1, createdById: actor.id, ...extra }, tag);
  area('Office, first floor', { category: 'commercial', activity: 'General offices', recommendedLux: 300, length: 7.5, width: 5, mountingHeight: 2, source: 'fluorescent',
    points: [107, 95, 82, 68, 68, 44, 73, 129, 106, 111, 86, 87, 59, 45, 58, 99, 72, 106, 115, 76], taskPoints: [96.7, 101, 92], nonTaskPoints: [77.1, 80, 74],
    fixtures: [{ type: 'T8 36 W + copper ballast', count: 7, wattsEach: 46 }], powerMode: 'measured', measuredW: 350, voltage: 236, observation: 'Reflectors dusty; two tubes flickering' });
  area('Weaving shed bay 2', { category: 'industrial', activity: 'Weaving: plain grey cloth', recommendedLux: 200, length: 30, width: 18, mountingHeight: 5, gridAccuracy: 10, source: 'mercury',
    points: [120, 140, 135, 110, 128, 142, 130, 118, 112, 138, 145, 126, 122, 133, 129, 117], taskPoints: [150, 160, 145, 155], nonTaskPoints: [95, 90, 100], taskArea: 300,
    fixtures: [{ type: 'Mercury (HPMV) 250 W', count: 12, wattsEach: 265 }], hoursPerYear: 7000, proposedW: 1500 });
  area('Finished goods store', { category: 'industrial', activity: 'Small material racks', recommendedLux: 150, length: 20, width: 12, mountingHeight: 6, source: 'led',
    points: [190, 205, 198, 210, 185, 200, 215, 195, 202], fixtures: [{ type: 'LED high-bay 100 W', count: 8, wattsEach: 100 }], hoursPerYear: 4000, measuredAt: '8 pm, no daylight' });

  // ---------------- Dryers ----------------
  const dryer = (tag, extra) => add('dryer', 'dryer', { tag, ...(filesDir ? (() => { const [ph, th] = pair('dryer', tag, 'dryer', 0.7);
      return { dryerPhoto: ref(ph), thermalPhoto: ref(th), thermalImageNo: `IR_${tag.slice(0, 6)}`, nameplatePhoto: ref(pic('dryer', tag, 'photo', `${tag}: name-plate`, demoPhoto(`${tag} plate`))) }; })() : {}), latentHeat: 2257.4, cpLiquid: 4.19, cpVapour: 1.8855, surfaces: [], hoursPerYear: 6000, tariff: 8,
    accuracy: { wOut: 5, mIn: 2, mOut: 2, tsIn: 1, tsOut: 1, tinDb: 1, toutDb: 1, toutWb: 1, heat: 5 }, createdById: actor.id, ...extra }, tag);
  dryer('Spray dryer 1', { dryerType: 'spray', heating: 'direct', operation: 'continuous', material: 'Detergent powder', outputMode: 'boneDry', output: 7200, moistureBasis: 'dry_kgkg',
    moistureIn: 0.2, moistureOut: 0.05, tsIn: 30, tsOut: 60, tinDb: 149, toutDb: 90, toutWb: 82, heatSource: 'steam', steamFlow: 2520, steamPressure: 7, steamEnthalpy: 2723, condensateEnthalpy: 377, auxKw: 45, steamCost: 2200 });
  dryer('Stenter 2', { dryerType: 'stenter', heating: 'direct', operation: 'continuous', material: 'Cotton fabric', outputMode: 'product', output: 900, moistureBasis: 'wet_pct', moistureIn: 55, moistureOut: 7, targetMoistureOut: 9,
    tsIn: 32, tsOut: 95, ambDb: 34, ambWb: 26, tinDb: 180, toutDb: 140, toutWb: 58, heatSource: 'thermic', tfFlow: 200000, tfCp: 2.4, tfIn: 240, tfOut: 210, auxKw: 60, hoursPerYear: 7000, observation: 'Exhaust dampers fully open: far more hot air leaves than the moisture needs' });
  dryer('Tray dryer 3', { dryerType: 'tray_cross', heating: 'direct', operation: 'batch', batchHours: 6, batchesPerYear: 900, material: 'Dyed yarn packages', outputMode: 'product', output: 450, moistureBasis: 'wet_pct',
    moistureIn: 42, moistureOut: 8, tsIn: 30, tsOut: 70, tinDb: 95, toutDb: 72, toutWb: 48, heatSource: 'electric', heaterKw: 36, auxKw: 4 });
  dryer('Drum dryer 4', { dryerType: 'drum', heating: 'indirect', operation: 'continuous', material: 'Starch paste', outputMode: 'product', output: 300, moistureBasis: 'wet_pct',
    moistureIn: 60, moistureOut: 6, tsIn: 35, tsOut: 105, heatSource: 'condensate', steamFlow: 650, steamPressure: 4, auxKw: 11, steamCost: 2200,
    surfaces: [{ name: 'Drum ends', area: 6, temp: 120 }, { name: 'Hood', area: 10, temp: 62 }] });
  dryer('Rotary dryer 5', { dryerType: 'rotary_cascading', heating: 'direct', operation: 'continuous', material: 'Sand', outputMode: 'boneDry', output: 792.2, dustOutput: 24.5, moistureBasis: 'dry_kgkg',
    moistureIn: 1.5, moistureOut: 0.0528, moistureDust: 0.04, tsIn: 21.1, tsOut: 82.2, tsDust: 93.3, cpSolid: 1.8855, latentHeat: 2402.7, ambDb: 21.1, ambWb: 15.5,
    tinDb: 232.6, toutDb: 105, toutWb: 41.7, heatSource: 'hotair', airIn: 37926, airOut: 30402, humAmb: 0.0126, humIn: 0.0126, humOut: 0.0581,
    surfaces: [{ name: 'Shell', area: 60, temp: 65 }] });

  // ---------------- Thermo-X ----------------
  const tNow = iso();
  const coal = add('heat', 'fuel', { name: 'Imported coal', category: 'solid', type: 'imported-coal', dateOfTesting: tNow.slice(0, 10), analysedBy: 'Demo Lab', moisture: '12', volatileMatter: '38', ash: '8', gcv: '5600',
    carbon: '', hydrogen: '', nitrogen: '', sulphur: '0.6', oxygen: '', ashFixedCarbon: '6', ashMoisture: '1', ashVolatileMatter: '2', ashGcv: '600', ashQuantity: '8', notes: '', updatedAt: tNow }, 'Imported coal');
  const fo = add('heat', 'fuel', { name: 'Furnace oil', category: 'liquid', type: 'fo', dateOfTesting: tNow.slice(0, 10), analysedBy: 'Demo Lab', moisture: '0.5', volatileMatter: '', ash: '0.1', gcv: '10200',
    carbon: '84', hydrogen: '12', nitrogen: '0.5', sulphur: '2.8', oxygen: '0.6', ashFixedCarbon: '', ashMoisture: '', ashVolatileMatter: '', ashGcv: '', ashQuantity: '', notes: '', updatedAt: tNow }, 'Furnace oil');
  const blr = add('heat', 'boiler', { name: 'Boiler-1', make: 'Demo Boilers', model: 'FT-6', serialNo: 'DB-0001', yearOfMake: '2016', boilerType: 'Fire tube (smoke tube) – package', firingType: 'Stoker / chain grate',
    capacityTph: '6', designPressure: '10.5', designTemp: '', heatingSurface: '180', ratedEfficiency: '78', fuelIds: [coal], notes: '', updatedAt: tNow }, 'Boiler-1');
  const tfh = add('heat', 'boiler', { name: 'TFH-1', make: 'Demo Heaters', model: 'TH-20', serialNo: 'DH-0002', yearOfMake: '2019', boilerType: 'Thermic fluid heater', firingType: 'Burner (oil/gas)',
    capacityTph: '2', designPressure: '6', designTemp: '280', heatingSurface: '60', ratedEfficiency: '82', fuelIds: [fo], notes: 'Rated 20 lakh kcal/h', updatedAt: tNow }, 'TFH-1');
  if (filesDir) { pair('heat', 'Boiler-1', 'boiler', 0.75); pair('heat', 'TFH-1', 'thermic fluid heater', 0.85); }
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(Date.now() - (7 - i) * 864e5); return d.toISOString().slice(0, 10); });
  add('heat', 'direct_test', { boilerId: blr, fuelId: coal, name: 'Direct method test', startDate: days[0], days: 7, fuelUnitKg: '1', fuelUnitLabel: 'kg',
    rows: days.map((d, i) => ({ date: d, fuelQty: String(10800 + i * 90), waterKg: String(76000 + i * 500) })), steamPressure: '9', steamTemp: '', feedWaterTemp: '70',
    steamQtyOverride: '', fuelQtyOverride: '', hoursPerDay: '24', updatedAt: tNow }, 'Boiler-1 direct');
  add('heat', 'indirect_test', { boilerId: blr, fuelId: coal, name: 'Indirect method test', testDate: days[6], dataSource: 'manual', instrument: null,
    samples: [{ id: crypto.randomUUID(), description: 'Furnace outlet', o2: '9.5', co2: '10.8', coPpm: '320', flueTemp: '235', ambientTemp: '32' },
      { id: crypto.randomUUID(), description: 'Economiser outlet', o2: '10.2', co2: '10.1', coPpm: '290', flueTemp: '185', ambientTemp: '32' }],
    humidityFactor: '0.024', cpFlueGas: '0.24', cpSteam: '0.45', radiationLoss: '2', updatedAt: tNow }, 'Boiler-1 indirect');
  add('heat', 'indirect_test', { boilerId: tfh, fuelId: fo, name: 'Indirect method test', testDate: days[6], dataSource: 'manual', instrument: null,
    samples: [{ id: crypto.randomUUID(), description: 'Heater outlet', o2: '10.5', co2: '8.2', coPpm: '180', flueTemp: '365', ambientTemp: '32' }],
    humidityFactor: '0.024', cpFlueGas: '0.24', cpSteam: '0.45', radiationLoss: '2', updatedAt: tNow }, 'TFH-1 indirect');

  // ---------------- JET-Eff (results worked out with JET-Eff's own formulas) ----------------
  const jet = (j) => {
    const f = j.flow, hyd = j.flow && j.pressure ? r((f * 998 * 9.81 * j.pressure * 10) / 3.6e6, 3) : null;
    const shaft = j.pumpPower ? r(j.pumpPower * 0.85, 3) : null;
    const eff = hyd !== null && shaft ? r(hyd / shaft * 100, 2) : null;
    const avg = r(j.bodyTemps.reduce((a, b) => a + b, 0) / j.bodyTemps.length, 2);
    const S = (t) => { const dt = t - j.ambientTemp; return r((10 + dt / 20) * dt, 2); };
    const sh = S(avg), tot = r(sh * j.surfaceArea, 2), eq = r(tot / j.lhSteam, 3);
    const insT = r(j.ambientTemp + 15, 2), shA = S(insT), totA = r(shA * j.surfaceArea, 2), eqA = r(totA / j.lhSteam, 3);
    const trapStatus = j.trapTempOut >= 110 ? 'Trap Passing' : 'Working OK';
    const trapEq = trapStatus === 'Trap Passing' && j.concentricDrain !== 'Drain before trap' ? 52 : (j.trapManual ?? null);
    const heatInlet = j.waterTempBefore != null ? r(Math.abs(f * 1000 * (j.waterTempAfter - j.waterTempBefore)), 2) : null;
    const eqUsed = heatInlet !== null ? r(heatInlet / j.lhSteam, 3) : null;
    const heating = j.operation !== 'Cooling';
    const total = heating && eqUsed !== null ? r(eqUsed + (trapEq ?? 0) + eq, 3) : null;
    const cool = !heating && j.coolingWaterFlow ? r(j.coolingWaterFlow * 1000 * (j.coolingWaterOut - j.coolingWaterIn), 2) : null;
    const eqCool = cool !== null ? r(cool / j.lhSteam, 3) : null;
    const replace = eff !== null && eff < 40, at40 = replace ? r(hyd / 0.4, 3) : null;
    const { trapManual: _t, ...rest } = j;
    if (filesDir) pair('textile', j.jetNo, 'jet machine', j.insulation === 'UnInsulated' ? 0.95 : 0.45);
    return add('textile', 'jet', { ...rest, velocity: null, hydraulicPower: hyd, shaftPower: shaft, pumpEfficiency: eff, avgBodyTemp: avg, surfaceHeatLoss: sh, totalSurfaceHeatLoss: tot, eqSteamLoss: eq,
      insulationBodyTemp: insT, surfaceHeatLossAfter: shA, totalSurfaceHeatLossAfter: totA, eqSteamLossAfter: eqA, steamSaving: r(eq - eqA, 3), trapStatus, trapEqSteamLoss: trapEq,
      heatInlet, eqSteamUsed: eqUsed, totalSteamUsed: total, jetExchangeEfficiency: total ? r(eqUsed / total * 100, 2) : null, coolingEffect: cool, eqSteamCooling: eqCool,
      coolingOption: eqUsed !== null && eqCool ? r(eqUsed / eqCool * 100, 2) : null, pumpSuggestion: eff === null ? null : replace ? 'Replace Pump' : 'Nil',
      shaftPowerAt40: at40, pumpSavingKw: replace ? r(shaft - at40, 3) : null }, j.jetNo);
  };
  jet({ jetNo: 'JET-01', jetType: 'U Jet', insulation: 'UnInsulated', capacity: 600, dia: 1.6, length: 6, surfaceArea: 32, operation: 'Heating', jetTemp: 130,
    flow: 120, pipePeriphery: 480, pressure: 1.8, rpm: 1450, pumpPower: 22, ambientTemp: 34, bodyTemps: [96, 102, 98, 105, 99, 101, 97],
    steamPressure: 6, steamTemp: 165, lhSteam: 495, trapType: 'Thermodynamic Trap', trapTempIn: 160, trapTempOut: 128, concentricDrain: 'No Drain',
    waterTempBefore: 60, waterTempAfter: 64, steamTempIn: 165, steamTempOut: 140, runningHrPerDay: 20, heatingTimePerDay: 8, observation: 'Body not insulated; trap passing live steam' });
  jet({ jetNo: 'JET-02', jetType: 'Long Jet', insulation: 'Insulated', capacity: 800, dia: 1.8, length: 9, surfaceArea: 52, operation: 'Hold', jetTemp: 125,
    flow: 200, pipePeriphery: 560, pressure: 2.0, rpm: 1460, pumpPower: 18.5, ambientTemp: 34, bodyTemps: [52, 55, 50, 54, 53, 51, 52],
    steamPressure: 6, steamTemp: 165, lhSteam: 495, trapType: 'Fluid Type Trap', trapTempIn: 158, trapTempOut: 92, concentricDrain: 'No Drain', trapManual: 4,
    waterTempBefore: 120, waterTempAfter: 122, steamTempIn: 165, steamTempOut: 150, runningHrPerDay: 20, heatingTimePerDay: 6 });
  jet({ jetNo: 'JET-03', jetType: 'U Jet', insulation: 'Half Insulated', capacity: 400, dia: 1.4, length: 5, surfaceArea: 24, operation: 'Cooling', jetTemp: 70,
    flow: 140, pipePeriphery: 420, pressure: 1.9, rpm: 1440, pumpPower: 11, ambientTemp: 34, bodyTemps: [68, 72, 66, 70, 69, 71, 67],
    steamPressure: 6, steamTemp: 165, lhSteam: 495, trapType: 'Thermodynamic Trap', trapTempIn: 150, trapTempOut: 115, concentricDrain: 'Drain before trap', trapManual: 18,
    waterTempBefore: 98, waterTempAfter: 94, coolingWaterIn: 32, coolingWaterOut: 37, coolingWaterFlow: 120, runningHrPerDay: 18, heatingTimePerDay: 5 });

  // ---------------- A-CMP ----------------
  const ATM = 1.013, CFM = 35.3147;
  // kVA, kVAR and load factor (%) worked out as A-CMP's form does when it saves.
  const elec = (c) => { const kva = c.genLoadVoltage && c.genLoadAmp ? 1.732 * c.genLoadVoltage * c.genLoadAmp / 1000 : 0, pf = c.genLoadPf || 0;
    return { kva: kva ? r(kva, 2) : undefined, kvar: kva && pf ? r(kva * Math.sqrt(1 - pf * pf), 2) : undefined, loadFactor: c.genLoadKw && c.ratedKw ? r(c.genLoadKw / (c.ratedKw / 0.92) * 100, 1) : 0 }; };
  const comp = (tag, c) => add('air', 'compressor', { ...elec(c), machineTag: tag, ...(filesDir ? (() => { const [ph, th] = pair('air', tag, 'compressor', 0.7);
      return { photoPath: ref(ph), motorPhotoPath: ref(pic('air', tag, 'photo', `${tag}: motor name-plate`, demoPhoto(`${tag} motor`))),
        thermalImages: JSON.stringify({ overall: { imgNo: `IR_${tag.slice(0, 4)}`, thermal: ref(th), reference: ref(ph) } }) }; })() : {}), makeModel: 'Demo Air', annualOperatingDays: 330, unitRate: 8, motorEfficiency: 92, createdById: actor.id, ...c }, tag);
  { // pump-up test
    const V = 2.0 + 0.01, m3 = (V * (7 - 0)) / ((95 / 60) * ATM), tf = 273 / (273 + 40), corr = m3 * tf;
    comp('C-01 Screw 37 kW', { compressorType: 'Screw', ratedCapacity: 6.2, ratedCapacityUnit: 'm3/min', ratedPressure: 7.5, processPressure: 6, ratedKw: 37, starterType: 'SD',
      designedSec: 0.18, designedAirGen: 5.5, genLoadVoltage: 412, genLoadAmp: 62, genLoadPf: 0.86, genLoadKw: 38, genUnloadVoltage: 414, genUnloadAmp: 25, genUnloadPf: 0.4, genUnloadKw: 7.2,
      loadPressure: 6.2, unloadPressure: 7.2, pumpActive: true, pumpP1: 0, pumpP2: 7, pumpTimeSec: 95, pumpAirTempC: 40, pumpTempFactor: r(tf, 4), pumpTankVolume: 2, pumpTankVolumeUnit: 'm3',
      pumpTankCalcMethod: 'Direct', pumpInletPipeActive: false, pumpOutletPipeActive: true, pumpOutletPipePeri: 160, pumpOutletPipePeriUnit: 'mm', pumpOutletPipeLength: 4.9, pumpOutletPipeLenUnit: 'm',
      pumpMainVolumeM3: V, pumpActualFadM3Min: r(corr, 3), pumpActualFadCfm: r(corr * CFM, 1), pumpRunningPressure: 7, pumpMeasuredPower: 38, description: 'Air leaks heard at the dryer' });
  }
  { // FAD (velocity) test
    const area = 0.1 * 0.1, vel = [5.8, 6.1, 6.3, 5.9, 6.0], avg = vel.reduce((a, b) => a + b, 0) / vel.length, s = area * avg, cfm = s * 60 * CFM;
    comp('C-02 Reciprocating 22 kW', { compressorType: 'Reciprocating', ratedCapacity: 120, ratedCapacityUnit: 'CFM', ratedPressure: 8, processPressure: 6.5, ratedKw: 22, starterType: 'DOL',
      designedSec: 0.2, genLoadVoltage: 410, genLoadAmp: 41, genLoadPf: 0.84, genLoadKw: 24.5, loadPressure: 6.5, unloadPressure: 8,
      fadActive: true, fadAreaType: 'Rectangle', fadAreaL: 0.1, fadAreaB: 0.1, fadNumPoints: vel.length, fadVelocities: JSON.stringify(vel), fadRunningPressure: 7.2, fadMeasuredPower: 24.5,
      fadSuctionArea: area, fadAvgVelocity: r(avg, 2), fadAirDeliveryM3Sec: r(s, 4), fadAirDeliveryM3Hr: r(s * 3600, 1), fadAirDeliveryCfm: r(cfm, 1), fadActualSec: r(24.5 / cfm, 4), fadActualAirGen: r(cfm / 24.5, 2) });
  }
  comp('C-03 VFD screw 45 kW', { compressorType: 'Screw', ratedCapacity: 7.8, ratedCapacityUnit: 'm3/min', ratedPressure: 7.5, processPressure: 6, ratedKw: 45, starterType: 'VFD',
    designedSec: 0.17, genLoadVoltage: 413, genLoadAmp: 58, genLoadPf: 0.95, genLoadKw: 39, loadPressure: 6.3, unloadPressure: 6.9, luType: 'VFD',
    luData: JSON.stringify([{ label: 'Load time (s)', v1: 300, v2: 280, v3: 310 }, { label: 'Unload time (s)', v1: 40, v2: 45, v3: 38 }]) });

  // ---------------- AI-PQA: a recording on the main input ----------------
  const N = 144, t = Array.from({ length: N }, (_, i) => `${String(Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}`);
  const wave = (base, amp, k = 1) => Array.from({ length: N }, (_, i) => r(base + amp * Math.sin(i / (8 * k)) + amp * 0.3 * Math.cos(i / 3), 2));
  const st = (a) => ({ min: Math.min(...a), max: Math.max(...a), avg: r(a.reduce((x, y) => x + y, 0) / a.length, 2), n: a.length });
  const se = { t, va: wave(414, 4), vb: wave(412, 4.5), vc: wave(415, 3.8), ia: wave(520, 110, 2), ib: wave(505, 105, 2), ic: wave(530, 115, 2), kw: wave(340, 80, 2), kva: wave(365, 85, 2), kvar: wave(130, 30, 2), pf: wave(0.93, 0.03), vthd: wave(2.6, 0.9), ithd: wave(9.8, 3) };
  const bundle = { format: 'Report Studio-PQ-JSON v1', panel: 'TR-1', recording_id: 'REC-DEMO-01', role: 'main', session_id: 'demo', instrument: 'Demo PQ analyser (Class A)', samples: N * 60,
    start: '2026-10-28 00:00:00', end: '2026-10-29 00:00:00', interval_s: 600, nominal_v: 415,
    stats: { v: st(se.va), va: st(se.va), vb: st(se.vb), vc: st(se.vc), i: st(se.ia), ia: st(se.ia), ib: st(se.ib), ic: st(se.ic), kw: st(se.kw), kva: st(se.kva), kvar: st(se.kvar), pf: st(se.pf), freq: { min: 49.86, max: 50.12, avg: 50.0, n: N }, vthd: st(se.vthd), ithd: st(se.ithd), v_imbalance_pct: 0.9, i_imbalance_pct: 4.6 },
    series: se,
    harmonics: { voltage: [{ h: 3, pct: 0.8 }, { h: 5, pct: 2.1 }, { h: 7, pct: 1.2 }, { h: 11, pct: 0.6 }], current: [{ h: 3, pct: 2.5 }, { h: 5, pct: 8.4 }, { h: 7, pct: 4.9 }, { h: 11, pct: 2.6 }, { h: 13, pct: 1.8 }] },
    compliance: { summary: { score: 79, total: 7, pass: 5, warn: 1, fail: 1 }, rules: [
      { standard: 'IEEE 519', clause: 'Voltage THD at PCC', description: 'Voltage distortion limits', measured: 3.5, limit: 8, unit: '%', verdict: 'pass', remark: 'Within limit' },
      { standard: 'IEEE 519', clause: 'Current TDD at PCC', description: 'Current distortion limits', measured: 12.8, limit: 12, unit: '%', verdict: 'fail', remark: 'Above limit at peak load: harmonic filter advised' },
      { standard: 'EN 50160', clause: 'Voltage variation', description: 'Supply voltage characteristics', measured: 2.1, limit: 10, unit: '%', verdict: 'pass', remark: '' },
      { standard: 'EN 50160', clause: 'Frequency', description: 'Supply voltage characteristics', measured: 0.28, limit: 1, unit: '%', verdict: 'pass', remark: '' },
      { standard: 'EN 50160', clause: 'Voltage unbalance', description: 'Supply voltage characteristics', measured: 0.9, limit: 2, unit: '%', verdict: 'pass', remark: '' },
      { standard: 'Utility PF', clause: 'Average power factor', description: 'Power factor incentive / penalty', measured: 0.93, limit: 0.95, unit: '', verdict: 'warn', remark: 'Below the incentive band' },
      { standard: 'IEC 61000-3-14', clause: 'Fifth harmonic current', description: 'Harmonic emission limits', measured: 8.4, limit: 10, unit: '%', verdict: 'pass', remark: '' }] },
    health: { overall: 74, status: 'fair', components: [
      { label: 'Harmonics Health', raw: 12.8, weight: 0.3, score: 58, status: 'fair', detail: 'Current TDD above the IEEE 519 limit at peak load', recommendation: 'Fit a passive or active harmonic filter on TR-2' },
      { label: 'Voltage Stability', raw: 2.1, weight: 0.25, score: 91, status: 'good', detail: 'Voltage within ±3 % of nominal', recommendation: 'No action' },
      { label: 'Power Factor', raw: 0.93, weight: 0.2, score: 66, status: 'fair', detail: 'Average PF 0.93; dips at night', recommendation: 'Replace the failed APFC stage 5 capacitor' },
      { label: 'Phase Balance', raw: 4.6, weight: 0.15, score: 78, status: 'fair', detail: 'Current unbalance 4.6 %', recommendation: 'Redistribute single-phase loads across phases' },
      { label: 'Frequency Stability', raw: 0.28, weight: 0.1, score: 97, status: 'good', detail: 'Frequency within ±0.3 %', recommendation: 'No action' }] },
    events: { total: 6, by_type: { voltage_dip: 3, interruption: 1, transient: 2 }, dip_swell: { dips: 3, swells: 0, severe: 1, nominal_v: 415, worst_dip_pct: 18.5 },
      list: [{ timestamp: '2026-10-28 09:14:20', type: 'voltage_dip', severity: 'high', phase: 'R', value: 338.2, threshold: 373.5, message: 'Dip to 81.5 % for 120 ms (motor start on PCC-2)' },
        { timestamp: '2026-10-28 13:02:05', type: 'interruption', severity: 'critical', phase: 'RYB', value: 0, threshold: 41.5, message: 'Supply interruption, 2.1 s' },
        { timestamp: '2026-10-28 17:40:51', type: 'transient', severity: 'medium', phase: 'B', value: 612, threshold: 586, message: 'Switching transient when APFC stage 3 connected' }] },
    data_quality: { quality_score: 96, scale_fixes: {}, outliers_removed: { ithd: 3 }, three_phase_warn: [] },
    cost: { inputs: { tariff: 8, demandCharge: 475, pfThreshold: 0.95, pfPenaltyPct: 1, hoursPerDay: 20, daysPerYear: 330, currency: '₹' } },
    observations: ['Current TDD exceeds IEEE 519 during the day shift, when the VFDs on TR-2 run.', 'Power factor dips below 0.93 at night when the APFC stage 5 capacitor (failed) is called.'],
    charts: [], sent_at: stamp };
  recs.push({ id: `pq-${auditId}-REC-DEMO-01`.replace(/[^A-Za-z0-9-]/g, '-'), app: 'power', kind: 'pq_recording', tag: 'REC-DEMO-01', payload: { schema: 'postman-pq/v1', bundle }, t: now });

  // ---------------- Report Studio: twelve months of bills ----------------
  const months = ['Apr-2025', 'May-2025', 'Jun-2025', 'Jul-2025', 'Aug-2025', 'Sep-2025', 'Oct-2025', 'Nov-2025', 'Dec-2025', 'Jan-2026', 'Feb-2026', 'Mar-2026'];
  const bills = months.map((m, i) => {
    const kwh = Math.round(205000 + 18000 * Math.sin(i / 2) + (i === 4 ? 22000 : 0));
    const pf = [0.97, 0.96, 0.93, 0.92, 0.95, 0.97, 0.98, 0.97, 0.94, 0.96, 0.97, 0.91][i];
    const md = [520, 548, 575, 590, 612, 560, 535, 520, 515, 530, 545, 580][i];
    const er = 4.6, fppa = 2.1, energy = kwh * er, fuel = kwh * fppa, demand = Math.max(md, 0.85 * 600) * 475, duty = (energy + fuel + demand) * 0.15;
    const tou = Math.round(kwh * 0.28), night = Math.round(kwh * 0.31), touDisc = Math.round(night * 0.4);
    return { month: m, kwh, net: Math.round(energy + fuel + demand + duty - touDisc), pf, actualMD: md, energyRate: er, fppaRate: fppa, todNight: night, todPeak: tou, touDiscount: touDisc,
      contract: 600, billingDemand: Math.max(md, 510), kvah: Math.round(kwh / pf), energyCharge: Math.round(energy), demandCharge: Math.round(demand), fuelSurcharge: Math.round(fuel),
      duty: Math.round(duty), rebate: 0, other: 0, verified: true, ocrSource: 'demo' };
  });
  const state = { meta: { reportType: 'detailed', financialYear: '2025-26' }, bills, dist: { demand: { contract: 600 } }, enabled: { motors: true, pumps: true, ac: true, chiller: true, coolingTower: true, jets: true, compressor: true, boiler: true, tfh: true, lux: true, dryers: true } };
  recs.push({ id: `rpt-${auditId}`.replace(/[^A-Za-z0-9-]/g, '-'), app: 'report', kind: 'report', tag: null,
    payload: { schema: 'postman-report/v1', n: 1, c: JSON.stringify(state), company: profile.companyName, type: 'detailed', fy: '2025-26', revision: 'Demo' }, t: now });

  if (filesDir) {
    fs.mkdirSync(path.join(filesDir, auditId), { recursive: true });
    const fins = db.prepare(`INSERT INTO files (id, audit_id, app, equipment_tag, kind, pair_id, caption, taken_at, uploaded_by, mime, size, sha256, received, status, original_name, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'image/png', ?, ?, ?, 'ready', ?, ?, ?)`);
    for (const f of files) {
      fs.writeFileSync(path.join(filesDir, auditId, f.sha), f.bytes);
      fins.run(f.id, auditId, f.app, f.tag ? String(f.tag).slice(0, 80) : null, f.kind, f.pairId, f.caption, now, actor.id, f.bytes.length, f.sha, f.bytes.length, `${f.kind}-${f.id.slice(0, 8)}.png`, now, now);
    }
  }
  const ins = db.prepare(`INSERT INTO records (id, audit_id, app, user_id, updated_by, device_id, kind, tag, taken_at, saved_at, synced_at, version, payload)
    VALUES (?, ?, ?, ?, ?, 'demo', ?, ?, ?, ?, ?, 1, ?)`);
  for (const x of recs) {
    const tag = x.tag ? String(x.tag).slice(0, 80) : null;
    ins.run(x.id, auditId, x.app, actor.id, actor.id, x.kind, tag, x.t, x.t, now, JSON.stringify(x.payload));
    if (filesDir) linkPhotosOfRecord(db, { id: x.id, audit_id: auditId, kind: x.kind, tag, payload: x.payload });
  }
  // Energy Ledger: bills, baseline and GHG for the same company (lib/demo-ledger.js).
  const ledger = createDemoLedger(db, actor, auditId, { ip });
  return { audit_id: auditId, records: recs.length, pictures: files.length, ledger };
}
