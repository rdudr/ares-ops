// ARES Console front end. Plain JS, no build step. All text goes through textContent (h()),
// so nothing typed by a user is ever interpreted as HTML.

const root = document.getElementById('app');
const state = { me: null, apps: [], sectors: {}, days: 30, timer: null };

// ---------- helpers ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM is allowed by the strict CSP; style="" is not
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

class ApiError extends Error {
  constructor(message, code, status) { super(message); this.code = code; this.status = status; }
}

// background: an automatic refresh, which must not keep an idle session alive.
async function api(method, path, body, { background = false } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-ARES': '1', ...(background ? { 'X-ARES-Background': '1' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.me) { state.me = null; route(); }
    if (data.code === 'password_change_required' && state.me) { state.me.must_change_pw = true; route(); }
    throw new ApiError(data.error || 'Something went wrong.', data.code, res.status);
  }
  return data;
}

function toast(msg) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

const fmtDate = ms => ms ? new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtDay = ms => ms ? new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—';
function ago(ms) {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} h ago`;
  const d = Math.round(hr / 24);
  return d < 30 ? `${d} day${d > 1 ? 's' : ''} ago` : fmtDay(ms);
}
const appName = code => state.apps.find(a => a.code === code)?.name || code || '—';
const ROLE = { super_admin: 'Super Admin', head: 'Head Member', engineer: 'Engineer' };
const STATUS = { active: 'Active', hold: 'On hold', revoked: 'Revoked' };
const AUDIT_STATUS = { draft: 'Draft', in_field: 'In field', processing: 'Processing', review: 'Review', approved: 'Approved', published: 'Published', archived: 'Archived' };
const statusPill = s => h('span', { class: `pill ${s}` }, STATUS[s] || s);

function currentFy() {
  const d = new Date();
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `FY${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

// Generic dialog: build(form) fills the form; submit(form) returns a promise. Errors show inline.
function openDialog(title, build, submit, { submitLabel = 'Save' } = {}) {
  const err = h('div', { class: 'err', hidden: true });
  const fields = h('div');
  const form = h('form', { method: 'dialog' },
    h('h2', {}, title), fields, err,
    h('div', { class: 'foot' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn' }, submitLabel)));
  const dlg = h('dialog', {}, form);
  build(fields);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.hidden = true;
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await submit(form);
      dlg.close();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

function showCredentials(name, loginId, password, isReset) {
  const dlg = h('dialog', {},
    h('div', { class: 'body' },
      h('h2', {}, isReset ? `New temporary password for ${name}` : `${name} is ready`),
      h('p', { class: 'muted small' }, 'Share these privately — in person or in a direct message, never in a group. ',
        'This password is shown only once. At first login they must set their own password, which you will never see.'),
      h('label', { class: 'f', style: 'margin-top:14px' }, 'Login ID', h('div', { class: 'secret' }, loginId)),
      h('label', { class: 'f', style: 'margin-top:12px' }, 'Temporary password', h('div', { class: 'secret' }, password)),
      h('div', { class: 'foot' },
        h('button', {
          class: 'btn ghost', type: 'button', onclick: async () => {
            try { await navigator.clipboard.writeText(`Login ID: ${loginId}\nTemporary password: ${password}`); toast('Copied'); }
            catch { toast('Copy not allowed here — select the text instead'); }
          },
        }, 'Copy both'),
        h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Done'))));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

const field = (label, input, hint) => h('label', { class: 'f' }, label, input, hint && h('span', { class: 'hint' }, hint));
const val = (form, name) => form.elements[name]?.value?.trim() ?? '';

// ---------- sign-in screens ----------
function gate(title, sub, formKids, onSubmit, btnLabel) {
  const err = h('div', { class: 'err', hidden: true });
  const form = h('form', {}, formKids, err, h('button', { class: 'btn', type: 'submit' }, btnLabel));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.hidden = true;
    const b = form.querySelector('button[type=submit]');
    b.disabled = true;
    try { await onSubmit(form); } catch (ex) { err.textContent = ex.message; err.hidden = false; } finally { b.disabled = false; }
  });
  root.replaceChildren(h('div', { class: 'gate' }, h('div', { class: 'card' },
    h('div', { class: 'brand' }, h('img', { src: '/logo.png', alt: '' }), h('div', {}, h('b', {}, 'ARES Console'), h('small', {}, 'AR Energy Services'))),
    h('h1', {}, title), h('p', { class: 'muted' }, sub), form)));
  form.querySelector('input')?.focus();
}

function setupScreen() {
  gate('Create the Super Admin', 'First run. Enter the one-time setup code shown in the server window.', [
    field('Setup code', h('input', { type: 'text', name: 'code', required: true, autocomplete: 'off' })),
    field('Your name', h('input', { type: 'text', name: 'name', required: true, autocomplete: 'name' })),
    field('Login ID', h('input', { type: 'text', name: 'login_id', required: true, autocomplete: 'username' }), 'Letters, numbers, dot or dash, e.g. axita'),
    field('Password', h('input', { type: 'password', name: 'password', required: true, autocomplete: 'new-password' }), 'At least 10 characters, letters and numbers'),
  ], async f => {
    await api('POST', '/api/setup', { code: val(f, 'code'), name: val(f, 'name'), login_id: val(f, 'login_id'), password: f.elements.password.value });
    toast('Super Admin created. Please sign in.');
    loginScreen();
  }, 'Create account');
}

function loginScreen() {
  gate('Sign in', 'For Super Admins and Head Members. Field engineers sign in from their app.', [
    field('Login ID', h('input', { type: 'text', name: 'login_id', required: true, autocomplete: 'username' })),
    field('Password', h('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password' })),
  ], async f => {
    await api('POST', '/api/login', { login_id: val(f, 'login_id'), password: f.elements.password.value });
    await loadMe();
    location.hash = '#/overview';
    route();
  }, 'Sign in');
}

function changePasswordScreen() {
  gate('Set your own password', 'You signed in with a temporary password. Choose your own to continue.', [
    field('Temporary password', h('input', { type: 'password', name: 'current', required: true, autocomplete: 'current-password' })),
    field('New password', h('input', { type: 'password', name: 'next', required: true, autocomplete: 'new-password' }), 'At least 10 characters, letters and numbers'),
  ], async f => {
    await api('POST', '/api/change-password', { current: f.elements.current.value, next: f.elements.next.value });
    state.me.must_change_pw = false;
    route();
  }, 'Save password');
}

async function loadMe() {
  const r = await api('GET', '/api/me');
  state.me = r.user;
  state.apps = r.apps;
  state.sectors = r.sectors;
}

// ---------- icons (line symbols in the spirit of SF Symbols) ----------
const ICONS = {
  overview: ['M4 16a8 8 0 1 1 16 0', 'M12 16l4-5', 'M3 20h18'],
  team: ['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M2.5 20a6.5 6.5 0 0 1 13 0', 'M16 4.5a3.5 3.5 0 0 1 0 7', 'M18 14.5a6.5 6.5 0 0 1 3.5 5.5'],
  audits: ['M5 21V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v17', 'M15 9h3a1 1 0 0 1 1 1v11', 'M3 21h18', 'M8.5 7h3M8.5 11h3M8.5 15h3'],
  tasks: ['M4 6l1.5 1.5L8 5', 'M4 12l1.5 1.5L8 11', 'M4 18l1.5 1.5L8 17', 'M11 6h9M11 12h9M11 18h9'],
  activity: ['M12 7v5l3 2', 'M3.5 12a8.5 8.5 0 1 0 2.5-6', 'M3 4v4h4'],
  account: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 12.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M6.5 18.5a6 6 0 0 1 11 0'],
  sidebar: ['M4 5h16v14H4z', 'M9 5v14'],
  live: ['M13 2 4 14h7l-1 8 9-12h-7z'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  doc: ['M7 3h7l4 4v14H7z', 'M14 3v4h4', 'M10 12h5M10 16h5'],
  play: ['M8 5.5v13l10-6.5z'],
  signout: ['M15 4h4v16h-4', 'M10 8l-4 4 4 4', 'M6 12h10'],
  apps: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'],
  phone: ['M7 2.5h10a1 1 0 0 1 1 1v17a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1z', 'M10.5 18.5h3'],
  download: ['M12 3v12', 'M7 10l5 5 5-5', 'M5 21h14'],
  guide: ['M4 5a2 2 0 0 1 2-2h5v17H6a2 2 0 0 0-2 2z', 'M20 5a2 2 0 0 0-2-2h-5v17h5a2 2 0 0 1 2 2z'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
};
const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(name) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'ic');
  s.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name]) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}
const initials = name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');

function readPref(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function writePref(key, v) {
  try { localStorage.setItem(key, v); } catch { /* storage blocked: preference just isn't remembered */ }
}

// ---------- shell: sidebar (regular width) / tab bar (compact width) + toolbar ----------
const PAGES = [
  { id: 'overview', label: 'Overview', group: 'Monitor', icon: 'overview' },
  { id: 'tasks', label: 'Tasks', group: 'Monitor', icon: 'tasks' },
  { id: 'activity', label: 'Activity log', group: 'Monitor', icon: 'activity' },
  { id: 'team', label: 'Team & access', group: 'Manage', icon: 'team' },
  { id: 'audits', label: 'Audits', group: 'Manage', icon: 'audits' },
  { id: 'apps', label: 'All apps', group: 'Field apps', icon: 'apps' },
  { id: 'guide', label: 'Getting started', group: 'Resources', icon: 'guide' },
  { id: 'account', label: 'My account', group: null, icon: 'account' },
];
const GROUPS = ['Monitor', 'Manage', 'Field apps', 'Resources'];
// Field apps get a sub-page each (from /api/me), listed under "All apps".
const menuPages = () => PAGES.flatMap(p => p.id !== 'apps' ? [p]
  : [p, ...(state.apps || []).filter(a => a.field).map(a => ({ id: `apps/${a.code}`, label: a.name, group: 'Field apps', icon: 'phone', sub: true }))]);
const EXTERNAL = [
  { href: '/pqa/', label: 'Power Quality analyser' },
  { href: '/apps/', label: 'Download page' },
  { href: 'https://arenergyservices.in', label: 'Public website' },
];

function shell(active, content) {
  const navLink = p => h('a', { class: `nav${p.sub ? ' sub' : ''}${p.id === active ? ' on' : ''}`, href: `#/${p.id}`, 'aria-current': p.id === active ? 'page' : null }, icon(p.icon), p.label);
  const extLink = x => h('a', { class: 'nav', href: x.href, target: '_blank', rel: 'noopener' }, icon('external'), x.label, h('span', { class: 'sr' }, ' (opens in a new tab)'));
  const side = h('nav', { class: 'side', 'aria-label': 'Sections' },
    h('a', { class: 'brand', href: '#/overview' }, h('img', { src: '/logo.png', alt: '' }),
      h('div', {}, h('b', {}, 'ARES Console'), h('small', {}, 'AR Energy Services'))),
    h('div', { class: 'side-scroll' },
      GROUPS.map(g => [h('div', { class: 'group' }, g), menuPages().filter(p => p.group === g).map(navLink), g === 'Resources' && EXTERNAL.map(extLink)])));

  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Sections' },
    PAGES.filter(p => p.group && p.group !== 'Resources').map(p => h('a', { class: p.id === active ? 'on' : '', href: `#/${p.id}`, 'aria-current': p.id === active ? 'page' : null },
      icon(p.icon), p.label.replace(' & access', '').replace(' log', '').replace('All apps', 'Apps'))));

  const shellEl = h('div', { class: `shell${readPref('ares.sidebar', 'open') === 'closed' ? ' collapsed' : ''}` });
  const toggle = h('button', {
    class: 'icon-btn sidebar-toggle', type: 'button', 'aria-label': 'Show or hide sidebar',
    'aria-expanded': String(!shellEl.classList.contains('collapsed')),
    onclick: () => {
      const closed = shellEl.classList.toggle('collapsed');
      toggle.setAttribute('aria-expanded', String(!closed));
      writePref('ares.sidebar', closed ? 'closed' : 'open');
    },
  }, icon('sidebar'));

  let pop = null;
  const closePop = () => { pop?.remove(); pop = null; document.removeEventListener('click', outside, true); };
  const outside = e => { if (pop && !pop.contains(e.target) && !menuBtn.contains(e.target)) closePop(); };
  const menuBtn = h('button', {
    class: 'menu-btn', type: 'button', 'aria-haspopup': 'menu',
    onclick: () => {
      if (pop) return closePop();
      pop = h('div', { class: 'popover', role: 'menu' },
        h('div', { class: 'who' }, h('b', {}, state.me.name), h('span', { class: 'small muted' }, `${state.me.login_id} · ${ROLE[state.me.role]}`)),
        h('a', { href: '#/account', role: 'menuitem', onclick: closePop }, icon('account'), 'My account'),
        h('button', {
          type: 'button', role: 'menuitem', onclick: async () => {
            closePop();
            await api('POST', '/api/logout').catch(() => {});
            state.me = null;
            route();
          },
        }, icon('signout'), 'Sign out'));
      toolbar.append(pop);
      document.addEventListener('click', outside, true);
      pop.querySelector('a').focus();
    },
  }, h('span', { class: 'av' }, initials(state.me.name)), state.me.name.split(' ')[0]);
  const toolbar = h('header', { class: 'toolbar' }, toggle,
    h('span', { class: 'title' }, menuPages().find(p => p.id === active)?.label || ''), h('span', { class: 'spacer' }), menuBtn);
  toolbar.addEventListener('keydown', e => { if (e.key === 'Escape') closePop(); });

  shellEl.append(side, h('div', { class: 'content' }, toolbar, h('main', { class: 'main' }, content)));
  root.replaceChildren(shellEl, tabbar);
}

async function route() {
  clearInterval(state.timer);
  if (!state.me) {
    try { await loadMe(); } catch {
      const s = await api('GET', '/api/setup').catch(() => ({ needed: false }));
      return s.needed ? setupScreen() : loginScreen();
    }
  }
  if (state.me.must_change_pw) return changePasswordScreen();
  const [page, param] = (location.hash.replace('#/', '') || 'overview').split('?')[0].split('/');
  const fn = page === 'audit' && param ? h2 => auditPage(h2, decodeURIComponent(param))
    : page === 'apps' && param ? h2 => appPage(h2, decodeURIComponent(param))
      : ({ overview, team, audits, tasks, activity, account, apps: appsPage, guide: guidePage }[page] || overview);
  const holder = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  const activeId = page === 'audit' ? 'audits' : page === 'apps' && param ? `apps/${param}` : page;
  shell(menuPages().some(p => p.id === activeId) ? activeId : 'overview', holder);
  try {
    await fn(holder);
  } catch (ex) {
    if (ex.status !== 401) holder.replaceChildren(h('div', { class: 'err' }, ex.message));
  }
}
window.addEventListener('hashchange', route);

// ---------- overview ----------
const PERIODS = [[7, 'Week'], [30, 'Month'], [90, 'Quarter'], [365, 'Year']];
const PERSON_COLUMNS = [
  { key: 'name', label: 'Person', get: p => p.name.toLowerCase() },
  { key: 'hours', label: 'Hours', num: true, get: p => p.hours },
  { key: 'records', label: 'Records', num: true, get: p => p.records },
  { key: 'records_per_hour', label: 'Records / hour', num: true, get: p => p.records_per_hour ?? -1 },
  { key: 'active_days', label: 'Active days', num: true, get: p => p.active_days },
  { key: 'tasks_done', label: 'Tasks done', num: true, get: p => p.tasks_done },
  { key: 'on_time_pct', label: 'On time', num: true, get: p => p.on_time_pct ?? -1 },
  { key: 'overdue', label: 'Overdue', num: true, get: p => p.overdue },
  { key: 'last_active', label: 'Last active', get: p => p.last_active || 0 },
];
state.sort = { key: 'hours', dir: -1 };

function niceMax(n) {
  if (n <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(n));
  return [1, 2, 2.5, 5, 10].map(m => m * pow).find(m => m >= n);
}

function recordsChart(days) {
  const total = days.reduce((s, x) => s + x.n, 0);
  const busiest = days.reduce((a, b) => (b.n > a.n ? b : a), days[0]);
  const today = days[days.length - 1];
  const label = d => new Date(`${d}T12:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const summary = total
    ? `${total} records in the last 14 days. Busiest day: ${label(busiest.d)} with ${busiest.n}. Today so far: ${today.n}.`
    : 'No records have been synced in the last 14 days.';
  const top = niceMax(Math.max(...days.map(x => x.n)));
  const ticks = [top, top / 2, 0];
  return h('div', {},
    h('p', { class: 'chart-summary' }, summary),
    h('div', { class: 'chart', role: 'img', 'aria-label': `Bar chart of records collected per day. ${summary}` },
      h('div', { class: 'yaxis', 'aria-hidden': 'true' }, ticks.map(t => h('span', {}, Number.isInteger(t) ? t : t.toFixed(1)))),
      h('div', { class: 'plot', 'aria-hidden': 'true' },
        ticks.slice(0, 2).map((t, i) => { const g = h('div', { class: 'grid' }); g.style.top = `${i * 50}%`; return g; }),
        days.map((x, i) => {
          const bar = h('div', { class: `bar${i === days.length - 1 ? ' today' : ''}`, title: `${label(x.d)}: ${x.n} records` }, h('i'));
          bar.firstChild.style.height = `${(x.n / top) * 100}%`;
          return bar;
        })),
      h('div', { class: 'xaxis', 'aria-hidden': 'true' },
        days.map((x, i) => h('span', {}, i === days.length - 1 ? 'Today' : (i % 2 === 0 ? label(x.d) : ''))))),
    // Same data as text for screen readers.
    h('table', { class: 'sr' }, h('caption', {}, 'Records per day'),
      h('tbody', {}, days.map(x => h('tr', {}, h('th', {}, label(x.d)), h('td', {}, x.n))))));
}

function peopleTable(people) {
  const wrap = h('div', { class: 'scroll' });
  const render = () => {
    const col = PERSON_COLUMNS.find(c => c.key === state.sort.key);
    const rows = [...people].sort((a, b) => {
      const x = col.get(a), y = col.get(b);
      return (x > y ? 1 : x < y ? -1 : 0) * state.sort.dir;
    });
    wrap.replaceChildren(h('table', {},
      h('thead', {}, h('tr', {}, PERSON_COLUMNS.map(c => h('th', {
        class: c.num ? 'n' : null, scope: 'col',
        'aria-sort': c.key === state.sort.key ? (state.sort.dir > 0 ? 'ascending' : 'descending') : null,
      }, h('button', {
        type: 'button', onclick: () => {
          state.sort = c.key === state.sort.key ? { key: c.key, dir: -state.sort.dir } : { key: c.key, dir: c.num || c.key === 'last_active' ? -1 : 1 };
          render();
        },
      }, c.label, c.key === state.sort.key ? (state.sort.dir > 0 ? ' ↑' : ' ↓') : ''))))),
      h('tbody', {}, rows.length ? rows.map(p => h('tr', {},
        h('td', {},
          h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' },
            h('span', { class: 'av' }, initials(p.name)),
            h('div', {},
              h('b', {}, p.name),
              h('div', { class: 'row small muted', style: 'gap:6px;margin-top:2px' },
                h('span', {}, `${p.employment === 'freelancer' ? 'Freelancer' : 'Staff'} · ${ROLE[p.role]}`),
                p.working_now && h('span', { class: 'live' }, 'Working now'),
                p.status !== 'active' && statusPill(p.status))))),
        h('td', { class: 'n' }, p.hours), h('td', { class: 'n' }, p.records),
        h('td', { class: 'n' }, p.records_per_hour ?? '—'), h('td', { class: 'n' }, p.active_days),
        h('td', { class: 'n' }, p.tasks_done), h('td', { class: 'n' }, p.on_time_pct == null ? '—' : `${p.on_time_pct}%`),
        h('td', { class: 'n' }, p.overdue ? h('span', { class: 'pill bad' }, `${p.overdue} overdue`) : '0'),
        h('td', { class: 'small muted' }, ago(p.last_active))))
        : h('tr', {}, h('td', { colspan: PERSON_COLUMNS.length, class: 'empty' }, 'No team members yet. Add people in Team & access.')))));
  };
  render();
  return wrap;
}

async function overview(holder, { background = false } = {}) {
  const d = await api('GET', `/api/dashboard?days=${state.days}`, null, { background });
  const t = d.totals;
  const overdueTotal = d.people.reduce((s, p) => s + p.overdue, 0);
  const periodName = (PERIODS.find(p => p[0] === d.days)?.[1] || `${d.days} days`).toLowerCase();

  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Period shown' },
    PERIODS.map(([n, label]) => h('button', {
      type: 'button', 'aria-pressed': String(n === state.days),
      onclick: () => { if (n !== state.days) { state.days = n; overview(holder); } },
    }, label)));

  const metric = (ic, label, value, note, unit) => h('div', { class: 'metric' },
    h('div', { class: 'top' }, icon(ic), label),
    h('div', { class: 'v' }, value, unit && h('small', {}, unit)),
    note);

  const people = d.people.filter(p => p.role !== 'super_admin' || p.records || p.hours);

  holder.replaceChildren(
    h('div', { class: 'head' },
      h('div', {}, h('h1', {}, 'Overview'),
        h('p', { class: 'muted small' }, `Team activity this ${periodName} · updated ${fmtDate(d.generated_at)}`)),
      seg),

    h('section', { 'aria-label': 'At a glance', class: 'metrics' },
      metric('live', 'Working now', t.working_now, h('div', { class: 'mnote' }, t.working_now === 1 ? 'person in an app' : 'people in an app')),
      metric('play', 'Tasks running', t.running_tasks, h('div', { class: 'mnote' }, `${t.open_tasks} open in total`)),
      metric('tasks', 'Overdue tasks', overdueTotal,
        h('div', { class: `mnote${overdueTotal ? ' bad' : ''}` }, overdueTotal ? 'Past their due date' : 'Nothing overdue')),
      metric('doc', 'Records', t.records, h('div', { class: 'mnote' }, `collected this ${periodName}`)),
      metric('clock', 'Hours logged', t.hours, h('div', { class: 'mnote' }, `in apps this ${periodName}`), 'h'),
      metric('audits', 'Audits in progress', t.open_audits, h('div', { class: 'mnote' }, `${t.active_people} active people`))),

    h('div', { class: 'grid2', style: 'margin-top:16px' },
      h('section', { class: 'card', 'aria-labelledby': 'h-now' },
        h('h2', { id: 'h-now' }, 'Working now'),
        h('p', { class: 'sub' }, 'People with an open session in a field app'),
        d.working_now.length ? h('div', { class: 'ilist' }, d.working_now.map(w => h('div', { class: 'it' },
          h('span', { class: 'av' }, initials(w.name)),
          h('div', { class: 'main-t' }, h('b', {}, w.name), h('span', {}, appName(w.app), w.industry_tag ? ` · ${w.industry_tag}` : '')),
          h('div', { class: 'trail' }, h('span', { class: 'live' }, `since ${new Date(w.started_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`),
            h('div', {}, `${w.records} records`)))))
          : h('p', { class: 'empty' }, 'Nobody is collecting data right now.')),
      h('section', { class: 'card', 'aria-labelledby': 'h-run' },
        h('div', { class: 'cap' }, h('h2', { id: 'h-run' }, 'Running tasks'), h('a', { href: '#/tasks', class: 'small' }, 'All tasks')),
        d.running_tasks.length ? h('div', { class: 'ilist' }, d.running_tasks.map(r => h('div', { class: 'it' },
          h('div', { class: 'main-t' }, h('b', {}, r.title),
            h('span', {}, [r.assignee_name || 'Unassigned', r.industry_tag, r.app && appName(r.app)].filter(Boolean).join(' · '))),
          h('div', { class: 'trail' }, `started ${ago(r.started_at)}`,
            r.due_at && h('div', {}, r.due_at < Date.now() ? h('span', { class: 'pill bad' }, `overdue · ${fmtDay(r.due_at)}`) : `due ${fmtDay(r.due_at)}`)))))
          : h('p', { class: 'empty' }, 'No task is marked as running.'))),

    h('section', { class: 'card', style: 'margin-top:16px', 'aria-labelledby': 'h-team' },
      h('h2', { id: 'h-team' }, 'Team performance'),
      h('p', { class: 'sub' }, `This ${periodName}. Hours come from the work sessions each app logs; records are readings saved by that person. `,
        'Records / hour appears once 15 minutes are logged. Select a column heading to sort.'),
      peopleTable(people)),

    h('div', { class: 'grid2', style: 'margin-top:16px' },
      h('section', { class: 'card', 'aria-labelledby': 'h-chart' }, h('h2', { id: 'h-chart' }, 'Records collected'), h('p', { class: 'sub' }, 'Per day, last 14 days, all apps'),
        recordsChart(d.records_per_day)),
      h('section', { class: 'card', 'aria-labelledby': 'h-act' },
        h('div', { class: 'cap' }, h('h2', { id: 'h-act' }, 'Recent activity'), h('a', { href: '#/activity', class: 'small' }, 'Full log')),
        h('div', { class: 'ilist' }, d.recent.map(a => h('div', { class: 'it' },
          h('div', { class: 'main-t' }, h('b', {}, a.user_name || 'System'), h('span', {}, describe(a))),
          h('div', { class: 'trail' }, ago(a.at))))))));

  clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (document.visibilityState === 'visible' && (location.hash.startsWith('#/overview') || !location.hash)) overview(holder, { background: true }).catch(() => {});
  }, 60000);
}

// ---------- team & access ----------
async function team(holder) {
  const [{ users }, { audits: auditList }] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/audits')]);
  const me = state.me;
  const canManage = u => u.id !== me.id && (me.role === 'super_admin' || (me.role === 'head' && u.role === 'engineer'));

  const appChips = u => h('div', { class: 'chips' }, state.apps.map(a => {
    const on = u.apps.includes(a.code);
    if (u.role === 'super_admin') return h('span', { class: 'chip on ro' }, a.name);
    const box = h('input', {
      type: 'checkbox', checked: on, disabled: !canManage(u),
      onchange: async e => {
        try {
          await api('POST', `/api/users/${u.id}/apps`, { app: a.code, grant: e.target.checked });
          toast(`${a.name} ${e.target.checked ? 'given to' : 'removed from'} ${u.name}`);
          e.target.closest('.chip').classList.toggle('on', e.target.checked);
        } catch (ex) { e.target.checked = !e.target.checked; toast(ex.message); }
      },
    });
    return h('label', { class: `chip${on ? ' on' : ''}` }, box, a.name);
  }));

  const setStatus = async (u, status) => {
    const msg = {
      hold: `Put ${u.name} on hold? They are signed out of every app now and cannot sync until you reactivate them.`,
      revoked: `Revoke ${u.name}? They are signed out everywhere and can no longer sign in or send data.`,
      active: `Reactivate ${u.name}?`,
    }[status];
    if (!confirm(msg)) return;
    try { await api('POST', `/api/users/${u.id}/status`, { status }); toast(`${u.name}: ${STATUS[status]}`); route(); }
    catch (ex) { toast(ex.message); }
  };

  const rows = users.map(u => {
    const m = canManage(u);
    return h('div', { class: 'person' },
      h('div', {},
        h('div', { class: 'row', style: 'gap:8px' }, h('span', { class: 'nm' }, u.name), statusPill(u.status),
          u.locked && h('span', { class: 'pill bad' }, 'Locked: wrong passwords')),
        h('div', { class: 'small muted', style: 'margin-top:4px' }, `Login ID: ${u.login_id}`),
        h('div', { class: 'small muted' }, ROLE[u.role], ' · ', u.employment === 'freelancer' ? 'Freelancer' : 'Staff', u.phone ? ` · ${u.phone}` : ''),
        h('div', { class: 'small muted' }, `Last sign-in: ${ago(u.last_login_at)}`, u.must_change_pw ? ' · has not set own password yet' : '')),
      h('div', {},
        h('div', { class: 'small muted', style: 'margin-bottom:6px' }, u.role === 'super_admin' ? 'Apps (all, as Super Admin)' : 'Apps this person can use'),
        appChips(u),
        h('div', { class: 'small muted', style: 'margin:12px 0 6px' }, 'Assigned audits'),
        u.role === 'engineer'
          ? (u.audits.length ? h('div', { class: 'chips' }, u.audits.map(a => h('span', { class: 'pill tag', title: a.id }, a.tag))) : h('span', { class: 'small muted' }, 'None — assign in Audits'))
          : h('span', { class: 'small muted' }, 'All audits (manager role)')),
      h('div', { class: 'actions' },
        m && u.status !== 'active' && h('button', { class: 'btn small', onclick: () => setStatus(u, 'active') }, 'Reactivate'),
        m && u.status === 'active' && h('button', { class: 'btn small warn', onclick: () => setStatus(u, 'hold') }, 'Put on hold'),
        m && u.status !== 'revoked' && h('button', { class: 'btn small danger', onclick: () => setStatus(u, 'revoked') }, 'Revoke'),
        m && h('button', {
          class: 'btn small ghost', onclick: async () => {
            if (!confirm(`Make a new temporary password for ${u.name}? Their current password stops working and they are signed out.`)) return;
            try { const r = await api('POST', `/api/users/${u.id}/reset-password`); showCredentials(u.name, u.login_id, r.temp_password, true); }
            catch (ex) { toast(ex.message); }
          },
        }, 'Reset password'),
        m && u.locked && h('button', {
          class: 'btn small', onclick: async () => {
            try { await api('POST', `/api/users/${u.id}/unlock`); toast(`${u.name} can sign in again`); route(); }
            catch (ex) { toast(ex.message); }
          },
        }, 'Unlock'),
        m && h('button', { class: 'btn small ghost', onclick: () => editPerson(u) }, 'Edit')));
  });

  holder.replaceChildren(
    h('div', { class: 'head' },
      h('div', {}, h('h1', {}, 'Team & access'),
        h('p', { class: 'muted small' }, 'One Login ID for every app. Tick the apps each person may use; changes apply immediately.')),
      h('button', { class: 'btn', onclick: () => addPerson(auditList) }, 'Add person')),
    h('div', { class: 'card' }, rows.length ? rows : h('p', { class: 'empty' }, 'No one yet.')));
}

function addPerson(auditList) {
  const me = state.me;
  openDialog('Add a person', f => {
    const role = h('select', { name: 'role' },
      h('option', { value: 'engineer' }, 'Engineer — collects data in apps'),
      me.role === 'super_admin' && h('option', { value: 'head' }, 'Head Member — manages work and the team'),
      me.role === 'super_admin' && h('option', { value: 'super_admin' }, 'Super Admin — full control'));
    const type = h('select', {
      name: 'employment', onchange: e => { if (e.target.value === 'freelancer') role.value = 'engineer'; role.disabled = e.target.value === 'freelancer'; },
    }, h('option', { value: 'staff' }, 'Staff'), h('option', { value: 'freelancer' }, 'Freelancer'));
    f.append(
      h('div', { class: 'fgrid' },
        field('Full name', h('input', { type: 'text', name: 'name', required: true })),
        field('Login ID', h('input', { type: 'text', name: 'login_id', required: true, autocomplete: 'off' }), 'e.g. ravi.k')),
      h('div', { class: 'fgrid', style: 'margin-top:12px' },
        field('Phone (optional)', h('input', { type: 'tel', name: 'phone' })),
        field('Type', type)),
      h('label', { class: 'f', style: 'margin-top:12px' }, 'Role', role),
      h('fieldset', {}, h('legend', {}, 'Apps they can use'),
        h('div', { class: 'chips' }, state.apps.map(a => h('label', { class: 'chip' }, h('input', { type: 'checkbox', name: 'apps', value: a.code }), a.name)))),
      h('fieldset', {}, h('legend', {}, 'Audits they work on (only these industries)'),
        auditList.length
          ? h('div', { class: 'chips' }, auditList.filter(a => !['published', 'archived'].includes(a.status)).map(a =>
            h('label', { class: 'chip', title: `${a.client_name} — ${a.site_name}` }, h('input', { type: 'checkbox', name: 'audits', value: a.id }), `${a.industry_tag} · ${a.title}`)))
          : h('p', { class: 'small muted' }, 'No audits yet — you can assign later.')),
      h('p', { class: 'note', style: 'margin-top:14px' }, 'A one-time temporary password is created. You will see it once, on the next screen.'));
  }, async f => {
    const checked = name => [...f.querySelectorAll(`input[name=${name}]:checked`)].map(i => i.value);
    const r = await api('POST', '/api/users', {
      name: val(f, 'name'), login_id: val(f, 'login_id'), phone: val(f, 'phone') || null,
      employment: val(f, 'employment'), role: f.elements.role.value, apps: checked('apps'), audits: checked('audits'),
    });
    route();
    showCredentials(r.user.name, r.user.login_id, r.temp_password, false);
  }, { submitLabel: 'Create login' });
}

function editPerson(u) {
  const me = state.me;
  openDialog(`Edit ${u.name}`, f => f.append(
    field('Full name', h('input', { type: 'text', name: 'name', value: u.name, required: true })),
    field('Phone', h('input', { type: 'tel', name: 'phone', value: u.phone || '' })),
    field('Type', h('select', { name: 'employment' },
      h('option', { value: 'staff', selected: u.employment === 'staff' }, 'Staff'),
      h('option', { value: 'freelancer', selected: u.employment === 'freelancer' }, 'Freelancer'))),
    me.role === 'super_admin' && field('Role', h('select', { name: 'role' },
      Object.entries(ROLE).map(([k, v]) => h('option', { value: k, selected: u.role === k }, v))))), async f => {
    const body = { name: val(f, 'name'), phone: val(f, 'phone'), employment: val(f, 'employment') };
    if (f.elements.role) body.role = f.elements.role.value;
    await api('PATCH', `/api/users/${u.id}`, body);
    toast('Saved');
    route();
  });
}

// ---------- audits ----------
async function audits(holder) {
  const [{ audits: list }, { users }] = await Promise.all([api('GET', '/api/audits'), api('GET', '/api/users')]);
  const engineers = users.filter(u => u.role === 'engineer' && u.status === 'active');

  const rows = list.map(a => {
    const add = h('select', {
      'aria-label': 'Add person to audit', onchange: async e => {
        if (!e.target.value) return;
        try { await api('POST', `/api/audits/${a.id}/assign`, { user_id: e.target.value, assign: true }); route(); } catch (ex) { toast(ex.message); }
      },
    }, h('option', { value: '' }, '+ Add person'), engineers.filter(u => !a.team.some(t => t.id === u.id)).map(u => h('option', { value: u.id }, u.name)));
    return h('tr', {},
      h('td', {}, h('span', { class: 'pill tag' }, a.industry_tag), h('div', { class: 'small muted', style: 'margin-top:4px' }, a.id, ' · ', a.fy)),
      h('td', {}, h('a', { href: `#/audit/${encodeURIComponent(a.id)}` }, h('b', {}, a.title)),
        h('div', { class: 'small muted' }, a.client_name, ' — ', a.site_name)),
      h('td', {}, h('select', {
        'aria-label': 'Audit status', onchange: async e => {
          try { await api('POST', `/api/audits/${a.id}/status`, { status: e.target.value }); toast('Status updated'); } catch (ex) { toast(ex.message); route(); }
        },
      }, Object.entries(AUDIT_STATUS).map(([k, v]) => h('option', { value: k, selected: a.status === k }, v)))),
      h('td', {},
        h('div', { class: 'chips', style: 'margin-bottom:6px' }, a.team.map(t => h('span', { class: 'chip on ro' }, t.name,
          h('button', {
            type: 'button', 'aria-label': `Remove ${t.name}`, title: 'Remove from this audit', onclick: async () => {
              try { await api('POST', `/api/audits/${a.id}/assign`, { user_id: t.id, assign: false }); route(); } catch (ex) { toast(ex.message); }
            },
          }, '×')))),
        add),
      h('td', { class: 'n' }, a.records), h('td', { class: 'n' }, a.open_tasks), h('td', { class: 'small' }, ago(a.last_sync)));
  });

  holder.replaceChildren(
    h('div', { class: 'head' },
      h('div', {}, h('h1', {}, 'Audits'), h('p', { class: 'muted small' }, 'Each plant gets a system-made industry tag; the public site shows only that tag, never the client name. ',
        'Engineers see only the audits they are added to.')),
      h('button', { class: 'btn', onclick: newAudit }, 'New audit')),
    h('div', { class: 'card scroll' }, list.length ? h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Tag'), h('th', {}, 'Audit'), h('th', {}, 'Status'), h('th', {}, 'Team'),
        h('th', { class: 'n' }, 'Records'), h('th', { class: 'n' }, 'Open tasks'), h('th', {}, 'Last sync'))),
      h('tbody', {}, rows)) : h('p', { class: 'empty' }, 'No audits yet. Create the first one.')));
}

