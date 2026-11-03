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
const ROLE = { super_admin: 'Super Admin', head: 'Admin', engineer: 'Engineer' };
// The apps this person works with in the Console (all for a Super Admin, their own for an Admin).
const mine = code => (state.myApps || []).includes(code);
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
// Sign-in, first run and own password: the website's dark panel with the form on a card.
function gate(title, sub, formKids, onSubmit, btnLabel, note) {
  const err = h('div', { class: 'err', hidden: true });
  const form = h('form', { class: 'gate-form' },
    h('div', { class: 'gate-title' }, h('h2', {}, title), h('p', {}, sub)),
    formKids, err,
    h('button', { class: 'btn go', type: 'submit' }, btnLabel, h('span', { class: 'go-ic', 'aria-hidden': 'true' }, icon('arrow'))),
    note && h('p', { class: 'gate-note' }, icon('lock'), h('span', {}, note)));
  form.querySelectorAll('input[type=password]').forEach(addShowToggle);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.hidden = true;
    const b = form.querySelector('button[type=submit]');
    b.disabled = true;
    try { await onSubmit(form); } catch (ex) { err.textContent = ex.message; err.hidden = false; } finally { b.disabled = false; }
  });
  const point = (ic, k, t) => h('li', {}, h('span', { class: 'gate-ic', 'aria-hidden': 'true' }, icon(ic)), h('span', {}, h('small', {}, k), h('span', {}, t)));
  root.replaceChildren(h('div', { class: 'gate' },
    h('main', { class: 'gate-panel' },
      h('div', { class: 'gate-top' }, brand(),
        h('a', { class: 'gate-site', href: 'https://arenergyservices.in/', target: '_blank', rel: 'noopener' },
          'arenergyservices.in', icon('external'), h('span', { class: 'sr' }, ' (public website, opens in a new tab)'))),
      h('div', { class: 'gate-body' },
        h('div', { class: 'gate-copy' },
          h('span', { class: 'kicker' }, 'Ops workspace'),
          h('h1', {}, 'Your team, audits and ', h('em', {}, 'field data'), ' in one place.'),
          h('p', {}, 'The private side of AR Energy Services: who is in the field, every audit and what it has collected, and who may use which app.'),
          h('ul', { class: 'gate-points' },
            point('team', 'One login', 'One Login ID for every field app.'),
            point('shield', 'Private by default', 'Client names and readings stay behind this sign-in.'),
            point('live', 'Live', 'See who is recording, in which app, for which audit.'))),
        form)),
    h('footer', { class: 'gate-foot' }, h('span', {}, '© AR Energy Services · private, not indexed'),
      h('a', { href: '/apps/' }, 'Download the field apps'))));
  form.querySelector('input')?.focus();
}

// A "Show" button inside a password field.
function addShowToggle(input) {
  const b = h('button', { type: 'button', class: 'pw-show', 'aria-pressed': 'false', 'aria-label': 'Show password' }, 'Show');
  b.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.textContent = show ? 'Hide' : 'Show';
    b.setAttribute('aria-pressed', String(show));
  });
  const wrap = h('span', { class: 'pw' });
  input.replaceWith(wrap);
  wrap.append(input, b);
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
  gate('Sign in', 'For Super Admins and Admins. Field engineers sign in from their app.', [
    field('Login ID', h('input', { type: 'text', name: 'login_id', required: true, autocomplete: 'username' })),
    field('Password', h('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password' })),
  ], async f => {
    await api('POST', '/api/login', { login_id: val(f, 'login_id'), password: f.elements.password.value });
    await loadMe();
    if (location.hash !== '#/billing') location.hash = '#/overview';
    route();
  }, 'Sign in', 'Five wrong passwords lock the account from that network for 15 minutes; an admin can unlock it sooner. You are signed out after 30 minutes idle.');
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
  state.myApps = r.my_apps;
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
  arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
  plus: ['M12 5v14', 'M5 12h14'],
  warn: ['M12 4 2.5 20h19z', 'M12 10v4.5', 'M12 17.5h.01'],
  back: ['M19 12H5', 'M11 6l-6 6 6 6'],
  tick: ['M5 12.5l4.5 4.5L19 7.5'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  cloud: ['M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6 9.5 4.25 4.25 0 0 0 7 18z'],
  check: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M8.5 12.2l2.4 2.4 4.6-4.8'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
  // one symbol per app, as on the website
  'app-survey': ['M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4'],
  'app-textile': ['M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11zM9 14a3 3 0 0 0 3 3'],
  'app-pump': ['M3 8h13l-3-3M21 16H8l3 3'],
  'app-air': ['M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h7'],
  'app-heat': ['M12 22c4 0 7-2.7 7-6.8 0-4.4-3.6-6.6-4.6-10.7-2.4 1.5-3.4 4-3.4 6-1.2-.8-2-2.2-2.2-3.6C6.7 9 5 11.5 5 15.2 5 19.3 8 22 12 22z'],
  'app-cool': ['M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z'],
  'app-motor': ['M4 17a8 8 0 1 1 16 0M12 17l4-5M4 21h16'],
  'app-power': ['M2 12h3l3-7 4 14 3-9 2 2h5'],
  'app-bills': ['M7 3h10v18l-3-2-2 2-2-2-3 2z', 'M10 8h4M10 12h4'],
  chevron: ['M6 9l6 6 6-6'],
  lock: ['M6 11h12v9H6z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
  shield: ['M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6z', 'M9 12l2 2 4-4'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
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

// ---------- shell: the website's dark header with a pill menu; a dock on phones ----------
const PAGES = [
  { id: 'overview', label: 'Overview', group: 'Monitor', icon: 'overview' },
  { id: 'tasks', label: 'Tasks', group: 'Monitor', icon: 'tasks' },
  { id: 'activity', label: 'Activity log', group: 'Monitor', icon: 'activity' },
  { id: 'team', label: 'Team & access', group: 'Manage', icon: 'team' },
  { id: 'audits', label: 'Audits', group: 'Manage', icon: 'audits' },
  { id: 'reports', label: 'Previous reports', group: 'Manage', icon: 'doc' },
  { id: 'apps', label: 'App console', group: 'Field apps', icon: 'apps' },
  { id: 'report-studio', label: 'Report Studio', group: 'Tools', icon: 'doc' },
  { id: 'guide', label: 'Getting started', group: null, icon: 'guide' },
  { id: 'account', label: 'My account', group: null, icon: 'account' },
  { id: 'more', label: 'More', group: null, icon: 'more' },
];
const GROUPS = ['Monitor', 'Manage', 'Field apps', 'Tools'];
// Field apps get a sub-page each (from /api/me), listed under "All apps".
const menuPages = () => PAGES;
// Each field app's data in the Console, listed under App console in the menu.
const fieldPages = () => (state.apps || []).filter(a => a.field && mine(a.code)).map(a => ({ id: `apps/${a.code}`, label: a.name, icon: 'phone', sub: true }));
const TOOLS = [
  { href: '/pqa/', label: 'Power Quality analyser', app: 'power' },
  { href: 'https://billing.arenergyservices.in/', label: 'GST Billing', app: 'bills' },
];
const toolLinks = () => TOOLS.filter(t => mine(t.app));

let heroSlot = null;
// A page's title block (older pages): sits at the top of the page, on paper.
function pageHead(...kids) {
  return h('div', { class: 'head' }, ...kids);
}

// The v2 title block: small heading, title with an italic part, one line on the page, main action.
function pageTitle({ kicker, title, em, sub, action }) {
  return h('header', { class: 'ptitle' },
    h('div', {}, kicker && h('span', { class: 'kicker' }, kicker),
      h('h1', {}, title, em && h('em', {}, em)),
      sub && h('p', {}, sub)),
    action);
}

// The dark round "go" button of the website: label plus a circle with a symbol.
const goBtn = (label, ic, attrs = {}) => h(attrs.href ? 'a' : 'button', { class: 'btn go', type: attrs.href ? null : 'button', ...attrs },
  label, h('span', { class: 'go-ic', 'aria-hidden': 'true' }, icon(ic)));

function brand() {
  return h('a', { class: 'brand', href: '#/overview' }, h('img', { src: '/logo.png', alt: '' }),
    h('span', {}, h('b', {}, 'ARES Console'), h('small', {}, 'AR Energy Services')));
}

async function signOut() {
  await api('POST', '/api/logout').catch(() => {});
  state.me = null;
  route();
}

// A menu item: page links stay in the Console, external ones open a new tab.
const mi = (href, ic, label, ext) => h('a', { href, role: 'menuitem', ...(ext ? { target: '_blank', rel: 'noopener' } : {}) },
  icon(ic), label, ext && h('span', { class: 'sr' }, ' (opens in a new tab)'));

// A button with a small menu under it. Closes on a choice, Escape or a click elsewhere.
function dropdown(btn, items) {
  const wrap = h('div', { class: 'dd' }, btn);
  let pop = null;
  const close = () => {
    pop?.remove(); pop = null;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', outside, true);
    document.removeEventListener('keydown', esc);
  };
  const outside = e => { if (pop && !wrap.contains(e.target)) close(); };
  const esc = e => { if (e.key === 'Escape') { close(); btn.focus(); } };
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.addEventListener('click', () => {
    if (pop) return close();
    pop = h('div', { class: 'popover', role: 'menu' }, items());
    pop.addEventListener('click', e => { if (e.target.closest('a')) close(); });
    wrap.append(pop);
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', outside, true);
    document.addEventListener('keydown', esc);
    pop.querySelector('a, button')?.focus();
  });
  return wrap;
}

function shell(active, content) {
  const me = state.me;
  const on = id => id === active || (id === 'apps' && active.startsWith('apps'));
  const cur = id => on(id) ? { class: 'on', 'aria-current': 'page' } : {};
  const link = (id, label) => h('a', { href: `#/${id}`, ...cur(id) }, label);
  // Tasks shows how many are overdue; filled in once the task list arrives.
  const badge = h('span', { class: 'nbadge', hidden: true });
  const tasksLink = h('a', { href: '#/tasks', ...cur('tasks') }, 'Tasks', badge);
  api('GET', '/api/tasks', null, { background: true }).then(({ tasks }) => {
    const n = tasks.filter(t => t.status !== 'done' && t.due_at && t.due_at < Date.now()).length;
    if (n) { badge.replaceChildren(h('span', { class: 'sr' }, 'overdue: '), String(n)); badge.hidden = false; }
  }).catch(() => {});
  const ddBtn = (label, isOn) => h('button', { type: 'button', class: isOn ? 'on' : null }, label, icon('chevron'));

  const fieldMenu = dropdown(ddBtn('Field apps', on('apps')),
    () => [mi('#/apps', 'apps', 'App console'), fieldPages().map(p => mi(`#/${p.id}`, 'phone', p.label))]);
  const moreMenu = dropdown(ddBtn('More', ['activity', 'report-studio', 'guide', 'more'].includes(active)),
    () => [mi('#/activity', 'activity', 'Activity log'), mi('#/report-studio', 'doc', 'Report Studio'),
      toolLinks().map(t => mi(t.href, 'external', t.label, true)),
      mi('#/guide', 'guide', 'Getting started'), mi('/apps/', 'download', 'Download page', true)]);
  const account = dropdown(
    h('button', { type: 'button', class: 'acct', 'aria-label': `Account menu: ${me.name}, ${ROLE[me.role]}` },
      h('span', { class: 'av' }, initials(me.name)), h('span', { class: 'acct-name' }, me.name.split(' ')[0])),
    () => [h('div', { class: 'who' }, h('b', {}, me.name), h('span', { class: 'small muted' }, `${me.login_id} · ${ROLE[me.role]}`)),
      mi('#/account', 'account', 'My account'),
      h('button', { type: 'button', role: 'menuitem', onclick: signOut }, icon('signout'), 'Sign out')]);

  const nav = h('nav', { class: 'topnav', 'aria-label': 'Main' }, brand(),
    h('div', { class: 'links' }, link('overview', 'Overview'), link('audits', 'Audits'), link('team', 'Team'), tasksLink,
      fieldMenu, link('reports', 'Reports'), moreMenu),
    h('div', { class: 'nav-end' }, h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Search people, audits and tags', onclick: openSearch }, icon('search')),
      account));

  // The overview puts its greeting here and turns the header dark (heroHead).
  heroSlot = h('div', { class: 'hero-slot' });

  // Phones: a dock with the four main pages and More.
  const dockLink = (id, ic, lbl) => h('a', { href: `#/${id}`, ...cur(id) }, icon(ic), lbl);
  const inDock = ['overview', 'audits', 'tasks', 'team'].includes(active);
  const dock = h('nav', { class: 'dock', 'aria-label': 'Sections' },
    dockLink('overview', 'overview', 'Overview'), dockLink('audits', 'audits', 'Audits'),
    dockLink('tasks', 'tasks', 'Tasks'), dockLink('team', 'team', 'Team'),
    h('a', { href: '#/more', class: inDock ? null : 'on', 'aria-current': active === 'more' ? 'page' : null }, icon('more'), 'More'));

  root.replaceChildren(h('div', { class: 'shell' }, h('header', { class: 'hero' }, nav, heroSlot), h('main', { class: 'main' }, content)), dock);
}

// Overview only: the dark header with the field photo, holding the page's opening.
function heroHead(...kids) {
  heroSlot.replaceChildren(...kids.filter(Boolean));
  heroSlot.parentElement.classList.add('dark');
  return document.createComment('page opening');
}

// Search (the magnifier in the menu, or "/"): people, audits and tasks, straight to their page.
async function openSearch() {
  const input = h('input', { type: 'search', placeholder: 'Name, Login ID, tag or task', 'aria-label': 'Search' });
  const out = h('div', { class: 'sresults', role: 'list' });
  const dlg = h('dialog', { class: 'search', 'aria-label': 'Search' }, h('div', { class: 'body' },
    h('label', { class: 'sfield' }, icon('search'), input), out));
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('a')) dlg.close(); });
  dlg.showModal();
  const [{ users }, { audits }, { tasks }] = await Promise.all([
    api('GET', '/api/users').catch(() => ({ users: [] })), api('GET', '/api/audits').catch(() => ({ audits: [] })),
    api('GET', '/api/tasks').catch(() => ({ tasks: [] }))]);
  const show = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) return out.replaceChildren(h('p', { class: 'empty' }, 'Type a name, Login ID, industry tag or task.'));
    const has = (...xs) => xs.some(x => String(x || '').toLowerCase().includes(q));
    const row = (href, ic, b, sub) => h('a', { href, role: 'listitem', class: 'mrow' }, h('span', { class: 'mic', 'aria-hidden': 'true' }, icon(ic)), h('span', { class: 'mt' }, h('b', {}, b), h('span', {}, sub)));
    const hits = [
      ...users.filter(u => has(u.name, u.login_id)).slice(0, 6).map(u => row(`#/team?p=${u.id}`, 'team', u.name, `${ROLE[u.role]} · ${u.login_id}`)),
      ...audits.filter(a => has(a.industry_tag, a.id, a.title, a.client_name, a.site_name)).slice(0, 6).map(a => row(`#/audit/${encodeURIComponent(a.id)}`, 'audits', `${a.industry_tag} · ${a.title}`, `${a.client_name} — ${a.site_name}`)),
      ...tasks.filter(t => has(t.title, t.industry_tag)).slice(0, 6).map(t => row('#/tasks', 'tasks', t.title, [t.industry_tag, t.assignee_name || 'Not assigned'].join(' · '))),
    ];
    out.replaceChildren(...(hits.length ? hits : [h('p', { class: 'empty' }, 'Nothing found.')]));
  };
  input.addEventListener('input', show);
  show();
  input.focus();
}
document.addEventListener('keydown', e => {
  if (e.key === '/' && state.me && !e.target.closest('input, textarea, select, [contenteditable]') && !document.querySelector('dialog[open]')) { e.preventDefault(); openSearch(); }
});

