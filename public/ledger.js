// Energy Ledger: the Console menu where a company's electricity bills, energy baseline and GHG inputs
// are entered. Plain JS like the rest of the Console; all text goes through textContent. Figures come
// from ledger-calc.js. Everything saved here stays with the audit. Docs: docs/ENERGY-LEDGER.md.
import * as K from './ledger-calc.js';

const { num, parseMonth, monthKey, monthLabel } = K;
let x; // the Console's helpers: { h, api, toast, icon, ago, fmtDate, field, logoImg, state }
const LEFT_KEY = 'ares-ledger-tab';

// ---------- formatting ----------
const n0 = v => (v === null || v === undefined || !Number.isFinite(v) ? '—' : (Math.round(v) || 0).toLocaleString('en-IN')); // || 0: never "-0"
const nd = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : (+v.toFixed(d) || 0).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
const rupees = v => (v === null || v === undefined ? '—' : `₹${n0(v)}`);
const crore = v => {
  if (v === null || v === undefined) return '—';
  const a = Math.abs(v);
  return a >= 1e7 ? `₹${nd(v / 1e7, 2)} Cr` : a >= 1e5 ? `₹${nd(v / 1e5, 2)} L` : rupees(v);
};
const pct = v => (v === null || v === undefined ? '—' : `${nd(v * 100, 1)} %`);
const FMT = { money: crore, n: n0, pct };
const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'];
const uid = () => crypto.randomUUID().slice(0, 8);

// ---------- charts ----------
// One y-axis each, thin bars with rounded ends anchored to the baseline, a surface gap, recessive grid,
// a legend from two series, a table of the figures underneath. Colours are the validated default set.
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, v);
  for (const c of kids.flat()) if (c) el.append(c);
  return el;
};
const niceMax = v => { if (!(v > 0)) return 1; const p = 10 ** Math.floor(Math.log10(v)); const m = (v * 1.04) / p; return [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10, 12].find(s => s >= m) * p; };
const short = v => (Math.abs(v) >= 1e7 ? `${+(v / 1e7).toFixed(2)} Cr` : Math.abs(v) >= 1e5 ? `${+(v / 1e5).toFixed(2)} L` : Math.abs(v) >= 1000 ? `${+(v / 1000).toFixed(2)}k` : `${+v.toFixed(2)}`);
const barPath = (bx, y, w, h, r) => { const c = Math.min(r, h, w / 2); return `M${bx},${y + h}V${y + c}Q${bx},${y} ${bx + c},${y}H${bx + w - c}Q${bx + w},${y} ${bx + w},${y + c}V${y + h}Z`; };

/** kind: 'bars' (stacked when several series) or 'line'. series: [{ name, values }]. refLine: { value, label }. */
function chart({ title, unit, labels, series, kind = 'bars', refLine = null, fmt = v => nd(v, 2) }) {
  const W = 460, H = 220, L = 44, R = 8, T = 10, B = 24;
  const tip = x.h('div', { class: 'lg-tip', hidden: true });
  const stackTop = i => series.reduce((a, s) => a + (s.values[i] || 0), 0);
  const peaks = labels.map((_, i) => (kind === 'bars' ? stackTop(i) : Math.max(...series.map(s => s.values[i] ?? 0))));
  const max = niceMax(Math.max(...peaks, refLine?.value || 0, 0));
  const y = v => T + (H - T - B) * (1 - v / max);
  const step = (W - L - R) / Math.max(labels.length, 1);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${title}, ${unit}`, class: 'lg-chart' });
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    root.append(svg('line', { x1: L, x2: W - R, y1: y(max * f), y2: y(max * f), style: 'stroke:var(--sep)' }));
    const t = svg('text', { x: L - 6, y: y(max * f) + 3.5, 'text-anchor': 'end', 'font-size': 11, style: 'fill:var(--label-2)' }); t.textContent = short(max * f); root.append(t);
  }
  labels.forEach((lab, i) => {
    if (labels.length > 7 && i % 2) return; // every other month, so the labels do not touch
    const t = svg('text', { x: L + step * (i + 0.5), y: H - 7, 'text-anchor': 'middle', 'font-size': 11, style: 'fill:var(--label-2)' }); t.textContent = lab; root.append(t);
  });
  const hover = (i, ev) => {
    tip.replaceChildren(x.h('b', {}, labels[i]), ...series.map(s => x.h('div', {}, `${series.length > 1 ? `${s.name}: ` : ''}${s.values[i] === null || s.values[i] === undefined ? '—' : fmt(s.values[i])} ${unit}`)));
    tip.hidden = false;
    const box = root.getBoundingClientRect();
    tip.style.left = `${Math.min(ev.clientX - box.left + 12, box.width - 170)}px`;
    tip.style.top = `${Math.max(ev.clientY - box.top - 20, 0)}px`;
  };
  if (kind === 'bars') {
    const w = Math.min(26, step * 0.56);
    labels.forEach((_, i) => {
      let base = 0;
      series.forEach((s, si) => {
        const v = s.values[i] || 0;
        if (v <= 0) return;
        const top = y(base + v), hgt = y(base) - top;
        const last = !series.slice(si + 1).some(n => (n.values[i] || 0) > 0);
        const bx = L + step * (i + 0.5) - w / 2;
        root.append(svg('path', { d: last ? barPath(bx, top, w, Math.max(hgt - 1, 1), 4) : `M${bx},${top}h${w}v${Math.max(hgt - 2, 1)}h${-w}Z`, fill: COLORS[si % COLORS.length] }));
        base += v;
      });
    });
  } else {
    series.forEach((s, si) => {
      const pts = labels.map((_, i) => (s.values[i] === null || s.values[i] === undefined ? null : [L + step * (i + 0.5), y(s.values[i])]));
      let d = '', pen = false; // a month with no figure leaves a gap in the line
      for (const p of pts) { if (p) { d += `${pen ? 'L' : 'M'}${p[0]},${p[1]}`; pen = true; } else pen = false; }
      root.append(svg('path', { d, fill: 'none', stroke: COLORS[si % COLORS.length], 'stroke-width': 2, 'stroke-linejoin': 'round' }));
      for (const p of pts) if (p) root.append(svg('circle', { cx: p[0], cy: p[1], r: 4, fill: COLORS[si % COLORS.length], style: 'stroke:var(--card)', 'stroke-width': 2 }));
    });
  }
  if (refLine) {
    root.append(svg('line', { x1: L, x2: W - R, y1: y(refLine.value), y2: y(refLine.value), style: 'stroke:var(--label)', 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }));
  }
  labels.forEach((_, i) => {
    const hit = svg('rect', { x: L + step * i, y: T, width: step, height: H - T - B, fill: 'transparent' });
    hit.addEventListener('mousemove', ev => hover(i, ev));
    hit.addEventListener('mouseleave', () => { tip.hidden = true; });
    root.append(hit);
  });
  const legend = series.length > 1 || refLine ? x.h('div', { class: 'lg-legend' }, series.length > 1 ? series.map((s, i) => x.h('span', {}, swatch(i), s.name)) : null,
    refLine ? x.h('span', {}, svg('svg', { width: 18, height: 4, 'aria-hidden': 'true' }, svg('line', { x1: 0, x2: 18, y1: 2, y2: 2, style: 'stroke:var(--label)', 'stroke-width': 1.5, 'stroke-dasharray': '5 3' })), refLine.label) : null) : null;
  const table = x.h('details', { class: 'lg-figs noprint' }, x.h('summary', {}, 'See the figures'), x.h('div', { class: 'lg-scroll' }, x.h('table', { class: 'lg-t' },
    x.h('thead', {}, x.h('tr', {}, x.h('th', {}, 'Month'), series.map(s => x.h('th', { class: 'n' }, `${series.length > 1 ? s.name : title} (${unit})`)))),
    x.h('tbody', {}, labels.map((l, i) => x.h('tr', {}, x.h('td', {}, l), series.map(s => x.h('td', { class: 'n' }, s.values[i] === null || s.values[i] === undefined ? '—' : fmt(s.values[i])))))))));
  return x.h('figure', { class: 'lg-fig' }, x.h('figcaption', {}, x.h('b', {}, title), x.h('span', { class: 'small muted' }, unit)), legend, x.h('div', { class: 'lg-plot' }, root, tip), table);
}
function swatch(i) {
  const s = svg('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': 'true' }, svg('rect', { width: 10, height: 10, rx: 2, fill: COLORS[i % COLORS.length] }));
  return s;
}

// ---------- the CEA version ----------
const ceaLine = st => `CEA CDM-CO₂ Baseline Database Version ${st.current} (${st.published})`;
function ceaNotice(st, onUpdated) {
  if (st.newer) {
    const admin = x.state.me.role === 'super_admin';
    return x.h('div', { class: 'lg-notice bad', role: 'status' },
      x.h('div', {}, x.h('b', {}, `CEA has published Version ${st.latest}`),
        x.h('p', { class: 'small' }, `The Console still holds Version ${st.current}. Read the new User Guide, then ${admin ? 'add its factors under "CEA baseline" on the Energy Ledger page' : 'ask the Super Admin to add its factors'}. Companies keep the version they were worked out with until someone moves them.`)),
      x.h('a', { class: 'btn sm', href: st.page_url, target: '_blank', rel: 'noopener noreferrer' }, 'Open the CEA page'),
      onUpdated && admin ? h2Add(onUpdated) : null);
  }
  return null;
}
const h2Add = go => x.h('button', { class: 'btn sm cta', type: 'button', onclick: go }, 'Add the new version');
/** The notice for the Overview page, or nothing. */
export async function overviewNotice(helpers) {
  x = helpers;
  const st = await x.api('GET', '/api/ledger/cea', null, { background: true });
  return st.newer ? x.h('div', { class: 'lg-notice bad', role: 'status' }, x.h('div', {}, x.h('b', {}, `CEA has published CDM-CO₂ Baseline Database Version ${st.latest}`),
    x.h('p', { class: 'small' }, `Energy Ledger holds Version ${st.current}. New grid factors need to be added.`)),
  x.h('a', { class: 'btn sm', href: '#/ledger' }, 'Open Energy Ledger')) : null;
}

// ---------- the menu page ----------
export async function ledgerHome(holder, helpers) {
  x = helpers;
  const [cea, { companies }, { audits }, factors] = await Promise.all([
    x.api('GET', '/api/ledger/cea'), x.api('GET', '/api/ledger/summary'), x.api('GET', '/api/audits'), fetch('/ledger-factors.json').then(r => r.json())]);
  const openList = audits.filter(a => !['published', 'archived'].includes(a.status));
  const draw = st => {
    const cur = st.versions[0];
    const addBtn = st.newer ? () => addVersionDialog(st, draw) : null;
    const tableB = cur.rows.filter(r => r.cross_border).sort((a, b) => b.fy.localeCompare(a.fy));
    holder.replaceChildren(x.h('div', {},
      x.h('div', { class: 'head' }, x.h('div', { class: 'row', style: 'gap:14px;flex-wrap:nowrap' },
        x.h('img', { src: '/icons/bills.png', alt: '', width: 56, height: 56, class: 'lg-logo' }),
        x.h('div', {}, x.h('h1', {}, 'Energy Ledger'), x.h('p', { class: 'muted small' }, 'One place for a company’s electricity bills, energy baseline and GHG data. It is kept with the audit.')))),
      ceaNotice(st, addBtn),
      x.h('section', { class: 'card' },
        x.h('div', { class: 'cap' }, x.h('h2', {}, 'Companies'), x.h('span', { class: 'small muted' }, `${openList.length} open`)),
        openList.length ? x.h('div', { class: 'ilist' }, openList.map(a => {
          const s = companies[a.id] || {};
          return x.h('div', { class: 'it' },
            x.h('div', { class: 'main-t' }, x.h('b', {}, a.client_name),
              x.h('span', {}, [a.site_name, a.id, s.saved_at ? `saved ${x.ago(s.saved_at)}` : 'nothing entered yet'].filter(Boolean).join(' · '))),
            x.h('div', { class: 'trail row', style: 'gap:6px' },
              x.h('span', { class: `pill ${s.bills ? (s.verified === s.bills ? 'ok' : 'warn') : 'soft'}` }, `Bills ${s.bills || 0}`),
              x.h('span', { class: `pill ${s.baseline ? 'ok' : 'soft'}` }, `Baseline ${s.baseline || 0}`),
              s.cea ? x.h('span', { class: 'pill soft' }, `CEA v${s.cea}`) : null,
              x.h('a', { class: 'btn sm', href: `#/ledger/${encodeURIComponent(a.id)}` }, 'Open')));
        })) : x.h('p', { class: 'empty' }, 'No open audits yet. Create one under Audits first.')),
      x.h('div', { class: 'grid2 lg-gap' },
        x.h('section', { class: 'card' },
          x.h('div', { class: 'cap' }, x.h('h2', {}, 'CEA baseline'), x.h('span', { class: 'pill ok' }, `Version ${st.current}`)),
          x.h('p', { class: 'small muted' }, `CDM-CO₂ Baseline Database for the Indian Power Sector, ${st.published}. tCO₂/MWh, including cross-border transfers (User Guide Appendix C, Table B).`),
          x.h('div', { class: 'lg-scroll' }, x.h('table', { class: 'lg-t' },
            x.h('thead', {}, x.h('tr', {}, x.h('th', {}, 'FY'), x.h('th', { class: 'n' }, 'Weighted average'), x.h('th', { class: 'n' }, 'OM'), x.h('th', { class: 'n' }, 'BM'), x.h('th', { class: 'n' }, 'CM'))),
            x.h('tbody', {}, tableB.map(r => x.h('tr', {}, x.h('td', {}, r.fy), ...['average', 'om', 'bm', 'cm'].map(k => x.h('td', { class: 'n' }, nd(r[k], 3)))))))),
          x.h('p', { class: 'small lg-check' }, watchLine(st)),
          x.h('div', { class: 'row', style: 'gap:8px;margin-top:8px' },
            x.h('button', { class: 'btn ghost sm', type: 'button', onclick: async e => {
              e.target.disabled = true;
              const fresh = await x.api('POST', '/api/ledger/cea/check').catch(ex => (x.toast(ex.message), null));
              if (fresh) { draw(fresh); x.toast(fresh.ok ? (fresh.newer ? `New version found: ${fresh.latest}` : `Up to date: CEA is at Version ${fresh.latest}`) : 'The check did not work this time.'); } else e.target.disabled = false;
            } }, 'Check CEA now'),
            cur.guide_url ? x.h('a', { class: 'btn ghost sm', href: cur.guide_url, target: '_blank', rel: 'noopener noreferrer' }, 'User Guide') : null,
            x.state.me.role === 'super_admin' ? x.h('button', { class: 'btn ghost sm', type: 'button', onclick: () => addVersionDialog(st, draw) }, 'Add a version') : null)),
        x.h('section', { class: 'card' },
          x.h('div', { class: 'cap' }, x.h('h2', {}, 'GHG factors'), x.h('span', { class: 'pill ok' }, `${factors.year} v${factors.version}`)),
          x.h('p', { class: 'small muted' }, `${factors.source}. ${factors.items.length} factors for fuels, bioenergy, refrigerants, well-to-tank, water, materials, waste and hotel stays, picked from a list on the GHG screen so nothing needs typing.`),
          x.h('h3', { class: 'lg-h3' }, 'Notes'),
          x.h('ul', { class: 'small lg-notes' },
            x.h('li', {}, 'Every grid factor shows the CEA version it came from, on screen, in the report and in Excel.'),
            x.h('li', {}, 'The Console looks at the CEA website once a day. When a new version appears, a notice shows here and on the Overview, and the activity log records it.'),
            x.h('li', {}, 'A new version is added by the Super Admin from its User Guide, so nobody’s report changes by itself. Each company then chooses when to move to it.'),
            x.h('li', {}, 'CEA factors are CO₂ only, not CO₂e. DEFRA factors are UK values; use a plant’s own factor where it has one.'))))));
  };
  draw(cea);
}
const watchLine = st => (st.checked_at
  ? (st.ok ? `Last checked ${x.ago(st.checked_at)}: CEA is at Version ${st.latest}.` : `The last check, ${x.ago(st.checked_at)}, did not work: ${st.error}`)
  : 'Not checked yet. The Console looks once a day.');