async function newAudit() {
  const { clients } = await api('GET', '/api/clients');
  openDialog('New audit', f => {
    const newClient = h('div', {},
      h('div', { class: 'fgrid', style: 'margin-top:12px' },
        field('Client name (private)', h('input', { type: 'text', name: 'client_name' })),
        field('Sector', h('select', { name: 'sector' }, Object.entries(state.sectors).map(([k, v]) => h('option', { value: k }, `${v} (${k})`))))));
    const newSite = h('div', {}, h('div', { class: 'fgrid', style: 'margin-top:12px' },
      field('Plant / unit name (private)', h('input', { type: 'text', name: 'site_name' })),
      field('Cluster code', h('input', { type: 'text', name: 'cluster', maxlength: 3 }), '3 letters for the town or cluster, such as SRT for Surat or ANK for Ankleshwar')));
    const siteSel = h('select', { name: 'site_id', onchange: e => { newSite.hidden = !!e.target.value; } });
    const fillSites = cid => {
      const c = clients.find(x => x.id === cid);
      siteSel.replaceChildren(h('option', { value: '' }, 'New plant…'), ...(c?.sites || []).map(s => h('option', { value: s.id }, `${s.name} (${s.industry_tag})`)));
      newSite.hidden = false;
    };
    const clientSel = h('select', {
      name: 'client_id', onchange: e => { newClient.hidden = !!e.target.value; fillSites(e.target.value); },
    }, h('option', { value: '' }, 'New client…'), clients.map(c => h('option', { value: c.id }, c.name)));
    fillSites('');
    f.append(field('Client', clientSel), newClient, h('label', { class: 'f', style: 'margin-top:12px' }, 'Plant', siteSel), newSite,
      h('div', { class: 'fgrid', style: 'margin-top:12px' },
        field('Financial year', h('input', { type: 'text', name: 'fy', value: currentFy(), required: true })),
        field('Audit title', h('input', { type: 'text', name: 'title', required: true, value: 'Energy audit' }))));
  }, async f => {
    const r = await api('POST', '/api/audits', {
      client_id: val(f, 'client_id') || null, client_name: val(f, 'client_name'), sector: val(f, 'sector'),
      site_id: val(f, 'site_id') || null, site_name: val(f, 'site_name'), cluster: val(f, 'cluster'),
      fy: val(f, 'fy'), title: val(f, 'title'),
    });
    toast(`Audit ${r.id} created`);
    route();
  }, { submitLabel: 'Create audit' });
}

