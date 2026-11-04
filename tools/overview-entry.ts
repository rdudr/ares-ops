// The overview the Console shows for one app at one company (App console > View data > View
// records > Overview): headline figures, charts and warnings, worked out with each field app's own
// calculation engine, so the figures are the ones the app itself shows.
// Bundled by tools/bundle-overview.mjs into public/overview.js as window.ARES_OVERVIEW.
// "@mla/…", "@pump/…" and so on are the app folders listed in tools/bundle-overview.mjs.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { fleetTotals } from "@mla/lib/motor-calc";
import { calculatePump, equivalentLength, efficiencyBand } from "@pump/lib/pump-calc";
import { calcAirUnit, calcChiller, calcCoolingTower, BANDS as COOL_BANDS } from "@cool/lib/calc";
import { calcTransformer } from "@xmer/lib/xmer-calc";
import { calcArea } from "@light/lib/light-calc";
import { calcDryer } from "@dryer/lib/dryer-calc";
import { analyseFuel, computeDirect, computeIndirect } from "@thermo/lib/boiler";
import { compressorPerformance, testPowerKw } from "@acmp/lib/compressor-calc";

type Tone = "good" | "warn" | "bad" | "muted";
type Kpi = { label: string; value: string; note?: string };
type Bar = { label: string; value: number; text?: string; tone?: Tone };
type Chart = { title: string; unit: string; bars: Bar[]; marks?: { value: number; label: string }[]; note?: string };
type Flag = { tone: Tone; tag: string; text: string };
type Slice = { label: string; value: number; tone?: Tone };
/** A donut: how a whole splits ("split", one colour per item) or how items rate ("status", by tone). */
type Donut = { title: string; unit: string; kind: "split" | "status"; slices: Slice[] };
type Overview = { kpis: Kpi[]; charts: Chart[]; flags: Flag[]; donuts?: Donut[] };
type Rec = { id: string; kind: string; tag: string | null; payload: any };