async function route() {
  clearInterval(state.timer);
  if (!state.me) {
    try { await loadMe(); } catch {
      const s = await api('GET', '/api/setup').catch(() => ({ needed: false }));
      return s.needed ? setupScreen() : loginScreen();
    }
  }
  if (state.me.must_change_pw) return changePasswordScreen();
  // Signed in on the way to GST Billing: carry on there.
  if (location.hash === '#/billing') { history.replaceState(null, '', '/#/overview'); return location.replace('/api/billing/sso'); }
  const [page, param, param2] = (location.hash.replace('#/', '') || 'overview').split('?')[0].split('/');
  state.query = new URLSearchParams(location.hash.split('?')[1] || '');
  const fn = page === 'audit' && param ? h2 => auditPage(h2, decodeURIComponent(param))
    : page === 'apps' && param && param2 ? h2 => appAuditPage(h2, decodeURIComponent(param), decodeURIComponent(param2))
    : page === 'apps' && param ? h2 => appPage(h2, decodeURIComponent(param))
      : ({ overview, team, audits, tasks, activity, account, apps: appsPage, guide: guidePage, reports: reportsPage, 'report-studio': reportStudioPage, more: morePage }[page] || overview);
  const holder = h('div', { class: 'page' }, h('p', { class: 'muted' }, 'Loading…'));
  const activeId = page === 'audit' ? 'audits' : page === 'apps' && param ? `apps/${param}` : page;
  shell([...menuPages(), ...fieldPages()].some(p => p.id === activeId) || page === 'guide' ? activeId : 'overview', holder);
  try {
    await fn(holder);
  } catch (ex) {
    if (ex.status !== 401) holder.replaceChildren(h('div', { class: 'err' }, ex.message));
  }
}
window.addEventListener('hashchange', route);

// ---------- More (phones: everything that is not in the dock) ----------
function morePage(holder) {
  const me = state.me;
  const row = (href, ic, label, note, ext) => h('a', { class: 'mrow', href, ...(ext ? { target: '_blank', rel: 'noopener' } : {}) },
    h('span', { class: 'mic', 'aria-hidden': 'true' }, icon(ic)),
    h('span', { class: 'mt' }, h('b', {}, label), note && h('span', {}, note)),
    ext && h('span', { class: 'sr' }, ' (opens in a new tab)'));
  const group = (title, rows, extra) => h('section', { class: 'card mgroup' }, h('div', { class: 'cap' }, h('h2', { class: 'kick' }, title), extra), rows);
  const tagline = code => state.apps.find(a => a.code === code)?.tagline;
  holder.replaceChildren(
    pageHead(h('div', {}, h('h1', {}, 'More'))),
    group('Field apps', fieldPages().map(p => row(`#/${p.id}`, 'phone', p.label, tagline(p.id.slice(5)))), h('a', { href: '#/apps', class: 'small' }, 'App console')),
    group('Records', [row('#/reports', 'doc', 'Previous reports', 'Finalised audits'), row('#/activity', 'activity', 'Activity log', 'Every sign-in, change and sync')]),
    group('Tools', [toolLinks().map(t => row(t.href, 'external', t.label, tagline(t.app), true)), row('#/report-studio', 'doc', 'Report Studio', 'Coming soon')]),
    group('Help', [row('#/guide', 'guide', 'Getting started', 'From new login to recording on site'), row('/apps/', 'download', 'Download page', 'Newest version of every field app', true)]),
    h('section', { class: 'card mgroup' },
      h('div', { class: 'macct' }, h('span', { class: 'av lg' }, initials(me.name)),
        h('span', {}, h('h2', {}, me.name), h('span', { class: 'small' }, `${ROLE[me.role]} · ${me.login_id}`))),
      h('a', { class: 'mrow plain', href: '#/account' }, icon('account'), 'My account and password'),
      h('button', { class: 'mrow plain danger', type: 'button', onclick: signOut }, icon('signout'), 'Sign out')));
}

// ---------- overview ----------
const PERIODS = [[7, 'Week'], [30, 'Month'], [90, 'Quarter'], [365, 'Year']];
const PERSON_COLUMNS = [
  { key: 'name', label: 'Person', get: p => p.name.toLowerCase() },
  { key: 'hours', label: 'Hours', num: true, get: p => p.hours },
  { key: 'records', label: 'Records', num: true, get: p => p.records },
  { key: 'records_per_hour', label: 'Per hour', num: true, get: p => p.records_per_hour ?? -1 },
  { key: 'active_days', label: 'Days', num: true, get: p => p.active_days },
  { key: 'tasks_done', label: 'Tasks done', num: true, get: p => p.tasks_done },
  { key: 'on_time_pct', label: 'On time', num: true, get: p => p.on_time_pct ?? -1 },
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
  const date = d => new Date(`${d}T12:00:00`);
  const label = d => date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const summary = total
    ? `${total} records in the last 14 days. Busiest day: ${label(busiest.d)} with ${busiest.n}. Today so far: ${today.n}.`
    : 'No records have been synced in the last 14 days.';
  const top = niceMax(Math.max(...days.map(x => x.n)));
  const xl = (x, i) => i === days.length - 1 ? 'Today' : i === 0 ? label(x.d) : date(x.d).getDay() === 0 ? 'Sun' : String(date(x.d).getDate());
  return h('div', {},
    h('p', { class: 'rc-sum' }, total
      ? [h('b', {}, String(total)), ' records, all apps. Busiest day ', h('b', {}, label(busiest.d)), ` with ${busiest.n}. Today so far: `, h('b', {}, String(today.n)), '.']
      : 'No records have been synced in the last 14 days.'),
    h('div', { class: 'rc', role: 'img', 'aria-label': `Bar chart of records collected per day. ${summary}` },
      h('div', { class: 'rc-y', 'aria-hidden': 'true' }, [top, top / 2, 0].map(t => h('span', {}, Number.isInteger(t) ? String(t) : t.toFixed(1)))),
      h('div', { class: 'rc-plot', 'aria-hidden': 'true' },
        h('div', { class: 'rc-bars' }, days.map((x, i) => {
          const cls = !x.n ? 'zero' : i === days.length - 1 ? 'today' : x === busiest ? 'top' : '';
          return h('div', { title: `${label(x.d)}: ${x.n} records` }, h('i', { class: cls, style: x.n ? `height:${(x.n / top) * 160}px` : null }));
        })),
        h('div', { class: 'rc-x' }, days.map((x, i) => h('span', { class: total && x === busiest ? 'b' : null }, i % 2 === 0 || i === days.length - 1 ? xl(x, i) : ''))))),
    // Same data as text for screen readers.
    h('table', { class: 'sr' }, h('caption', {}, 'Records per day'),
      h('tbody', {}, days.map(x => h('tr', {}, h('th', {}, label(x.d)), h('td', {}, x.n))))));
}

function peopleTable(people) {
  const wrap = h('div', { class: 'scroll' });
  const sub = p => {
    const base = `${p.employment === 'freelancer' ? 'Freelancer' : 'Staff'} · ${ROLE[p.role]}`;
    const extra = p.working_now ? h('span', { class: 'ok' }, 'in the field') : p.status === 'hold' ? h('span', { class: 'warn' }, 'on hold')
      : p.status === 'revoked' ? h('span', { class: 'bad' }, 'revoked') : null;
    return h('span', {}, base, extra && ' · ', extra);
  };
  const render = () => {
    const col = PERSON_COLUMNS.find(c => c.key === state.sort.key) || PERSON_COLUMNS[1];
    const rows = [...people].sort((a, b) => {
      const x = col.get(a), y = col.get(b);
      return (x > y ? 1 : x < y ? -1 : 0) * state.sort.dir;
    });
    wrap.replaceChildren(h('table', { class: 'htable' },
      h('thead', {}, h('tr', {}, PERSON_COLUMNS.map(c => h('th', {
        class: c.num ? 'n' : null, scope: 'col',
        'aria-sort': c.key === col.key ? (state.sort.dir > 0 ? 'ascending' : 'descending') : null,
      }, h('button', {
        type: 'button', onclick: () => {
          state.sort = c.key === col.key ? { key: c.key, dir: -state.sort.dir } : { key: c.key, dir: c.num || c.key === 'last_active' ? -1 : 1 };
          render();
        },
      }, c.label, c.key === col.key ? (state.sort.dir > 0 ? ' ↑' : ' ↓') : ''))))),
      h('tbody', {}, rows.length ? rows.map(p => h('tr', {},
        h('td', {}, h('span', { class: 'hp' }, h('span', { class: `av s38${p.status !== 'active' ? ' dim' : ''}`, 'aria-hidden': 'true' }, initials(p.name)),
          h('span', { class: 'hp-n' }, h('b', {}, p.name), sub(p)))),
        h('td', { class: 'n strong' }, String(p.hours)), h('td', { class: 'n' }, String(p.records)),
        h('td', { class: 'n' }, p.records_per_hour ?? '—'), h('td', { class: 'n' }, String(p.active_days)),
        h('td', { class: 'n' }, String(p.tasks_done)),
        h('td', { class: 'n' }, p.on_time_pct == null ? '—' : `${p.on_time_pct}%`, p.overdue ? h('span', { class: 'od' }, `${p.overdue} overdue`) : null),
        h('td', { class: 'la' }, ago(p.last_active))))
        : h('tr', {}, h('td', { colspan: PERSON_COLUMNS.length, class: 'empty' }, 'No team members yet. Add people in Team & access.')))));
  };
  render();
  return wrap;
}

const dur = ms => { const m = Math.round(ms / 60000); return m < 60 ? `${m} m` : `${Math.floor(m / 60)} h ${m % 60} m`; };
const hourLabel = hr => hr === 12 ? '12 pm' : hr === 0 || hr === 24 ? '12 am' : hr < 12 ? `${hr} am` : `${hr - 12} pm`;