function addVersionDialog(st, done) {
  const latestFy = st.versions[0].rows.map(r => r.fy).sort().pop();
  const nextFy = (() => { const y = parseInt(latestFy, 10) + 1; return `${y}-${String(y + 1).slice(2)}`; })();
  const row = (fy, cross) => {
    const inputs = ['average', 'om', 'bm', 'cm'].map(k => x.h('input', { 'aria-label': `${k} ${fy}`, inputmode: 'decimal', class: 'nin', 'data-k': k }));
    const fyIn = x.h('input', { value: fy, class: 'nin', 'aria-label': 'Financial year' });
    return { tr: x.h('tr', {}, x.h('td', {}, fyIn), x.h('td', {}, cross ? 'Table B' : 'Table A'), ...inputs.map(i => x.h('td', {}, i))),
      read: () => { const o = { fy: fyIn.value.trim(), cross_border: cross }; for (const i of inputs) o[i.dataset.k] = num(i.value); return o; }, inputs };
  };
  const rows = [row(nextFy, true), row(nextFy, false)];
  const version = x.h('input', { value: st.newer ? st.latest : '' }), published = x.h('input', { placeholder: 'August 2027' });
  const guide = x.h('input', { type: 'url', placeholder: 'https://cea.nic.in/...' });
  const err = x.h('p', { class: 'err', hidden: true });
  const dlg = x.h('dialog', { class: 'pick lg-dlg' }, x.h('div', { class: 'body' },
    x.h('h2', {}, 'Add a CEA version'),
    x.h('p', { class: 'muted small' }, 'Type the factors from Appendix C of the new User Guide. Add a line for each year the guide revised. Earlier years are carried over from the version before unless you give them here.'),
    x.h('div', { class: 'fgrid' }, x.field('Version', version), x.field('Published', published), x.field('User Guide link', guide)),
    x.h('div', { class: 'lg-scroll' }, x.h('table', { class: 'lg-t' }, x.h('thead', {}, x.h('tr', {}, ['FY', 'Table', 'Average', 'OM', 'BM', 'CM'].map(t => x.h('th', {}, t)))), x.h('tbody', {}, rows.map(r => r.tr)))),
    err,
    x.h('div', { class: 'foot' }, x.h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      x.h('button', { class: 'btn cta', type: 'button', onclick: async () => {
        const given = rows.map(r => r.read());
        const carried = st.versions[0].rows.filter(o => !given.some(g => g.fy === o.fy && g.cross_border === o.cross_border));
        try {
          const fresh = await x.api('POST', '/api/ledger/cea/versions', { version: version.value, published: published.value, guide_url: guide.value, rows: [...carried, ...given] });
          dlg.close(); done(fresh); x.toast(`Version ${fresh.current} added`);
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      } }, 'Save version'))));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

// ---------- one company ----------
const KIND = { bills: 'ledger_bills', baseline: 'ledger_baseline', ghg: 'ledger_ghg' };
const TABS = [['overview', 'Overview'], ['bills', 'Bills'], ['baseline', 'Baseline'], ['ghg', 'GHG'], ['report', 'Report']];
const L = { live: [], dirty: new Set(), versions: {}, timer: null, saving: false };

export async function ledgerCompany(holder, id, helpers, { solo = false } = {}) {
  x = helpers;
  const [d, { audits }, factors] = await Promise.all([
    x.api('GET', `/api/ledger/company/${encodeURIComponent(id)}`), x.api('GET', '/api/audits'), fetch('/ledger-factors.json').then(r => r.json())]);
  Object.assign(L, {
    id, solo, holder, factors, cea: d.cea, watch: d.watch, ai: d.ai, audit: d.audit, company: audits.find(a => a.id === id) || {},
    bills: d.records.ledger_bills?.payload || K.blankBills(), baseline: d.records.ledger_baseline?.payload || K.blankBaseline(), ghg: d.records.ledger_ghg?.payload || K.blankGhg(),
    versions: Object.fromEntries(Object.values(KIND).map(k => [k, d.records[k]?.version || 0])), lastBy: Object.values(d.records).sort((a, b) => b.saved_at - a.saved_at)[0] || null,
    dirty: new Set(), stale: false, consent: false, error: null, tab: readTab(),
  });
  const contract = L.company.contract_demand_kva ?? null;
  if (L.bills.cfg.contractDemand === null && contract) L.bills.cfg.contractDemand = contract;
  applyCea(false);
  drawCompany();
}
function readTab() { try { return sessionStorage.getItem(LEFT_KEY) || 'overview'; } catch { return 'overview'; } }
const setTab = t => { L.tab = t; try { sessionStorage.setItem(LEFT_KEY, t); } catch { /* private window */ } drawCompany(); };

/** The financial year of most of the bills or baseline months, else the audit's. */
function dominantFy() {
  const counts = {};
  for (const p of L.baseline.months) { const f = K.fyOf(p); counts[f] = (counts[f] || 0) + 1; }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : String(L.audit.fy || '').replace(/^FY/, '');
}
/** Sets the grid factor from a CEA version. Keeps a company on its version unless move is true. */
function applyCea(move) {
  const g = L.ghg, fy = g.fy || dominantFy();
  const source = move || !g.cea ? L.cea : { ...L.cea, version: g.cea.version, published: g.cea.published, rows: g.cea.rows || L.cea.rows };
  const f = K.ceaFactor(source, fy, g.basis || 'average', g.crossBorder !== false);
  if (!f) return;
  const changed = !g.cea || g.cea.version !== source.version || g.cea.fy !== f.fy || g.gridEF !== f.value || g.cea.wantedFy !== fy;
  g.gridEF = f.value;
  g.cea = { version: source.version, published: source.published, fy: f.fy, wantedFy: fy, exact: f.exact, guide_url: source.guide_url || L.cea.guide_url || null, rows: source.rows };
  g.defra = { short: L.factors.short, source: L.factors.source, version: L.factors.version, year: L.factors.year, url: L.factors.url };
  if (changed && (L.versions.ledger_ghg || L.dirty.size)) touch('ledger_ghg');
}

// Worked out once per change, however many figures are on screen; touch() and drawCompany() clear it.
let calcCache = null;
const calc = () => {
  if (calcCache) return calcCache;
  const bc = K.billCalc(L.bills), blc = K.baselineCalc(L.baseline), gc = K.ghgCalc(blc, L.baseline, L.ghg);
  return (calcCache = { bc, blc, gc });
};
/** A piece of text worked out from the figures; refreshed as people type. */
const live = (fn, attrs = {}) => { const s = x.h('span', attrs); const set = C => { s.textContent = fn(C); }; set(calc()); L.live.push(set); return s; };
function refresh() { calcCache = null; const C = calc(); for (const f of L.live) f(C); }

function touch(kind) {
  L.dirty.add(kind);
  if (kind === KIND.bills && K.billsIntoBaseline(L.bills, L.baseline)) L.dirty.add(KIND.baseline);
  if (kind !== KIND.ghg) applyCea(false);
  refresh();
  status();
  clearTimeout(L.timer);
  L.timer = setTimeout(flush, 1200);
}
async function flush() {
  if (L.saving || L.stale || L.audit.closed) return;
  L.saving = true; status();
  try {
    for (const kind of [...L.dirty]) {
      const payload = kind === KIND.bills ? L.bills : kind === KIND.baseline ? L.baseline : L.ghg;
      L.dirty.delete(kind);
      try {
        const r = await x.api('PUT', `/api/ledger/company/${encodeURIComponent(L.id)}/${kind}`, { payload, base_version: L.versions[kind] });
        L.versions[kind] = r.version;
        L.error = null;
      } catch (ex) {
        L.dirty.add(kind);
        if (ex.code === 'stale') L.stale = true;
        L.error = ex.message;
        if (!L.stale) { clearTimeout(L.timer); L.timer = setTimeout(flush, 10000); }
        break;
      }
    }
  } finally { L.saving = false; status(); }
  if (L.dirty.size && !L.error) flush();
}
window.addEventListener('beforeunload', e => { if (L.dirty.size) e.preventDefault(); });
window.addEventListener('hashchange', () => { if (L.dirty.size) flush(); });

function status() {
  const s = L.statusEl; if (!s) return;
  const set = (text, cls) => { s.textContent = text; s.className = `pill ${cls}`; };
  if (L.audit.closed) set('Finalised, read only', 'soft');
  else if (L.stale) set('Changed by a team-mate: reload', 'bad');
  else if (L.error) set('Not saved yet, trying again', 'warn');
  else if (L.saving || L.dirty.size) set('Saving…', 'soft');
  else set('All saved', 'ok');
}

function drawCompany() {
  clearTimeout(L.tabTimer);
  calcCache = null;
  L.live = [];
  L.statusEl = x.h('span', { class: 'pill ok', role: 'status' }, 'All saved');
  const c = L.company, g = L.ghg;
  const body = x.h('div', { class: 'lg-body' });
  ({ overview: drawOverview, bills: drawBills, baseline: drawBaseline, ghg: drawGhg, report: drawReport })[L.tab](body);
  const newer = g.cea && parseFloat(L.cea.version) > parseFloat(g.cea.version);
  L.holder.replaceChildren(x.h('div', { class: L.solo ? 'lg-solo' : '' },
    x.h('div', { class: 'head noprint' }, x.h('div', {},
      L.solo ? null : x.h('p', { class: 'small' }, x.h('a', { href: '#/ledger' }, '‹ Energy Ledger')),
      x.h('div', { class: 'row', style: 'flex-wrap:nowrap;gap:14px;align-items:center' }, x.logoImg(c.logo_file_id, 48), x.h('h1', { class: 'lg-title' }, c.client_name || L.id)),
      x.h('p', { class: 'muted small' }, [c.site_name, L.id, L.audit.fy].filter(Boolean).join(' · '))),
    x.h('div', { class: 'row', style: 'gap:8px' }, L.statusEl,
      L.stale ? x.h('button', { class: 'btn sm', type: 'button', onclick: () => location.reload() }, 'Reload') : null,
      L.solo ? null : x.h('button', { class: 'btn ghost sm', type: 'button', onclick: () => window.open(`#/ledger/${encodeURIComponent(L.id)}?solo`, '_blank', 'noopener') }, 'Open in new window', x.icon('external')))),
    ceaNotice(L.watch, null),
    newer ? x.h('div', { class: 'lg-notice warn noprint' }, x.h('div', {}, x.h('b', {}, `This company uses CEA Version ${g.cea.version}; Version ${L.cea.version} is available`),
      x.h('p', { class: 'small' }, 'Its figures stay as they are until you move it.')),
    x.h('button', { class: 'btn sm', type: 'button', onclick: () => { applyCea(true); touch(KIND.ghg); drawCompany(); } }, `Move to Version ${L.cea.version}`)) : null,
    x.h('nav', { class: 'lg-tabs noprint', 'aria-label': 'Energy Ledger sections' }, TABS.map(([id, label]) =>
      x.h('button', { type: 'button', class: id === L.tab ? 'on' : '', 'aria-current': id === L.tab ? 'page' : null, onclick: () => setTab(id) }, label))),
    body));
  status();
}

// ---------- small form parts ----------
const ro = () => L.audit.closed;
const nin = (obj, key, kind, attrs = {}) => {
  const i = x.h('input', { class: 'nin', inputmode: 'decimal', value: obj[key] ?? '', disabled: ro(), ...attrs });
  i.addEventListener('input', () => {
    const v = i.value.trim();
    const parsed = v === '' ? null : num(v);
    i.classList.toggle('bad', v !== '' && parsed === null);
    obj[key] = parsed;
    if (attrs.onset) attrs.onset();
    touch(kind);
  });
  return i;
};
const tin = (obj, key, kind, attrs = {}) => {
  const i = x.h('input', { value: obj[key] ?? '', disabled: ro(), ...attrs });
  i.addEventListener('input', () => { obj[key] = i.value; touch(kind); });
  return i;
};
const sel = (obj, key, kind, opts, after, attrs = {}) => {
  const s = x.h('select', { disabled: ro(), ...attrs }, opts.map(o => (o.items ? x.h('optgroup', { label: o.label }, o.items.map(i => x.h('option', { value: i.v }, i.t))) : x.h('option', { value: o.v }, o.t))));
  s.value = obj[key] ?? '';
  s.addEventListener('change', () => { const raw = s.value; obj[key] = /^-?\d+(\.\d+)?$/.test(raw) ? +raw : raw; if (after) after(raw); touch(kind); });
  return s;
};
const tile = (label, valueNode, sub) => x.h('div', { class: 'lg-kpi' }, x.h('span', { class: 'small muted' }, label), x.h('b', {}, valueNode), sub ? x.h('span', { class: 'small muted' }, sub) : null);
const card = (title, sub, ...kids) => x.h('section', { class: 'card lg-card' }, x.h('div', { class: 'cap' }, x.h('h2', {}, title)), sub ? x.h('p', { class: 'small muted' }, sub) : null, ...kids);
const scroll = t => x.h('div', { class: 'lg-scroll' }, t);

// ---------- overview ----------
function drawOverview(w) {
  const { bc, blc, gc } = calc();
  const f = K.findings(bc, blc, gc, FMT);
  if (!bc.months && !blc.months) {
    w.append(card('Nothing entered yet', 'Start with the bills: upload the PDFs or photographs, or bring in the team’s Excel sheet. The baseline fills itself from them.',
      x.h('button', { class: 'btn cta', type: 'button', onclick: () => setTab('bills') }, 'Go to Bills')));
    return;
  }
  const labels = bc.live.map(r => r.month);
  w.append(x.h('div', { class: 'lg-kpis' },
    tile('Electricity bought', `${n0(bc.total.kwh)} kWh`, `${bc.months} month${bc.months === 1 ? '' : 's'} of bills`),
    tile('Total billed', crore(bc.total.bill), bc.blended ? `₹${nd(bc.blended, 2)} per kWh` : null),
    tile('Highest demand', bc.maxMD === null ? '—' : `${n0(bc.maxMD)} kVA`, bc.cd ? `Contract ${n0(bc.cd)} kVA` : 'Contract not set'),
    tile('Average power factor', bc.avg.pf === null ? '—' : nd(bc.avg.pf, 3), bc.loadFactor ? `Load factor ${pct(bc.loadFactor)}` : null),
    tile('Rebates and discounts', crore(bc.rebates.total), `PF ${crore(bc.rebates.pf)} · TOU ${crore(bc.rebates.tou)} · EHV ${crore(bc.rebates.ehv)}`),
    tile('Scope 1 + 2', `${n0(gc.total12)} tCO₂e`, `Scope 1 ${n0(gc.s1)} · Scope 2 ${n0(gc.s2)}`),
    tile('Total energy', blc.total.totalToe === null ? '—' : `${nd(blc.total.totalToe, 1)} TOE`, blc.hasProd ? `${nd(blc.total.secKwh, 3)} kWh/${blc.basisLabel}` : 'Production not entered')));
  if (f.length) w.append(card('What the figures say', null, x.h('div', { class: 'lg-finds' }, f.map(i =>
    x.h('div', { class: 'lg-find' }, x.h('span', { class: `pill ${i.tone === 'good' ? 'ok' : i.tone}` }, i.tag), x.h('span', {}, i.text))))));
  const charts = x.h('div', { class: 'lg-charts' });
  if (bc.months) {
    charts.append(chart({ title: 'Units consumed', unit: 'kWh', labels, series: [{ name: 'Units', values: bc.live.map(r => r.kwh) }], fmt: n0 }));
    charts.append(chart({ title: 'Cost per unit', unit: '₹/kWh', labels, kind: 'line', series: [{ name: 'Rate', values: bc.live.map(r => r.rate) }] }));
    charts.append(chart({ title: 'Maximum demand', unit: 'kVA', labels, series: [{ name: 'Actual MD', values: bc.live.map(r => r.md) }], fmt: n0, refLine: bc.cd ? { value: bc.cd, label: `Contract ${n0(bc.cd)} kVA` } : null }));
    charts.append(chart({ title: 'What the bill is made of', unit: '₹', labels, fmt: n0, series: [
      { name: 'Energy', values: bc.live.map(r => r.energy) }, { name: 'Fuel surcharge', values: bc.live.map(r => r.fuel) },
      { name: 'Demand', values: bc.live.map(r => r.demand) }, { name: 'Duty', values: bc.live.map(r => r.duty) },
      { name: 'TOU', values: bc.live.map(r => r.touCharge) }] }));
  }
  if (blc.months) {
    const ml = gc.months.map(m => m.label);
    charts.append(chart({ title: 'Monthly emissions', unit: 'tCO₂e', labels: ml, fmt: v => nd(v, 1), series: [{ name: 'Scope 1', values: gc.months.map(m => m.s1) }, { name: 'Scope 2', values: gc.months.map(m => m.s2) }] }));
    if (blc.hasProd) charts.append(chart({ title: 'Specific electricity', unit: `kWh/${blc.basisLabel}`, labels: blc.rows.map(r => r.label), kind: 'line', series: [{ name: 'SEC', values: blc.rows.map(r => r.secKwh) }], fmt: v => nd(v, 3) }));
  }
  w.append(charts);
  w.append(x.h('p', { class: 'small muted lg-src' }, `Grid factor ${nd(gc.gridEF, 3)} kgCO₂/kWh: ${K.ceaLabel(L.ghg)}. Fuel factors: ${L.ghg.defra?.short || '—'}.`));
}

// ---------- bills ----------
const BILL_COLS = [
  ['kwh', 'Units kWh', 'wide'], ['net', 'Bill ₹', 'wide'], ['pf', 'PF'], ['actualMD', 'Actual MD kVA'], ['energyRate', 'Energy ₹/kWh'],
  ['fppaRate', 'FPPA ₹/kWh'], ['todNight', 'Night units', 'wide'], ['todPeak', 'TOU units', 'wide'], ['touDiscUnits', 'TOU disc. units', 'wide'], ['touDiscount', 'TOU disc. ₹', 'wide'],
];
const needsReview = r => r.src && Object.keys(r.src).length;

function drawBills(w) {
  const cfg = L.bills.cfg, K_ = KIND.bills;
  const file = x.h('input', { type: 'file', accept: 'application/pdf,image/jpeg,image/png,image/webp', multiple: true, hidden: true });
  const xl = x.h('input', { type: 'file', accept: '.xlsx,.xls', hidden: true });
  const stat = x.h('span', { class: 'small muted', role: 'status' });
  const picked = (input, go) => input.addEventListener('change', async () => {
    const files = [...input.files];
    input.value = ''; // so that choosing the same file again works
    if (files.length) await go(files);
  });
  const excelBtn = x.h('button', { class: 'btn ghost', type: 'button', disabled: ro(), onclick: () => xl.click() }, 'Bring in Excel');
  picked(file, files => ingestBills(files, stat));
  picked(xl, files => importExcel(files[0], excelBtn, stat));
  w.append(card('Add bills', 'Upload PDFs or photographs. Text PDFs are read directly and pictures by OCR, here on the Console. Check each one against the bill, then mark it verified.',
    x.h('div', { class: 'row', style: 'gap:8px' },
      x.h('button', { class: 'btn cta', type: 'button', disabled: ro(), onclick: () => file.click() }, 'Upload bills'),
      excelBtn,
      x.h('button', { class: 'btn ghost', type: 'button', disabled: ro(), onclick: () => { addMonth(); drawCompany(); } }, 'Add a month'),
      x.h('button', { class: 'btn ghost', type: 'button', onclick: exportExcel }, 'Download Excel'), stat), file, xl));

  w.append(card('Connection and tariff', 'One set for this connection. The defaults are DGVCL HTP-1; change anything that differs on this plant’s bill.',
    x.h('div', { class: 'lg-form' },
      x.field('Source of power', tin(cfg, 'discom', K_, { placeholder: 'DGVCL' })), x.field('Consumer no.', tin(cfg, 'consumerNo', K_)), x.field('Tariff', tin(cfg, 'tariff', K_)),
      x.field('Contract demand kVA', nin(cfg, 'contractDemand', K_)), x.field('Minimum billing, share of contract', nin(cfg, 'minBillingPct', K_)),
      x.field('First slab kVA', nin(cfg, 'slabKva', K_)), x.field('First slab ₹/kVA', nin(cfg, 'slab1Rate', K_)), x.field('Next slab ₹/kVA', nin(cfg, 'slab2Rate', K_)),
      x.field('Above contract ₹/kVA', nin(cfg, 'excessRate', K_)), x.field('TOU ₹/kWh', nin(cfg, 'touRate', K_)), x.field('TOU discount rate per kVA', nin(cfg, 'touDiscRate', K_), 'Used when the bill gives TOU discount units but not the ₹'), x.field('Night rebate ₹/kWh', nin(cfg, 'nightRebateRate', K_)),
      x.field('EHV rebate, share of energy', nin(cfg, 'ehvPct', K_)), x.field('Electricity duty, share', nin(cfg, 'dutyRate', K_)))));

  const rows = L.bills.rows;
  w.append(card(`Monthly bills (${rows.length})`, 'Worked out is the bill from these figures and the tariff. Difference near zero means the reading and the tariff agree.',
    rows.length ? scroll(x.h('table', { class: 'lg-t lg-edit' },
      x.h('thead', {}, x.h('tr', {}, x.h('th', {}, 'Month'), BILL_COLS.map(c => x.h('th', {}, c[1])), x.h('th', { class: 'n' }, '₹/kWh'), x.h('th', { class: 'n' }, 'Worked out ₹'), x.h('th', { class: 'n' }, 'Difference ₹'), x.h('th', {}, 'Bill'))),
      x.h('tbody', {}, rows.map(r => billRow(r))),
      x.h('tfoot', {}, x.h('tr', {}, x.h('td', {}, 'Total'), BILL_COLS.map(c => x.h('td', { class: 'n' }, c[0] === 'kwh' ? live(C => n0(C.bc.total.kwh)) : c[0] === 'net' ? live(C => n0(C.bc.total.bill)) : '')),
        x.h('td', { class: 'n' }, live(C => nd(C.bc.blended, 2))), x.h('td', { class: 'n' }, live(C => n0(C.bc.total.totalBill))), x.h('td'), x.h('td'))))) : x.h('p', { class: 'empty' }, 'No bills yet.')));
}
function billRow(r) {
  r.id ||= uid();
  const find = C => C.bc.rows.find(q => q.id === r.id);
  const diffEl = live(C => { const q = find(C); return q ? nd(q.diff, 0) : '—'; });
  const td = (k, wide) => x.h('td', {}, nin(r, k, KIND.bills, { 'aria-label': `${k} ${r.month || ''}`, class: `nin${wide ? ' wide' : ''}${r.src?.[k] ? ' read' : ''}`, title: r.src?.[k] ? `Read by ${r.src[k]}` : null }));
  return x.h('tr', {},
    x.h('td', {}, monthPicker(r)),
    BILL_COLS.map(c => td(c[0], c[2])),
    x.h('td', { class: 'n' }, live(C => { const q = find(C); return q ? nd(q.rate, 2) : '—'; })),
    x.h('td', { class: 'n' }, live(C => { const q = find(C); return q ? n0(q.totalBill) : '—'; })),
    x.h('td', { class: 'n' }, diffEl),
    x.h('td', { class: 'lg-acts' },
      x.h('button', { class: `pill ${r.verified ? 'ok' : needsReview(r) ? 'warn' : 'soft'} lg-pillbtn`, type: 'button', onclick: () => reviewBill(r) }, r.verified ? 'Verified' : 'Review'),
      x.h('button', { class: 'lg-x', type: 'button', disabled: ro(), 'aria-label': `Remove ${r.month || 'this month'}`, onclick: () => { if (confirm(`Remove ${r.month || 'this month'}?`)) { L.bills.rows.splice(L.bills.rows.indexOf(r), 1); touch(KIND.bills); drawCompany(); } } }, '×')));
}
function monthPicker(r) {
  const p = parseMonth(r.month) || {};
  const m = x.h('select', { disabled: ro(), 'aria-label': 'Month' }, K.MONTHS.map((t, i) => x.h('option', { value: i + 1 }, t)));
  const now = new Date().getFullYear();
  const y = x.h('select', { disabled: ro(), 'aria-label': 'Year' }, Array.from({ length: 9 }, (_, i) => now + 1 - i).map(v => x.h('option', { value: v }, v)));
  if (p.m) m.value = p.m; if (p.y) y.value = p.y;
  const fire = () => { r.month = monthLabel(+y.value, +m.value); touch(KIND.bills); };
  if (!p.m) fire();
  m.addEventListener('change', fire); y.addEventListener('change', fire);
  return x.h('div', { class: 'lg-month' }, m, y);
}
function addMonth(month, quiet = false) {
  const rows = L.bills.rows;
  let label = month;
  if (!label) {
    const last = rows.map(r => parseMonth(r.month)).filter(Boolean).sort((a, b) => a.y - b.y || a.m - b.m).pop();
    label = last ? monthLabel(last.m === 12 ? last.y + 1 : last.y, (last.m % 12) + 1) : monthLabel(new Date().getFullYear(), new Date().getMonth() + 1);
  }
  const r = { id: uid(), month: label };
  rows.push(r); sortBills();
  if (!quiet) touch(KIND.bills);
  return r;
}
function sortBills() {
  L.bills.rows.sort((a, b) => { const p = parseMonth(a.month) || { y: 9999, m: 0 }, q = parseMonth(b.month) || { y: 9999, m: 0 }; return p.y - q.y || p.m - q.m; });
}

async function ingestBills(files, stat) {
  const { readBills } = await import('./ledger-ocr.js');
  try {
    const bills = await readBills(files, t => { stat.textContent = t; });
    let added = 0, unread = 0, unsaved = 0;
    for (const b of bills) {
      const parsed = parseMonth(b.fields.month);
      const month = parsed ? monthLabel(parsed.y, parsed.m) : null;
      let row = month && L.bills.rows.find(r => r.month === month);
      if (!row) row = addMonth(month || undefined, true);
      for (const [k, v] of Object.entries(b.fields)) {
        if (k === 'month') continue;
        if (k === 'contract') { if (L.bills.cfg.contractDemand === null) L.bills.cfg.contractDemand = num(v); continue; }
        if (num(row[k]) === null) { row[k] = v; (row.src ||= {})[k] = b.sources[k]; }
      }
      row.verified = false;
      if (Object.keys(b.fields).length < 3) unread++;
      stat.textContent = `Saving the picture of ${row.month}…`;
      row.scan = await saveScan(b.img.dataUrl, row.month, b.name).catch(() => { unsaved++; return row.scan || null; });
      added++;
    }
    touch(KIND.bills);
    drawCompany();
    x.toast(`${added} bill${added === 1 ? '' : 's'} read${unread ? `; ${unread} with few figures found` : ''}. Check each against the bill.${unsaved ? ` ${unsaved} picture${unsaved === 1 ? '' : 's'} could not be saved.` : ''}`);
  } catch (ex) { stat.textContent = ''; x.toast(ex.message); }
}
async function saveScan(dataUrl, month, name) {
  // Decoded here: this page's security policy does not let fetch() read a data: address.
  const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), c => c.charCodeAt(0)).buffer;
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  const id = crypto.randomUUID();
  const r = await x.api('POST', '/api/files', { id, audit_id: L.id, app: 'ledger', kind: 'scan', equipment_tag: month, caption: `Electricity bill ${month}`,
    mime: 'image/jpeg', size: bytes.byteLength, sha256: sha, name: `bill-${month}.jpg`, taken_at: Date.now() });
  if (r.file.status === 'ready') return r.file.id;
  const up = await fetch(`/api/files/${id}/content?offset=0`, { method: 'PUT', credentials: 'same-origin', headers: { 'X-ARES': '1', 'Content-Type': 'application/octet-stream' }, body: bytes });
  if (!up.ok) throw new Error('The picture of the bill did not upload.');
  return id;
}