// ── formatting ──────────────────────────────────────────────────────────────
const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const f = (v: unknown, d = 1) => (ok(v) ? v.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—");
const inr = (v: unknown) => (ok(v) ? `₹ ${Math.round(v).toLocaleString("en-IN")}` : "—");
const sum = (xs: (number | null | undefined)[]) => xs.reduce<number>((a, x) => a + (ok(x) ? x : 0), 0);
const avg = (xs: (number | null | undefined)[]) => { const v = xs.filter(ok); return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null; };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const of = (recs: Rec[], kind: string) => recs.filter((r) => r.kind === kind).map((r) => r.payload);
/** Runs one record through its engine; a record the engine cannot read is skipped, not fatal. */
const safe = <T,>(fn: () => T): T | null => { try { return fn(); } catch { return null; } };

// ── MLA: motors ─────────────────────────────────────────────────────────────
function motor(recs: Rec[]): Overview {
  const motors = of(recs, "motor"), sessions = of(recs, "monitoring_session");
  const t = safe(() => fleetTotals(motors)) as any;
  if (!t) return { kpis: [{ label: "Motors", value: String(motors.length) }], charts: [], flags: [] };
  const tone = (k: string): Tone => (k === "under" ? "warn" : k === "over" ? "bad" : "good");
  const flags: Flag[] = [];
  motors.forEach((m, i) => {
    const c = t.calcs[i];
    if (c.zone.key === "under" || c.zone.key === "over") flags.push({ tone: tone(c.zone.key), tag: m.motorTag, text: `${c.zone.short}: load factor ${f(c.loadFactorPct)} %` });
    if (ok(c.unbalance?.vUnbalPct) && c.unbalance.vUnbalPct > 1) flags.push({ tone: "warn", tag: m.motorTag, text: `Voltage unbalance ${f(c.unbalance.vUnbalPct, 2)} %: derate × ${f(c.unbalance.deratingFactor, 2)}` });
  });
  for (const s of sessions) flags.push({ tone: "muted", tag: s.motor?.motorTag || "Monitoring", text: `Monitored ${f(s.summary?.durationH)} h: average load ${f(s.summary?.lf?.avg)} %, running ${f(s.summary?.runningPct, 0)} % of the time` });
  return {
    kpis: [
      { label: "Motors analysed", value: String(t.count), note: plural(sessions.length, "monitoring session") },
      { label: "Running power", value: `${f(t.activeKw)} kW`, note: `of ${f(t.ratedKw)} kW connected` },
      { label: "Fleet average load", value: `${f(t.avgLf)} %`, note: `plant PF ${f(t.plantPf, 2)}` },
      { label: "Upgrade savings", value: inr(t.savings), note: `${f(t.savingsKwh, 0)} kWh a year` },
    ],
    charts: [
      { title: "Load factor by motor", unit: "%", marks: [{ value: 40, label: "40 %" }, { value: 95, label: "95 %" }],
        bars: motors.map((m, i) => ({ label: m.motorTag, value: t.calcs[i].loadFactorPct, tone: tone(t.calcs[i].zone.key) })) },
      { title: "Savings a year with an efficient motor", unit: "₹",
        bars: motors.map((m, i) => ({ label: m.motorTag, value: t.calcs[i].audit.annualSavingsCost, text: inr(t.calcs[i].audit.annualSavingsCost) })).filter((b) => b.value > 0) },
    ],
    flags,
  };
}

// ── Pump EFF ────────────────────────────────────────────────────────────────
function pump(recs: Rec[]): Overview {
  const tests = of(recs, "pump_test");
  const rows = tests.map((p) => {
    const od = ok(p.pipePeriphery) ? p.pipePeriphery / 3.14 : null;
    const id = od !== null ? od - 2 * (p.pipeThickness ?? 0) : null;
    const r = safe(() => calculatePump({ ...p, equivalentLengthM: equivalentLength(p.straightLengthM, p.fittings, id).totalM })) as any;
    return { p, r, band: efficiencyBand(r?.pumpEfficiency ?? null) };
  });
  const effs = rows.map((x) => x.r?.pumpEfficiency);
  const tone = (t: string): Tone => (t === "good" ? "good" : t === "fair" ? "warn" : t === "poor" ? "bad" : "muted");
  return {
    kpis: [
      { label: "Pumps tested", value: String(tests.length), note: `${tests.filter((p) => p.method === "TRANSIT").length} transit · ${tests.filter((p) => p.method === "DOPPLER").length} Doppler` },
      { label: "Average efficiency", value: `${f(avg(effs))} %`, note: "pumps with full readings" },
      { label: "Input power", value: `${f(sum(tests.map((p) => p.inputPowerKw)))} kW`, note: `useful ${f(sum(rows.map((x) => x.r?.hydraulicPowerKw)))} kW` },
      { label: "Below 50 %", value: String(effs.filter((e) => ok(e) && e < 50).length), note: "repair or replace" },
    ],
    charts: [{ title: "Pump efficiency", unit: "%", marks: [{ value: 50, label: "50 %" }, { value: 70, label: "70 %" }],
      bars: rows.filter((x) => ok(x.r?.pumpEfficiency)).map((x) => ({ label: x.p.pumpTag, value: x.r.pumpEfficiency, tone: tone(x.band.tone) })) }],
    flags: rows.filter((x) => x.band.tone === "poor" || ok(x.r?.frictionLossM)).map((x) => x.band.tone === "poor"
      ? { tone: "bad" as Tone, tag: x.p.pumpTag, text: `${x.band.label}: efficiency ${f(x.r?.pumpEfficiency)} %` }
      : { tone: "muted" as Tone, tag: x.p.pumpTag, text: `Friction loss in the line ${f(x.r.frictionLossM, 2)} m` }),
  };
}

// ── AC, AHU & Chiller ───────────────────────────────────────────────────────
function cool(recs: Rec[]): Overview {
  const units = of(recs, "air_unit").map((u) => ({ u, r: safe(() => calcAirUnit(u)) as any }));
  const chillers = of(recs, "chiller").map((c) => ({ c, r: safe(() => calcChiller(c)) as any }));
  const towers = of(recs, "cooling_tower").map((t) => ({ t, r: safe(() => calcCoolingTower(t)) as any }));
  const acs = units.filter((x) => x.u.category === "AC"), ahus = units.filter((x) => x.u.category === "AHU");
  const acTr = sum(acs.map((x) => x.r?.netTr)), acKw = sum(acs.map((x) => x.r?.kwUsed));
  const all = [...units.map((x) => ({ tag: x.u.tag, v: x.r?.verdict })), ...chillers.map((x) => ({ tag: x.c.tag, v: x.r?.verdict })), ...towers.map((x) => ({ tag: x.t.tag, v: x.r?.verdict }))];
  return {
    kpis: [
      { label: "Equipment assessed", value: String(all.length), note: `${acs.length} AC · ${ahus.length} AHU · ${chillers.length} chiller · ${towers.length} tower` },
      { label: "AC specific power", value: acTr > 0 ? `${f(acKw / acTr, 2)} kW/TR` : "—", note: `${f(acTr)} TR measured` },
      { label: "Chiller cooling", value: `${f(sum(chillers.map((x) => x.r?.trGenerated)))} TR`, note: `AHUs deliver ${f(sum(ahus.map((x) => x.r?.netTr)))} TR` },
      { label: "Cooling-tower load", value: `${f(sum(towers.map((x) => x.r?.trGenerated)))} TR` },
    ],
    charts: [
      { title: "AC specific power", unit: "kW/TR", marks: [{ value: COOL_BANDS.acKwPerTr.good, label: "good" }, { value: COOL_BANDS.acKwPerTr.fair, label: "poor above" }],
        bars: acs.filter((x) => ok(x.r?.kwPerTr)).map((x) => ({ label: x.u.tag, value: x.r.kwPerTr, text: f(x.r.kwPerTr, 2), tone: x.r.verdict?.tone })) },
      { title: "Chiller specific power", unit: "kW/TR", bars: chillers.filter((x) => ok(x.r?.spcTotal)).map((x) => ({ label: x.c.tag, value: x.r.spcTotal, text: f(x.r.spcTotal, 2), tone: x.r.verdict?.tone })) },
      { title: "Cooling-tower effectiveness", unit: "%", marks: [{ value: COOL_BANDS.ctEffectiveness.fair, label: "45 %" }, { value: COOL_BANDS.ctEffectiveness.good, label: "60 %" }],
        bars: towers.filter((x) => ok(x.r?.effectiveness)).map((x) => ({ label: x.t.tag, value: x.r.effectiveness, tone: x.r.verdict?.tone })) },
    ],
    flags: all.filter((x) => x.v && (x.v.tone === "bad" || x.v.tone === "warn")).map((x) => ({ tone: x.v.tone, tag: x.tag, text: x.v.label })),
  };
}

// ── Xmer-Eff ────────────────────────────────────────────────────────────────
function xmer(recs: Rec[]): Overview {
  const rows = of(recs, "transformer").map((t) => ({ t, r: safe(() => calcTransformer(t)) as any }));
  const below = rows.filter((x) => x.r?.star && x.r.star.level < 3);
  return {
    kpis: [
      { label: "Transformers", value: String(rows.length), note: `${f(sum(rows.map((x) => x.t.ratingKva)), 0)} kVA installed` },
      { label: "Average loading", value: `${f(avg(rows.map((x) => x.r?.loadingPct)), 0)} %` },
      { label: "Losses now", value: `${f(sum(rows.map((x) => x.r?.lossActual)), 0)} W`, note: "at the measured loads" },
      { label: "Losses a year", value: `${f(sum(rows.map((x) => x.r?.annualLossKwh)), 0)} kWh`, note: inr(sum(rows.map((x) => x.r?.annualLossCost))) },
    ],
    charts: [
      { title: "Loading", unit: "%", marks: [{ value: 50, label: "50 %" }], bars: rows.filter((x) => ok(x.r?.loadingPct)).map((x) => ({ label: x.t.tag, value: x.r.loadingPct })) },
      { title: "Cost of losses a year", unit: "₹", bars: rows.filter((x) => ok(x.r?.annualLossCost)).map((x) => ({ label: x.t.tag, value: x.r.annualLossCost, text: inr(x.r.annualLossCost), tone: x.r.star && x.r.star.level < 3 ? "warn" : "good" })) },
    ],
    flags: below.map((x) => ({ tone: "warn" as Tone, tag: x.t.tag, text: x.r.star.level === 0 ? "Below IS 1180 level 1: candidate for a low-loss replacement" : `IS 1180 level ${x.r.star.level}, below level 3` })),
  };
}

// ── Lighting ────────────────────────────────────────────────────────────────
function light(recs: Rec[]): Overview {
  const rows = of(recs, "lighting_area").map((a) => ({ a, r: safe(() => calcArea(a)) as any }));
  const area = sum(rows.map((x) => x.r?.area)), watts = sum(rows.map((x) => x.r?.circuitW));
  const tone = (k?: string): Tone => (k === "good" ? "good" : k === "review" ? "warn" : k === "urgent" ? "bad" : "muted");
  return {
    kpis: [
      { label: "Areas", value: String(rows.length), note: `${f(area, 0)} m² surveyed` },
      { label: "Lighting load", value: `${f(watts / 1000, 2)} kW`, note: area > 0 ? `${f(watts / area)} W/m² on average` : undefined },
      { label: "Energy a year", value: `${f(sum(rows.map((x) => x.r?.annualKwh)), 0)} kWh` },
      { label: "Possible saving", value: `${f(sum(rows.map((x) => x.r?.annualSavingKwh)), 0)} kWh`, note: inr(sum(rows.map((x) => x.r?.annualSavingCost))) },
    ],
    charts: [
      { title: "Installed load efficiency ratio (ILER)", unit: "", marks: [{ value: 0.5, label: "0.5" }, { value: 0.75, label: "0.75" }],
        bars: rows.filter((x) => ok(x.r?.iler)).map((x) => ({ label: x.a.tag, value: x.r.iler, text: f(x.r.iler, 2), tone: tone(x.r.band?.key) })) },
      { title: "Light level against the recommended", unit: "lux",
        bars: rows.filter((x) => ok(x.r?.eAvg)).map((x) => ({ label: x.a.tag, value: x.r.eAvg, text: `${f(x.r.eAvg, 0)} of ${f(x.r.recommendedLux, 0)}`, tone: ok(x.r.recommendedLux) && x.r.eAvg < x.r.recommendedLux ? "warn" : "good" })) },
    ],
    flags: rows.filter((x) => x.r?.band && x.r.band.key !== "good").map((x) => ({ tone: tone(x.r.band.key), tag: x.a.tag, text: `${x.r.band.label}: ILER ${f(x.r.iler, 2)}` })),
  };
}

// ── Dryers ──────────────────────────────────────────────────────────────────
function dryer(recs: Rec[]): Overview {
  const rows = of(recs, "dryer").map((d) => ({ d, r: safe(() => calcDryer(d)) as any }));
  const band = (r: any): { tone: Tone; text: string } => {
    if (!ok(r?.efficiency) || !r.bench) return { tone: "muted", text: "" };
    if (r.efficiency < r.bench.min) return { tone: "bad", text: `below the typical ${r.bench.min}–${r.bench.max} %` };
    if (r.efficiency > r.bench.max) return { tone: "warn", text: `above the typical ${r.bench.min}–${r.bench.max} %: check the readings` };
    return { tone: "good", text: "within the typical range" };
  };
  return {
    kpis: [
      { label: "Dryers", value: String(rows.length), note: `${rows.filter((x) => ok(x.r?.efficiency)).length} with efficiency worked out` },
      { label: "Average efficiency", value: `${f(avg(rows.map((x) => x.r?.efficiency)))} %` },
      { label: "Heat a year", value: `${f(sum(rows.map((x) => x.r?.annualHeatGJ)), 0)} GJ`, note: `${f(sum(rows.map((x) => x.r?.annualEvaporationT)), 0)} t of water evaporated` },
      { label: "Possible saving", value: `${f(sum(rows.map((x) => x.r?.annualSavingGJ)), 0)} GJ`, note: inr(sum(rows.map((x) => x.r?.annualSavingCost))) },
    ],
    charts: [{ title: "Dryer efficiency", unit: "%", bars: rows.filter((x) => ok(x.r?.efficiency)).map((x) => ({ label: x.d.tag, value: x.r.efficiency, tone: band(x.r).tone })) }],
    flags: rows.filter((x) => ["bad", "warn"].includes(band(x.r).tone)).map((x) => ({ tone: band(x.r).tone, tag: x.d.tag, text: `Efficiency ${f(x.r.efficiency)} %, ${band(x.r).text}` })),
  };
}

// ── Thermo-X: boilers and thermic fluid heaters ─────────────────────────────
function heat(recs: Rec[]): Overview {
  const fuels = of(recs, "fuel"), boilers = of(recs, "boiler");
  const direct = of(recs, "direct_test"), indirect = of(recs, "indirect_test");
  const fuel = (id: string) => fuels.find((x) => x.id === id) || null;
  const latest = (xs: any[], id: string) => xs.filter((t) => t.boilerId === id).sort((a, b) => String(b.updatedAt || b.testDate || b.startDate).localeCompare(String(a.updatedAt || a.testDate || a.startDate)))[0];
  const rows = boilers.map((b) => {
    const d = latest(direct, b.id), i = latest(indirect, b.id);
    const de = d ? (safe(() => { const fu = fuel(d.fuelId); return fu ? computeDirect(d, analyseFuel(fu), b).efficiency : null; }) as number | null) : null;
    const ie = i ? (safe(() => computeIndirect(i, fuel(i.fuelId))?.overall.efficiency ?? null) as number | null) : null;
    return { b, de: ok(de) ? de : null, ie: ok(ie) ? ie : null };
  });
  const latestEff = rows.map((x) => x.ie ?? x.de);
  const tone = (v: number) => (v < 70 ? "bad" : v < 80 ? "warn" : "good") as Tone;
  return {
    kpis: [
      { label: "Boilers and heaters", value: String(boilers.length), note: plural(fuels.length, "fuel") },
      { label: "Tests", value: String(direct.length + indirect.length), note: `${direct.length} direct · ${indirect.length} indirect` },
      { label: "Average efficiency", value: `${f(avg(latestEff))} %`, note: "latest test of each" },
      { label: "Below 70 %", value: String(latestEff.filter((e) => ok(e) && e < 70).length), note: "need attention" },
    ],
    charts: [{ title: "Efficiency by test", unit: "%", marks: [{ value: 70, label: "70 %" }],
      bars: rows.flatMap((x) => [
        ...(x.de !== null ? [{ label: `${x.b.name} · direct`, value: x.de, tone: tone(x.de) }] : []),
        ...(x.ie !== null ? [{ label: `${x.b.name} · indirect`, value: x.ie, tone: tone(x.ie) }] : []),
      ]) }],
    flags: rows.filter((x) => ok(x.ie ?? x.de) && (x.ie ?? x.de)! < 70).map((x) => ({ tone: "bad" as Tone, tag: x.b.name, text: `Efficiency ${f(x.ie ?? x.de)} %, below 70 %` })),
  };
}

// ── JET-Eff (the app saves its results with each jet) ───────────────────────
function textile(recs: Rec[]): Overview {
  const jets = of(recs, "jet");
  const tone = (e: number) => (e < 40 ? "bad" : e < 60 ? "warn" : "good") as Tone;
  return {
    kpis: [
      { label: "Jets surveyed", value: String(jets.length) },
      { label: "Steam saving", value: `${f(sum(jets.map((j) => j.steamSaving)), 1)} kg/h`, note: "from insulating the bodies" },
      { label: "Average pump efficiency", value: `${f(avg(jets.map((j) => j.pumpEfficiency)), 0)} %` },
      { label: "Steam traps passing", value: String(jets.filter((j) => j.trapStatus === "Trap Passing").length), note: plural(jets.filter((j) => j.pumpSuggestion === "Replace Pump").length, "pump") + " to replace" },
    ],
    charts: [
      { title: "Pump efficiency", unit: "%", marks: [{ value: 40, label: "40 %" }], bars: jets.filter((j) => ok(j.pumpEfficiency)).map((j) => ({ label: j.jetNo, value: j.pumpEfficiency, tone: tone(j.pumpEfficiency) })) },
      { title: "Steam saving from insulation", unit: "kg/h", bars: jets.filter((j) => ok(j.steamSaving)).map((j) => ({ label: j.jetNo, value: j.steamSaving, text: f(j.steamSaving, 1) })) },
    ],
    flags: [
      ...jets.filter((j) => j.trapStatus === "Trap Passing").map((j) => ({ tone: "bad" as Tone, tag: j.jetNo, text: "Steam trap passing live steam" })),
      ...jets.filter((j) => j.pumpSuggestion === "Replace Pump").map((j) => ({ tone: "warn" as Tone, tag: j.jetNo, text: `Pump efficiency ${f(j.pumpEfficiency)} %: replace the pump` })),
      ...jets.filter((j) => j.insulation === "UnInsulated").map((j) => ({ tone: "warn" as Tone, tag: j.jetNo, text: "Body not insulated" })),
    ],
  };
}

// ── A-CMP: air compressors ──────────────────────────────────────────────────
function air(recs: Rec[]): Overview {
  const rows = of(recs, "compressor").map((c) => {
    const p = safe(() => compressorPerformance(c)) as any;
    const kw = p?.measuredKw ?? testPowerKw(c, null);
    const eff = ok(c.motorEfficiency) && c.motorEfficiency > 0 ? c.motorEfficiency / 100 : 1;
    const lf = ok(kw) && ok(c.ratedKw) && c.ratedKw > 0 ? (kw / (c.ratedKw / eff)) * 100 : null;
    return { c, p, kw, lf };
  });
  const toneOf = (t?: string): Tone => (t === "good" ? "good" : t === "warn" ? "warn" : t === "bad" ? "bad" : "muted");
  return {
    kpis: [
      { label: "Compressors", value: String(rows.length), note: `${f(sum(rows.map((x) => x.c.ratedKw)), 0)} kW rated` },
      { label: "Measured power", value: `${f(sum(rows.map((x) => x.kw)))} kW` },
      { label: "Average load factor", value: `${f(avg(rows.map((x) => x.lf)))} %` },
      { label: "Specific energy", value: `${f(avg(rows.map((x) => x.p?.actualSec)), 3)} kW/CFM`, note: "from FAD and pump-up tests" },
    ],
    charts: [
      { title: "Specific energy, actual", unit: "kW/CFM", bars: rows.filter((x) => ok(x.p?.actualSec)).map((x) => ({ label: x.c.machineTag, value: x.p.actualSec, text: `${f(x.p.actualSec, 3)} (design ${f(x.p.designSec, 3)})`, tone: toneOf(x.p.verdict?.tone) })) },
      { title: "Load factor", unit: "%", marks: [{ value: 100, label: "100 %" }], bars: rows.filter((x) => ok(x.lf)).map((x) => ({ label: x.c.machineTag, value: x.lf!, tone: x.lf! > 100 ? "bad" : "good" })) },
    ],
    flags: [
      ...rows.filter((x) => x.p?.verdict && ["bad", "warn"].includes(x.p.verdict.tone)).map((x) => ({ tone: toneOf(x.p.verdict.tone), tag: x.c.machineTag, text: x.p.verdict.label })),
      ...rows.filter((x) => ok(x.lf) && x.lf > 100).map((x) => ({ tone: "bad" as Tone, tag: x.c.machineTag, text: `Running above full-load input: load factor ${f(x.lf)} %` })),
    ],
  };
}

// ── ARES: plant electrical survey (the app saves its results with each entry) ─
function survey(recs: Rec[]): Overview {
  const zones = of(recs, "zone"), panels = of(recs, "panel"), machines = of(recs, "machine"), apfc = of(recs, "apfc");
  const lf = (m: any) => (ok(m.loadFactor) ? m.loadFactor * 100 : null);
  const tone = (v: number) => (v < 40 ? "warn" : v > 100 ? "bad" : "good") as Tone;
  const lfs = machines.map(lf);
  return {
    kpis: [
      { label: "Main inputs", value: String(zones.length), note: `${f(sum(zones.map((z) => z.measuredKw ?? z.totalPower)))} kW measured` },
      { label: "Panels", value: String(panels.length), note: `${panels.filter((p) => p.type === "PCC").length} PCC · ${panels.filter((p) => p.type === "MCC").length} MCC` },
      { label: "Machines", value: String(machines.length), note: `${f(sum(machines.map((m) => m.measuredKw ?? m.calculatedPower)))} kW` },
      { label: "Machines out of range", value: String(lfs.filter((v) => ok(v) && (v < 40 || v > 100)).length),
        note: `${lfs.filter((v) => ok(v) && v < 40).length} under · ${lfs.filter((v) => ok(v) && v > 100).length} over · ${lfs.filter((v) => ok(v) && v >= 40 && v <= 100).length} normal` },
    ],
    charts: [
      { title: "Power by main input", unit: "kW", bars: zones.map((z) => ({ label: z.name, value: z.measuredKw ?? z.totalPower ?? 0, text: `${f(z.measuredKw ?? z.totalPower)} kW · PF ${f(z.pf, 2)}`, tone: ok(z.pf) && z.pf < 0.9 ? "warn" : "good" })) },
      { title: "Machine load factor", unit: "%", marks: [{ value: 40, label: "40 %" }, { value: 100, label: "100 %" }],
        bars: machines.filter((m) => ok(lf(m))).map((m) => ({ label: m.machineTag, value: lf(m)!, tone: tone(lf(m)!) })) },
    ],
    flags: [
      ...machines.filter((m) => ok(lf(m)) && (lf(m)! < 40 || lf(m)! > 100)).map((m) => ({ tone: tone(lf(m)!), tag: m.machineTag, text: `${lf(m)! > 100 ? "Overloaded" : "Underloaded"}: load factor ${f(lf(m))} %` })),
      ...apfc.filter((a) => a.remark && a.remark !== "OK").map((a) => ({ tone: (a.remark === "Not OK" ? "bad" : "warn") as Tone, tag: `APFC stage ${a.stage}`, text: [a.remark, a.description].filter(Boolean).join(": ") })),
      ...zones.filter((z) => ok(z.ithd1) && z.ithd1 > 12).map((z) => ({ tone: "warn" as Tone, tag: z.name, text: `Current THD ${f(z.ithd1)} % on the input` })),
    ],
  };
}

// ── Donuts, as the ARES app shows them: a split of the whole and a status mix, per app ──
/** Largest first; past six items the rest are grouped as "Others". */
function split(title: string, unit: string, items: { label: string; value: number | null | undefined }[]): Donut {
  const xs = items.filter((x) => ok(x.value) && x.value > 0).map((x) => ({ label: x.label, value: x.value as number })).sort((a, b) => b.value - a.value);
  const top = xs.length > 6 ? [...xs.slice(0, 5), { label: `Others (${xs.length - 5})`, value: sum(xs.slice(5).map((x) => x.value)) }] : xs;
  return { title, unit, kind: "split", slices: top };
}
function status(title: string, slices: Slice[]): Donut {
  return { title, unit: "", kind: "status", slices: slices.filter((x) => x.value > 0) };
}
const countBy = <T,>(xs: T[], key: (x: T) => string | null | undefined) => {
  const m = new Map<string, number>();
  for (const x of xs) { const k = key(x); if (k) m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].map(([label, value]) => ({ label, value }));
};
const n = (xs: (number | null | undefined)[], test: (v: number) => boolean) => xs.filter((v) => ok(v) && test(v)).length;

const DONUTS: Record<string, (recs: Rec[]) => Donut[]> = {
  motor: (recs) => {
    const motors = of(recs, "motor");
    const t = safe(() => fleetTotals(motors)) as any;
    if (!t) return [];
    return [
      status("Load mix", [
        { label: "Under-loaded (< 40 %)", value: t.counts.under, tone: "warn" }, { label: "Normal (40–75 %)", value: t.counts.normal, tone: "muted" },
        { label: "Optimal (75–95 %)", value: t.counts.optimal, tone: "good" }, { label: "Overloaded (> 95 %)", value: t.counts.over, tone: "bad" }]),
      split("Running power by motor", "kW", motors.map((m, i) => ({ label: m.motorTag, value: t.calcs[i].P_kW }))),
    ];
  },
  pump: (recs) => {
    const tests = of(recs, "pump_test");
    const effs = tests.map((p) => {
      const od = ok(p.pipePeriphery) ? p.pipePeriphery / 3.14 : null;
      const id = od !== null ? od - 2 * (p.pipeThickness ?? 0) : null;
      return (safe(() => calculatePump({ ...p, equivalentLengthM: equivalentLength(p.straightLengthM, p.fittings, id).totalM })) as any)?.pumpEfficiency;
    });
    return [
      status("Efficiency bands", [{ label: "Good (≥ 70 %)", value: n(effs, (v) => v >= 70 && v <= 100), tone: "good" },
        { label: "Fair (50–70 %)", value: n(effs, (v) => v >= 50 && v < 70), tone: "warn" }, { label: "Poor (< 50 %)", value: n(effs, (v) => v < 50), tone: "bad" }]),
      split("Input power by pump", "kW", tests.map((p) => ({ label: p.pumpTag, value: p.inputPowerKw }))),
    ];
  },
  cool: (recs) => {
    const v = [...of(recs, "air_unit").map((u) => (safe(() => calcAirUnit(u)) as any)?.verdict), ...of(recs, "chiller").map((c) => (safe(() => calcChiller(c)) as any)?.verdict),
      ...of(recs, "cooling_tower").map((t) => (safe(() => calcCoolingTower(t)) as any)?.verdict)];
    const units = of(recs, "air_unit");
    return [
      status("Assessment status", [{ label: "Good", value: v.filter((x) => x?.tone === "good").length, tone: "good" },
        { label: "Average", value: v.filter((x) => x?.tone === "warn").length, tone: "warn" }, { label: "Poor", value: v.filter((x) => x?.tone === "bad").length, tone: "bad" },
        { label: "Not enough data", value: v.filter((x) => !x || x.tone === "muted").length, tone: "muted" }]),
      split("Equipment", "", [{ label: "AC", value: units.filter((u) => u.category === "AC").length }, { label: "AHU", value: units.filter((u) => u.category === "AHU").length },
        { label: "Chillers", value: of(recs, "chiller").length }, { label: "Cooling towers", value: of(recs, "cooling_tower").length }]),
    ];
  },
  xmer: (recs) => {
    const rows = of(recs, "transformer").map((t) => ({ t, r: safe(() => calcTransformer(t)) as any }));
    return [
      status("IS 1180 star level", [{ label: "Level 3 or better", value: rows.filter((x) => x.r?.star && x.r.star.level >= 3).length, tone: "good" },
        { label: "Level 1–2", value: rows.filter((x) => x.r?.star && x.r.star.level >= 1 && x.r.star.level < 3).length, tone: "warn" },
        { label: "Below level 1", value: rows.filter((x) => x.r?.star && x.r.star.level === 0).length, tone: "bad" },
        { label: "Rating not in the table", value: rows.filter((x) => !x.r?.star).length, tone: "muted" }]),
      split("Energy lost a year", "kWh", rows.map((x) => ({ label: x.t.tag, value: x.r?.annualLossKwh }))),
    ];
  },
  light: (recs) => {
    const rows = of(recs, "lighting_area").map((a) => ({ a, r: safe(() => calcArea(a)) as any }));
    return [
      status("ILER assessment", [{ label: "Satisfactory to good", value: rows.filter((x) => x.r?.band?.key === "good").length, tone: "good" },
        { label: "Review suggested", value: rows.filter((x) => x.r?.band?.key === "review").length, tone: "warn" },
        { label: "Urgent action", value: rows.filter((x) => x.r?.band?.key === "urgent").length, tone: "bad" }]),
      split("Lighting load by area", "W", rows.map((x) => ({ label: x.a.tag, value: x.r?.circuitW }))),
    ];
  },
  dryer: (recs) => {
    const rows = of(recs, "dryer").map((d) => ({ d, r: safe(() => calcDryer(d)) as any }));
    const rated = rows.filter((x) => ok(x.r?.efficiency) && x.r.bench);
    return [
      status("Against the typical range", [{ label: "Within", value: rated.filter((x) => x.r.efficiency >= x.r.bench.min && x.r.efficiency <= x.r.bench.max).length, tone: "good" },
        { label: "Above (check readings)", value: rated.filter((x) => x.r.efficiency > x.r.bench.max).length, tone: "warn" },
        { label: "Below", value: rated.filter((x) => x.r.efficiency < x.r.bench.min).length, tone: "bad" }]),
      split("Heat a year by dryer", "GJ", rows.map((x) => ({ label: x.d.tag, value: x.r?.annualHeatGJ }))),
    ];
  },
  heat: (recs) => {
    // The latest efficiency of each boiler: its indirect test when there is one, else its direct test.
    const bars = heat(recs).charts[0]?.bars || [];
    const effs = of(recs, "boiler").map((b) => (bars.find((x) => x.label === `${b.name} · indirect`) || bars.find((x) => x.label === `${b.name} · direct`))?.value);
    return [
      status("Latest efficiency", [{ label: "80 % or more", value: n(effs, (v) => v >= 80), tone: "good" },
        { label: "70–80 %", value: n(effs, (v) => v >= 70 && v < 80), tone: "warn" }, { label: "Below 70 %", value: n(effs, (v) => v < 70), tone: "bad" }]),
      split("Tests", "", [{ label: "Direct method", value: of(recs, "direct_test").length }, { label: "Indirect method", value: of(recs, "indirect_test").length }]),
    ];
  },
  textile: (recs) => {
    const jets = of(recs, "jet");
    return [
      split("Operation mix", "", countBy(jets, (j) => j.operation)),
      status("Steam traps", [{ label: "Working OK", value: jets.filter((j) => j.trapStatus === "Working OK").length, tone: "good" },
        { label: "Passing steam", value: jets.filter((j) => j.trapStatus === "Trap Passing").length, tone: "bad" }]),
    ];
  },
  air: (recs) => {
    const cs = of(recs, "compressor");
    return [
      split("Technology mix", "", countBy(cs, (c) => c.compressorType || "Unknown")),
      split("Measured power by compressor", "kW", cs.map((c) => ({ label: c.machineTag, value: testPowerKw(c, null) }))),
    ];
  },
  survey: (recs) => {
    const zones = of(recs, "zone"), panels = of(recs, "panel"), machines = of(recs, "machine");
    const kw = (x: any) => x.measuredKw ?? x.totalPower;
    const lfs = machines.map((m) => (ok(m.loadFactor) ? m.loadFactor * 100 : null));
    return [
      split("Plant main inputs power", "kW", zones.map((z) => ({ label: z.name, value: kw(z) }))),
      split("PCC panels power", "kW", panels.filter((p) => p.type === "PCC").map((p) => ({ label: p.name, value: kw(p) }))),
      split("MCC panels power", "kW", panels.filter((p) => p.type === "MCC").map((p) => ({ label: p.name, value: kw(p) }))),
      status("Machine loading status", [{ label: "Underloaded (< 40 %)", value: n(lfs, (v) => v < 40), tone: "warn" },
        { label: "Normal (40–100 %)", value: n(lfs, (v) => v >= 40 && v <= 100), tone: "good" }, { label: "Overloaded (> 100 %)", value: n(lfs, (v) => v > 100), tone: "bad" }]),
    ];
  },
};

const BY_APP: Record<string, (recs: Rec[]) => Overview> = { motor, pump, cool, xmer, light, dryer, heat, textile, air, survey };

/** The overview for one app's records at one company, or null when the app has none. */
function overview(app: string, records: Rec[]): Overview | null {
  const fn = BY_APP[app];
  if (!fn) return null;
  const recs = records.filter((r) => r.kind !== "company_profile" && !r.payload?._deleted);
  if (!recs.length) return null;
  const o = fn(recs);
  const donuts = (safe(() => DONUTS[app]?.(recs)) || []).filter((d) => d.slices.length && sum(d.slices.map((x) => x.value)) > 0);
  // Charts with no bars are left out rather than drawn empty.
  return { ...o, donuts, charts: o.charts.filter((c) => c.bars.length), flags: o.flags.slice(0, 40) };
}

(globalThis as any).ARES_OVERVIEW = { overview, apps: Object.keys(BY_APP), version: "__OVERVIEW_VERSION__" };