async function overview(holder, { background = false } = {}) {
  const [d, { audits: auditList }, { tasks: taskList }, { users }] = await Promise.all([
    api('GET', `/api/dashboard?days=${state.days}`, null, { background }),
    api('GET', '/api/audits', null, { background }).catch(() => ({ audits: [] })),
    api('GET', '/api/tasks', null, { background }).catch(() => ({ tasks: [] })),
    api('GET', '/api/users', null, { background }).catch(() => ({ users: [] }))]);
  const t = d.totals;
  const now = Date.now();
  const periodName = (PERIODS.find(p => p[0] === d.days)?.[1] || `${d.days} days`).toLowerCase();
  const me = state.me;
  const running = auditList.filter(a => !CLOSED.has(a.status));
  const open = taskList.filter(x => x.status !== 'done');
  const overdue = open.filter(isLate).sort((a, b) => a.due_at - b.due_at);
  const locked = users.filter(u => u.locked);
  const tempPw = users.filter(u => u.must_change_pw && u.status === 'active' && !u.locked && u.role === 'engineer');
  const working = d.working_now;
  const first = firstName(me.name);
  const hr = new Date().getHours();
  const greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';

  // ---- the dark header: greeting, period, five figures ----
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Period for the figures on this page' },
    PERIODS.map(([n, label]) => h('button', {
      type: 'button', 'aria-pressed': String(n === state.days),
      onclick: () => { if (n !== state.days) { state.days = n; overview(holder); } },
    }, label)));
  const sentence = [];
  if (overdue.length) sentence.push(`${inWords(overdue.length)} task${overdue.length === 1 ? ' is' : 's are'} past ${overdue.length === 1 ? 'its' : 'their'} due date`);
  if (locked.length) sentence.push(`${locked.map(u => u.name).join(' and ')} ${locked.length === 1 ? 'is' : 'are'} locked out`);
  const onSchedule = open.length - overdue.length;
  const sub = (sentence.length ? `${sentence.join(' and ').replace(/^./, c => c.toUpperCase())}. ` : '')
    + (open.length ? `${sentence.length ? 'The other' : 'All'} ${inWords(onSchedule, true)} open task${onSchedule === 1 ? ' is' : 's are'} on schedule.` : 'No open tasks.');
  const kpi = (ic, v, b, note, bad) => h('div', { class: `okpi${bad ? ' bad' : ''}` }, h('span', { class: 'ok-ic', 'aria-hidden': 'true' }, icon(ic)),
    h('span', { class: 'ok-v' }, v), h('span', { class: 'ok-t' }, h('b', {}, b), h('span', {}, note)));
  const stageCount = s => running.filter(a => a.status === s).length;
  const last14 = d.records_per_day.reduce((s, x) => s + x.n, 0);
  const opening = heroHead(h('div', { class: 'ov-top' },
    h('div', { class: 'ov-greet' },
      h('span', { class: 'livechip' }, `Live · ${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}, ${timeOf(now)}`),
      h('h1', {}, `${greet}, ${first}. `, working.length
        ? [h('em', {}, `${inWords(working.length)} ${working.length === 1 ? 'engineer' : 'engineers'}`), ` ${working.length === 1 ? 'is' : 'are'} in the field right now.`]
        : 'Nobody is in the field right now.'),
      h('p', {}, sub),
      h('div', { class: 'ov-acts' },
        overdue.length ? goBtn('Review overdue tasks', 'arrow', { href: '#/tasks', class: 'btn go white' }) : goBtn('Open tasks', 'arrow', { href: '#/tasks', class: 'btn go white' }),
        h('button', { type: 'button', class: 'ghostw', onclick: newAudit }, icon('plus'), 'New audit'))),
    seg),
  h('div', { class: 'ov-kpis-wrap' }, h('section', { class: 'ov-kpis', 'aria-label': `At a glance, this ${periodName}` },
    kpi('live', String(working.length), 'Working now', working.length ? working.map(w => `${firstName(w.name)} in ${appName(w.app)}`).join(', ') : 'nobody in an app'),
    kpi('doc', t.records.toLocaleString('en-IN'), `Records this ${periodName}`, `${last14.toLocaleString('en-IN')} in the last 14 days`),
    kpi('clock', `${t.hours} h`, 'Hours logged', `in field apps this ${periodName}`),
    kpi('audits', String(running.length), 'Running audits', [stageCount('in_field') && `${stageCount('in_field')} in the field`, stageCount('review') && `${stageCount('review')} in review`].filter(Boolean).join(', ') || 'none in the field'),
    kpi('warn', String(overdue.length), 'Overdue tasks', overdue.length ? `oldest was due ${fmtDay(overdue[0].due_at)}` : 'nothing overdue', overdue.length > 0))));

  // ---- In the field today ----
  const sess = d.sessions_today || d.working_now.map(w => ({ ...w, open: true }));
  const sessEnd = s => s.open ? now : (s.ended_at || s.last_seen_at || s.started_at);
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const hOf = ms => (ms - day0.getTime()) / 3600000;
  let from = 8, to = 20;
  for (const s of sess) { from = Math.min(from, Math.floor(hOf(s.started_at) / 2) * 2); to = Math.max(to, Math.ceil(hOf(sessEnd(s)) / 2) * 2); }
  from = Math.max(0, from); to = Math.min(24, to);
  const pct = ms => `${Math.max(0, Math.min(100, (hOf(ms) - from) / (to - from) * 100)).toFixed(2)}%`;
  const nowPct = pct(now);
  const steps = (to - from) / 2;
  const peopleIds = [...new Set(sess.map(s => s.user_id))];
  const quiet = d.people.filter(p => p.role === 'engineer' && p.status === 'active' && !peopleIds.includes(p.id)).slice(0, Math.max(0, 5 - peopleIds.length));
  const tlRow = (id, name, sub, bars) => h('div', { class: 'tl-row' },
    h('div', { class: 'tl-who' }, h('span', { class: 'av s36', 'aria-hidden': 'true' }, initials(name)), h('span', {}, h('b', {}, name), h('span', {}, sub))),
    h('div', { class: 'tl-lane', style: `background-size:${100 / steps}% 100%` }, bars, h('span', { class: 'tl-now', style: `left:${nowPct}`, 'aria-hidden': 'true' })));
  const timeline = h('section', { class: 'ov-card today', 'aria-labelledby': 'h-today' },
    h('div', { class: 'tl-h' }, h('div', {}, h('span', { class: 'kicker' }, 'Today'), h('h2', { id: 'h-today' }, 'In the field today')),
      h('div', { class: 'tl-key' }, h('span', { class: 'k-open' }, 'Open now'), h('span', { class: 'k-done' }, 'Finished'))),
    h('div', { class: 'tl-scroll' }, h('div', { class: 'tl' },
      h('div', { class: 'tl-axis', 'aria-hidden': 'true' }, h('div', { class: 'tl-who' }), h('div', { class: 'tl-ticks' },
        Array.from({ length: steps + 1 }, (_, i) => h('span', { style: `left:${i / steps * 100}%`, class: i === 0 ? 'first' : i === steps ? 'last' : null }, hourLabel(from + i * 2))),
        h('span', { class: 'now', style: `left:${nowPct}` }, `Now ${timeOf(now).replace(/\s?[ap]m$/i, '')}`))),
      peopleIds.map(uid => {
        const ss = sess.filter(s => s.user_id === uid);
        const ms = ss.reduce((n, s) => n + (sessEnd(s) - s.started_at), 0);
        const recs = ss.reduce((n, s) => n + (s.records || 0), 0);
        return tlRow(uid, ss[0].name, `${dur(ms)} · ${recs} records`, ss.map(s => {
          const label = s.open ? [appName(s.app), s.industry_tag, `${s.records || 0} records`].filter(Boolean).join(' · ') : (APP_SHORT[s.app] || appName(s.app));
          return h(s.audit_id ? 'a' : 'span', {
            class: `tl-bar${s.open ? ' open' : ''}`, href: s.audit_id ? `#/audit/${encodeURIComponent(s.audit_id)}` : null,
            style: `left:${pct(s.started_at)};width:calc(${pct(sessEnd(s))} - ${pct(s.started_at)})`,
          }, label, h('span', { class: 'sr' }, s.open ? `, open since ${timeOf(s.started_at)}` : `, ${timeOf(s.started_at)} to ${timeOf(sessEnd(s))}`),
          s.open ? h('span', { class: 'tl-dot', 'aria-hidden': 'true' }) : null);
        }));
      }),
      quiet.map(p => tlRow(p.id, p.name, 'no session today', h('span', { class: 'tl-quiet' }, p.last_active ? `Last active ${ago(p.last_active)}` : 'Not active yet'))),
      !peopleIds.length && !quiet.length ? h('p', { class: 'empty' }, 'Nobody has opened a field app today.') : null)),
    h('p', { class: 'tl-note' }, 'Bars are the work sessions each field app logs. Select a bar to open that audit.'));

  // ---- Needs attention ----
  const unlock = async u => { try { await api('POST', `/api/users/${u.id}/unlock`); toast(`${u.name} can sign in again`); overview(holder); } catch (ex) { toast(ex.message); } };
  const attn = [
    overdue.length && h('div', { class: 'at' }, h('span', { class: 'at-ic bad', 'aria-hidden': 'true' }, icon('clock')),
      h('span', { class: 'at-t' }, h('b', {}, `${overdue.length} task${overdue.length === 1 ? '' : 's'} overdue`),
        h('span', {}, overdue.slice(0, 4).map(x => `${x.title} (${fmtDay(x.due_at)})`).join(', ')),
        h('a', { href: '#/tasks' }, 'Open tasks', icon('arrow')))),
    ...locked.map(u => h('div', { class: 'at' }, h('span', { class: 'at-ic bad', 'aria-hidden': 'true' }, icon('lock')),
      h('span', { class: 'at-t' }, h('b', {}, `${u.name} is locked out`), h('span', {}, 'Too many wrong passwords. The lock lifts by itself after 15 minutes, or unlock now.')),
      u.can_manage && h('button', { type: 'button', class: 'tbtn dark at-btn', onclick: () => unlock(u) }, 'Unlock'))),
    ...tempPw.map(u => h('div', { class: 'at' }, h('span', { class: 'at-ic warn', 'aria-hidden': 'true' }, icon('warn')),
      h('span', { class: 'at-t' }, h('b', {}, `${u.name} can’t sync yet`), h('span', {}, 'The temporary password hasn’t been replaced, so nothing they record can arrive.'),
        h('a', { href: `#/team?p=${u.id}` }, 'Open in Team', icon('arrow'))))),
  ].filter(Boolean);
  const attention = h('section', { class: 'ov-card attn', 'aria-labelledby': 'h-attn' },
    h('span', { class: 'kicker red' }, 'Needs attention'),
    h('h2', { id: 'h-attn' }, attn.length ? `${inWords(attn.length)} thing${attn.length === 1 ? '' : 's'} to sort out` : 'Nothing to sort out'),
    attn.length ? h('div', {}, attn) : h('p', { class: 'empty' }, 'No overdue tasks, and everyone can sign in and sync.'));

  // ---- Audit pipeline ----
  const pipe = h('section', { class: 'pipe', 'aria-labelledby': 'h-pipe' },
    h('div', { class: 'pipe-h' }, h('div', {}, h('span', { class: 'kicker sage' }, 'Audit pipeline'),
      h('h2', { id: 'h-pipe' }, `${inWords(running.length)} audit${running.length === 1 ? '' : 's'}, `, h('em', {}, 'first visit to report')),
      h('p', {}, 'Every running audit and the stage it is at. Open one to see what has been collected and what is still to do.')),
      goBtn('All audits', 'arrow', { href: '#/audits', class: 'btn go white' })),
    h('ol', {}, STAGES.map(([k, label], i) => {
      const xs = running.filter(a => a.status === k);
      return h('li', { class: k === 'in_field' ? 'hot' : xs.length ? null : 'none' },
        h('div', { class: 'p-top' }, h('span', { class: 'p-n' }, String(i + 1).padStart(2, '0')), h('span', {}, `${xs.length} audit${xs.length === 1 ? '' : 's'}`)),
        h('h3', {}, label),
        xs.length ? xs.map(a => {
          const lt = taskList.filter(x => x.audit_id === a.id && isLate(x)).length;
          return h('a', { class: 'p-a', href: `#/audit/${encodeURIComponent(a.id)}` },
            h('span', { class: 'p-tag' }, h('span', {}, a.industry_tag), lt ? h('span', { class: 'p-late' }, `${lt} late`) : null),
            h('span', { class: 'p-sub' }, a.records ? `${a.records} records · ${a.open_tasks} open task${a.open_tasks === 1 ? '' : 's'}` : `${a.title} · no data yet`));
        }) : h('p', { class: 'p-none' }, k === 'approved' ? 'Nothing is waiting to be published.' : 'No audit at this stage.'));
    })),
    (() => { const n = auditList.length - running.length; return n ? h('p', { class: 'pipe-foot' }, `${inWords(n)} finalised audit${n === 1 ? ' is' : 's are'} kept as ${n === 1 ? 'it was' : 'they were'} in `, h('a', { href: '#/reports' }, 'Previous reports'), '.') : null; })());

  // ---- How the team is doing ----
  const people = d.people.filter(p => p.role !== 'super_admin' || p.records || p.hours);
  const teamSec = h('section', { class: 'tdo', 'aria-labelledby': 'h-team' },
    h('div', { class: 'tdo-h' }, h('div', {}, h('span', { class: 'kicker' }, `This ${periodName}`), h('h2', { id: 'h-team' }, 'How the team is doing')),
      h('p', {}, 'Hours come from the work sessions each app logs; records are readings saved by that person. Select a column heading to sort.')),
    h('div', { class: 'tcard' }, peopleTable(people)));

  // ---- Records collected + Latest changes ----
  const chart = h('section', { class: 'ov-card rec', 'aria-labelledby': 'h-rec' }, h('span', { class: 'kicker' }, 'Last 14 days'),
    h('h2', { id: 'h-rec' }, 'Records collected'), recordsChart(d.records_per_day));
  const recent = h('section', { class: 'ov-card act', 'aria-labelledby': 'h-act' },
    h('div', { class: 'act-h' }, h('div', {}, h('span', { class: 'kicker' }, 'Activity'), h('h2', { id: 'h-act' }, 'Latest changes')), h('a', { href: '#/activity' }, 'Full log')),
    h('ol', {}, d.recent.slice(0, 6).map(a => h('li', {}, h('span', {}, h('b', {}, a.user_name || 'System'), ' ',
      h('span', { class: /locked|refused|failed/.test(a.action) ? 'bad' : null }, describe(a))), h('span', { class: 'when' }, ago(a.at))))));

  holder.replaceChildren(opening,
    h('div', { class: 'ov' },
      h('div', { class: 'ov-row' }, timeline, attention),
      pipe, teamSec,
      h('div', { class: 'ov-row' }, chart, recent)),
    h('footer', { class: 'ov-foot' },
      h('div', {}, h('span', {}, 'ARES Console · ops.arenergyservices.in · private, not indexed'),
        h('span', {}, h('a', { href: '#/guide' }, 'Getting started'), h('a', { href: '/apps/', target: '_blank', rel: 'noopener' }, 'Download page'), h('a', { href: 'https://arenergyservices.in/', target: '_blank', rel: 'noopener' }, 'Public website'))),
      h('div', { class: 'wordmark', 'aria-hidden': 'true' }, 'ARES Console')));

  clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (document.visibilityState === 'visible' && (location.hash.startsWith('#/overview') || !location.hash)) overview(holder, { background: true }).catch(() => {});
  }, 60000);
}