const REVIEW_FIELDS = [
  ['kwh', 'Units consumed, kWh'], ['net', 'Bill amount, ₹'], ['pf', 'Power factor'], ['actualMD', 'Actual maximum demand, kVA'], ['energyRate', 'Energy rate, ₹/kWh'],
  ['fppaRate', 'FPPA rate, ₹/kWh'], ['todNight', 'Night units'], ['todPeak', 'TOU units'], ['touDiscUnits', 'TOU discount units'], ['touDiscount', 'TOU discount, ₹'],
  ['billingDemand', 'Billing demand as billed, kVA'], ['energyCharge', 'Energy charge as billed, ₹'], ['demandCharge', 'Demand charge as billed, ₹'], ['fuelSurcharge', 'Fuel surcharge as billed, ₹'], ['duty', 'Duty as billed, ₹'], ['kvah', 'kVAh'],
];
function reviewBill(r) {
  const liveBefore = L.live; L.live = [];
  const inputs = REVIEW_FIELDS.map(([k, t]) => x.field(t, nin(r, k, KIND.bills, { class: `nin${r.src?.[k] ? ' read' : ''}` }), r.src?.[k] ? `Read by ${r.src[k] === 'ai' ? 'AI' : r.src[k] === 'derived' ? 'working it out' : r.src[k] === 'pdf' ? 'the PDF text' : 'OCR'}` : null));
  const stat = x.h('span', { class: 'small muted', role: 'status' });
  const aiBlock = L.ai.bill_reading && r.scan ? (() => {
    const box = x.h('input', { type: 'checkbox' }); box.checked = L.consent;
    const go = x.h('button', { class: 'btn ghost sm', type: 'button', disabled: !L.consent, onclick: async () => {
      go.disabled = true; stat.textContent = 'Asking the AI reader…';
      try {
        const buf = await (await fetch(`/api/files/${r.scan}`)).arrayBuffer();
        let bin = ''; new Uint8Array(buf).forEach(b => { bin += String.fromCharCode(b); });
        const res = await x.api('POST', '/api/ai/bill-read', { audit_id: L.id, mime: 'image/jpeg', data: btoa(bin) });
        let n = 0;
        for (const [k, v] of Object.entries(res.fields)) if (k !== 'month' && num(r[k]) === null) { r[k] = v; (r.src ||= {})[k] = 'ai'; n++; }
        touch(KIND.bills); dlg.close(); x.toast(`The AI reader filled ${n} empty field${n === 1 ? '' : 's'}. Check them against the bill.`); reviewBill(r);
      } catch (ex) { stat.textContent = ex.message; go.disabled = false; }
    } }, 'Read with AI');
    box.addEventListener('change', () => { L.consent = box.checked; go.disabled = !box.checked; });
    return x.h('div', { class: 'lg-ai' }, x.h('label', { class: 'small lg-check' }, box, ' The client agreed that this bill may be read by an AI service (Anthropic Claude), outside India.'), go);
  })() : null;
  const dlg = x.h('dialog', { class: 'pick lg-dlg wide' }, x.h('div', { class: 'body' },
    x.h('h2', {}, `Bill for ${r.month}`),
    x.h('div', { class: 'lg-review' },
      r.scan ? x.h('a', { class: 'lg-scan', href: `/api/files/${r.scan}`, target: '_blank', rel: 'noopener' }, x.h('img', { src: `/api/files/${r.scan}`, alt: `Scanned electricity bill for ${r.month}` })) : x.h('p', { class: 'empty' }, 'No picture of this bill.'),
      x.h('div', {}, x.h('div', { class: 'lg-form two' }, inputs), aiBlock, stat)),
    x.h('div', { class: 'foot' }, x.h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, 'Close'),
      x.h('button', { class: 'btn cta', type: 'button', disabled: ro(), onclick: () => { r.verified = !r.verified; touch(KIND.bills); dlg.close(); } }, r.verified ? 'Mark not verified' : 'Mark verified'))));
  dlg.addEventListener('close', () => { dlg.remove(); L.live = liveBefore; refresh(); if (L.tab === 'bills') drawCompany(); });
  document.body.append(dlg);
  dlg.showModal();
}