// ---------- one audit: what has been collected ----------
async function auditPage(holder, id) {
  const [data, { tasks: allTasks }] = await Promise.all([api('GET', `/api/audits/${encodeURIComponent(id)}/data`), api('GET', '/api/tasks')]);
  const a = data.audit;
  const tasksHere = allTasks.filter(t => t.audit_id === a.id);
  const open = tasksHere.filter(t => t.status !== 'done');
  const apps = Object.entries(data.apps);

  // Per app: count per equipment kind, and who collected how much and when.
  const appCards = apps.map(([code, recs]) => {
    const byKind = new Map(), byPerson = new Map();
    for (const r of recs) {
      byKind.set(r.kind || '—', (byKind.get(r.kind || '—') || 0) + 1);
      const p = byPerson.get(r.recorded_by) || { n: 0, last: 0 };
      byPerson.set(r.recorded_by, { n: p.n + 1, last: Math.max(p.last, r.taken_at) });
    }
    const appOpen = open.filter(t => t.app === code);
    return h('section', { class: 'card', style: 'margin-top:16px' },
      h('div', { class: 'cap' }, h('h2', {}, appName(code)), h('span', { class: 'small muted' }, `${recs.length} records`)),
      h('div', { class: 'grid2' },
        h('div', {}, h('div', { class: 'section-title', style: 'margin-top:0' }, 'Equipment recorded'),
          h('div', { class: 'ilist' }, [...byKind].map(([k, n]) => h('div', { class: 'it' }, h('div', { class: 'main-t' }, h('b', {}, k)), h('div', { class: 'trail' }, String(n)))))),
        h('div', {}, h('div', { class: 'section-title', style: 'margin-top:0' }, 'Collected by'),
          h('div', { class: 'ilist' }, [...byPerson].map(([who, v]) => h('div', { class: 'it' },
            h('span', { class: 'av' }, initials(who)), h('div', { class: 'main-t' }, h('b', {}, who), h('span', {}, `last on ${fmtDate(v.last)}`)),
            h('div', { class: 'trail' }, `${v.n} records`)))))),
      appOpen.length ? h('p', { class: 'small', style: 'margin-top:10px' }, h('span', { class: 'pill warn' }, `${appOpen.length} task${appOpen.length > 1 ? 's' : ''} still open`), ' ',
        appOpen.map(t => t.title).join(' · ')) : null);
  });

  // Power quality recordings saved here by the analyser (ops.arenergyservices.in/pqa/).
  const pq = (data.apps.power || []).filter(r => r.kind === 'pq_recording');
  const ROLE_AT = { main: 'Plant main input', pcc: 'PCC panel', mcc: 'MCC panel' };
  const pqCard = h('section', { class: 'card', style: 'margin-top:16px' },
    h('div', { class: 'cap' }, h('h2', {}, 'Power quality'),
      h('a', { class: 'btn', href: `/pqa/?audit=${encodeURIComponent(a.id)}`, target: '_blank', rel: 'noopener' }, icon('live'), 'Open the analyser for this audit')),
    h('p', { class: 'sub' }, 'AI power quality analysis to IEEE 519, EN 50160 and IEC 61000. Recordings saved from the analyser appear here and go into the report.'),
    pq.length ? h('div', { class: 'ilist' }, pq.map(r => {
      const p = r.payload, c = p.compliance?.summary, hl = p.health;
      return h('div', { class: 'it' },
        h('div', { class: 'main-t' }, h('b', {}, p.panel || r.tag || 'Recording'),
          h('span', {}, [ROLE_AT[p.role] || p.role, p.instrument, p.start && `${p.start} to ${p.end}`, `${(p.samples || 0).toLocaleString('en-IN')} samples`, r.recorded_by].filter(Boolean).join(' · '))),
        h('div', { class: 'trail' },
          c ? h('span', { class: `pill ${c.fail ? 'bad' : c.warn ? 'warn' : 'ok'}` }, `${c.pass}/${c.total} checks pass`) : null, ' ',
          hl?.overall != null ? h('span', { class: 'pill soft' }, `health ${Math.round(hl.overall)}`) : null));
    })) : h('p', { class: 'empty' }, 'No power quality recording saved for this audit yet.'));

  const photos = data.files.filter(f => f.mime.startsWith('image/'));
  const others = data.files.filter(f => !f.mime.startsWith('image/'));
  // Wrapped in h(): it skips empty (null) sections and flattens lists; replaceChildren would print them.
  holder.replaceChildren(h('div', {},
    h('div', { class: 'head' },
      h('div', {},
        h('p', { class: 'small' }, h('a', { href: '#/audits' }, '‹ All audits')),
        h('h1', {}, a.title),
        h('p', { class: 'muted small' }, h('span', { class: 'pill tag' }, a.industry_tag), ` ${a.id} · ${a.fy} · ${AUDIT_STATUS[a.status] || a.status}`,
          a.client_name ? ` · ${a.client_name} — ${a.site_name}` : ''))),

    h('section', { class: 'metrics' },
      h('div', { class: 'metric' }, h('div', { class: 'top' }, icon('doc'), 'Records'), h('div', { class: 'v' }, apps.reduce((n, [, r]) => n + r.length, 0)),
        h('div', { class: 'mnote' }, `across ${apps.length} app${apps.length === 1 ? '' : 's'}`)),
      h('div', { class: 'metric' }, h('div', { class: 'top' }, icon('overview'), 'Photos & files'), h('div', { class: 'v' }, data.files.length),
        h('div', { class: 'mnote' }, `${photos.length} images`)),
      h('div', { class: 'metric' }, h('div', { class: 'top' }, icon('tasks'), 'Tasks still open'), h('div', { class: 'v' }, open.length),
        h('div', { class: `mnote${open.some(t => t.due_at && t.due_at < Date.now()) ? ' bad' : ''}` },
          open.some(t => t.due_at && t.due_at < Date.now()) ? 'some are overdue' : `${tasksHere.length - open.length} done`))),

    open.length ? h('section', { class: 'card', style: 'margin-top:16px' }, h('h2', {}, 'Still to collect'),
      h('p', { class: 'sub' }, 'Open tasks on this audit'),
      h('div', { class: 'ilist' }, open.map(t => h('div', { class: 'it' },
        h('div', { class: 'main-t' }, h('b', {}, t.title), h('span', {}, [t.assignee_name || 'Unassigned', t.app && appName(t.app)].filter(Boolean).join(' · '))),
        h('div', { class: 'trail' }, t.due_at ? (t.due_at < Date.now() ? h('span', { class: 'pill bad' }, `overdue · ${fmtDay(t.due_at)}`) : `due ${fmtDay(t.due_at)}`) : (t.status === 'running' ? 'running' : 'to do')))))) : null,

    pqCard,

    apps.length ? appCards : h('section', { class: 'card', style: 'margin-top:16px' }, h('p', { class: 'empty' }, 'Nothing has been synced for this audit yet.')),

    photos.length ? h('section', { class: 'card', style: 'margin-top:16px' }, h('h2', {}, 'Photos'),
      h('p', { class: 'sub' }, 'With what each one shows. Thermal and normal photos of the same spot share a pair.'),
      h('div', { class: 'photos' }, photos.map(f => h('figure', {},
        h('a', { href: f.url, target: '_blank', rel: 'noopener' }, h('img', { src: f.url, alt: f.caption || 'Photo', loading: 'lazy' })),
        h('figcaption', {}, h('b', {}, f.caption || 'No caption'),
          h('span', {}, [f.kind === 'thermal' ? 'Thermal' : 'Photo', f.equipment_tag, appName(f.app), f.uploaded_by_name].filter(Boolean).join(' · '))))))) : null,

    others.length ? h('section', { class: 'card', style: 'margin-top:16px' }, h('h2', {}, 'Other files'),
      h('div', { class: 'ilist' }, others.map(f => h('div', { class: 'it' },
        h('div', { class: 'main-t' }, h('a', { href: f.url }, h('b', {}, f.original_name || f.id)), h('span', {}, [f.caption, f.equipment_tag, appName(f.app)].filter(Boolean).join(' · '))),
        h('div', { class: 'trail' }, `${Math.ceil(f.size / 1024)} KB`))))) : null));
}