// ---------- team & access ----------
// Short app names for chips in tables.
const APP_SHORT = { survey: 'BRIEF', textile: 'JET', pump: 'Pump', air: 'Air', heat: 'Boiler', cool: 'AHU', motor: 'MLA', power: 'PQ', bills: 'GST' };
const appSym = code => icon(ICONS[`app-${code}`] ? `app-${code}` : 'apps');
const firstName = name => name.split(/\s+/)[0];
const STAGE_TONE = { draft: 'draft', in_field: 'ok', processing: 'proc', review: 'warn', approved: 'ok', published: 'soft', archived: 'soft' };
const stagePill = s => h('span', { class: `spill ${STAGE_TONE[s] || 'soft'}` }, AUDIT_STATUS[s] || s);
const timeOf = ms => new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
const dayTime = ms => {
  if (!ms) return 'never';
  const d = new Date(ms), today = new Date();
  return d.toDateString() === today.toDateString() ? `Today, ${timeOf(ms)}` : fmtDate(ms);
};

async function team(holder) {
  const [{ users }, { audits: auditList }, dash] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/audits'),
    api('GET', '/api/dashboard?days=30').catch(() => ({ working_now: [] }))]);
  const me = state.me;
  const live = id => dash.working_now.find(w => w.user_id === id);
  const needsAction = u => u.locked || (u.must_change_pw && u.status === 'active');
  const FILTERS = [['all', 'Everyone', () => true], ['action', 'Needs action', needsAction],
    ['active', 'Active', u => u.status === 'active'], ['hold', 'On hold', u => u.status === 'hold'], ['revoked', 'Revoked', u => u.status === 'revoked']];
  let filter = 'all', q = '';
  let sel = users.find(u => u.id === state.query.get('p')) || users.find(u => u.id === state.teamSel) || users.find(u => u.role === 'engineer') || users[0];

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

  const statusCell = (u, on) => u.locked ? h('span', { class: 'spill bad' }, icon('lock'), 'Locked')
    : u.status === 'hold' ? h('span', { class: 'spill warn' }, 'On hold')
      : u.status === 'revoked' ? h('span', { class: 'spill bad' }, 'Revoked')
        : u.must_change_pw ? h('span', { class: 'spill warn' }, 'Temporary password')
          : h('span', { class: `spill ok${on ? ' white' : ''}` }, 'Active');
  const avTone = u => u.status !== 'active' ? ' dim' : '';

  // ---- the table ----
  const tbody = h('tbody');
  const counts = h('div', { class: 'fpills', role: 'group', 'aria-label': 'Show' });
  const drawFilters = () => counts.replaceChildren(...FILTERS.map(([k, label, fn]) => {
    const n = users.filter(fn).length;
    return h('button', { type: 'button', 'aria-pressed': String(filter === k), onclick: () => { filter = k; drawFilters(); drawRows(); } },
      label, h('span', { class: k === 'action' && n ? 'cnt alert' : 'cnt' }, String(n)));
  }));
  const drawRows = () => {
    const fn = FILTERS.find(f => f[0] === filter)[2];
    const list = users.filter(fn).filter(u => !q || `${u.name} ${u.login_id}`.toLowerCase().includes(q));
    tbody.replaceChildren(...(list.length ? list.map(u => {
      const on = sel && u.id === sel.id;
      const w = live(u.id);
      return h('tr', { class: on ? 'sel' : u.locked ? 'tint-bad' : u.must_change_pw && u.status === 'active' ? 'tint-warn' : null },
        h('td', { class: 'pcell' }, h('button', { type: 'button', class: 'prow', 'aria-pressed': String(on), onclick: () => { sel = u; state.teamSel = u.id; drawRows(); drawPanel(); } },
          h('span', { class: `av${on ? ' deep' : avTone(u)}`, 'aria-hidden': 'true' }, initials(u.name)),
          h('span', { class: 'pn' }, h('b', {}, u.name), h('span', {}, u.login_id)))),
        h('td', { class: 'role' }, ROLE[u.role],
          u.owner ? h('span', { class: 'own' }, 'Main Super Admin') : h('span', {}, u.employment === 'freelancer' ? 'Freelancer' : 'Staff')),
        h('td', {}, u.role === 'super_admin' ? h('span', { class: 'mutedcell' }, 'All apps')
          : u.apps.length ? h('span', { class: 'achips' }, u.apps.filter(c => APP_SHORT[c]).map(c => h('span', {}, APP_SHORT[c]))) : h('span', { class: 'mutedcell' }, 'None')),
        h('td', {}, statusCell(u, on)),
        h('td', { class: w ? 'last live' : 'last' }, w ? 'In the field' : ago(u.last_login_at)));
    }) : [h('tr', {}, h('td', { colspan: 5, class: 'empty' }, 'No one here.'))]));
  };

  // ---- the person panel ----
  const panel = h('aside', { class: 'ppanel', 'aria-labelledby': 'p-name' });
  const drawPanel = () => {
    const u = sel;
    if (!u) return panel.replaceChildren(h('p', { class: 'empty' }, 'Select a person.'));
    const m = u.can_manage;
    const w = live(u.id);
    const fn = firstName(u.name);
    // Engineers get field apps and the analyser; billing is for managers.
    const apps = state.apps.filter(a => mine(a.code) && (a.field || a.web) && (a.code !== 'bills' || u.role !== 'engineer'));
    const appRow = a => {
      const has = u.role === 'super_admin' || u.apps.includes(a.code);
      const box = h('input', {
        type: 'checkbox', checked: has, disabled: u.role === 'super_admin' || !u.can_change_apps.includes(a.code),
        onchange: async e => {
          try {
            await api('POST', `/api/users/${u.id}/apps`, { app: a.code, grant: e.target.checked });
            toast(`${a.name} ${e.target.checked ? 'given to' : 'removed from'} ${u.name}`);
            u.apps = e.target.checked ? [...u.apps, a.code] : u.apps.filter(c => c !== a.code);
            drawRows(); drawPanel();
          } catch (ex) { e.target.checked = !e.target.checked; toast(ex.message); }
        },
      });
      return h('label', { class: `arow${has ? ' on' : ''}` }, box, h('span', { class: 'aic', 'aria-hidden': 'true' }, appSym(a.code)),
        h('span', { class: 'an' }, a.name), !a.field && h('span', { class: 'anote' }, 'web app'));
    };
    const audits = u.audits.map(x => ({ ...x, a: auditList.find(a => a.id === x.id) }));
    panel.replaceChildren(
      h('div', { class: 'pp-top' },
        h('div', { class: 'pp-id' }, h('span', { class: 'av xl', 'aria-hidden': 'true' }, initials(u.name)),
          h('span', { class: 'pp-nm' }, h('h2', { id: 'p-name' }, u.name),
            h('span', { class: 'pp-role' }, `${ROLE[u.role]} · ${u.employment === 'freelancer' ? 'Freelancer' : 'Staff'}`),
            h('span', { class: 'pp-login' }, `Login ID ${u.login_id}`)),
          m && h('button', { type: 'button', class: 'obtn sm', onclick: () => editPerson(u) }, 'Edit')),
        h('div', { class: 'pp-state' }, statusCell(u, false),
          w && h('span', { class: 'livedot' }, `In ${appName(w.app)} since ${timeOf(w.started_at)}`)),
        h('dl', { class: 'pp-dl' },
          h('div', {}, h('dt', {}, 'Last sign-in'), h('dd', {}, dayTime(u.last_login_at))),
          h('div', {}, h('dt', {}, 'Password'), h('dd', {}, u.must_change_pw ? 'Temporary, not changed yet' : 'Own password set')),
          h('div', {}, h('dt', {}, 'Phone'), h('dd', { class: u.phone ? null : 'mutedcell' }, u.phone || 'Not added')))),
      h('fieldset', { class: 'pp-sec' }, h('legend', {}, u.role === 'super_admin' ? 'Apps (all, as Super Admin)' : `Apps ${fn} can use`),
        h('div', { class: 'arows' }, apps.map(appRow)),
        h('p', { class: 'pp-note' }, `Changes reach ${fn}’s phone at the next sync.`)),
      h('div', { class: 'pp-sec' },
        h('div', { class: 'pp-h' }, h('h3', {}, u.role === 'engineer' ? `Audits ${fn} works on` : 'Audits'),
          u.role === 'engineer' && m && h('button', { type: 'button', class: 'linkbtn', onclick: () => addToAudit(u, auditList) }, '+ Add to an audit')),
        u.role === 'engineer'
          ? (audits.length ? audits.map(x => h('a', { class: 'aud', href: `#/audit/${encodeURIComponent(x.id)}` },
            h('span', { class: 'tagpill' }, x.tag), h('span', { class: 'at' }, x.a?.title || x.id), x.a && stagePill(x.a.status)))
            : h('p', { class: 'pp-note' }, 'Not on any audit yet.'))
          : h('p', { class: 'pp-note' }, u.role === 'head' ? 'Admins see the audits of their apps.' : 'Super Admins see every audit.'),
        u.role === 'engineer' && h('p', { class: 'pp-note' }, 'Engineers see and add data only for these industries.')),
      m && h('div', { class: 'pp-sec last' }, h('h3', {}, 'Sign-in and access'),
        h('div', { class: 'pp-btns' },
          u.locked && h('button', {
            type: 'button', class: 'obtn dark', onclick: async () => {
              try { await api('POST', `/api/users/${u.id}/unlock`); toast(`${u.name} can sign in again`); route(); } catch (ex) { toast(ex.message); }
            },
          }, 'Unlock'),
          h('button', {
            type: 'button', class: 'obtn', onclick: async () => {
              if (!confirm(`Make a new temporary password for ${u.name}? Their current password stops working and they are signed out.`)) return;
              try { const r = await api('POST', `/api/users/${u.id}/reset-password`); showCredentials(u.name, u.login_id, r.temp_password, true); } catch (ex) { toast(ex.message); }
            },
          }, 'Reset password'),
          u.status !== 'active' && h('button', { type: 'button', class: 'obtn dark', onclick: () => setStatus(u, 'active') }, 'Reactivate'),
          u.status === 'active' && h('button', { type: 'button', class: 'obtn warn', onclick: () => setStatus(u, 'hold') }, 'Put on hold'),
          u.status !== 'revoked' && h('button', { type: 'button', class: 'obtn bad', onclick: () => setStatus(u, 'revoked') }, 'Revoke')),
        h('p', { class: 'pp-note' }, `Hold or Revoke signs ${fn} out of every app now. Work not yet synced stays on the phone.`)));
  };

  const search = h('input', { type: 'search', placeholder: 'Name or Login ID', oninput: e => { q = e.target.value.trim().toLowerCase(); drawRows(); } });
  drawFilters(); drawRows(); drawPanel();
  holder.replaceChildren(
    pageTitle({
      kicker: 'Manage', title: 'Team & ', em: 'access',
      sub: me.role === 'super_admin'
        ? 'One Login ID for every app. Choose the apps each person may use; hold, revoke or app changes reach their phone at the next sync.'
        : 'Your team: Engineers who work on your apps. You can give or take only your own apps, and change only people who work on nothing else.',
      action: goBtn('Add person', 'plus', { onclick: () => addPerson(auditList) }),
    }),
    h('div', { class: 'fbar' }, counts, h('label', { class: 'fsearch' }, icon('search'), h('span', { class: 'sr' }, 'Find a person'), search)),
    h('div', { class: 'tgrid' },
      h('section', { class: 'tcard', 'aria-label': 'People' }, h('div', { class: 'scroll' },
        h('table', { class: 'ptable' }, h('thead', {}, h('tr', {}, ['Person', 'Role', 'Apps', 'Status', 'Last sign-in'].map(c => h('th', { scope: 'col' }, c)))), tbody))),
      panel));
}

// Put an Engineer on one more audit.
function addToAudit(u, auditList) {
  const open = auditList.filter(a => !['published', 'archived'].includes(a.status) && !u.audits.some(x => x.id === a.id));
  openDialog(`Add ${u.name} to an audit`, f => f.append(open.length
    ? field('Audit', h('select', { name: 'audit' }, open.map(a => h('option', { value: a.id }, `${a.industry_tag} · ${a.title} (${AUDIT_STATUS[a.status]})`))))
    : h('p', { class: 'muted' }, 'They are already on every running audit.')), async f => {
    if (!f.elements.audit) return;
    await api('POST', `/api/audits/${encodeURIComponent(f.elements.audit.value)}/assign`, { user_id: u.id, assign: true });
    toast(`${u.name} added`);
    route();
  }, { submitLabel: 'Add' });
}