// ---------- the team's bill table, column for column ----------
// The same 33 columns, the same two heading rows and the same Total and Average rows as the team's
// "bills analysis" workbook. The report page and the Excel download are both drawn from this list.
// total: 'sum' adds the column, otherwise it shows ***. The Average row is the mean of each column.
const P2 = v => (v === null || v === undefined ? '—' : `${nd(v * 100, 2)} %`);
const BILL_SHEET = c => {
  const col = (group, head, get, kind, total) => ({ group, head, get, kind, total });
  return [
    col(null, 'Month', r => r.month, 'text'), col(null, 'Total Unit Consumed', r => r.kwh, 'n0', 'sum'), col(null, 'Total Bill Amount', r => r.bill, 'n2', 'sum'),
    col(null, 'Rate Rs./ Unit', r => r.rate, 'n2'), col(null, 'Power Factor', r => r.pf, 'n3'), col(null, 'Actual M.D.', r => r.md, 'n0'),
    col(null, 'Billing Demand', r => r.billingDemand, 'n0'), col(null, 'Demand Charge', r => r.demand, 'n0', 'sum'),
    col('Energy Charges', 'Rs./kWh', r => r.eRate, 'n2'), col('Energy Charges', 'Energy Charge', r => r.energy, 'n0', 'sum'),
    col('FPPA Charges', 'Rs./kWh', r => r.fRate, 'n2'), col('FPPA Charges', 'Fuel Sur charge', r => r.fuel, 'n0', 'sum'),
    col('PF Rebate', '% of Energy Charge', r => r.pct, 'pct'), col('PF Rebate', 'PF Adj/Rebate', r => r.pfAdj, 'n0', 'sum'),
    col('Night Hour', 'Night Unit', r => r.night, 'n0', 'sum'), col('Night Hour', '% Night Unit', r => r.nightPct, 'pct'),
    col('Night Hour', 'Rate', () => num(c.nightRebateRate) || 0, 'n2'), col('Night Hour', 'Night Rebate', r => r.nightRebate, 'n0', 'sum'),
    col('EHV Rebate', 'EHV Energy Charges', r => r.energy, 'n0', 'sum'), col('EHV Rebate', '% EHV Rebate', () => num(c.ehvPct) || 0, 'pct'), col('EHV Rebate', 'EHV Charges', r => r.ehv, 'n0', 'sum'),
    col('TOU Hour', 'TOU Unit', r => r.tou, 'n0', 'sum'), col('TOU Hour', '% TOU Units', r => r.touPct, 'pct'), col('TOU Hour', 'Rate', () => num(c.touRate) || 0, 'n2'),
    col('TOU Hour', 'TOU Charges', r => r.touCharge, 'n0', 'sum'), col('TOU Hour', 'TOU DISC Unit', r => r.discUnits, 'n0', 'sum'), col('TOU Hour', 'Rate Per KVA', () => num(c.touDiscRate) || 0, 'n2'), col('TOU Hour', 'TOU Disc', r => r.touDiscount, 'n0', 'sum'),
    col('Elec Duty', 'Total Consumption charge', r => r.totalCons, 'n0', 'sum'), col('Elec Duty', 'Rate', () => num(c.dutyRate) || 0, 'pct'), col('Elec Duty', 'ED Charge', r => r.duty, 'n0', 'sum'),
    col(null, 'Total Bill', r => r.totalBill, 'n2', 'sum'), col(null, 'Difference', r => r.diff, 'n2'),
  ];
};
/** Heading groups: [{ title, from, span }] for the columns that sit under one heading. */
const sheetGroups = cols => {
  const out = [];
  cols.forEach((k, i) => { const last = out[out.length - 1]; if (k.group && last?.title === k.group) last.span++; else if (k.group) out.push({ title: k.group, from: i, span: 1 }); });
  return out;
};
function sheetFooters(cols, live) {
  const values = k => live.map(k.get).filter(v => v !== null && v !== undefined);
  const totalRow = cols.map(k => (k.kind === 'text' ? 'Total' : k.total === 'sum' ? (values(k).length ? values(k).reduce((a, b) => a + b, 0) : null) : '***'));
  const avgRow = cols.map(k => { if (k.kind === 'text') return 'Average'; const v = values(k); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; });
  return [totalRow, avgRow];
}
const sheetCell = (k, v) => (v === '***' || typeof v === 'string' ? v : k.kind === 'n0' ? n0(v) : k.kind === 'n2' ? nd(v, 2) : k.kind === 'n3' ? nd(v, 3) : k.kind === 'pct' ? P2(v) : (v ?? '—'));