// ---------- tasks ----------
async function tasks(holder) {
  const [{ tasks: list }, { audits: auditList }, { users }] = await Promise.all([api('GET', '/api/tasks'), api('GET', '/api/audits'), api('GET', '/api/users')]);
  const setStatus = async (t, status) => {
    try { await api('POST', `/api/tasks/${t.id}/status`, { status }); route(); } catch (ex) { toast(ex.message); }
  };
  const card = t => {
    const late = t.status !== 'done' && t.due_at && t.due_at < Date.now();
    return h('div', { class: `task${late ? ' late' : ''}` },
      h('div', { class: 't' }, t.title),
      h('div', { class: 'meta' }, h('span', { class: 'pill tag' }, t.industry_tag), t.app && h('span', {}, appName(t.app)),
        h('span', {}, t.assignee_name || 'Unassigned'),
        t.due_at && h('span', { style: late ? 'color:var(--bad);font-weight:600' : '' }, `due ${fmtDay(t.due_at)}`),
        t.status === 'running' && h('span', {}, `started ${ago(t.started_at)}`),
        t.status === 'done' && h('span', {}, `done ${fmtDay(t.done_at)}`)),
      h('div', { class: 'row', style: 'gap:6px' },
        t.status === 'todo' && h('button', { class: 'btn small', onclick: () => setStatus(t, 'running') }, 'Start'),
        t.status === 'running' && h('button', { class: 'btn small', onclick: () => setStatus(t, 'done') }, 'Mark done'),
        t.status !== 'todo' && h('button', { class: 'btn small ghost', onclick: () => setStatus(t, 'todo') }, 'Back to to-do')));
  };
  const col = (title, items, emptyText) => h('div', { class: 'card' }, h('h2', {}, `${title} (${items.length})`),
    items.length ? items.map(card) : h('p', { class: 'empty' }, emptyText));
  const done = list.filter(t => t.status === 'done').slice(0, 30);
  holder.replaceChildren(
    h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Tasks'), h('p', { class: 'muted small' }, 'What the team is doing now and next.')),
      h('button', { class: 'btn', disabled: !auditList.length, title: auditList.length ? null : 'Create an audit first', onclick: () => newTask(auditList, users) }, 'New task')),
    h('div', { class: 'cols' },
      col('Running', list.filter(t => t.status === 'running'), 'Nothing running.'),
      col('To do', list.filter(t => t.status === 'todo'), 'Nothing waiting.'),
      col('Done', done, 'Nothing finished yet.')));
}