function addPerson(auditList) {
  const me = state.me;
  openDialog('Add a person', f => {
    const role = h('select', { name: 'role' },
      h('option', { value: 'engineer' }, 'Engineer — collects data in apps'),
      me.role === 'super_admin' && h('option', { value: 'head' }, 'Admin — sees the Console for the apps given to them'),
      me.owner && h('option', { value: 'super_admin' }, 'Super Admin — full control'));
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
        h('div', { class: 'chips' }, state.apps.filter(a => mine(a.code)).map(a => h('label', { class: 'chip' }, h('input', { type: 'checkbox', name: 'apps', value: a.code }), a.name)))),
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
      Object.entries(ROLE).filter(([k]) => k !== 'super_admin' || me.owner || u.role === k)
        .map(([k, v]) => h('option', { value: k, selected: u.role === k }, v))))), async f => {
    const body = { name: val(f, 'name'), phone: val(f, 'phone'), employment: val(f, 'employment') };
    if (f.elements.role) body.role = f.elements.role.value;
    await api('PATCH', `/api/users/${u.id}`, body);
    toast('Saved');
    route();
  });
}

// ---------- audits ----------
// The running stages, in order, as numbered on the website.
const STAGES = [['draft', 'Draft'], ['in_field', 'In the field'], ['processing', 'Processing'], ['review', 'Review'], ['approved', 'Approved']];
const stageLabel = s => STAGES.find(x => x[0] === s)?.[1] || AUDIT_STATUS[s] || s;
const isLate = t => t.status !== 'done' && t.due_at && t.due_at < Date.now();

async function audits(holder) {
  const [{ audits: list }, { users }, { tasks }] = await Promise.all([api('GET', '/api/audits'), api('GET', '/api/users'),
    api('GET', '/api/tasks').catch(() => ({ tasks: [] }))]);
  const engineers = users.filter(u => u.role === 'engineer' && u.status === 'active');
  const running = list.filter(a => !CLOSED.has(a.status));
  const done = list.length - running.length;
  let stage = state.query.get('stage') || '';

  const addPerson = a => {
    const free = engineers.filter(u => !a.team.some(t => t.id === u.id));
    openDialog(`Add a person to ${a.industry_tag}`, f => f.append(free.length
      ? field('Engineer', h('select', { name: 'user' }, free.map(u => h('option', { value: u.id }, u.name))))
      : h('p', { class: 'muted' }, 'Every active Engineer is already on this audit.')), async f => {
      if (!f.elements.user) return;
      await api('POST', `/api/audits/${encodeURIComponent(a.id)}/assign`, { user_id: f.elements.user.value, assign: true });
      toast('Added'); route();
    }, { submitLabel: 'Add' });
  };

  const tbody = h('tbody');
  const strip = h('div', { class: 'stagebar', role: 'group', 'aria-label': 'Filter by stage' });
  const drawStrip = () => strip.replaceChildren(
    h('button', { type: 'button', class: 'all', 'aria-pressed': String(!stage), onclick: () => { stage = ''; drawStrip(); drawRows(); } },
      h('span', { class: 'sn' }, String(running.length)), h('span', { class: 'sl' }, 'All running')),
    ...STAGES.map(([k, label], i) => {
      const n = running.filter(a => a.status === k).length;
      return h('button', { type: 'button', 'aria-pressed': String(stage === k), onclick: () => { stage = stage === k ? '' : k; drawStrip(); drawRows(); } },
        h('span', { class: `sn${n ? '' : ' zero'}` }, String(n)), h('span', { class: 'sl' }, h('span', { class: 'snum' }, String(i + 1).padStart(2, '0')), ` · ${label}`));
    }),
    h('a', { class: 'fin', href: '#/reports' }, h('span', { class: 'sn' }, String(done)), h('span', { class: 'sl' }, 'Finalised · Previous reports', icon('arrow'))));
  const drawRows = () => {
    const rows = running.filter(a => !stage || a.status === stage);
    tbody.replaceChildren(...(rows.length ? rows.map(a => {
      const late = tasks.filter(t => t.audit_id === a.id && isLate(t)).length;
      const href = `#/audit/${encodeURIComponent(a.id)}`;
      return h('tr', {},
        h('td', { class: 'tagc' }, h('span', { class: 'tagstack' }, h('span', { class: 'tagpill bd' }, a.industry_tag), h('span', { class: 'aid' }, a.id))),
        h('td', {}, h('a', { class: 'atitle', href }, a.title), h('span', { class: 'asub' }, `${a.client_name} — ${a.site_name} · ${a.fy}`)),
        h('td', {}, h('span', { class: `spill lg ${STAGE_TONE[a.status] || 'soft'}` }, stageLabel(a.status))),
        h('td', {}, h('span', { class: 'avstack' }, a.team.map((t, i) => h('span', { class: `av sm${i % 2 ? ' alt' : ''}`, title: t.name }, initials(t.name))),
          h('button', { type: 'button', class: 'addc', 'aria-label': `Add a person to ${a.industry_tag}`, onclick: () => addPerson(a) }, icon('plus')))),
        h('td', { class: a.records ? 'n strong' : 'n' }, String(a.records)),
        h('td', { class: 'n' }, String(a.open_tasks), late ? h('span', { class: 'late' }, `${late} late`) : null),
        h('td', { class: 'sync' }, ago(a.last_sync)),
        h('td', { class: 'go' }, h('a', { class: 'rgo', href, 'aria-label': `Open ${a.industry_tag}` }, icon('arrow'))));
    }) : [h('tr', {}, h('td', { colspan: 8, class: 'empty' }, running.length ? 'No audit at this stage.' : done ? 'No running audits. Finalised ones are in Previous reports.' : 'No audits yet. Create the first one.'))]));
  };
  drawStrip(); drawRows();
  holder.replaceChildren(
    pageTitle({
      kicker: 'Manage', title: 'Running ', em: 'audits',
      sub: 'Each plant gets a system-made industry tag; the public site shows only the tag, never the client. Engineers see only the audits they are added to.',
      action: goBtn('New audit', 'plus', { onclick: newAudit }),
    }),
    strip,
    h('section', { class: 'tcard wide', 'aria-label': 'Running audits' }, h('div', { class: 'scroll' },
      h('table', { class: 'atable' }, h('thead', {}, h('tr', {},
        h('th', { scope: 'col' }, 'Tag'), h('th', { scope: 'col' }, 'Audit'), h('th', { scope: 'col' }, 'Stage'), h('th', { scope: 'col' }, 'Team'),
        h('th', { scope: 'col', class: 'n' }, 'Records'), h('th', { scope: 'col', class: 'n' }, 'Open tasks'), h('th', { scope: 'col' }, 'Last sync'),
        h('th', { scope: 'col', class: 'go' }, h('span', { class: 'sr' }, 'Open')))), tbody))),
    h('p', { class: 'foot-note' }, 'Move an audit to its next stage, finalise it or download its data from the audit page.'));
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
  const [data, { tasks: allTasks }, { audits: allAudits }, { users }, dash] = await Promise.all([
    api('GET', `/api/audits/${encodeURIComponent(id)}/data`), api('GET', '/api/tasks'), api('GET', '/api/audits'),
    api('GET', '/api/users').catch(() => ({ users: [] })), api('GET', '/api/dashboard?days=30').catch(() => ({ working_now: [] }))]);
  // Removed records stay on the server as versions; the audit page shows only current ones.
  for (const k of Object.keys(data.apps)) data.apps[k] = data.apps[k].filter(r => !r.payload._deleted);
  for (const k of Object.keys(data.apps)) if (!data.apps[k].length) delete data.apps[k];
  const listed = allAudits.find(x => x.id === data.audit.id) || {};
  const a = { ...listed, ...data.audit };
  const finalised = CLOSED.has(a.status);
  const tasksHere = allTasks.filter(t => t.audit_id === a.id);
  const open = tasksHere.filter(t => t.status !== 'done');
  const late = open.filter(isLate);
  const pq = (data.apps.power || []).filter(r => r.kind === 'pq_recording');
  const apps = Object.entries(data.apps).filter(([code]) => code !== 'power');
  const total = Object.values(data.apps).reduce((n, r) => n + r.length, 0);
  const photos = data.files.filter(f => f.mime.startsWith('image/'));
  const others = data.files.filter(f => !f.mime.startsWith('image/'));
  const enc = encodeURIComponent(a.id);

  // ---- dark header: tag, title, stage steps ----
  const stepIdx = finalised ? 5 : Math.max(0, STAGES.findIndex(s => s[0] === a.status));
  const steps = [...STAGES.map(s => s[1]), 'Finalised'];
  const next = !finalised && STAGES[stepIdx + 1];
  const moveTo = async status => {
    try { await api('POST', `/api/audits/${enc}/status`, { status }); toast(`Moved to ${stageLabel(status)}`); route(); } catch (ex) { toast(ex.message); }
  };
  const sector = state.sectors?.[a.sector];
  const header = h('header', { class: 'ahero' },
    h('div', { class: 'ah-top' },
      h('div', { class: 'ah-id' },
        h('a', { class: 'ah-back', href: finalised ? '#/reports' : '#/audits' }, icon('back'), finalised ? 'Previous reports' : 'Running audits'),
        h('span', { class: 'ah-tag' }, `${a.industry_tag} · ${a.id}`),
        h('h1', {}, `${a.title}, `, h('em', {}, a.client_name || a.site_name || '')),
        h('p', {}, [a.site_name, [sector, a.cluster && `${a.cluster.toUpperCase()} cluster`].filter(Boolean).join(', '), a.fy, a.created_at && `started ${fmtDay(a.created_at)}`].filter(Boolean).join(' · '))),
      h('div', { class: 'ah-acts' },
        h('a', { class: 'ah-zip', href: `/api/audits/${enc}/export.zip` }, icon('download'), 'Download all (ZIP)'),
        finalised
          ? h('button', { type: 'button', class: 'ah-fin', onclick: async () => {
            if (!confirm('Reopen this audit? It returns to the running lists and its data can be changed again.')) return;
            try { await api('POST', `/api/audits/${enc}/reopen`); toast('Audit reopened'); route(); } catch (ex) { toast(ex.message); }
          } }, 'Reopen', h('span', { class: 'go-ic', 'aria-hidden': 'true' }, icon('arrow')))
          : h('button', { type: 'button', class: 'ah-fin', onclick: () => finaliseAudit(a) }, 'Finalise audit', h('span', { class: 'go-ic', 'aria-hidden': 'true' }, icon('tick'))))),
    h('div', { class: 'ah-steps' },
      h('ol', { 'aria-label': 'Stage of this audit' }, steps.map((label, i) => {
        const done = i < stepIdx, now = i === stepIdx;
        return h('li', { class: done ? 'done' : now ? 'now' : null, 'aria-current': now ? 'step' : null },
          h('span', { class: 'st-top' }, h('span', { class: 'st-n' }, String(i + 1).padStart(2, '0')),
            done ? icon('tick') : now ? h('span', { class: 'st-now' }, 'Now') : null),
          h('span', { class: 'st-l' }, label, done ? h('span', { class: 'sr' }, ', done') : null));
      })),
      next && h('button', { type: 'button', class: 'ah-next', onclick: () => moveTo(next[0]) }, `Move to ${next[1]}`, icon('arrow'))));

  // ---- the four counts ----
  const lastRec = Object.entries(data.apps).flatMap(([code, rs]) => rs.map(r => ({ code, r })))
    .sort((x, y) => (y.r.synced_at || y.r.taken_at || 0) - (x.r.synced_at || x.r.taken_at || 0))[0];
  const stat = (v, b, sub, bad) => h('div', { class: 'astat' }, h('span', { class: `as-v${bad ? ' bad' : ''}` }, String(v)),
    h('span', { class: 'as-t' }, h('b', {}, b), h('span', { class: bad ? 'bad' : null }, sub)));
  const glance = h('section', { class: 'astats', 'aria-label': 'This audit at a glance' },
    stat(total, 'Records', `from ${Object.keys(data.apps).length} app${Object.keys(data.apps).length === 1 ? '' : 's'}`),
    stat(data.files.length, 'Photos & files', `${photos.length} photo${photos.length === 1 ? '' : 's'}, ${others.length} file${others.length === 1 ? '' : 's'}`),
    stat(open.length, 'Open tasks', late.length ? `${late.length} overdue` : `${tasksHere.length - open.length} done`, late.length > 0),
    h('div', { class: 'astat' }, h('span', { class: 'as-ic', 'aria-hidden': 'true' }, icon('cloud')),
      h('span', { class: 'as-t' }, h('b', {}, a.last_sync ? `Synced ${ago(a.last_sync)}` : 'Not synced yet'),
        h('span', {}, lastRec ? `${lastRec.r.recorded_by}, ${appName(lastRec.code)}` : 'Nothing has arrived'))));

  // ---- what each app collected ----
  const kindLabel = k => String(k || '—').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
  const minor = k => /profile|company/i.test(k);
  const taskLine = t => isLate(t)
    ? h('p', { class: 'ac-task' }, h('span', { class: 'spill bad sq' }, 'Overdue'), `${t.title} · ${t.assignee_name || 'not assigned'} · was due ${fmtDay(t.due_at)}`)
    : h('p', { class: 'ac-task' }, h('span', { class: 'spill ok sq' }, '1 open'), `${t.title} · ${t.assignee_name || 'not assigned'}${t.due_at ? ` · due ${fmtDay(t.due_at)}` : ''}`);
  const appCards = apps.map(([code, recs]) => {
    const byKind = new Map(), byPerson = new Map();
    for (const r of recs) {
      byKind.set(r.kind, (byKind.get(r.kind) || 0) + 1);
      const p = byPerson.get(r.recorded_by) || { n: 0, last: 0 };
      byPerson.set(r.recorded_by, { n: p.n + 1, last: Math.max(p.last, r.taken_at || 0) });
    }
    const kinds = [...byKind].sort((x, y) => minor(x[0]) - minor(y[0]) || y[1] - x[1]);
    const max = Math.max(...kinds.filter(k => !minor(k[0])).map(k => k[1]), 1);
    const meta = state.apps.find(x => x.code === code);
    const appOpen = open.filter(t => t.app === code);
    return h('article', { class: 'acard', 'aria-labelledby': `app-${code}` },
      h('div', { class: 'ac-head' }, h('span', { class: 'ac-ic', 'aria-hidden': 'true' }, appSym(code)),
        h('span', { class: 'ac-nm' }, h('h3', { id: `app-${code}` }, appName(code)), h('span', {}, `${(meta?.tagline || '').split(':')[0]} · ${recs.length} records`)),
        h('a', { class: 'obtn sm arrowed', href: `#/apps/${code}/${enc}` }, 'View and correct records', icon('arrow'))),
      h('div', { class: 'ac-body' },
        h('div', { class: 'ac-kinds' }, h('h4', {}, 'Equipment recorded'),
          h('ul', {}, kinds.map(([k, n]) => minor(k)
            ? h('li', { class: 'minor' }, h('span', {}, kindLabel(k)), h('span', {}), h('b', {}, String(n)))
            : h('li', {}, h('span', {}, kindLabel(k)), h('span', { class: 'bar', 'aria-hidden': 'true' }, h('span', { style: `width:${Math.max(2, Math.round(n / max * 100))}%` })), h('b', {}, String(n)))))),
        h('div', { class: 'ac-who' }, h('h4', {}, 'Collected by'),
          [...byPerson].sort((x, y) => y[1].n - x[1].n).map(([who, v], i) => h('div', { class: 'ac-p' },
            h('span', { class: `av s34${i % 2 ? ' alt' : ''}`, 'aria-hidden': 'true' }, initials(who)),
            h('span', { class: 'ac-pn' }, h('b', {}, who), h('span', {}, `last ${dayTime(v.last).replace('Today', 'today')}`)), h('b', {}, String(v.n)))))),
      appOpen.length ? taskLine(appOpen.find(isLate) || appOpen[0]) : null);
  });
  // Apps with open tasks but no data yet.
  const waiting = [...new Set(open.filter(t => t.app && !data.apps[t.app] && t.app !== 'power').map(t => t.app))].map(code => {
    const ts = open.filter(t => t.app === code);
    return h('div', { class: 'aempty' }, h('span', { class: 'ac-ic white', 'aria-hidden': 'true' }, appSym(code)),
      h('span', { class: 'ae-t' }, h('b', {}, `${appName(code)}: nothing yet`),
        h('span', {}, `${ts.length} task${ts.length === 1 ? '' : 's'} waiting: ${ts.map(t => `${t.title}${t.due_at ? `, due ${fmtDay(t.due_at)}` : ''}, ${t.assignee_name || 'not assigned'}`).join('; ')}`)),
      !finalised && h('button', { type: 'button', class: 'obtn sm', onclick: () => addPersonTo(a, users) }, 'Assign someone'));
  });

  // ---- side column ----
  const stillToCollect = h('section', { class: 'side-card', 'aria-labelledby': 'h-open' },
    h('div', { class: 'sc-h' }, h('h2', { id: 'h-open' }, 'Still to collect'),
      !finalised && h('button', { type: 'button', class: 'tbtn dark', onclick: () => newTask(allAudits.filter(x => x.id === a.id), users) }, '+ Task')),
    open.length ? h('ul', { class: 'stc' }, open.sort((x, y) => isLate(y) - isLate(x)).map(t => h('li', {}, h('b', {}, t.title),
      h('span', {}, isLate(t) ? h('span', { class: 'due bad' }, `Overdue · ${fmtDay(t.due_at)}`) : t.due_at ? h('span', { class: 'due' }, `Due ${fmtDay(t.due_at)}`) : null,
        [t.assignee_name || 'Not assigned', t.app && appName(t.app), t.status === 'running' ? 'running' : 'to do'].filter(Boolean).join(' · ')))))
      : h('p', { class: 'empty' }, 'Nothing open on this audit.'));
  const live = uid => dash.working_now.find(w => w.user_id === uid);
  const crew = (listed.team || []).map((t, i) => {
    const u = users.find(x => x.id === t.id), w = live(t.id);
    const note = w ? h('span', { class: 'cr-live' }, `In ${appName(w.app)} now`) : u?.locked ? h('span', { class: 'cr-bad' }, 'Locked out')
      : h('span', {}, `${ROLE[u?.role] || 'Engineer'} · ${t.employment === 'freelancer' ? 'Freelancer' : 'Staff'}`);
    return h('div', { class: 'cr' }, h('span', { class: `av s38${i % 2 ? ' alt' : ''}`, 'aria-hidden': 'true' }, initials(t.name)),
      h('span', { class: 'cr-n' }, h('b', {}, t.name), note),
      !finalised && h('button', {
        type: 'button', class: 'cr-x', 'aria-label': `Remove ${t.name} from this audit`, onclick: async () => {
          if (!confirm(`Remove ${t.name} from this audit?`)) return;
          try { await api('POST', `/api/audits/${enc}/assign`, { user_id: t.id, assign: false }); route(); } catch (ex) { toast(ex.message); }
        },
      }, icon('close')));
  });
  const teamCard = h('section', { class: 'side-card pad24', 'aria-labelledby': 'h-crew' }, h('h2', { id: 'h-crew' }, 'Team on this audit'),
    crew.length ? crew : h('p', { class: 'empty' }, 'Nobody yet.'),
    !finalised && h('button', { type: 'button', class: 'cr-add', onclick: () => addPersonTo(a, users) }, icon('plus'), 'Add a person'));
  const ROLE_AT = { main: 'Plant main input', pcc: 'PCC panel', mcc: 'MCC panel' };
  const pqCard = h('section', { class: 'pqcard', 'aria-labelledby': 'h-pq' },
    h('div', { class: 'pq-h' }, h('span', { class: 'pq-ic', 'aria-hidden': 'true' }, appSym('power')),
      h('span', {}, h('h2', { id: 'h-pq' }, 'Power quality'), h('span', {}, 'IEEE 519, EN 50160, IEC 61000'))),
    pq.length ? pq.map(r => {
      const p = r.payload, c = p.compliance?.summary, hl = p.health;
      return h('div', { class: 'pq-rec' }, h('b', {}, p.panel || r.tag || 'Recording'),
        h('span', {}, [ROLE_AT[p.role] || p.role, p.start && `${p.start} to ${p.end}`, p.samples && `${p.samples.toLocaleString('en-IN')} samples`, r.recorded_by].filter(Boolean).join(' · ')),
        h('span', { class: 'pq-pills' }, c && h('span', { class: 'pq-pass' }, `${c.pass} of ${c.total} checks pass`),
          hl?.overall != null && h('span', { class: 'pq-hl' }, `Health ${Math.round(hl.overall)}`)));
    }) : h('p', { class: 'pq-none' }, 'No power quality recording saved for this audit yet.'),
    h('a', { class: 'pq-open', href: `/pqa/?audit=${enc}`, target: '_blank', rel: 'noopener' }, 'Open the analyser for this audit',
      h('span', { class: 'go-ic', 'aria-hidden': 'true' }, icon('external')), h('span', { class: 'sr' }, '(opens in a new tab)')));

  // ---- photos and files ----
  let show = 'all';
  const grid = h('div', { class: 'pgrid' });
  const fileBox = h('div', { class: 'pfiles' });
  const pills = h('div', { class: 'fpills sm', role: 'group', 'aria-label': 'Show photos from' });
  const photoApps = [...new Set(photos.map(f => f.app).filter(Boolean))];
  const drawPhotos = () => {
    pills.replaceChildren(...[['all', 'All', data.files.length], ...photoApps.map(c => [c, appName(c), photos.filter(f => f.app === c).length]), ['files', 'Files', others.length]]
      .filter(([k, , n]) => k === 'all' || n).map(([k, label, n]) => h('button', { type: 'button', 'aria-pressed': String(show === k), onclick: () => { show = k; drawPhotos(); } },
        label, h('span', { class: 'cnt' }, String(n)))));
    const ps = show === 'files' ? [] : photos.filter(f => show === 'all' || f.app === show);
    grid.replaceChildren(...ps.map(f => h('figure', {},
      h('a', { class: 'pimg', href: f.url, target: '_blank', rel: 'noopener' }, h('img', { src: f.url, alt: f.caption || 'Photo', loading: 'lazy' })),
      h('figcaption', {}, h('b', {}, f.caption || (f.kind === 'thermal' ? 'Thermal image' : 'Photo')),
        h('span', {}, [appName(f.app), f.uploaded_by_name, f.taken_at && fmtDay(f.taken_at)].filter(Boolean).join(' · ')),
        f.location ? h('a', { href: f.location.map_url, target: '_blank', rel: 'noopener' }, 'Where it was taken') : h('span', {}, 'No location recorded')))));
    grid.hidden = !ps.length;
    const fs = show === 'all' || show === 'files' ? others : [];
    fileBox.replaceChildren(...fs.map(f => h('div', { class: 'pf' }, icon('doc'), h('a', { href: f.url }, f.original_name || f.id),
      h('span', {}, [appName(f.app), f.uploaded_by_name, `${(f.size / 1048576).toFixed(1)} MB`].filter(Boolean).join(' · ')))));
    fileBox.hidden = !fs.length;
  };
  drawPhotos();
  const photoSec = h('section', { class: 'psec', 'aria-labelledby': 'h-photos' },
    h('div', { class: 'ps-h' }, h('div', {}, h('span', { class: 'kicker' }, 'Photos & files'),
      h('h2', { id: 'h-photos' }, `${photos.length} photo${photos.length === 1 ? '' : 's'}, ${others.length} file${others.length === 1 ? '' : 's'}`)), pills),
    grid, fileBox, !data.files.length && h('p', { class: 'empty' }, 'No photos or files yet.'));

  holder.replaceChildren(h('div', { class: 'apage' },
    header,
    finalised ? h('div', { class: 'note' },
      `Finalised${a.finalized_at ? ` on ${fmtDate(a.finalized_at)}` : ''}${a.finalized_by_name ? ` by ${a.finalized_by_name}` : ''}. This is a previous report: its data is kept as it was. `,
      a.report_file_id ? h('a', { href: `/api/files/${a.report_file_id}`, target: '_blank', rel: 'noopener' }, 'Open the final report') : 'No report file attached.') : null,
    glance,
    h('div', { class: 'acols' },
      h('div', { class: 'a-main' }, h('div', { class: 'sec-h' }, h('span', { class: 'kicker' }, 'Data by app'), h('h2', {}, 'What has been collected')),
        appCards.length ? appCards : waiting.length ? null : h('div', { class: 'aempty' }, h('span', { class: 'ae-t' }, h('b', {}, 'Nothing has been synced for this audit yet.'),
          h('span', {}, 'Records appear here as soon as an engineer syncs from a field app.'))),
        waiting),
      h('aside', { class: 'a-side' }, stillToCollect, teamCard, pqCard)),
    photoSec));
}