function billSheetTable(bc, name) {
  const c = bc.cfg, cols = BILL_SHEET(c), groups = sheetGroups(cols), [tot, avg] = sheetFooters(cols, bc.live);
  const head1 = [];
  cols.forEach((k, i) => {
    if (!k.group) head1.push(x.h('th', { rowspan: 2, class: i ? 'n' : '' }, k.head));
    else { const g = groups.find(q => q.from === i); if (g) head1.push(x.h('th', { colspan: g.span, class: 'grp' }, g.title)); }
  });
  const info = x.h('table', { class: 'lg-bill-info' }, x.h('tbody', {},
    x.h('tr', {}, x.h('td', { colspan: 8, class: 'ttl' }, `ELECTRICITY CONSUMPTION AND BILLS [${name.toUpperCase()}]`)),
    x.h('tr', {}, x.h('td', {}, 'Source of Power:'), x.h('td', {}, x.h('b', {}, c.discom || '—')), x.h('td', {}, 'Consumer No:'), x.h('td', {}, x.h('b', {}, c.consumerNo || '—')),
      x.h('td', {}, 'Contract Demand'), x.h('td', {}, x.h('b', {}, `${n0(bc.cd)} kVA`)),
      x.h('td', {}, `${n0((num(c.minBillingPct) ?? 0.85) * 100)}% of contract demand`), x.h('td', {}, x.h('b', {}, `${nd(bc.minBD, 1)} kVA`), `  ${c.tariff || ''}`))));
  return x.h('section', { class: 'lg-billpage' }, info, scroll(x.h('table', { class: 'lg-t lg-bill' },
    x.h('thead', {}, x.h('tr', {}, head1), x.h('tr', {}, cols.filter(k => k.group).map(k => x.h('th', { class: 'n' }, k.head)))),
    x.h('tbody', {}, bc.live.map(r => x.h('tr', {}, cols.map((k, i) => x.h('td', { class: i ? 'n' : '' }, sheetCell(k, k.get(r))))))),
    x.h('tfoot', {}, [tot, avg].map(row => x.h('tr', {}, row.map((v, i) => x.h('td', { class: i ? 'n' : '' }, sheetCell(cols[i], v)))))))));
}

// ---------- Excel, in the team's format ----------
function xlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((res, rej) => { const s = x.h('script', { src: '/vendor/xlsx.full.min.js' }); s.onload = () => res(window.XLSX); s.onerror = () => rej(new Error('The Excel reader could not be loaded.')); document.head.append(s); });
}
/** The rows of each sheet, read in a worker so that no file can freeze the page. */
function readWorkbook(file) {
  return file.arrayBuffer().then(buf => new Promise((resolve, reject) => {
    const w = new Worker('/ledger-xlsx-worker.js');
    const stop = setTimeout(() => { w.terminate(); reject(new Error('This Excel file is taking too long to read. Copy the bills sheet into a new file and try again.')); }, 60000);
    const done = fn => v => { clearTimeout(stop); w.terminate(); fn(v); };
    w.onmessage = done(e => (e.data.error ? reject(new Error('This Excel file could not be read.')) : resolve(e.data.sheets)));
    w.onerror = done(() => reject(new Error('The Excel reader could not start. Reload the page and try again.')));
    w.postMessage(buf, [buf]);
  }));
}
/** A month from a cell: an Excel date (a day count from 30 Dec 1899) or text like Apr-25. */
const excelMonth = v => {
  if (typeof v === 'number' && v > 20000) { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 }; }
  return parseMonth(v);
};
async function importExcel(f, btn, stat) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Reading…'; stat.textContent = `Reading ${f.name}…`;
  try {
    const sheets = await readWorkbook(f);
    const sheet = sheets.find(q => q.rows.some(r => String(r[0] ?? '').trim() === 'Month'));
    if (!sheet) throw new Error('This is not the bills format: no sheet has a "Month" heading in its first column.');
    const rows = sheet.rows, monthOf = excelMonth;
    const headAt = rows.findIndex(r => String(r[0] ?? '').trim() === 'Month');
    if (headAt < 1) throw new Error('This is not the bills format: the "Month" heading needs its details row above it.');
    const top = rows[headAt], sub = rows[headAt + 1] || [];
    const findCol = (row, re) => row.findIndex(c => re.test(String(c ?? '')));
    const col = {
      kwh: findCol(top, /Total Unit/i), net: findCol(top, /Total Bill Amount/i), pf: findCol(top, /Power Factor/i), actualMD: findCol(top, /Actual M/i),
      energyRate: findCol(sub, /Rs\.\/\s*kWh/i), fppaRate: sub.findIndex((c, i) => /Rs\.\/\s*kWh/i.test(String(c ?? '')) && i > findCol(sub, /Rs\.\/\s*kWh/i)),
      todNight: findCol(sub, /Night Unit/i), todPeak: findCol(sub, /^TOU Unit/i), touDiscUnits: findCol(sub, /TOU DISC Unit/i), touDiscount: findCol(sub, /^TOU Disc$/i),
    };
    if (col.kwh < 0 || col.net < 0) throw new Error('This is not the bills format: the units or bill amount column is missing.');
    const info = rows[headAt - 1] || [];
    const after = re => { const i = findCol(info, re); return i < 0 ? null : info.slice(i + 1).find(c => c !== null && c !== '') ?? null; };
    const c = L.bills.cfg;
    c.discom = after(/Source of Power/i) ?? c.discom; c.consumerNo = String(after(/Consumer No/i) ?? c.consumerNo);
    c.contractDemand = num(after(/Contract Demand/i)) ?? c.contractDemand;
    const tariff = info.find(v => /^HT/i.test(String(v ?? ''))); if (tariff) c.tariff = String(tariff);
    const data = rows.slice(headAt + 2).filter(r => monthOf(r[0]));
    const first = data[0] || [];
    const rateOf = re => { const i = findCol(sub, re); return i < 0 ? null : num(first[i]); };
    const set = (k, v) => { if (v !== null) c[k] = v; };
    set('touRate', rateOf(/^Rate$/i) === null ? null : num(first[sub.findIndex((t, i) => /^Rate$/i.test(String(t ?? '')) && i > findCol(sub, /TOU Unit/i))]));
    set('ehvPct', rateOf(/% EHV/i));
    set('touDiscRate', rateOf(/Rate Per KVA/i));
    set('nightRebateRate', num(first[sub.findIndex((t, i) => /^Rate$/i.test(String(t ?? '')) && i > findCol(sub, /Night Unit/i))]));
    set('dutyRate', num(first[sub.findIndex((t, i) => /^Rate$/i.test(String(t ?? '')) && i > findCol(sub, /Total Consumption/i))]));
    let n = 0;
    for (const r of data) {
      const p = monthOf(r[0]), month = monthLabel(p.y, p.m);
      const row = L.bills.rows.find(q => q.month === month) || addMonth(month, true);
      for (const [k, i] of Object.entries(col)) if (i >= 0 && num(r[i]) !== null) { row[k] = num(r[i]); }
      row.from = 'excel';
      n++;
    }
    if (!n) throw new Error('No months were found under the "Month" heading.');
    touch(KIND.bills); drawCompany();
    x.toast(`${n} month${n === 1 ? '' : 's'} brought in from Excel`);
  } catch (ex) {
    btn.disabled = false; btn.textContent = label; stat.textContent = '';
    x.toast(ex.message);
  }
}
async function exportExcel() {
  const XL = await xlsx();
  const { bc, blc, gc } = calc();
  const c = bc.cfg, name = L.company.client_name || L.id;
  const cols = BILL_SHEET(c), groups = sheetGroups(cols), [tot, avg] = sheetFooters(cols, bc.live);
  const line2 = Array(33).fill(null);
  line2[0] = 'Source of Power  :   '; line2[4] = c.discom; line2[6] = 'Consumer No:'; line2[8] = c.consumerNo; line2[12] = 'Contract Demand'; line2[15] = bc.cd; line2[16] = 'kVA';
  line2[18] = 'EHV Rebate'; line2[21] = `${n0((num(c.minBillingPct) ?? 0.85) * 100)}% of contract demand`; line2[27] = bc.minBD; line2[28] = 'kVA'; line2[29] = c.tariff;
  const head3 = cols.map((k, i) => { const g = groups.find(q => q.from === i); return k.group ? (g ? g.title : null) : k.head; });
  const head4 = cols.map(k => (k.group ? k.head : null));
  const bills = [[`ELECTRICITY CONSUMPTION AND BILLS  [${name}]`], line2, head3, head4, ...bc.live.map(r => cols.map(k => k.get(r))), tot, avg];
  const billSheet = XL.utils.aoa_to_sheet(bills);
  const span = (r, s, cn) => ({ s: { r, c: s }, e: { r, c: s + cn - 1 } });
  billSheet['!merges'] = [span(0, 0, 30), span(1, 0, 4), span(1, 4, 2), span(1, 6, 2), span(1, 8, 4), span(1, 12, 3), span(1, 16, 2), span(1, 18, 3), span(1, 21, 6),
    ...cols.flatMap((k, i) => (k.group ? [] : [{ s: { r: 2, c: i }, e: { r: 3, c: i } }])), ...groups.map(g => span(2, g.from, g.span))];
  const base = [[`ENERGY BASELINE [${name}]`], ['Month', `Production (${blc.unit})`, 'Grid kWh', ...blc.total.sources.map(s => `${s.name} kWh`), 'Total kWh', 'Electrical TOE', ...blc.total.fuels.flatMap(f => [`${f.name} (${f.unit})`, 'TOE']), 'Thermal TOE', 'Total TOE', `kWh/${blc.basisLabel}`, 'Water kL'],
    ...blc.rows.map(r => [r.label, r.prod, r.grid, ...r.sources.map(s => s.kwh), r.elecKwh, r.elecToe, ...r.fuels.flatMap(f => [f.qty, f.toe]), r.thermalToe, r.totalToe, r.secKwh, r.water])];
  const ghg = [[`GHG EMISSIONS [${name}]`], ['Grid factor kgCO2/kWh', gc.gridEF], ['Grid factor source', K.ceaLabel(L.ghg)], ['Fuel factor source', L.ghg.defra?.source || ''], [],
    ['Scope', 'Source', 'Quantity', 'Unit', 'Factor kgCO2e', 'tCO2e'],
    ...gc.fuels.map(f => ['Scope 1', f.name, f.qty, f.unit, f.ef, f.t]), ...gc.lines.map(l => [l.type === 'scope3' ? 'Scope 3' : 'Scope 1', l.name, num(l.qty), l.unit, num(l.ef), l.t]),
    ['Scope 2', 'Purchased electricity', gc.gridKwh, 'kWh', gc.gridEF, gc.gross2], ['Total Scope 1 + 2', '', '', '', '', gc.total12]];
  const wb = XL.utils.book_new();
  XL.utils.book_append_sheet(wb, billSheet, 'Bills');
  XL.utils.book_append_sheet(wb, XL.utils.aoa_to_sheet(base), 'Baseline');
  XL.utils.book_append_sheet(wb, XL.utils.aoa_to_sheet(ghg), 'GHG');
  XL.writeFile(wb, `Energy Ledger ${name.replace(/[^\w ]+/g, '')}.xlsx`);
}