function newTask(auditList, users) {
  openDialog('New task', f => f.append(
    field('Audit', h('select', { name: 'audit_id', required: true }, auditList.map(a => h('option', { value: a.id }, `${a.industry_tag} · ${a.title}`)))),
    field('Task', h('input', { type: 'text', name: 'title', required: true, placeholder: 'e.g. Compressor leak test, Unit 1' })),
    h('div', { class: 'fgrid' },
      field('App (optional)', h('select', { name: 'app' }, h('option', { value: '' }, '—'), state.apps.map(a => h('option', { value: a.code }, a.name)))),
      field('Due date (optional)', h('input', { type: 'date', name: 'due' }))),
    field('Assign to', h('select', { name: 'assignee' }, h('option', { value: '' }, 'Nobody yet'),
      users.filter(u => u.status === 'active').map(u => h('option', { value: u.id }, `${u.name} (${ROLE[u.role]})`))),
    'Assigning also adds the person to that audit.')), async f => {
    await api('POST', '/api/tasks', { audit_id: val(f, 'audit_id'), title: val(f, 'title'), app: val(f, 'app') || null, due: val(f, 'due') || null, assignee: val(f, 'assignee') || null });
    toast('Task added');
    route();
  }, { submitLabel: 'Add task' });
}

// ---------- activity ----------
const ACTION = {
  'login.console': 'signed in to the Console', 'login.app': 'signed in to an app', 'login.failed': 'failed to sign in',
  'login.locked': 'was locked after repeated wrong passwords', 'login.refused': 'was refused sign-in',
  'access.refused': 'was blocked from an app', 'password.changed': 'changed their password', 'password.reset': 'reset a password',
  'user.created': 'added a person', 'user.updated': 'edited a person', 'user.activated': 'reactivated a person',
  'user.put_on_hold': 'put a person on hold', 'user.revoked': 'revoked a person', 'app.granted': 'gave app access',
  'app.removed': 'removed app access', 'audit.created': 'created an audit', 'audit.status': 'changed audit status',
  'audit.assigned': 'added a person to an audit', 'audit.unassigned': 'removed a person from an audit',
  'task.created': 'added a task', 'task.status': 'moved a task', sync: 'synced data', 'setup.super_admin_created': 'set up the Console',
  'user.unlocked': 'unlocked a person', 'file.uploaded': 'uploaded a file', 'file.downloaded': 'downloaded a file',
  'admin.recovered': 'recovered an admin account on the server',
};
const describe = a => [ACTION[a.action] || a.action, (a.target_name || a.target) && `· ${a.target_name || a.target}`, a.detail && `· ${a.detail}`].filter(Boolean).join(' ');