// Put an Engineer on an audit (from the audit page).
function addPersonTo(a, users) {
  const free = users.filter(u => u.role === 'engineer' && u.status === 'active' && !(a.team || []).some(t => t.id === u.id));
  openDialog(`Add a person to ${a.industry_tag}`, f => f.append(free.length
    ? field('Engineer', h('select', { name: 'user' }, free.map(u => h('option', { value: u.id }, u.name))))
    : h('p', { class: 'muted' }, 'Every active Engineer is already on this audit.')), async f => {
    if (!f.elements.user) return;
    await api('POST', `/api/audits/${encodeURIComponent(a.id)}/assign`, { user_id: f.elements.user.value, assign: true });
    toast('Added'); route();
  }, { submitLabel: 'Add' });
}

// ---------- tasks ----------
const NUM_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
const inWords = (n, lower) => { const w = NUM_WORDS[n] || String(n); return lower && NUM_WORDS[n] ? w.toLowerCase() : w; };

async function tasks(holder) {
  const [{ tasks: list }, { audits: auditList }, { users }] = await Promise.all([api('GET', '/api/tasks'), api('GET', '/api/audits'), api('GET', '/api/users')]);
  const f = { audit: '', person: '', app: '', overdue: false };
  const setStatus = async (t, status) => {
    try { await api('POST', `/api/tasks/${t.id}/status`, { status }); route(); } catch (ex) { toast(ex.message); }
  };
  const monthAgo = Date.now() - 30 * 86400000;
  const open = list.filter(t => t.status !== 'done');
  const overdue = open.filter(isLate);

  const who = t => t.assignee_name
    ? [h('span', { class: `av xs${t.assignee_name.length % 2 ? ' alt' : ''}`, 'aria-hidden': 'true' }, initials(t.assignee_name)), t.assignee_name]
    : [h('span', { class: 'unas' }, 'Not assigned')];
  const due = t => isLate(t) ? h('span', { class: 'due bad' }, `Overdue · ${fmtDay(t.due_at)}`)
    : t.due_at ? h('span', { class: 'due' }, `Due ${fmtDay(t.due_at)}`) : h('span', { class: 'nodue' }, 'no due date');
  const head = t => h('span', { class: 'tk-tag' }, h('span', { class: 'tagpill sm' }, t.industry_tag), t.app ? appName(t.app) : null);
  const card = t => {
    const late = isLate(t);
    const cls = `tk${late ? ' late' : ''}${!t.assignee && t.status !== 'done' ? ' unassigned' : ''}`;
    if (t.status === 'running') return h('article', { class: cls }, head(t), h('h3', {}, t.title), h('span', { class: 'tk-who' }, who(t), due(t)),
      h('span', { class: 'tk-foot' }, h('span', { class: 'tk-when' }, `started ${ago(t.started_at)}`),
        h('span', { class: 'tk-acts' }, h('button', { type: 'button', class: 'tlink', onclick: () => setStatus(t, 'todo') }, 'To do'),
          h('button', { type: 'button', class: 'tbtn dark', onclick: () => setStatus(t, 'done') }, 'Mark done'))));
    if (t.status === 'todo') return h('article', { class: cls }, head(t), h('h3', {}, t.title),
      h('span', { class: 'tk-row' }, h('span', { class: 'tk-who' }, who(t), due(t)),
        h('button', { type: 'button', class: `tbtn${late ? ' dark' : ''}`, onclick: () => setStatus(t, 'running') }, 'Start')));
    const onTime = !t.due_at || t.done_at <= t.due_at + 86400000;
    const lateDays = t.due_at ? Math.round((t.done_at - t.due_at) / 86400000) : 0;
    return h('article', { class: cls }, head(t), h('h3', { class: 'dn' }, t.title),
      h('span', { class: 'tk-row muted13' }, h('span', { class: 'tk-done' }, icon('check'),
        `${t.assignee_name || 'Nobody'} · done ${fmtDay(t.done_at)}, ${onTime ? 'on time' : `${lateDays} day${lateDays === 1 ? '' : 's'} late`}`),
        h('button', { type: 'button', class: 'tlink', onclick: () => setStatus(t, 'todo') }, 'Reopen')));
  };
  const cols = h('div', { class: 'tcols' });
  let showOld = false;
  const draw = () => {
    const keep = t => (!f.audit || t.audit_id === f.audit) && (!f.person || (f.person === '-' ? !t.assignee : t.assignee === f.person))
      && (!f.app || t.app === f.app) && (!f.overdue || isLate(t));
    // Overdue work stays at the top of its column.
    const sortLate = xs => [...xs.filter(isLate), ...xs.filter(t => !isLate(t))];
    const run = sortLate(list.filter(t => t.status === 'running' && keep(t)));
    const todo = sortLate(list.filter(t => t.status === 'todo' && keep(t)));
    const doneAll = list.filter(t => t.status === 'done' && keep(t)).sort((a, b) => (b.done_at || 0) - (a.done_at || 0));
    const doneRecent = doneAll.filter(t => (t.done_at || 0) >= monthAgo);
    const col = (id, n, title, count, items, empty, extra) => h('section', { class: 'tcol', 'aria-labelledby': id },
      h('div', { class: 'tcol-h' }, h('h2', { id }, h('span', {}, n), title), count),
      items.length ? items.map(card) : h('p', { class: 'empty' }, empty), extra);
    cols.replaceChildren(
      col('col-run', '01', 'Running', h('span', { class: 'tcnt' }, String(run.length)), run, 'Nothing running.'),
      col('col-todo', '02', 'To do', h('span', { class: 'tcnt' }, String(todo.length)), todo, 'Nothing waiting.'),
      col('col-done', '03', 'Done', h('span', { class: 'tsub' }, showOld ? 'all' : 'last 30 days'), showOld ? doneAll : doneRecent, 'Nothing finished yet.',
        !showOld && doneAll.length > doneRecent.length && h('button', { type: 'button', class: 'tlink older', onclick: () => { showOld = true; draw(); } }, 'Older finished tasks')));
  };
  const pick = (label, key, opts) => h('label', { class: 'fsel' }, h('span', { class: 'sr' }, label),
    h('select', { onchange: e => { f[key] = e.target.value; draw(); } }, opts), icon('chevron'));
  const people = [...new Map(list.filter(t => t.assignee).map(t => [t.assignee, t.assignee_name])).entries()];
  const overdueBtn = h('button', {
    type: 'button', class: 'odbtn', 'aria-pressed': 'false', onclick: () => { f.overdue = !f.overdue; overdueBtn.setAttribute('aria-pressed', String(f.overdue)); draw(); },
  }, 'Only overdue', h('span', { class: 'cnt' }, String(overdue.length)));
  draw();
  holder.replaceChildren(
    pageTitle({
      kicker: 'Monitor', title: 'Tasks, ', em: 'now and next',
      sub: `${inWords(open.length)} open${overdue.length ? `, ${inWords(overdue.length, true)} of them overdue` : ''}. Overdue work stays at the top of its column. Assigning a task also adds that person to the audit.`,
      action: goBtn('New task', 'plus', { onclick: () => newTask(auditList, users), disabled: !auditList.length, title: auditList.length ? null : 'Create an audit first' }),
    }),
    h('div', { class: 'tfilters' },
      pick('Audit', 'audit', [h('option', { value: '' }, 'All audits'), auditList.filter(a => !CLOSED.has(a.status)).map(a => h('option', { value: a.id }, `${a.industry_tag} · ${a.title}`))]),
      pick('Person', 'person', [h('option', { value: '' }, 'Everyone'), people.map(([id, n]) => h('option', { value: id }, n)), h('option', { value: '-' }, 'Not assigned')]),
      pick('App', 'app', [h('option', { value: '' }, 'All apps'), state.apps.filter(a => a.field).map(a => h('option', { value: a.code }, a.name))]),
      overdue.length ? overdueBtn : null),
    cols);
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
    pageHead( h('div', {}, h('h1', {}, 'Activity log'),
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
    pageHead( h('div', {}, h('h1', {}, 'My account'),
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
  const web = apps.filter(a => a.web && !a.field);
  const planned = apps.filter(a => !a.field && !a.web);
  holder.replaceChildren(
    pageHead(
      h('div', {}, h('h1', {}, 'App console'),
        h('p', { class: 'muted small' }, 'Every field app and its data. Choose an app to see each company it has data for: the company profile, what was recorded, by whom and when.')),
    ),
    h('nav', { class: 'appnav', 'aria-label': 'Field apps' }, field.map(a => h('a', { class: 'btn', href: `#/apps/${a.code}` }, a.name))),
    h('div', { class: 'appgrid' }, field.map(a => {
      const r = rel[a.code];
      return h('div', { class: 'appcard' },
        h('div', { class: 'row' }, appIcon(r), h('div', { style: 'min-width:0' }, h('b', {}, a.name), h('div', { class: 'small muted' }, a.tagline))),
        h('div', { class: 'list' },
          h('div', {}, h('span', { class: 'muted' }, 'Version'), r ? h('span', {}, `v${r.version} · ${fmtDay(Date.parse(r.released_at))}`) : h('span', { class: 'muted' }, 'Not published')),
          h('div', {}, h('span', { class: 'muted' }, 'Records'), h('span', { class: 'num' }, a.records.toLocaleString('en-IN'))),
          h('div', {}, h('span', { class: 'muted' }, 'Audits with data'), h('span', { class: 'num' }, a.audits)),
          h('div', {}, h('span', { class: 'muted' }, 'People with access'), h('span', { class: 'num' }, a.people.filter(p => p.status === 'active').length)),
          h('div', {}, h('span', { class: 'muted' }, 'Last sync'), h('span', {}, a.last_sync ? ago(a.last_sync) : 'Nothing yet'))),
        h('div', { class: 'row' },
          h('a', { class: 'btn sm', href: `#/apps/${a.code}` }, 'View data'),
          a.web && h('a', { class: 'btn ghost sm', href: a.web, target: '_blank', rel: 'noopener' }, `Open ${a.name}`, icon('external'))));
    })),
    ...(web.length ? [h('h2', { class: 'section-title' }, 'Web apps'),
    h('div', { class: 'appgrid' }, web.map(a => h('a', { class: 'appcard', href: a.url, target: '_blank', rel: 'noopener' },
      h('div', { class: 'row' }, h('span', { class: 'appicon blank', style: 'width:44px;height:44px' }, icon('live')),
        h('div', { style: 'min-width:0' }, h('b', {}, a.name), h('div', { class: 'small muted' }, a.tagline))),
      h('div', { class: 'list' },
        h('div', {}, h('span', { class: 'muted' }, 'Where'), h('span', {}, a.where)),
        a.managersOnly
          ? h('div', {}, h('span', { class: 'muted' }, 'Who can open it'), h('span', {}, 'Super Admins, and Admins given it'))
          : [h('div', {}, h('span', { class: 'muted' }, 'Records'), h('span', { class: 'num' }, a.records.toLocaleString('en-IN'))),
            h('div', {}, h('span', { class: 'muted' }, 'Audits with data'), h('span', { class: 'num' }, a.audits)),
            h('div', {}, h('span', { class: 'muted' }, 'People with access'), h('span', { class: 'num' }, a.people.filter(p => p.status === 'active').length))]))))] : []),
    ...(planned.length ? [h('h2', { class: 'section-title' }, 'Planned'),
    h('div', { class: 'card' }, h('div', { class: 'chips' }, planned.map(a => h('span', { class: 'pill soft' }, a.name))),
      h('p', { class: 'small muted', style: 'margin-top:10px' }, 'These can already be ticked for people in Team & access; their apps are not built yet.'))] : []));
}

/** One company in one app: its profile, what was recorded, by whom, and links to the data and the app. */
function companyCard(code, appWeb, appName, x) {
  const p = x.profile || {};
  const address = [p.area, p.district, p.state, p.pincode].filter(Boolean).join(', ');
  return h('section', { class: 'card company' },
    h('div', { class: 'cap' },
      h('div', { style: 'min-width:0' },
        h('h2', {}, p.companyName || x.client_name),
        h('p', { class: 'small muted' }, h('span', { class: 'pill tag' }, x.industry_tag), ` ${x.site_name} · ${x.title} · ${x.fy} · ${AUDIT_STATUS[x.status] || x.status}`)),
      h('div', { class: 'row', style: 'flex-wrap:wrap;justify-content:flex-end' },
        h('a', { class: 'btn sm', href: `#/apps/${code}/${encodeURIComponent(x.audit_id)}` }, 'View records'),
        appWeb && !CLOSED.has(x.status) && h('a', { class: 'btn ghost sm', href: appWeb, target: '_blank', rel: 'noopener' }, `Open ${appName}`, icon('external')))),
    h('div', { class: 'grid3' },
      h('div', {},
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Company profile'),
        x.profile ? h('div', { class: 'small' },
          h('div', {}, address || h('span', { class: 'muted' }, 'No address saved')),
          p.overallConsumption ? h('div', { class: 'muted' }, `Consumption: ${p.overallConsumption}`) : null,
          h('div', { class: 'muted', style: 'margin-top:4px' }, `Saved by ${p.saved_by || '—'}${p.saved_at ? ` · ${fmtDate(p.saved_at)}` : ''}${p.from_app && p.from_app !== code ? ` (in ${(state.apps || []).find(a => a.code === p.from_app)?.name || p.from_app})` : ''}`))
          : h('p', { class: 'small muted' }, 'Not saved yet in any app.')),
      h('div', {},
        h('div', { class: 'section-title', style: 'margin-top:0' }, `What was recorded (${x.records})`),
        h('div', { class: 'chips' }, x.kinds.filter(k => k.kind !== 'company_profile').map(k => h('span', { class: 'pill soft' }, `${k.kind.replace(/_/g, ' ')} ${k.n}`))),
        h('div', { class: 'small muted', style: 'margin-top:6px' }, `From ${x.first_taken ? fmtDate(x.first_taken) : '—'} to ${ago(x.last_sync)}`)),
      h('div', {},
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Created by'),
        x.creators.length ? h('div', { class: 'list small' }, x.creators.map(c => h('div', {},
          h('span', {}, c.name), h('span', { class: 'muted' }, `${c.records} record${c.records === 1 ? '' : 's'} · last ${fmtDate(c.last)}`))))
          : h('p', { class: 'small muted' }, 'Only the company profile so far.'))));
}

async function appPage(holder, code) {
  const [d, rel] = await Promise.all([api('GET', `/api/apps?app=${encodeURIComponent(code)}`), releases()]);
  const a = d.app, r = rel[code];
  const metric = (ic, label, value, note) => h('div', { class: 'metric' }, h('div', { class: 'top' }, icon(ic), label), h('div', { class: 'v' }, value), note);
  const active = a.people.filter(p => p.status === 'active');
  holder.replaceChildren(h('div', {},
    pageHead(
      h('div', { class: 'row' }, appIcon(r, 52),
        h('div', {}, h('p', { class: 'small' }, h('a', { href: '#/apps' }, '‹ App console')),
          h('h1', {}, a.name), h('p', { class: 'muted small' }, a.tagline || 'Planned app'))),
      a.web && h('a', { class: 'btn', href: a.web, target: '_blank', rel: 'noopener' }, `Open ${a.name}`, icon('external')),
    ),
    h('section', { 'aria-label': 'At a glance', class: 'metrics' },
      metric('doc', 'Records', a.records.toLocaleString('en-IN'), h('div', { class: 'mnote' }, `from ${a.recorders} ${a.recorders === 1 ? 'person' : 'people'}`)),
      metric('audits', 'Audits with data', a.audits, h('div', { class: 'mnote' }, 'not counting deleted records')),
      metric('team', 'People with access', active.length, h('div', { class: 'mnote' }, a.people.length > active.length ? `${a.people.length - active.length} on hold or removed` : 'all active')),
      metric('clock', 'Last sync', a.last_sync ? ago(a.last_sync) : '—', h('div', { class: 'mnote' }, a.last_sync ? fmtDate(a.last_sync) : 'nothing received yet'))),

    h('h2', { class: 'section-title' }, 'Companies (running audits)'),
    d.audits.filter(x => !CLOSED.has(x.status)).length
      ? d.audits.filter(x => !CLOSED.has(x.status)).map(x => companyCard(code, a.web, a.name, x))
      : h('div', { class: 'card' }, h('p', { class: 'empty' }, `No running audit has data from ${a.name} yet.`)),
    d.audits.some(x => CLOSED.has(x.status)) ? [h('h2', { class: 'section-title' }, 'Finalised (previous reports)'),
      d.audits.filter(x => CLOSED.has(x.status)).map(x => companyCard(code, a.web, a.name, x))] : null,

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
          h('span', {}, `v${v.version}`),
          h('span', { class: 'small muted' }, `${fmtDay(Date.parse(v.released_at))} · ${v.hosted ? fmtSize(v.size) : 'no longer hosted'}`))))
          : h('p', { class: 'empty' }, 'No version published yet.'),
          r && h('p', { class: 'small muted', style: 'margin-top:10px' }, 'Installed apps check for a newer version every few hours and offer it. File: ', r.file, '.'))))));
}