// ---------- baseline ----------
const GCV_HINT = [[/coal|lignite/i, 4000], [/briquette/i, 3800], [/husk/i, 3200], [/diesel/i, 10750], [/gas oil|ldo/i, 10500], [/fuel oil|residual/i, 9800], [/natural gas|cng|png/i, 8600], [/lpg/i, 11000]];
const UNIT_MAP = { tonnes: 'Ton', litres: 'Litre', 'cubic metres': 'SCM', kg: 'kg' };

function fuelChoices() {
  const seen = new Map();
  for (const i of L.factors.items) {
    if (!['Fuels', 'Bioenergy'].includes(i.g) || !UNIT_MAP[i.u]) continue;
    const key = `${i.n}|${i.u}`;
    if (!seen.has(key)) seen.set(key, i);
  }
  const groups = {};
  for (const [key, i] of seen) (groups[i.a] ||= []).push({ v: key, t: `${i.n}, per ${i.u.replace('tonnes', 'tonne').replace('litres', 'litre').replace('cubic metres', 'm³')} (${nd(i.v, i.v < 10 ? 3 : 1)} kg)` });
  return [{ v: '', t: 'Choose from DEFRA…' }, ...Object.entries(groups).map(([label, items]) => ({ label, items })), { v: 'custom', t: 'My own factor' }];
}
function pickFuel(f, key) {
  f.pick = key;
  if (key === 'custom' || !key) { f.source = key ? f.source || '' : ''; if (!key) f.ef = null; return; }
  const [name, unit] = key.split('|');
  const i = L.factors.items.find(q => ['Fuels', 'Bioenergy'].includes(q.g) && q.n === name && q.u === unit);
  f.ef = i.v; f.unit = UNIT_MAP[unit]; f.basis = 'mass';
  f.source = L.factors.short; f.factorName = name;
  if (!f.name || f.autoName) { f.name = name.replace(/\s*\(.*\)$/, ''); f.autoName = true; }
  if (num(f.gcv) === null) f.gcv = (GCV_HINT.find(([re]) => re.test(name)) || [])[1] ?? L.factors.gcv_kcal_per_kg[name] ?? null;
}
/** Solid fuels: DEFRA's factor per tonne is for UK coal. Per unit of heat it travels better. */
function energyBasisEf(f) {
  if (f.unit !== 'Ton' || !f.factorName || num(f.gcv) === null) return null;
  const i = L.factors.items.find(q => q.g === 'Fuels' && q.n === f.factorName && q.u === 'kWh (Gross CV)');
  return i ? +((i.v * num(f.gcv) * 1000) / K.KCAL_PER_KWH).toFixed(1) : null;
}

function drawBaseline(w) {
  const b = L.baseline, k = KIND.baseline;
  const fyOpts = K.fyMonths(dominantFy() || '2026-27');
  w.append(card('Months and production', 'Grid units come from the bills by themselves. Type over one if the plant’s own record differs.',
    x.h('div', { class: 'lg-form' },
      x.field('Production counted in', tin(b, 'prodUnit', k, { placeholder: 'Metre, kg, piece' })),
      x.field('Specific consumption', sel(b, 'secBasis', k, K.SEC_BASIS, () => drawCompany())),
      x.field('Water source', tin(b, 'waterSource', k))),
    x.h('div', { class: 'row', style: 'gap:8px;margin-top:12px' },
      x.h('button', { class: 'btn ghost sm', type: 'button', disabled: ro(), onclick: () => { for (const p of fyOpts) if (!b.months.some(q => q.y === p.y && q.m === p.m)) b.months.push(p); b.months.sort((a, c) => a.y - c.y || a.m - c.m); touch(k); drawCompany(); } }, `Add all of FY ${dominantFy() || ''}`),
      x.h('button', { class: 'btn ghost sm', type: 'button', disabled: ro(), onclick: () => { b.fuels.push({ id: uid(), name: '', unit: 'Ton', gcv: null, ef: null, values: {}, autoName: true }); touch(k); drawCompany(); } }, 'Add a fuel'),
      x.h('button', { class: 'btn ghost sm', type: 'button', disabled: ro(), onclick: () => { b.elecSources.push({ id: uid(), name: 'Solar generation', values: {} }); touch(k); drawCompany(); } }, 'Add solar or other source'))));

  if (b.fuels.length) w.append(card('Fuels', 'Pick the fuel and the factor comes from the DEFRA 2026 set. GCV starts at a typical Indian value: use the plant’s own.',
    x.h('div', { class: 'lg-fuels' }, b.fuels.map(f => {
      const hint = x.h('p', { class: 'small lg-hint' });
      const paint = () => {
        const e = energyBasisEf(f);
        hint.replaceChildren();
        if (e && num(f.ef) && Math.abs(e - f.ef) / f.ef > 0.15) {
          hint.append(`${L.factors.short} per tonne assumes UK fuel. At ${n0(num(f.gcv))} kcal/kg the same fuel per unit of heat is ${n0(e)} kg/tonne. `,
            x.h('button', { class: 'lg-link', type: 'button', disabled: ro(), onclick: () => { f.ef = e; f.basis = 'energy'; f.source = `${L.factors.short}, kWh gross CV basis at plant GCV`; touch(k); drawCompany(); } }, 'Use this'));
        }
      };
      paint();
      return x.h('div', { class: 'lg-fuel' },
        x.h('div', { class: 'lg-form two' },
          x.field('Fuel and factor', sel(f, 'pick', k, fuelChoices(), v => { pickFuel(f, v); drawCompany(); })),
          x.field('Name in the report', tin(f, 'name', k, { oninput: () => { f.autoName = false; } })),
          x.field('Counted in', sel(f, 'unit', k, K.FUEL_UNITS.map(u => ({ v: u.v, t: u.v })), () => drawCompany())),
          x.field(`GCV kcal/${K.fuelUnit(f.unit).per}`, nin(f, 'gcv', k, { onset: paint })),
          x.field(`Factor kgCO₂e/${f.unit}`, nin(f, 'ef', k, { disabled: ro() || (f.pick && f.pick !== 'custom' && f.basis !== 'energy') }), f.source || null),
          f.pick === 'custom' ? x.field('Factor source', tin(f, 'source', k)) : null),
        hint,
        x.h('button', { class: 'lg-link danger', type: 'button', disabled: ro(), onclick: () => { b.fuels.splice(b.fuels.indexOf(f), 1); touch(k); drawCompany(); } }, 'Remove this fuel'));
    }))));

  if (b.elecSources.length) w.append(card('Other electricity sources', null, x.h('div', { class: 'lg-form' }, b.elecSources.map(s => x.h('div', {},
    x.field('Source name', tin(s, 'name', k)),
    x.h('button', { class: 'lg-link danger', type: 'button', disabled: ro(), onclick: () => { b.elecSources.splice(b.elecSources.indexOf(s), 1); touch(k); drawCompany(); } }, 'Remove'))))));

  const months = b.months;
  w.append(card('Monthly figures', null, months.length ? scroll(x.h('table', { class: 'lg-t lg-edit' },
    x.h('thead', {}, x.h('tr', {}, x.h('th', {}, 'Month'), x.h('th', {}, `Production ${b.prodUnit}`), x.h('th', {}, 'Grid kWh'), b.elecSources.map(s => x.h('th', {}, `${s.name} kWh`)), b.fuels.map(f => x.h('th', {}, `${f.name || 'Fuel'} ${f.unit}`)), x.h('th', {}, 'Water kL'),
      x.h('th', { class: 'n' }, 'TOE'), x.h('th', { class: 'n' }, 'kWh/unit'), x.h('th', {}))),
    x.h('tbody', {}, months.map(p => {
      const key = monthKey(p.y, p.m);
      const row = C => C.blc.rows.find(r => r.key === key);
      const grid = nin(b.grid, key, k, { 'aria-label': `Grid kWh ${key}`, class: `nin wide${b.gridAuto?.[key] ? ' read' : ''}`, title: b.gridAuto?.[key] ? 'From the bills' : null, onset: () => { if (b.gridAuto) delete b.gridAuto[key]; grid.classList.remove('read'); } });
      return x.h('tr', {}, x.h('td', {}, monthLabel(p.y, p.m)),
        x.h('td', {}, nin(b.production, key, k, { class: 'nin wide', 'aria-label': `Production ${key}` })), x.h('td', {}, grid),
        b.elecSources.map(s => x.h('td', {}, nin((s.values ||= {}), key, k, { class: 'nin wide' }))),
        b.fuels.map(f => x.h('td', {}, nin((f.values ||= {}), key, k, { class: 'nin wide', 'aria-label': `${f.name} ${key}` }))),
        x.h('td', {}, nin(b.water, key, k, { class: 'nin' })),
        x.h('td', { class: 'n' }, live(C => nd(row(C)?.totalToe, 2))), x.h('td', { class: 'n' }, live(C => nd(row(C)?.secKwh, 3))),
        x.h('td', {}, x.h('button', { class: 'lg-x', type: 'button', disabled: ro(), 'aria-label': `Remove ${monthLabel(p.y, p.m)}`, onclick: () => { b.months.splice(b.months.indexOf(p), 1); touch(k); drawCompany(); } }, '×')));
    })),
    x.h('tfoot', {}, x.h('tr', {}, x.h('td', {}, 'Total'), x.h('td', { class: 'n' }, live(C => n0(C.blc.total.prod))), x.h('td', { class: 'n' }, live(C => n0(C.blc.total.grid))),
      b.elecSources.map((_, i) => x.h('td', { class: 'n' }, live(C => n0(C.blc.total.sources[i]?.kwh)))), b.fuels.map((_, i) => x.h('td', { class: 'n' }, live(C => n0(C.blc.total.fuels[i]?.qty)))),
      x.h('td', { class: 'n' }, live(C => n0(C.blc.total.water))), x.h('td', { class: 'n' }, live(C => nd(C.blc.total.totalToe, 2))), x.h('td', { class: 'n' }, live(C => nd(C.blc.total.secKwh, 3))), x.h('td'))))) : x.h('p', { class: 'empty' }, 'No months yet. Add bills, or add a financial year above.')));
}

// ---------- GHG ----------
const LINE_TYPES = {
  mobile: { label: 'Mobile combustion', scope: 1, groups: ['Fuels', 'Bioenergy'] },
  fugitive: { label: 'Refrigerants and gases', scope: 1, groups: ['Refrigerants and gases'] },
  process: { label: 'Process emissions', scope: 1, groups: [] },
  scope3: { label: 'Scope 3', scope: 3, groups: ['Well-to-tank of fuels', 'Well-to-tank of bioenergy', 'Water supply', 'Water treatment', 'Purchased materials', 'Waste disposal', 'Hotel stay'] },
};
const lineItems = l => L.factors.items.filter(i => LINE_TYPES[l.type].groups.includes(i.g));
const itemKey = i => `${i.g}|${i.n}|${i.u}|${i.o}`;
const itemText = i => `${i.n}${i.o ? `, ${i.o.toLowerCase()}` : ''}, per ${i.u}`;