async function activity(holder) {
  const { activity: list } = await api('GET', '/api/activity?limit=300');
  holder.replaceChildren(
    h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Activity log'),
      h('p', { class: 'muted small' }, 'Every sign-in, change, sync and blocked attempt. This log cannot be edited or deleted.'))),
    h('div', { class: 'card scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Who'), h('th', {}, 'What'), h('th', {}, 'Details'), h('th', {}, 'From'))),
      h('tbody', {}, list.map(a => h('tr', {},
        h('td', { class: 'small', style: 'white-space:nowrap' }, fmtDate(a.at)),
        h('td', {}, a.user_name || '—'),
        h('td', { style: /refused|failed|locked|revoked/.test(a.action) ? 'color:var(--bad)' : '' }, ACTION[a.action] || a.action),
        h('td', { class: 'small muted' }, [a.target_name || a.target, a.detail].filter(Boolean).join(' · ')),
        h('td', { class: 'small muted' }, a.ip || '')))))));
}

// ---------- my account ----------
async function account(holder) {
  const err = h('div', { class: 'err', hidden: true });
  const form = h('form', { class: 'card', style: 'max-width:460px' }, h('h2', {}, 'Change password'),
    field('Current password', h('input', { type: 'password', name: 'current', required: true, autocomplete: 'current-password' })),
    field('New password', h('input', { type: 'password', name: 'next', required: true, autocomplete: 'new-password' }), 'At least 10 characters, letters and numbers. Signs you out on other devices.'),
    err, h('div', { class: 'foot', style: 'margin-top:16px' }, h('button', { class: 'btn', type: 'submit' }, 'Save')));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.hidden = true;
    try {
      await api('POST', '/api/change-password', { current: form.elements.current.value, next: form.elements.next.value });
      form.reset();
      toast('Password changed');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
  holder.replaceChildren(
    h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'My account'),
      h('p', { class: 'muted small' }, `${state.me.name} · ${state.me.login_id} · ${ROLE[state.me.role]}`))),
    form);
}