// ---------- Report Studio (coming soon) ----------
function reportStudioPage(holder) {
  holder.replaceChildren(
    pageHead( h('div', {}, h('h1', {}, 'Report Studio'),
      h('p', { class: 'muted small' }, 'The final audit report, made from every app\u2019s data for a company.'))),
    h('div', { class: 'card', style: 'text-align:center;padding:48px 20px' },
      h('span', { class: 'pill soft', style: 'font-size:13px' }, 'Coming soon'),
      h('p', { style: 'margin-top:14px' }, 'Report Studio will build each audit\u2019s report straight from the data collected in the field apps and the Power Quality analyser.'),
      h('p', { class: 'small muted', style: 'margin-top:6px' }, 'Until then, finalised audits and their data are in ', h('a', { href: '#/reports' }, 'Previous reports'), '.')));
}

// ---------- getting started ----------
function guidePage(holder) {
  const step = (n, title, ...body) => h('li', { class: 'gstep' }, h('span', { class: 'gnum', 'aria-hidden': 'true' }, n), h('div', {}, h('b', {}, title), h('p', { class: 'small muted' }, ...body)));
  holder.replaceChildren(
    pageHead( h('div', {}, h('h1', {}, 'Getting started'),
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

// ---------- one app's data for one company audit: view, correct, remove ----------
const CLOSED = new Set(['published', 'archived']);
const hidden = k => k === 'id' || k.startsWith('_');
const isPhoto = v => typeof v === 'string' && v.startsWith('ares-photo:');
const showValue = v => v == null || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);

function photoLink(v) {
  const id = v.slice('ares-photo:'.length);
  return h('a', { href: `/api/files/${encodeURIComponent(id)}`, target: '_blank', rel: 'noopener' }, 'Photo');
}

/** A record's first few readable values, for the list. */
function summary(payload) {
  return Object.entries(payload).filter(([k, v]) => !hidden(k) && v !== null && v !== '' && typeof v !== 'object' && !isPhoto(v))
    .slice(0, 4).map(([k, v]) => `${k}: ${v}`).join(' · ');
}

function editRecord(r, onSaved) {
  const entries = Object.entries(r.payload).filter(([k]) => !hidden(k));
  openDialog(`Edit ${r.kind.replace(/_/g, ' ')}${r.tag ? ` · ${r.tag}` : ''}`, f => {
    f.append(h('p', { class: 'small muted' }, 'Saved as a new version: the earlier one is kept, and phones on this audit get the change at their next sync.'),
      h('div', { class: 'fgrid', style: 'margin-top:12px' },
        field('Tag', h('input', { type: 'text', name: '__tag', value: r.tag || '' }), 'Unique in this audit for this app; leave empty if it has none'),
        entries.map(([k, v]) => typeof v === 'object' && v !== null
          ? field(k, h('textarea', { name: k, rows: 4, 'data-json': '1' }, JSON.stringify(v, null, 2)), 'JSON')
          : field(k, h('input', { type: 'text', name: k, value: v == null ? '' : String(v), 'data-type': typeof v })))));
  }, async f => {
    const payload = { ...r.payload };
    for (const [k, v] of entries) {
      const el = f.elements[k];
      if (!el) continue;
      if (el.dataset.json) {
        try { payload[k] = JSON.parse(el.value || 'null'); } catch { throw new Error(`"${k}" is not valid JSON.`); }
      } else if (typeof v === 'number') {
        const n = el.value.trim() === '' ? null : Number(el.value);
        if (n !== null && !Number.isFinite(n)) throw new Error(`"${k}" must be a number.`);
        payload[k] = n;
      } else if (typeof v === 'boolean') {
        payload[k] = /^(true|yes|1)$/i.test(el.value.trim());
      } else {
        payload[k] = el.value;
      }
    }
    await api('PUT', `/api/records/${encodeURIComponent(r.id)}`, { payload, tag: val(f, '__tag') || null });
    toast('Record saved');
    onSaved();
  }, { submitLabel: 'Save changes' });
}

async function appAuditPage(holder, code, auditId) {
  const [d, { audits: all }] = await Promise.all([
    api('GET', `/api/audits/${encodeURIComponent(auditId)}/data?app=${encodeURIComponent(code)}`), api('GET', '/api/audits')]);
  const a = all.find(x => x.id === auditId) || d.audit;
  const locked = CLOSED.has(a.status);
  const app = (state.apps || []).find(x => x.code === code) || { name: code };
  const recs = (d.apps[code] || []).filter(r => !r.payload._deleted);
  const profile = recs.find(r => r.kind === 'company_profile');
  const items = recs.filter(r => r.kind !== 'company_profile');
  const reload = () => appAuditPage(holder, code, auditId);
  const photos = (d.files || []).filter(f => f.app === code && f.mime.startsWith('image/'));

  const remove = r => async () => {
    if (!confirm(`Remove ${r.kind.replace(/_/g, ' ')}${r.tag ? ` ${r.tag}` : ''}? Phones delete it at their next sync; the earlier versions stay on the server.`)) return;
    try { await api('DELETE', `/api/records/${encodeURIComponent(r.id)}`); toast('Record removed'); reload(); } catch (ex) { toast(ex.message); }
  };
  const actions = r => locked ? null : h('div', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' },
    h('button', { type: 'button', class: 'btn ghost sm', onclick: () => editRecord(r, reload) }, 'Edit'),
    h('button', { type: 'button', class: 'btn ghost sm danger', onclick: remove(r) }, 'Remove'));

  holder.replaceChildren(h('div', {},
    pageHead(
      h('div', {},
        h('p', { class: 'small' }, h('a', { href: '#/apps' }, '‹ App console'), ' · ', h('a', { href: `#/apps/${code}` }, app.name)),
        h('h1', {}, a.client_name || d.audit.client_name || a.title),
        h('p', { class: 'muted small' }, h('span', { class: 'pill tag' }, a.industry_tag), ` ${a.site_name} · ${a.title} · ${a.id} · ${a.fy} · ${AUDIT_STATUS[a.status] || a.status}`)),
      h('div', { class: 'row' },
        h('a', { class: 'btn ghost', href: `#/audit/${encodeURIComponent(a.id)}` }, 'Whole audit'))),
    locked && h('div', { class: 'note', style: 'margin-top:12px' }, 'This audit is finalised: its data is kept as it was and cannot be changed. Reopen it from the audit page to make corrections.'),

    h('h2', { class: 'section-title' }, 'Company profile in this app'),
    h('div', { class: 'card' }, profile
      ? h('div', {}, h('div', { class: 'list' }, Object.entries(profile.payload).filter(([k]) => !hidden(k)).map(([k, v]) => h('div', {}, h('span', { class: 'muted' }, k), h('span', {}, showValue(v))))),
        h('div', { style: 'margin-top:10px' }, actions(profile)))
      : h('p', { class: 'empty' }, 'Not saved in this app yet.')),

    h('h2', { class: 'section-title' }, `Records (${items.length})`),
    h('div', { class: 'card scroll' }, items.length ? h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Tag'), h('th', {}, 'What'), h('th', {}, 'Details'), h('th', {}, 'Recorded by'), h('th', {}, 'Last saved'), h('th', {}, ''))),
      h('tbody', {}, items.map(r => h('tr', {},
        h('td', {}, r.tag ? h('span', { class: 'pill tag' }, r.tag) : '—'),
        h('td', {}, r.kind.replace(/_/g, ' '), Object.values(r.payload).some(isPhoto) ? [' · ', photoLink(Object.values(r.payload).find(isPhoto))] : null),
        h('td', { class: 'small' }, summary(r.payload) || '—'),
        h('td', { class: 'small' }, r.updated_by_name && r.updated_by_name !== r.recorded_by ? `${r.recorded_by} (edited by ${r.updated_by_name})` : r.recorded_by),
        h('td', { class: 'small' }, fmtDate(r.saved_at)),
        h('td', {}, actions(r))))))
      : h('p', { class: 'empty' }, 'No records from this app for this company yet.')),

    photos.length ? [h('h2', { class: 'section-title' }, `Photos (${photos.length})`),
      h('div', { class: 'card' }, h('div', { class: 'photos' }, photos.map(f => h('figure', {},
        h('a', { href: f.url, target: '_blank', rel: 'noopener' }, h('img', { src: f.url, alt: f.caption || 'Photo', loading: 'lazy' })),
        h('figcaption', {}, h('b', {}, f.caption || 'Photo'),
          h('span', {}, [f.equipment_tag, f.uploaded_by_name, f.taken_at && fmtDate(f.taken_at)].filter(Boolean).join(' · ')),
          f.location ? h('a', { href: f.location.map_url, target: '_blank', rel: 'noopener' }, 'Where it was taken (map)') : null)))))] : null));
}

// ---------- finalising an audit, and previous reports ----------
async function uploadReport(auditId, file) {
  if (file.type !== 'application/pdf') throw new Error('The final report must be a PDF.');
  if (file.size > 25 * 1024 * 1024) throw new Error('The report file must be 25 MB or smaller.');
  const bytes = await file.arrayBuffer();
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  const id = crypto.randomUUID();
  await api('POST', '/api/files', { id, audit_id: auditId, app: 'report', kind: 'scan', caption: 'Final audit report',
    mime: 'application/pdf', size: bytes.byteLength, sha256: sha, name: file.name, taken_at: Date.now() });
  for (let off = 0; off < bytes.byteLength; off += 4 * 1024 * 1024) {
    const r = await fetch(`/api/files/${id}/content?offset=${off}`, {
      method: 'PUT', credentials: 'same-origin', headers: { 'X-ARES': '1', 'Content-Type': 'application/octet-stream' },
      body: bytes.slice(off, off + 4 * 1024 * 1024),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'The report did not upload.');
  }
  return id;
}

function finaliseAudit(a) {
  openDialog(`Finalise ${a.client_name || a.title}`, f => {
    f.append(h('p', {}, 'Use this once the report is made. The audit then leaves the running lists in the Console and the field apps, and its data is kept as it is (it can be reopened if a correction is needed).'),
      h('div', { style: 'margin-top:12px' }, field('Final report (PDF, optional)', h('input', { type: 'file', name: 'report', accept: 'application/pdf' }), 'Kept with the audit and included in its ZIP download')));
  }, async f => {
    const file = f.elements.report.files[0];
    const reportId = file ? await uploadReport(a.id, file) : null;
    await api('POST', `/api/audits/${encodeURIComponent(a.id)}/finalise`, { report_file_id: reportId });
    toast('Audit finalised');
    route();
  }, { submitLabel: 'Finalise audit' });
}

async function reportsPage(holder) {
  const { audits: list } = await api('GET', '/api/audits');
  const done = list.filter(a => CLOSED.has(a.status)).sort((x, y) => (y.finalized_at || 0) - (x.finalized_at || 0));
  holder.replaceChildren(
    pageHead( h('div', {}, h('h1', {}, 'Previous reports'),
      h('p', { class: 'muted small' }, 'Finalised audits. Their data is kept as it was; open one to see every record, photo and file, or download all of it as a ZIP.'))),
    h('div', { class: 'card scroll' }, done.length ? h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Company'), h('th', {}, 'Audit'), h('th', {}, 'Finalised'), h('th', { class: 'n' }, 'Records'), h('th', {}, 'Report'), h('th', {}, ''))),
      h('tbody', {}, done.map(a => h('tr', {},
        h('td', {}, h('b', {}, a.client_name), h('div', { class: 'small muted' }, a.site_name, ' · ', h('span', { class: 'pill tag' }, a.industry_tag))),
        h('td', {}, h('a', { href: `#/audit/${encodeURIComponent(a.id)}` }, a.title), h('div', { class: 'small muted' }, a.id, ' · ', a.fy)),
        h('td', { class: 'small' }, a.finalized_at ? fmtDate(a.finalized_at) : '—', a.finalized_by_name ? h('div', { class: 'muted' }, `by ${a.finalized_by_name}`) : null),
        h('td', { class: 'n' }, a.records),
        h('td', {}, a.report_file_id ? h('a', { href: `/api/files/${a.report_file_id}`, target: '_blank', rel: 'noopener' }, 'Open report') : h('span', { class: 'muted small' }, 'None attached')),
        h('td', {}, h('a', { class: 'btn ghost sm', href: `/api/audits/${encodeURIComponent(a.id)}/export.zip` }, icon('download'), 'ZIP'))))))
      : h('p', { class: 'empty' }, 'No audit has been finalised yet. Finalise one from its audit page once the report is made.')));
}

route();