function drawGhg(w) {
  const g = L.ghg, k = KIND.ghg;
  g.crossBorderSel = g.crossBorder === false ? 'out' : 'in';
  const fys = [...new Set(L.cea.rows.map(r => r.fy))].sort().reverse();
  const fy = g.fy || dominantFy();
  const f = K.ceaFactor({ ...L.cea, ...g.cea }, fy, g.basis || 'average', g.crossBorder !== false);
  w.append(x.h('section', { class: 'card lg-card lg-grid' },
    x.h('div', { class: 'cap' }, x.h('h2', {}, 'Scope 2 grid factor'), x.h('span', { class: 'pill ok' }, `CEA Version ${g.cea?.version || L.cea.version}`)),
    x.h('div', { class: 'lg-big' }, x.h('b', {}, nd(num(g.gridEF), 3)), x.h('span', { class: 'small muted' }, 'kgCO₂/kWh (tCO₂/MWh)')),
    x.h('p', { class: 'small' }, K.ceaLabel(g)),
    f && !f.exact ? x.h('p', { class: 'small lg-warnline' }, `CEA has not published FY ${fy} yet, so the factor for FY ${f.fy} is used. Move on when a newer version appears.`) : null,
    x.h('div', { class: 'lg-form' },
      x.field('Financial year', sel(g, 'fy', k, [{ v: '', t: `Same as the data (${dominantFy() || '—'})` }, ...fys.map(v => ({ v, t: v }))], () => { applyCea(false); drawCompany(); })),
      x.field('Factor', sel(g, 'basis', k, Object.entries(K.CEA_BASIS).map(([v, t]) => ({ v, t })), () => { applyCea(false); drawCompany(); }), 'Weighted average for Scope 2. Margins are for reductions and offsets.'),
      x.field('Cross-border transfers', sel(g, 'crossBorderSel', k, [{ v: 'in', t: 'Included (Table B)' }, { v: 'out', t: 'Excluded (Table A)' }], v => { g.crossBorder = v === 'in'; applyCea(false); drawCompany(); })),
      x.field('Metered by', tin(g, 'meterName', k)), x.field('Renewable offset, tCO₂e', nin(g, 'reOffset', k)), x.field('Offset from', tin(g, 'reOffsetSince', k, { placeholder: 'Oct 2025' })))));

  const { gc } = calc();
  const addLine = type => { g.lines.push({ id: uid(), type, name: '', qty: null, unit: '', ef: null, source: '', pick: '' }); touch(k); drawCompany(); };
  w.append(card('Other emission sources', 'Fuels in the baseline count by themselves. Add vehicles, refrigerant top-ups and Scope 3 here; factors come from the DEFRA 2026 list.',
    x.h('div', { class: 'row', style: 'gap:8px;margin-bottom:10px' }, Object.entries(LINE_TYPES).map(([t, v]) => x.h('button', { class: 'btn ghost sm', type: 'button', disabled: ro(), onclick: () => addLine(t) }, `Add ${v.label.toLowerCase()}`))),
    g.lines.length ? x.h('div', { class: 'lg-lines' }, g.lines.map(l => lineEditor(l))) : x.h('p', { class: 'empty' }, 'None added.')));

  w.append(card('Emissions', 'Updates as you type.',
    scroll(x.h('table', { class: 'lg-t' },
      x.h('thead', {}, x.h('tr', {}, x.h('th', {}, 'Scope'), x.h('th', {}, 'Source'), x.h('th', { class: 'n' }, 'Quantity'), x.h('th', {}, 'Unit'), x.h('th', { class: 'n' }, 'Factor kg'), x.h('th', { class: 'n' }, 'tCO₂e'), x.h('th', {}, 'Factor source'))),
      x.h('tbody', {}, gc.fuels.map(fu => x.h('tr', {}, x.h('td', {}, 'Scope 1'), x.h('td', {}, fu.name || 'Fuel'), x.h('td', { class: 'n' }, n0(fu.qty)), x.h('td', {}, fu.unit), x.h('td', { class: 'n' }, fu.ef === null ? 'not set' : nd(fu.ef, 3)), x.h('td', { class: 'n' }, nd(fu.t, 2)), x.h('td', { class: 'small' }, (L.baseline.fuels.find(q => q.id === fu.id) || {}).source || '—'))),
        x.h('tr', {}, x.h('td', {}, 'Scope 2'), x.h('td', {}, `Grid (${g.meterName || 'meter'})`), x.h('td', { class: 'n' }, n0(gc.gridKwh)), x.h('td', {}, 'kWh'), x.h('td', { class: 'n' }, nd(gc.gridEF, 3)), x.h('td', { class: 'n' }, live(C => nd(C.gc.gross2, 2))), x.h('td', { class: 'small' }, `CEA Version ${g.cea?.version}, FY ${g.cea?.fy}`))),
      x.h('tfoot', {}, x.h('tr', {}, x.h('td', { colspan: 5 }, 'Scope 1 total'), x.h('td', { class: 'n' }, live(C => nd(C.gc.s1, 2))), x.h('td')), x.h('tr', {}, x.h('td', { colspan: 5 }, 'Scope 2 net'), x.h('td', { class: 'n' }, live(C => nd(C.gc.s2, 2))), x.h('td')),
        x.h('tr', {}, x.h('td', { colspan: 5 }, 'Scope 1 + 2'), x.h('td', { class: 'n' }, live(C => nd(C.gc.total12, 2))), x.h('td')), x.h('tr', {}, x.h('td', { colspan: 5 }, 'Scope 3 (reported separately)'), x.h('td', { class: 'n' }, live(C => nd(C.gc.s3, 2))), x.h('td')))))));
}
function lineEditor(l) {
  const k = KIND.ghg, meta = LINE_TYPES[l.type];
  const items = lineItems(l);
  const byGroup = {};
  for (const i of items) (byGroup[i.g === 'Fuels' || i.g === 'Bioenergy' ? i.a : i.g] ||= []).push({ v: itemKey(i), t: itemText(i) });
  const opts = [{ v: '', t: items.length ? 'Choose a factor…' : 'My own factor' }, ...Object.entries(byGroup).map(([label, list]) => ({ label, items: list }))];
  return x.h('div', { class: 'lg-fuel' }, x.h('b', { class: 'small' }, `${meta.label} (Scope ${meta.scope})`),
    x.h('div', { class: 'lg-form two' },
      items.length ? x.field('Factor', sel(l, 'pick', k, opts, v => {
        const i = items.find(q => itemKey(q) === v);
        if (i) { l.ef = i.v; l.unit = i.u; l.source = L.factors.short; if (!l.name) l.name = i.n; }
        drawCompany();
      })) : null,
      x.field('Name in the report', tin(l, 'name', k)), x.field(`Quantity${l.unit ? `, ${l.unit}` : ''}`, nin(l, 'qty', k)),
      x.field('Unit', tin(l, 'unit', k)), x.field('Factor kgCO₂e per unit', nin(l, 'ef', k), l.source || null),
      !l.pick ? x.field('Factor source', tin(l, 'source', k)) : null),
    x.h('div', { class: 'row', style: 'justify-content:space-between' }, x.h('span', { class: 'small' }, live(C => { const q = C.gc.lines.find(n => n.id === l.id); return q?.t === null || q?.t === undefined ? '' : `${nd(q.t, 3)} tCO₂e`; })),
      x.h('button', { class: 'lg-link danger', type: 'button', disabled: ro(), onclick: () => { L.ghg.lines.splice(L.ghg.lines.indexOf(l), 1); touch(k); drawCompany(); } }, 'Remove')));
}