// ---------- field apps ----------
// The download page lives on this same server (/apps/); its apps.json has versions and history.
async function releases() {
  try {
    const r = await fetch('/apps/apps.json', { cache: 'no-store' });
    return r.ok ? (await r.json()).apps || {} : {};
  } catch { return {}; }
}
const fmtSize = n => `${(n / 1e6).toFixed(1)} MB`;

function appIcon(rel, size = 44) {
  return rel?.icon
    ? h('img', { class: 'appicon', src: `/apps/${rel.icon}`, alt: '', width: size, height: size })
    : h('span', { class: 'appicon blank', style: `width:${size}px;height:${size}px` }, icon('phone'));
}

async function appsPage(holder) {
  const [{ apps }, rel] = await Promise.all([api('GET', '/api/apps'), releases()]);
  const field = apps.filter(a => a.field);
  const web = apps.filter(a => a.web);
  const planned = apps.filter(a => !a.field && !a.web);
  holder.replaceChildren(
    h('div', { class: 'head' },
      h('div', {}, h('h1', {}, 'Field apps'),
        h('p', { class: 'muted small' }, 'The Android apps engineers use on site. Each sends its readings here by itself; open an app to see its data, people and versions.')),
      h('a', { class: 'btn', href: '/apps/', target: '_blank', rel: 'noopener' }, icon('download'), 'Download page')),
    h('div', { class: 'appgrid' }, field.map(a => {
      const r = rel[a.code];
      return h('a', { class: 'appcard', href: `#/apps/${a.code}` },
        h('div', { class: 'row' }, appIcon(r), h('div', { style: 'min-width:0' }, h('b', {}, a.name), h('div', { class: 'small muted' }, a.tagline))),
        h('div', { class: 'list' },
          h('div', {}, h('span', { class: 'muted' }, 'Version'), r ? h('span', {}, `v${r.version} · ${fmtDay(Date.parse(r.released_at))}`) : h('span', { class: 'muted' }, 'Not published')),
          h('div', {}, h('span', { class: 'muted' }, 'Records'), h('span', { class: 'num' }, a.records.toLocaleString('en-IN'))),
          h('div', {}, h('span', { class: 'muted' }, 'Audits with data'), h('span', { class: 'num' }, a.audits)),
          h('div', {}, h('span', { class: 'muted' }, 'People with access'), h('span', { class: 'num' }, a.people.filter(p => p.status === 'active').length)),
          h('div', {}, h('span', { class: 'muted' }, 'Last sync'), h('span', {}, a.last_sync ? ago(a.last_sync) : 'Nothing yet'))));
    })),
    h('h2', { class: 'section-title' }, 'Web apps'),
    h('div', { class: 'appgrid' }, web.map(a => h('a', { class: 'appcard', href: '/pqa/', target: '_blank', rel: 'noopener' },
      h('div', { class: 'row' }, h('span', { class: 'appicon blank', style: 'width:44px;height:44px' }, icon('live')),
        h('div', { style: 'min-width:0' }, h('b', {}, a.name), h('div', { class: 'small muted' }, a.tagline))),
      h('div', { class: 'list' },
        h('div', {}, h('span', { class: 'muted' }, 'Where'), h('span', {}, 'ops.arenergyservices.in/pqa')),
        h('div', {}, h('span', { class: 'muted' }, 'Records'), h('span', { class: 'num' }, a.records.toLocaleString('en-IN'))),
        h('div', {}, h('span', { class: 'muted' }, 'Audits with data'), h('span', { class: 'num' }, a.audits)),
        h('div', {}, h('span', { class: 'muted' }, 'People with access'), h('span', { class: 'num' }, a.people.filter(p => p.status === 'active').length)))))),
    h('h2', { class: 'section-title' }, 'Planned'),
    h('div', { class: 'card' }, h('div', { class: 'chips' }, planned.map(a => h('span', { class: 'pill soft' }, a.name))),
      h('p', { class: 'small muted', style: 'margin-top:10px' }, 'These can already be ticked for people in Team & access; their apps are not built yet.')));
}

async function appPage(holder, code) {
  const [d, rel] = await Promise.all([api('GET', `/api/apps?app=${encodeURIComponent(code)}`), releases()]);
  const a = d.app, r = rel[code];
  const metric = (ic, label, value, note) => h('div', { class: 'metric' }, h('div', { class: 'top' }, icon(ic), label), h('div', { class: 'v' }, value), note);
  const active = a.people.filter(p => p.status === 'active');
  holder.replaceChildren(
    h('div', { class: 'head' },
      h('div', { class: 'row' }, appIcon(r, 52),
        h('div', {}, h('h1', {}, a.name), h('p', { class: 'muted small' }, a.tagline || 'Planned app'))),
      r && h('a', { class: 'btn', href: r.apk_url, download: '' }, icon('download'), `Download v${r.version}`)),
    h('section', { 'aria-label': 'At a glance', class: 'metrics' },
      metric('doc', 'Records', a.records.toLocaleString('en-IN'), h('div', { class: 'mnote' }, `from ${a.recorders} ${a.recorders === 1 ? 'person' : 'people'}`)),
      metric('audits', 'Audits with data', a.audits, h('div', { class: 'mnote' }, 'not counting deleted records')),
      metric('team', 'People with access', active.length, h('div', { class: 'mnote' }, a.people.length > active.length ? `${a.people.length - active.length} on hold or removed` : 'all active')),
      metric('clock', 'Last sync', a.last_sync ? ago(a.last_sync) : '—', h('div', { class: 'mnote' }, a.last_sync ? fmtDate(a.last_sync) : 'nothing received yet'))),

    h('h2', { class: 'section-title' }, 'Audits with data from this app'),
    h('div', { class: 'card scroll' }, d.audits.length ? h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Tag'), h('th', {}, 'Audit'), h('th', {}, 'Status'), h('th', {}, 'What was recorded'), h('th', { class: 'n' }, 'Records'), h('th', {}, 'Last sync'))),
      h('tbody', {}, d.audits.map(x => h('tr', {},
        h('td', {}, h('span', { class: 'pill tag' }, x.industry_tag)),
        h('td', {}, h('a', { href: `#/audit/${encodeURIComponent(x.audit_id)}` }, x.title), h('div', { class: 'small muted' }, x.audit_id, ' · ', x.site_name)),
        h('td', {}, AUDIT_STATUS[x.status] || x.status),
        h('td', {}, h('div', { class: 'chips' }, x.kinds.map(k => h('span', { class: 'pill soft' }, `${k.kind.replace(/_/g, ' ')} ${k.n}`)))),
        h('td', { class: 'n' }, x.records),
        h('td', {}, ago(x.last_sync))))))
      : h('p', { class: 'empty' }, 'Nothing has been synced from this app yet.')),

    h('div', { class: 'grid2' },
      h('div', {},
        h('h2', { class: 'section-title' }, 'People with access'),
        h('div', { class: 'card' }, a.people.length ? h('div', { class: 'list' }, a.people.map(p => h('div', {},
          h('span', {}, p.name, h('span', { class: 'small muted' }, p.role === 'super_admin' ? ' · Super Admin' : p.employment === 'freelancer' ? ' · Freelancer' : ' · Staff')),
          h('span', { class: `pill ${p.status}` }, p.status === 'active' ? 'Active' : p.status === 'hold' ? 'On hold' : 'Removed'))))
          : h('p', { class: 'empty' }, 'Nobody yet.'),
          h('p', { class: 'small muted', style: 'margin-top:10px' }, 'Give or remove access in ', h('a', { href: '#/team' }, 'Team & access'), '.'))),
      h('div', {},
        h('h2', { class: 'section-title' }, 'Versions'),
        h('div', { class: 'card' }, r ? h('div', { class: 'list' }, (r.history || []).map(v => h('div', {},
          v.hosted ? h('a', { href: v.apk_url, download: '' }, `v${v.version}`) : h('span', {}, `v${v.version}`),
          h('span', { class: 'small muted' }, `${fmtDay(Date.parse(v.released_at))} · ${v.hosted ? fmtSize(v.size) : 'no longer hosted'}`))))
          : h('p', { class: 'empty' }, 'No version published yet.'),
          r && h('p', { class: 'small muted', style: 'margin-top:10px' }, 'Installed apps check for a newer version every few hours and offer it. File: ', r.file, '.')))));
}

// ---------- getting started ----------
function guidePage(holder) {
  const step = (n, title, ...body) => h('li', { class: 'gstep' }, h('span', { class: 'gnum', 'aria-hidden': 'true' }, n), h('div', {}, h('b', {}, title), h('p', { class: 'small muted' }, ...body)));
  holder.replaceChildren(
    h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Getting started'),
      h('p', { class: 'muted small' }, 'How a new engineer goes from no account to recording on site.'))),
    h('div', { class: 'grid2' },
      h('div', {},
        h('h2', { class: 'section-title' }, 'For the admin'),
        h('ol', { class: 'card gsteps' },
          step(1, 'Add the person', 'In ', h('a', { href: '#/team' }, 'Team & access'), ', add them, tick the apps they may use and pass on the Login ID and temporary password.'),
          step(2, 'Add them to audits (optional)', 'Assign existing audits in ', h('a', { href: '#/audits' }, 'Audits'), '. Engineers can also start a new audit from the app at a new plant; it then appears here.'),
          step(3, 'Hold or remove access', 'On hold or Removed takes effect at the person’s next sync. Their unsent work stays on the phone.'))),
      h('div', {},
        h('h2', { class: 'section-title' }, 'For the engineer'),
        h('ol', { class: 'card gsteps' },
          step(1, 'Install the app', 'Open ', h('a', { href: '/apps/', target: '_blank', rel: 'noopener' }, 'the download page'), ' on the phone, tap Download and allow the install.'),
          step(2, 'Sign in', 'Use the Login ID and temporary password, then set your own password. One login works in every app you were given.'),
          step(3, 'Choose or start an audit', 'Pick an audit you were added to, or tap Start a new audit and enter the company, plant, sector and cluster code.'),
          step(4, 'Fill in the plant details', 'Details already saved for the audit in another app are offered, so nothing is typed twice.'),
          step(5, 'Record, online or not', 'Everything saves on the phone first and syncs by itself. The header shows “Synced”, “Offline” or how many changes are waiting.')))),
    h('h2', { class: 'section-title' }, 'More'),
    h('div', { class: 'card list' },
      h('div', {}, h('a', { href: '#/apps' }, 'Field apps'), h('span', { class: 'small muted' }, 'versions, people and data per app')),
      h('div', {}, h('a', { href: '/apps/', target: '_blank', rel: 'noopener' }, 'Download page'), h('span', { class: 'small muted' }, 'ops.arenergyservices.in/apps')),
      h('div', {}, h('a', { href: 'https://arenergyservices.in', target: '_blank', rel: 'noopener' }, 'Public website'), h('span', { class: 'small muted' }, 'arenergyservices.in'))));
}

route();