// ---------- report ----------
// Three parts, each with all its tables and graphs: 1 Electricity bills, 2 Energy baseline, 3 GHG
// emissions. Portrait A4 with the AR name on every page (the @page rules in styles.css); only the
// team's 33-column bill table takes a wide page of its own.
function printIdentity(company) {
  // The company's name in the page margin. Only a nicety, so a browser without this feature just goes without it.
  try {
    const name = String(company).replace(/["\\\n]/g, ' ').slice(0, 70);
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`@page{@top-right{content:"${name}"}} @page billsheet{@top-right{content:"${name}"}}`);
    document.adoptedStyleSheets = [sheet];
  } catch { /* the rest of the page header still prints */ }
}
function drawReport(w) {
  const { bc, blc, gc } = calc();
  const c = L.company, g = L.ghg, cfg = bc.cfg, name = c.client_name || L.id;
  const f = K.findings(bc, blc, gc, FMT);
  printIdentity(name);
  const N = t => ({ t, n: true });
  const table = (head, rows, foot) => scroll(x.h('table', { class: 'lg-t lg-rt' },
    x.h('thead', {}, x.h('tr', {}, head.map(t => x.h('th', { class: t.n ? 'n' : '' }, t.t || t)))),
    x.h('tbody', {}, rows.map(r => x.h('tr', {}, r.map((v, i) => x.h('td', { class: head[i].n ? 'n' : '' }, v))))),
    foot ? x.h('tfoot', {}, foot.map(r => x.h('tr', {}, r.map((v, i) => x.h('td', { class: head[i].n ? 'n' : '' }, v))))) : null));
  const part = (no, title, ...kids) => x.h('section', { class: 'lg-part' }, x.h('h3', { class: 'lg-parth' }, `${no}. ${title}`), ...kids);
  const sub = t => x.h('h4', { class: 'lg-subh' }, t);
  const charts = (...list) => x.h('div', { class: 'lg-charts' }, list);
  const note = t => x.h('p', { class: 'small muted lg-rnote' }, t);
  const share = v => (bc.total.bill ? pct((v || 0) / bc.total.bill) : '—');

  // ---- 1. bills ----
  const labels = bc.live.map(r => r.month);
  const parts = [['Demand charge', bc.total.demand], ['Energy charge', bc.total.energy], ['FPPA (fuel surcharge)', bc.total.fuel], ['TOU charges', bc.total.touCharge], ['TOU discount', bc.total.touDiscount],
    ['PF adjustment or rebate', bc.total.pfAdj], ['Night rebate', bc.total.nightRebate], ['EHV charges', bc.total.ehv], ['Total consumption charge', bc.total.totalCons], ['Electricity duty', bc.total.duty]];
  const billPart = bc.months ? part(1, 'Electricity bills',
    table(['Item', N('Value')], [
      ['Source of power', cfg.discom || '—'], ['Consumer no.', cfg.consumerNo || '—'], ['Tariff', cfg.tariff || '—'], ['Contract demand', bc.cd ? `${n0(bc.cd)} kVA` : '—'],
      [`Minimum billing demand`, bc.minBD ? `${nd(bc.minBD, 1)} kVA` : '—'], ['Months of bills', `${bc.months} (${labels[0]} to ${labels[labels.length - 1]})`],
      ['Bills verified against the bill', `${bc.verified} of ${bc.months}`], ['Total units', `${n0(bc.total.kwh)} kWh`], ['Total billed', rupees(bc.total.bill)], ['Average rate', `₹${nd(bc.blended, 2)} per kWh`],
      ['Highest demand', `${n0(bc.maxMD)} kVA`], ['Average power factor', nd(bc.avg.pf, 3)], ['Load factor', pct(bc.loadFactor)], ['Night units', pct(bc.nightShare)], ['TOU units', pct(bc.touShare)],
    ]),
    sub('What the bills are made of'),
    table(['Charge', N('Total ₹'), N('Share of the bill')], parts.map(([t, v]) => [t, n0(v), share(v)]), [['Total billed', n0(bc.total.bill), '100.0 %']]),
    sub('Rebates and discounts earned'),
    table(['Rebate', N('Total ₹')], [['Power factor rebate', n0(bc.rebates.pf)], ['TOU discount', n0(bc.rebates.tou)], ['EHV rebate', n0(bc.rebates.ehv)], ['Night rebate', n0(bc.rebates.night)]], [['Total', n0(bc.rebates.total)]]),
    bc.demandAdvice ? [sub('Contract demand'),
      table(['Month', N('Actual MD kVA'), N('Billing demand kVA'), N('Above contract kVA'), N('Demand charge ₹'), N(`At ${n0(bc.demandAdvice.suggested)} kVA contract ₹`)],
        bc.live.map(r => [r.month, n0(r.md), n0(r.billingDemand), n0(r.overKva), n0(r.demand), n0(K.demandCharge(r.md === null ? null : Math.max(r.md, bc.demandAdvice.suggested * (num(cfg.minBillingPct) ?? 0.85)), cfg, bc.demandAdvice.suggested))]),
        [['Total', '', '', '', n0(bc.demandAdvice.today), n0(bc.demandAdvice.cost)]]),
      bc.demandAdvice.saving > 0 ? note(`A contract of ${n0(bc.demandAdvice.suggested)} kVA would have saved ${rupees(bc.demandAdvice.saving)} on demand charges over these ${bc.demandAdvice.months} months, before any deposit or fee for the change.`) : null] : null,
    sub('Graphs'),
    charts(
      chart({ title: 'Units consumed', unit: 'kWh', labels, series: [{ name: 'Units', values: bc.live.map(r => r.kwh) }], fmt: n0 }),
      chart({ title: 'Cost per unit', unit: '₹/kWh', labels, kind: 'line', series: [{ name: 'Rate', values: bc.live.map(r => r.rate) }] }),
      chart({ title: 'Maximum demand', unit: 'kVA', labels, series: [{ name: 'Actual MD', values: bc.live.map(r => r.md) }], fmt: n0, refLine: bc.cd ? { value: bc.cd, label: `Contract ${n0(bc.cd)} kVA` } : null }),
      chart({ title: 'Power factor', unit: 'PF', labels, kind: 'line', series: [{ name: 'PF', values: bc.live.map(r => r.pf) }], fmt: v => nd(v, 3), refLine: { value: 0.95, label: 'Rebate starts above 0.95' } }),
      chart({ title: 'What the bill is made of', unit: '₹', labels, fmt: n0, series: [
        { name: 'Energy', values: bc.live.map(r => r.energy) }, { name: 'Fuel surcharge', values: bc.live.map(r => r.fuel) },
        { name: 'Demand', values: bc.live.map(r => r.demand) }, { name: 'Duty', values: bc.live.map(r => r.duty) }, { name: 'TOU', values: bc.live.map(r => r.touCharge) }] }),
      chart({ title: 'Night and TOU units', unit: 'kWh', labels, fmt: n0, series: [{ name: 'Night', values: bc.live.map(r => r.night) }, { name: 'TOU', values: bc.live.map(r => r.tou) }] })),
    billSheetTable(bc, name)) : null;

  // ---- 2. baseline ----
  const rows = blc.rows, ml = rows.map(r => r.label), T = blc.total, bl = blc.basisLabel;
  const hasThermal = T.thermalToe !== null, hasWater = T.water !== null;
  const basePart = blc.months ? part(2, 'Energy baseline',
    table(['Item', N('Total'), N(`Per ${bl}`)], [
      ['Production', `${n0(T.prod)} ${blc.unit}`, '—'], ['Electricity', `${n0(T.elecKwh)} kWh`, blc.hasProd ? `${nd(T.secKwh, 3)} kWh` : '—'],
      ['Electrical energy', `${nd(T.elecToe, 2)} TOE`, '—'], ['Thermal energy', hasThermal ? `${nd(T.thermalToe, 2)} TOE` : '—', blc.hasProd && hasThermal ? `${nd(T.secThermal, 4)} TOE` : '—'],
      ['Total energy', `${nd(T.totalToe, 2)} TOE`, blc.hasProd ? `${nd(T.secTotal, 4)} TOE` : '—'], ['Water', hasWater ? `${n0(T.water)} kL` : '—', blc.hasProd && hasWater ? `${nd(T.secWater, 3)} kL` : '—'],
    ]),
    note('1 kWh = 860 kcal; 1 TOE = 10,000,000 kcal. Specific figures for the period are total over total.'),
    sub('Electrical'),
    table(['Month', N(`Production ${blc.unit}`), N('Grid kWh'), ...T.sources.map(s => N(`${s.name} kWh`)), N('Total kWh'), N('TOE'), N(`kWh/${bl}`)],
      rows.map(r => [r.label, n0(r.prod), n0(r.grid), ...r.sources.map(s => n0(s.kwh)), n0(r.elecKwh), nd(r.elecToe, 2), nd(r.secKwh, 3)]),
      [['Total', n0(T.prod), n0(T.grid), ...T.sources.map(s => n0(s.kwh)), n0(T.elecKwh), nd(T.elecToe, 2), nd(T.secKwh, 3)]]),
    hasThermal ? [sub('Thermal'),
      table(['Month', ...T.fuels.flatMap(u => [N(`${u.name} ${u.unit}`), N('TOE')]), N('Thermal TOE'), N(`TOE/${bl}`)],
        rows.map(r => [r.label, ...r.fuels.flatMap(u => [n0(u.qty), nd(u.toe, 2)]), nd(r.thermalToe, 2), nd(r.secThermal, 4)]),
        [['Total', ...T.fuels.flatMap(u => [n0(u.qty), nd(u.toe, 2)]), nd(T.thermalToe, 2), nd(T.secThermal, 4)]]),
      note(L.baseline.fuels.map(u => `${u.name}: GCV ${n0(num(u.gcv))} kcal/${K.fuelUnit(u.unit).per}`).join(' · '))] : null,
    sub('Overall'),
    table(['Month', N('Electrical TOE'), N('Thermal TOE'), N('Total TOE'), N(`TOE/${bl}`)], rows.map(r => [r.label, nd(r.elecToe, 2), nd(r.thermalToe, 2), nd(r.totalToe, 2), nd(r.secTotal, 4)]),
      [['Total', nd(T.elecToe, 2), nd(T.thermalToe, 2), nd(T.totalToe, 2), nd(T.secTotal, 4)]]),
    hasWater ? [sub(`Water (${L.baseline.waterSource || 'all sources'})`),
      table(['Month', N(`Production ${blc.unit}`), N('Water kL'), N(`kL/${bl}`)], rows.map(r => [r.label, n0(r.prod), n0(r.water), nd(r.secWater, 3)]), [['Total', n0(T.prod), n0(T.water), nd(T.secWater, 3)]])] : null,
    sub('Graphs'),
    charts(
      T.sources.length ? chart({ title: 'Electricity by source', unit: 'kWh', labels: ml, fmt: n0, series: [{ name: 'Grid', values: rows.map(r => r.grid) }, ...T.sources.map((s, i) => ({ name: s.name, values: rows.map(r => r.sources[i].kwh) }))] })
        : chart({ title: 'Grid electricity', unit: 'kWh', labels: ml, fmt: n0, series: [{ name: 'Grid', values: rows.map(r => r.grid) }] }),
      blc.hasProd ? chart({ title: 'Production', unit: blc.unit, labels: ml, fmt: n0, series: [{ name: 'Production', values: rows.map(r => r.prod) }] }) : null,
      blc.hasProd ? chart({ title: 'Specific electricity', unit: `kWh/${bl}`, labels: ml, kind: 'line', series: [{ name: 'SEC', values: rows.map(r => r.secKwh) }], fmt: v => nd(v, 3) }) : null,
      hasThermal ? chart({ title: 'Thermal energy', unit: 'TOE', labels: ml, fmt: v => nd(v, 2), series: T.fuels.map((u, i) => ({ name: u.name || 'Fuel', values: rows.map(r => r.fuels[i].toe) })) }) : null,
      chart({ title: 'Total energy', unit: 'TOE', labels: ml, fmt: v => nd(v, 2), series: [{ name: 'Electrical', values: rows.map(r => r.elecToe) }, { name: 'Thermal', values: rows.map(r => r.thermalToe) }] }),
      blc.hasProd ? chart({ title: 'Specific energy', unit: `TOE/${bl}`, labels: ml, kind: 'line', series: [{ name: 'Total', values: rows.map(r => r.secTotal) }], fmt: v => nd(v, 4) }) : null,
      hasWater ? chart({ title: 'Water drawn', unit: 'kL', labels: ml, fmt: n0, series: [{ name: 'Water', values: rows.map(r => r.water) }] }) : null,
      hasWater && blc.hasProd ? chart({ title: 'Specific water', unit: `kL/${bl}`, labels: ml, kind: 'line', series: [{ name: 'Water', values: rows.map(r => r.secWater) }], fmt: v => nd(v, 3) }) : null)) : null;

  // ---- 3. GHG ----
  const scopeRows = [...gc.fuels.map(u => ['Scope 1', u.name, n0(u.qty), u.unit, u.ef === null ? 'not set' : nd(u.ef, 3), nd(u.t, 2)]),
    ...gc.lines.filter(l => l.type !== 'scope3').map(l => ['Scope 1', l.name, n0(num(l.qty)), l.unit, nd(num(l.ef), 3), nd(l.t, 2)])];
  const fuelCols = gc.fuels.map(u => N(`${u.name} tCO₂e`));
  const ghgPart = part(3, 'GHG emissions',
    x.h('div', { class: 'lg-kpis print' }, tile('Scope 1', `${nd(gc.s1, 1)} tCO₂e`), tile('Scope 2', `${nd(gc.s2, 1)} tCO₂e`), tile('Scope 1 + 2', `${nd(gc.total12, 1)} tCO₂e`),
      gc.intensity !== null ? tile('Intensity', `${nd(gc.intensity, 3)}`, `tCO₂e per ${bl}`) : null),
    x.h('p', { class: 'small' }, x.h('b', {}, 'Grid emission factor: '), `${nd(gc.gridEF, 3)} tCO₂/MWh, ${K.ceaLabel(g)}.`),
    sub('Summary'),
    table(['Scope', 'Source', N('Quantity'), 'Unit', N('Factor kgCO₂e'), N('tCO₂e')],
      [...scopeRows, ['Scope 2', `Grid (${g.meterName || 'meter'})`, n0(gc.gridKwh), 'kWh', nd(gc.gridEF, 3), nd(gc.gross2, 2)],
        ...(gc.offset ? [['Scope 2', `Renewable offset${g.reOffsetSince ? ` from ${g.reOffsetSince}` : ''}`, '', '', '', nd(-gc.offset, 2)]] : []),
        ...gc.onSite.map(s => ['Scope 2', `${s.name}, on site, no grid emission`, n0(s.kwh), 'kWh', '0', '0.00']),
        ...gc.lines.filter(l => l.type === 'scope3').map(l => ['Scope 3', l.name, n0(num(l.qty)), l.unit, nd(num(l.ef), 3), nd(l.t, 2)])],
      [['Total', 'Scope 1 + 2', '', '', '', nd(gc.total12, 2)], ...(gc.s3 ? [['Total', 'Scope 3, reported separately', '', '', '', nd(gc.s3, 2)]] : [])]),
    sub('Month by month'),
    table(['Month', ...fuelCols, N('Scope 1 tCO₂e'), N('Scope 2 tCO₂e'), N('Total tCO₂e'), N(`tCO₂e/${bl}`)],
      gc.months.map(m => [m.label, ...m.byFuel.map(v => nd(v, 2)), nd(m.s1, 2), nd(m.s2, 2), nd(m.total, 2), nd(m.intensity, 4)]),
      [['Total', ...gc.fuels.map(u => nd(u.t, 2)), nd(gc.months.reduce((a, m) => a + m.s1, 0), 2), nd(gc.gross2, 2), nd(gc.months.reduce((a, m) => a + m.total, 0), 2), nd(gc.months.length && blc.hasProd ? gc.months.reduce((a, m) => a + m.total, 0) / (T.prod / blc.basis) : null, 4)]]),
    note('Monthly figures carry fuel and grid. Other sources and any offset are in the summary only, as they are not monthly.'),
    sub('Graphs'),
    charts(
      chart({ title: 'Monthly emissions', unit: 'tCO₂e', labels: gc.months.map(m => m.label), fmt: v => nd(v, 1), series: [{ name: 'Scope 1', values: gc.months.map(m => m.s1) }, { name: 'Scope 2', values: gc.months.map(m => m.s2) }] }),
      chart({ title: 'Emissions by scope', unit: 'tCO₂e', labels: gc.s3 ? ['Scope 1', 'Scope 2', 'Scope 3'] : ['Scope 1', 'Scope 2'], fmt: v => nd(v, 1), series: [{ name: 'Emissions', values: gc.s3 ? [gc.s1, gc.s2, gc.s3] : [gc.s1, gc.s2] }] }),
      gc.fuels.length ? chart({ title: 'Scope 1 by fuel', unit: 'tCO₂e', labels: gc.months.map(m => m.label), fmt: v => nd(v, 1), series: gc.fuels.map((u, i) => ({ name: u.name || 'Fuel', values: gc.months.map(m => m.byFuel[i]) })) }) : null,
      chart({ title: 'Scope 2, purchased electricity', unit: 'tCO₂e', labels: gc.months.map(m => m.label), fmt: v => nd(v, 1), series: [{ name: 'Scope 2', values: gc.months.map(m => m.s2) }] }),
      blc.hasProd ? chart({ title: 'Emission intensity', unit: `tCO₂e/${bl}`, labels: gc.months.map(m => m.label), kind: 'line', series: [{ name: 'Intensity', values: gc.months.map(m => m.intensity) }], fmt: v => nd(v, 4) }) : null));

  w.append(x.h('div', { class: 'row noprint', style: 'gap:8px;margin-bottom:14px' },
    x.h('button', { class: 'btn cta', type: 'button', onclick: () => window.print() }, 'Print or save as PDF'),
    x.h('button', { class: 'btn ghost', type: 'button', onclick: exportExcel }, 'Download Excel')));
  w.append(x.h('article', { class: 'lg-report' },
    x.h('header', { class: 'lg-rhead' },
      x.h('div', { class: 'lg-brand' }, x.h('img', { src: '/logo.png', alt: 'AR Energy Services' }), x.h('div', {}, x.h('b', {}, 'AR Energy Services'), x.h('span', { class: 'small muted' }, 'Energy audit team'))),
      x.h('h2', {}, 'Electricity bill, energy baseline and GHG report'),
      x.h('p', {}, x.h('b', {}, name)),
      x.h('p', { class: 'small' }, [c.site_name, L.audit.fy, L.id].filter(Boolean).join(' · '))),
    x.h('div', { class: 'lg-kpis print' },
      tile('Electricity', `${n0(bc.total.kwh)} kWh`, `${bc.months} months`), tile('Total billed', crore(bc.total.bill), bc.blended ? `₹${nd(bc.blended, 2)}/kWh` : null),
      tile('Highest demand', `${n0(bc.maxMD)} kVA`, bc.cd ? `Contract ${n0(bc.cd)} kVA` : null), tile('Rebates and discounts', crore(bc.rebates.total)),
      tile('Total energy', T.totalToe === null ? '—' : `${nd(T.totalToe, 1)} TOE`), tile('Scope 1 + 2', `${n0(gc.total12)} tCO₂e`)),
    f.length ? x.h('section', {}, x.h('h3', {}, 'Findings'), x.h('ul', { class: 'lg-rlist' }, f.map(i => x.h('li', {}, i.text)))) : null,
    x.h('section', { class: 'lg-sources' }, x.h('h3', {}, 'Data sources'),
      table(['Data', 'Source'], [
        ['Grid emission factor', `${nd(gc.gridEF, 3)} tCO₂/MWh. ${K.ceaLabel(g)}.${g.cea && !g.cea.exact ? ` FY ${g.cea.wantedFy} is not yet published by CEA.` : ''} CO₂ only.`],
        ['Fuel and other factors', g.defra?.source || L.factors.source], ['Electricity data', `${bc.months} bills, ${bc.verified} verified against the bill by a person`],
        ['Prepared', `ARES Console, Energy Ledger, ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`]])),
    billPart, basePart, ghgPart));
}
