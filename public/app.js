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
      // An action that returns false keeps the dialog open (the person chose to go back).
      if ((await submit(form)) !== false) dlg.close();
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
// The field apps and tools, as tiles on the sign-in page (their own icons).
const GATE_TOOLS = [
  ['survey', 'BRIEF'], ['motor', 'Motor Pulse'], ['heat', 'Boiler & Fuel'], ['textile', 'Dye House'], ['air', 'Air Findings'], ['pump', 'Hydro Flow'],
  ['cool', 'Cool Zone'], ['xmer', 'Trafo Check'], ['light', 'Lux Survey'], ['dryer', 'Dryer Heat'], ['power', 'Grid Lens'], ['bills', 'GST Billing'],
];

// A password box with show / hide and a Caps Lock warning.
function passwordField(label, name, autocomplete, hint) {
  const input = h('input', { type: 'password', name, required: true, autocomplete, spellcheck: 'false' });
  const caps = h('span', { class: 'caps', hidden: true, role: 'status' }, 'Caps Lock is on');
  const eye = h('button', { type: 'button', class: 'pw-eye', 'aria-label': 'Show password', 'aria-pressed': 'false' }, 'Show');
  eye.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.textContent = show ? 'Hide' : 'Show';
    eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    eye.setAttribute('aria-pressed', String(show));
    input.focus();
  });
  const capsCheck = e => { if (e.getModifierState) caps.hidden = !e.getModifierState('CapsLock'); };
  input.addEventListener('keydown', capsCheck);
  input.addEventListener('keyup', capsCheck);
  input.addEventListener('blur', () => { caps.hidden = true; });
  return h('label', { class: 'f' }, label, h('span', { class: 'pw-wrap' }, input, eye), caps, hint && h('span', { class: 'hint' }, hint));
}

function gate(title, sub, formKids, onSubmit, btnLabel, { busyLabel = 'Please wait…', below = null } = {}) {
  const err = h('div', { class: 'err', hidden: true, role: 'alert' });
  const form = h('form', {}, formKids, err, h('button', { class: 'btn', type: 'submit' }, btnLabel), below);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.hidden = true;
    const b = form.querySelector('button[type=submit]');
    b.disabled = true;
    b.textContent = busyLabel;
    try { await onSubmit(form); } catch (ex) { err.textContent = ex.message; err.hidden = false; } finally { b.disabled = false; b.textContent = btnLabel; }
  });
  root.replaceChildren(h('div', { class: 'gate' }, h('div', { class: 'card' },
    h('div', { class: 'brand' }, h('img', { src: '/logo.png', alt: '' }), h('div', {}, h('b', {}, 'ARES Console'), h('small', {}, 'AR Energy Services'))),
    h('h1', {}, title), h('p', { class: 'muted' }, sub), form)));
  form.querySelector('input:not([type=checkbox])')?.focus();
}

function setupScreen() {
  gate('Create the Super Admin', 'First run. Enter the one-time setup code shown in the server window.', [
    field('Setup code', h('input', { type: 'text', name: 'code', required: true, autocomplete: 'off' })),
    field('Your name', h('input', { type: 'text', name: 'name', required: true, autocomplete: 'name' })),
    field('Login ID', h('input', { type: 'text', name: 'login_id', required: true, autocomplete: 'username' }), 'Letters, numbers, dot or dash, e.g. axita'),
    passwordField('Password', 'password', 'new-password', 'At least 10 characters, letters and numbers'),
  ], async f => {
    await api('POST', '/api/setup', { code: val(f, 'code'), name: val(f, 'name'), login_id: val(f, 'login_id'), password: f.elements.password.value });
    toast('Super Admin created. Please sign in.');
    loginScreen();
  }, 'Create account', { busyLabel: 'Creating…' });
}

function loginScreen() {
  const saved = readPref('ares-login-id', '');
  gate('Welcome back', 'Sign in to ARES Console. For Super Admins and Admins. Field engineers sign in from their app.', [
    field('Login ID', h('input', { type: 'text', name: 'login_id', required: true, autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', value: saved, placeholder: 'Your Login ID' })),
    passwordField('Password', 'password', 'current-password'),
    h('div', { class: 'gate-row' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'remember', checked: !!saved }), 'Remember my Login ID'),
      h('details', { class: 'forgot' }, h('summary', {}, 'Forgot password?'),
        h('p', {}, 'Ask your Super Admin to reset it from the Team page. You get a one-time password and choose your own at the next sign-in.'))),
  ], async f => {
    await api('POST', '/api/login', { login_id: val(f, 'login_id'), password: f.elements.password.value });
    writePref('ares-login-id', f.elements.remember.checked ? val(f, 'login_id') : '');
    await loadMe();
    if (location.hash !== '#/billing') location.hash = '#/overview';
    route();
  }, 'Sign in', { busyLabel: 'Signing in…' });
  // A remembered Login ID: start in the password box.
  if (saved) root.querySelector('input[name=password]')?.focus();
}

function changePasswordScreen() {
  gate('Set your own password', 'You signed in with a temporary password. Choose your own to continue.', [
    passwordField('Temporary password', 'current', 'current-password'),
    passwordField('New password', 'next', 'new-password', 'At least 10 characters, letters and numbers'),
  ], async f => {
    await api('POST', '/api/change-password', { current: f.elements.current.value, next: f.elements.next.value });
    state.me.must_change_pw = false;
    route();
  }, 'Save password', { busyLabel: 'Saving…' });
}

async function loadMe() {
  const r = await api('GET', '/api/me');
  state.me = r.user;
  state.apps = r.apps;
  state.myApps = r.my_apps;
  state.sectors = r.sectors;
  state.workTypes = r.work_types || {};
  state.states = r.states || [];
  state.fy = r.fy || currentFy();
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
  lock: ['M6 11h12v10H6z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3', 'M12 15v2'],
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
  { id: 'team-activity', label: 'Team activity', group: 'Monitor', icon: 'team' },
  { id: 'tasks', label: 'Tasks', group: 'Monitor', icon: 'tasks' },
  { id: 'activity', label: 'Activity log', group: 'Monitor', icon: 'activity' },
  { id: 'team', label: 'Team & access', group: 'Manage', icon: 'team' },
  { id: 'audits', label: 'Audits', group: 'Manage', icon: 'audits' },
  { id: 'reports', label: 'Previous reports', group: 'Manage', icon: 'doc' },
  { id: 'apps', label: 'App console', group: 'Field apps', icon: 'apps' },
  { id: 'guide', label: 'Getting started', group: null, icon: 'guide' },
  { id: 'account', label: 'My account', group: null, icon: 'account' },
];
const GROUPS = ['Monitor', 'Manage', 'Field apps', 'Tools'];
// Field apps get a sub-page each (from /api/me), listed under "All apps".
const menuPages = () => PAGES;
// Each field app's data in the Console, listed under App console in the menu.
const fieldPages = () => (state.apps || []).filter(a => a.field && mine(a.code)).map(a => ({ id: `apps/${a.code}`, label: a.name, icon: 'phone', code: a.code, sub: true }));
const TOOLS = [
  { code: 'power', href: '/pqa/', label: 'Grid Lens (power quality)', app: 'power' },
  { code: 'bills', href: 'https://billing.arenergyservices.in/', label: 'GST Billing', app: 'bills' },
];
const toolLinks = () => TOOLS.filter(t => mine(t.app));

// ---------- opening a tool, already signed in ----------
// Asks what the work is for (an audit's company, a new company, or a quick check), then opens the
// tool with a one-time launch code (lib/launch.js) so it needs no second sign-in. The public
// audit website just opens.
const NO_LAUNCH = new Set(['audit', 'power', 'bills']); // AR's analyser and GST Billing keep their own sign-in
// Where each tool takes the code: the field apps and the analyser on their sign-in page, Report Studio on its page.
const launchUrl = a => new URL(a.field || a.code === 'power' ? 'login' : '', new URL(a.web, location.origin));

async function launchTool(a, auditId) {
  const w = window.open('', '_blank'); // opened during the click, so the browser does not block it
  try {
    const r = await api('POST', '/api/launch', { app: a.code, audit: auditId || null });
    const u = launchUrl(a);
    u.searchParams.set('launch', r.code);
    if (auditId) u.searchParams.set('audit', auditId);
    if (w) { w.opener = null; w.location.href = u.href; } else location.href = u.href;
  } catch (ex) {
    if (w) w.close();
    toast(ex.message);
  }
}

async function openTool(codeOrApp, auditId) {
  const a = typeof codeOrApp === 'string' ? (state.apps || []).find(x => x.code === codeOrApp) : codeOrApp;
  if (!a || !a.web) return;
  if (NO_LAUNCH.has(a.code)) { window.open(a.web, '_blank', 'noopener'); return; }
  if (auditId) { launchTool(a, auditId); return; }
  let list = [];
  try { list = (await api('GET', '/api/audits')).audits.filter(x => !CLOSED.has(x.status)); } catch { /* quick check still works */ }
  const dlg = h('dialog', { class: 'pick' });
  const choose = id => { dlg.close(); launchTool(a, id); };
  dlg.append(h('div', { class: 'body' },
    h('div', { class: 'row', style: 'gap:14px;margin-bottom:6px' }, appIcon(null, 48, a.code), h('h2', { style: 'margin:0' }, `Open ${a.name}`)),
    h('p', { class: 'muted' }, 'What is this for? Link the work to a company’s audit, or do a quick check that is not saved to any company.'),
    h('div', { class: 'pick-list' },
      list.length
        ? list.map(x => h('button', { type: 'button', class: 'pick-item', onclick: () => choose(x.id) },
          h('span', { class: 'pill tag' }, x.industry_tag),
          h('span', { class: 'pick-t' }, h('b', {}, x.client_name), h('span', { class: 'small muted' }, `${x.title} · ${x.site_name}`))))
        : h('p', { class: 'empty' }, 'No open audits yet.')),
    h('div', { class: 'foot', style: 'justify-content:space-between;flex-wrap:wrap' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => { dlg.close(); location.hash = '#/audits'; toast('Register the new company here, then open the app for it.'); } }, 'New company'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'),
        h('button', { type: 'button', class: 'btn cta', onclick: () => choose(null) }, 'Quick check')))));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

function shell(active, content) {
  const navLink = p => h('a', { class: `nav${p.sub ? ' sub' : ''}${p.id === active ? ' on' : ''}`, href: `#/${p.id}`, 'aria-current': p.id === active ? 'page' : null }, icon(p.icon), p.label);
  // The download page for every AR app (Android APKs and web links), on this server at /apps/.
  const downloadLink = () => h('a', { class: 'nav', href: '/apps/', target: '_blank', rel: 'noopener' }, icon('download'), 'Download apps', h('span', { class: 'sr' }, ' (opens in a new tab)'));
  const extLink = x => h('a', { class: 'nav', href: x.href, target: '_blank', rel: 'noopener', onclick: e => { if (!NO_LAUNCH.has(x.code)) { e.preventDefault(); openTool(x.code); } } }, icon('external'), x.label, h('span', { class: 'sr' }, ' (opens in a new tab)'));
  const side = h('nav', { class: 'side', 'aria-label': 'Sections' },
    h('a', { class: 'brand', href: '#/overview' }, h('img', { src: '/logo.png', alt: '' }),
      h('div', {}, h('b', {}, 'ARES Console'), h('small', {}, 'AR Energy Services'))),
    h('div', { class: 'side-scroll' },
      GROUPS.map(g => [h('div', { class: 'group' }, g), g === 'Tools' && toolLinks().map(extLink), menuPages().filter(p => p.group === g).map(navLink),
        g === 'Field apps' && [...fieldPages().map(navLink), downloadLink()]])));

  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Sections' },
    // Seven fit a phone's bar; Team activity is a link on the Overview there.
    PAGES.filter(p => p.group && p.group !== 'Tools' && p.id !== 'team-activity').map(p => h('a', { class: p.id === active ? 'on' : '', href: `#/${p.id}`, 'aria-current': p.id === active ? 'page' : null },
      icon(p.icon), p.label.replace(' & access', '').replace(' log', '').replace('App console', 'Apps').replace('Previous reports', 'Reports'))));

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
        h('a', { href: '/apps/', target: '_blank', rel: 'noopener', role: 'menuitem', onclick: closePop }, icon('download'), 'Download apps'),
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
    h('span', { class: 'title' }, [...menuPages(), ...fieldPages()].find(p => p.id === active)?.label || ''), h('span', { class: 'spacer' }), menuBtn);
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
  // Signed in on the way to GST Billing: carry on there.
  if (location.hash === '#/billing') { history.replaceState(null, '', '/#/overview'); return location.replace('/api/billing/sso'); }
  const [page, param, param2] = (location.hash.replace('#/', '') || 'overview').split('?')[0].split('/');
  const fn = page === 'audit' && param ? h2 => auditPage(h2, decodeURIComponent(param))
    : page === 'apps' && param && param2 ? h2 => appAuditPage(h2, decodeURIComponent(param), decodeURIComponent(param2))
    : page === 'apps' && param ? h2 => appPage(h2, decodeURIComponent(param))
      : ({ overview: pipelinePage, 'team-activity': teamActivity, team, audits, tasks, activity, account, apps: appsPage, guide: guidePage, reports: reportsPage }[page] || pipelinePage);
  const holder = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  const activeId = page === 'audit' ? 'audits' : page === 'apps' && param ? `apps/${param}` : page;
  shell([...menuPages(), ...fieldPages()].some(p => p.id === activeId) || page === 'guide' ? activeId : 'overview', holder);
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

async function teamActivity(holder, { background = false } = {}) {
  const d = await api('GET', `/api/dashboard?days=${state.days}`, null, { background });
  const t = d.totals;
  const overdueTotal = d.people.reduce((s, p) => s + p.overdue, 0);
  const periodName = (PERIODS.find(p => p[0] === d.days)?.[1] || `${d.days} days`).toLowerCase();

  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Period shown' },
    PERIODS.map(([n, label]) => h('button', {
      type: 'button', 'aria-pressed': String(n === state.days),
      onclick: () => { if (n !== state.days) { state.days = n; teamActivity(holder); } },
    }, label)));

  const metric = (ic, label, value, note, unit) => h('div', { class: 'metric' },
    h('div', { class: 'top' }, icon(ic), label),
    h('div', { class: 'v' }, value, unit && h('small', {}, unit)),
    note);

  const people = d.people.filter(p => p.role !== 'super_admin' || p.records || p.hours);

  holder.replaceChildren(
    h('div', { class: 'head' },
      h('div', {}, h('h1', {}, 'Team activity'),
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
    if (document.visibilityState === 'visible' && location.hash.startsWith('#/team-activity')) teamActivity(holder, { background: true }).catch(() => {});
  }, 60000);
}

// ---------- team & access ----------
// ---------- profile card (My account: photo and details for the report team) ----------
// Every person has a profile card (photo, position, qualification, experience); this page shows
// the team's profile cards (photo, position, qualification, experience) instead of per-app access.
// Creating a card creates that person's login. Cards marked "in reports" fill the report's
// assessment-team section (GET /api/team-cards).

// Shrinks a chosen picture to at most 480 px as a JPEG before it is sent (the server takes 300 KB).
function pickPhoto(onPicked) {
  const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', hidden: true });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { toast('That picture is too large (15 MB at most).'); return; }
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 480 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      onPicked(c.toDataURL('image/jpeg', 0.82));
    } catch { toast('That file could not be read as a picture.'); }
  });
  document.body.append(input);
  input.click();
}

const avatar = (u, size = 72) => u.photo
  ? h('img', { class: 'pc-photo', src: u.photo, alt: '', width: size, height: size })
  : h('span', { class: 'pc-photo blank', style: `width:${size}px;height:${size}px`, 'aria-hidden': 'true' }, initials(u.name || '?'));

// The card's fields, for adding a card, editing someone's, and editing your own.
// Returns a function that reads the form into the request body.
function cardFields(f, u, { loginId = false, manage = false } = {}) {
  let photo = u.photo || null;
  const preview = h('div', {}, avatar({ ...u, photo }, 88));
  const photoBtn = h('button', { type: 'button', class: 'btn small ghost' }, photo ? 'Change photo' : 'Add photo');
  const showPhoto = () => { preview.replaceChildren(avatar({ ...u, photo }, 88)); photoBtn.textContent = photo ? 'Change photo' : 'Add photo'; };
  photoBtn.addEventListener('click', () => pickPhoto(d => { photo = d; showPhoto(); }));
  f.append(
    h('div', { class: 'row', style: 'gap:14px;margin-bottom:14px' }, preview,
      h('div', { class: 'row', style: 'gap:8px' }, photoBtn,
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => { photo = null; showPhoto(); } }, 'Remove photo'))),
    h('div', { class: 'fgrid' },
      field('Full name', h('input', { type: 'text', name: 'name', value: u.name || '', required: true, maxlength: 80 })),
      loginId
        ? field('Login ID', h('input', { type: 'text', name: 'login_id', required: true, autocomplete: 'off' }), 'e.g. ravi.k')
        : field('Position', h('input', { type: 'text', name: 'position', value: u.position || '', maxlength: 80 }), 'e.g. Energy Auditor')),
    loginId && h('div', { style: 'margin-top:12px' },
      field('Position', h('input', { type: 'text', name: 'position', value: u.position || '', maxlength: 80 }), 'e.g. Energy Auditor')),
    h('div', { style: 'margin-top:12px' },
      field('Qualification', h('input', { type: 'text', name: 'qualification', value: u.qualification || '', maxlength: 160 }), 'e.g. M.Tech (Energy Systems), BEE Certified Energy Auditor')),
    h('div', { style: 'margin-top:12px' },
      field('Experience', h('textarea', { name: 'experience', rows: 3, maxlength: 600 }, u.experience || ''), 'A line or two, as it should read in a report')),
    h('div', { class: 'fgrid', style: 'margin-top:12px' },
      field('Phone', h('input', { type: 'tel', name: 'phone', value: u.phone || '' })),
      field('E-mail', h('input', { type: 'text', name: 'email', value: u.email || '', autocomplete: 'off' }))),
    h('label', { class: 'chip', style: 'margin-top:14px' },
      h('input', { type: 'checkbox', name: 'in_report', checked: u.in_report !== false }), 'Show this card in reports (assessment team)'),
    manage && state.me.role === 'super_admin' && h('div', { class: 'fgrid', style: 'margin-top:12px' },
      field('Order in reports', h('input', { type: 'text', name: 'report_order', value: String(u.report_order || 0), inputmode: 'numeric' }), '0 first, then 1, 2 …'),
      u.id && u.id !== state.me.id && field('Console role', h('select', { name: 'role' },
        Object.entries(ROLE).map(([k, v]) => h('option', { value: k, selected: u.role === k }, v))))));
  return form => {
    const b = {
      name: val(form, 'name'), position: val(form, 'position') || null, qualification: val(form, 'qualification') || null,
      experience: form.elements.experience.value.trim() || null, phone: val(form, 'phone') || null,
      email: val(form, 'email') || null, in_report: form.elements.in_report.checked, photo,
    };
    if (form.elements.report_order) b.report_order = Number(val(form, 'report_order') || 0);
    if (form.elements.role) b.role = form.elements.role.value;
    return b;
  };
}

function editMyCard() {
  let collect;
  openDialog('My profile card', f => { collect = cardFields(f, state.me); }, async f => {
    const r = await api('PATCH', '/api/me/profile', collect(f));
    state.me = { ...state.me, ...r.user };
    toast('Saved');
    route();
  });
}

// Associated faculty: shown on the Team page and in reports, without a login. Super Admin edits.
// AR Energy Services: one company, run by its owner (the main Super Admin). Each person gets the
// apps and audits they work on; Admins manage only the Engineers of their own apps (lib/scope.js).
async function team(holder) {
  const [{ users }, { audits: auditList }] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/audits')]);
  const me = state.me;
  const canManage = u => u.can_manage;

  const appChips = u => h('div', { class: 'chips' }, state.apps.filter(a => mine(a.code)).map(a => {
    const on = u.apps.includes(a.code);
    if (u.role === 'super_admin') return h('span', { class: 'chip on ro' }, a.name);
    const box = h('input', {
      type: 'checkbox', checked: on, disabled: !u.can_change_apps.includes(a.code),
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
          u.owner && h('span', { class: 'pill soft' }, 'Main Super Admin'),
          u.locked && h('span', { class: 'pill bad' }, 'Locked: wrong passwords')),
        h('div', { class: 'small muted', style: 'margin-top:4px' }, `Login ID: ${u.login_id}`),
        h('div', { class: 'small muted' }, ROLE[u.role], ' · ', u.employment === 'freelancer' ? 'Freelancer' : 'Staff', u.phone ? ` · ${u.phone}` : ''),
        h('div', { class: 'small muted' }, `Last sign-in: ${ago(u.last_login_at)}`, u.must_change_pw ? ' · has not set own password yet' : '')),
      h('div', {},
        h('div', { class: 'small muted', style: 'margin-bottom:6px' }, u.role === 'super_admin' ? 'Apps (all, as Super Admin)'
          : me.role === 'super_admin' ? 'Apps this person can use' : 'Your apps this person can use'),
        appChips(u),
        h('div', { class: 'small muted', style: 'margin:12px 0 6px' }, 'Assigned audits'),
        u.role === 'engineer'
          ? (u.audits.length ? h('div', { class: 'chips' }, u.audits.map(a => h('span', { class: 'pill tag', title: a.id }, a.tag))) : h('span', { class: 'small muted' }, 'None — assign in Audits'))
          : h('span', { class: 'small muted' }, u.role === 'head' ? 'The audits of their apps (Admin)' : 'All audits (Super Admin)')),
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
        h('p', { class: 'muted small' }, me.role === 'super_admin'
          ? 'One Login ID for every app. Tick the apps each person may use; changes apply immediately.'
          : 'Your team: Engineers who work on your apps. You can give or take only your own apps, and change only people who work on nothing else.')),
      h('button', { class: 'btn', onclick: () => addPerson(auditList) }, 'Add person')),
    h('div', { class: 'card' }, rows.length ? rows : h('p', { class: 'empty' }, 'No one yet.')));
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
// ---------- the audit process (lib/stages.js): stages, the progress line, moving on ----------
const CHECK = () => { const NS = 'http://www.w3.org/2000/svg', v = document.createElementNS(NS, 'svg'); v.setAttribute('viewBox', '0 0 24 24'); v.setAttribute('class', 'pcheck');
  const pth = document.createElementNS(NS, 'path'); pth.setAttribute('d', 'M5 12.5l4.2 4.2L19 7'); v.append(pth); return v; };
const stageOf = (P, key) => P.stages.find(s => s.key === key) || { key, label: key, short: key };
const daysSince = ms => ms ? Math.max(0, Math.floor((Date.now() - ms) / 86400000)) : 0;
const reachedAt = (a, key) => { const l = [...(a.history || [])].reverse().find(x => x.to_stage === key); return l ? l.at : (key === 'initiated' ? a.created_at : null); };

/** Where a stage stands for this company: done, current, waiting (approval), skipped or still to come. */
function stageState(a, key) {
  const cur = a.stages.indexOf(a.stage || 'initiated'), i = a.stages.indexOf(key);
  if (i < 0) return 'skip';
  if (i < cur) return 'done';
  if (i > cur) return 'todo';
  if (key === 'approval') return 'wait';
  if (key === 'completed') return 'done';
  if (key === 'post_audit') return a.post_audit_status === 'done' ? 'done' : a.post_audit_status === 'not_done' ? 'bad' : 'cur';
  return 'cur';
}
const STATE_WORD = { done: 'done', cur: 'in progress', wait: 'waiting for approval', bad: 'not done', skip: 'not needed (walkthrough audit)', todo: 'to come' };

/** The progress line: a circle per stage, coloured by where it stands, joined by a line. */
function progressLine(a, P, { compact = false } = {}) {
  let n = 0;
  return h('ol', { class: `pline${compact ? ' compact' : ''}`, 'aria-label': `Audit progress: ${stageOf(P, a.stage).label}` },
    P.stages.map(st => {
      const k = stageState(a, st.key);
      if (k !== 'skip') n++;
      const when = !compact && (k === 'done' || k === 'cur' || k === 'wait' || k === 'bad') ? reachedAt(a, st.key) : null;
      return h('li', { class: `ps ${k}`, title: `${st.label}: ${STATE_WORD[k]}${when ? ` (since ${fmtDay(when)})` : ''}` },
        h('span', { class: 'pdot' }, k === 'done' ? CHECK() : k === 'skip' ? '–' : k === 'bad' ? '!' : String(n)),
        h('span', { class: 'plabel' }, compact ? st.short : st.label),
        when ? h('span', { class: 'pwhen' }, fmtDay(when)) : null);
    }));
}

/** May this person move the company on (as the server decides it): Super Admin, its lead, any Head when it has no lead. */
function canMoveStage(a) {
  if (state.me.role === 'super_admin') return true;
  const lead = (a.team || []).find(t => t.role === 'lead');
  return lead ? lead.id === state.me.id : state.me.role === 'head';
}
async function moveTo(a, to, note, reload) {
  try { await api('POST', `/api/audits/${encodeURIComponent(a.id)}/stage`, { to, note: note || null }); toast('Audit moved on'); reload(); }
  catch (ex) { toast(ex.message); }
}
function sendBack(a, P, reload, onlyTo = null) {
  const cur = a.stages.indexOf(a.stage);
  const back = a.stages.slice(0, cur).filter(k => !onlyTo || k === onlyTo);
  openDialog(`Send ${a.client_name || a.id} back`, f => {
    f.append(field('Back to', h('select', { name: 'to' }, back.reverse().map(k => h('option', { value: k }, stageOf(P, k).label)))),
      field('Why', h('textarea', { name: 'note', rows: 3, required: true, placeholder: 'What needs doing, e.g. "Add the boiler thermal images"' }), 'Shown in the audit\'s history'));
  }, async f => {
    if (!val(f, 'note')) throw new Error('Say why it goes back.');
    await api('POST', `/api/audits/${encodeURIComponent(a.id)}/stage`, { to: val(f, 'to'), note: val(f, 'note') });
    toast('Sent back'); reload();
  }, { submitLabel: 'Send back' });
}
function postAuditDialog(a, status, reload) {
  openDialog(status === 'done' ? 'Post audit done' : 'Post audit: not done', f => {
    f.append(field('Note', h('textarea', { name: 'note', rows: 3, placeholder: status === 'done' ? 'What the plant carried out' : 'What is still pending, and why' }), 'Details of the post audit come later; a short note is enough for now'));
  }, async f => {
    await api('POST', `/api/audits/${encodeURIComponent(a.id)}/post-audit`, { status, note: val(f, 'note') || null });
    toast('Post audit recorded'); reload();
  }, { submitLabel: 'Save' });
}

/** The next step for one company: the hint, and the buttons this person may use. */
function nextStepBox(a, P, reload) {
  const nx = a.next || {}, next = nx.next ? stageOf(P, nx.next) : null;
  const isApprover = P.approver && P.approver.id === state.me.id, may = canMoveStage(a);
  const buttons = [];
  if (a.stage === 'approval') {
    if (isApprover) {
      buttons.push(h('button', { type: 'button', class: 'btn', onclick: () => moveTo(a, 'final', null, reload) }, 'Approve draft'));
      buttons.push(h('button', { type: 'button', class: 'btn ghost', onclick: () => sendBack(a, P, reload, 'draft') }, 'Send back to draft'));
    } else if (may) buttons.push(h('button', { type: 'button', class: 'btn ghost', onclick: () => sendBack(a, P, reload, 'draft') }, 'Take back to draft'));
  } else if (a.stage === 'post_audit') {
    if (may) {
      buttons.push(h('button', { type: 'button', class: 'btn', onclick: () => postAuditDialog(a, 'done', reload) }, 'Mark done'));
      buttons.push(h('button', { type: 'button', class: 'btn ghost', onclick: () => postAuditDialog(a, 'not_done', reload) }, 'Not done'));
    }
  } else if (next && may) {
    const label = next.key === 'approval' ? `Send to ${P.approver ? P.approver.name.split(' ')[0] : 'approver'} for approval`
      : next.key === 'completed' ? 'Mark completed' : `Move to ${next.label}`;
    buttons.push(h('button', { type: 'button', class: nx.ready ? 'btn' : 'btn ghost',
      onclick: () => next.key === 'completed' ? finaliseAudit(a) : moveTo(a, next.key, null, reload) }, label));
  }
  if (may && a.stages.indexOf(a.stage) > 0 && a.stage !== 'approval') buttons.push(h('button', { type: 'button', class: 'btn ghost', onclick: () => sendBack(a, P, reload) }, 'Go back'));
  return h('div', { class: `nextbox ${a.stage === 'approval' ? 'wait' : nx.ready ? 'ready' : ''}` },
    h('div', {}, h('div', { class: 'small muted' }, 'Now'), h('b', {}, stageOf(P, a.stage).label), h('span', { class: 'small muted' }, ` · ${daysSince(a.stage_at)} day${daysSince(a.stage_at) === 1 ? '' : 's'}`)),
    h('p', { class: 'small' }, nx.ready && next && a.stage !== 'approval' ? h('span', { class: 'pill ok' }, `Ready for ${next.short}`) : null, nx.ready && next ? ' ' : '', nx.hint || ''),
    buttons.length ? h('div', { class: 'row', style: 'gap:8px' }, buttons)
      : h('p', { class: 'small muted' }, a.stage === 'approval' ? `Only ${P.approver ? P.approver.name : 'the approver'} approves.` : 'Only the team lead or a Super Admin moves this audit on.'));
}

/** The audit team: who is on this company and as what; add, change role, remove. */
function auditTeamBox(a, P, users, reload) {
  const roleSel = (t) => h('select', { 'aria-label': `${t.name}'s role`, onchange: async e => {
    try { await api('POST', `/api/audits/${encodeURIComponent(a.id)}/assign`, { user_id: t.id, assign: true, role: e.target.value }); toast('Role changed'); reload(); } catch (ex) { toast(ex.message); }
  } }, Object.entries(P.roles).map(([k, v]) => h('option', { value: k, selected: t.role === k }, v)));
  const free = users.filter(u => u.status === 'active' && !(a.team || []).some(t => t.id === u.id) && (u.role !== 'super_admin' || state.me.role === 'super_admin'));
  const addSel = h('select', { 'aria-label': 'Person to add' }, h('option', { value: '' }, 'Add a person…'), free.map(u => h('option', { value: u.id }, `${u.name} · ${ROLE[u.role] || u.role}`)));
  const addRole = h('select', { 'aria-label': 'Their role' }, Object.entries(P.roles).map(([k, v]) => h('option', { value: k, selected: k === ((a.team || []).some(t => t.role === 'lead') ? 'field' : 'lead') }, v)));
  return h('div', { class: 'teambox' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'Audit team'),
    (a.team || []).length ? h('div', { class: 'tlist' }, a.team.map(t => h('div', { class: 'trow2' },
      h('span', { class: `av ${t.role === 'lead' ? 'lead' : ''}` }, initials(t.name)),
      h('div', {}, h('b', {}, t.name), h('div', { class: 'small muted' }, t.role === 'lead' ? 'Moves the audit through its stages' : t.role === 'report' ? 'Writes the report in Report Studio' : 'Records in the field apps')),
      roleSel(t),
      h('button', { type: 'button', class: 'btn ghost sm danger', 'aria-label': `Remove ${t.name}`, onclick: async () => {
        if (!confirm(`Take ${t.name} off this audit?`)) return;
        try { await api('POST', `/api/audits/${encodeURIComponent(a.id)}/assign`, { user_id: t.id, assign: false }); reload(); } catch (ex) { toast(ex.message); }
      } }, 'Remove'))))
      : h('p', { class: 'small muted' }, 'Nobody yet. Add a team lead first: they move the audit through its stages.'),
    h('div', { class: 'row', style: 'gap:8px;margin-top:10px' }, addSel, addRole,
      h('button', { type: 'button', class: 'btn sm', onclick: async () => {
        if (!addSel.value) return toast('Choose a person to add.');
        try { await api('POST', `/api/audits/${encodeURIComponent(a.id)}/assign`, { user_id: addSel.value, assign: true, role: addRole.value }); toast('Added to the audit'); reload(); } catch (ex) { toast(ex.message); }
      } }, 'Add')),
    h('p', { class: 'small muted', style: 'margin-top:8px' }, 'Engineers see only the companies they are on; the team lead moves this audit on; ',
      P.approver ? `${P.approver.name} approves the draft.` : 'the approver approves the draft.'));
}

// ---------- Overview: every company and where it is in the process ----------
const STAGE_GROUPS = [
  ['all', 'All', null],
  ['field', 'Field work', ['initiated', 'walkthrough', 'detailed']],
  ['report', 'Processing & report', ['processing', 'draft', 'final']],
  ['approval', 'Approval', ['approval']],
  ['done', 'Completed', ['completed']],
  ['post', 'Post audit', ['post_audit']],
];
async function pipelinePage(holder) {
  const P = await api('GET', '/api/pipeline');
  let group = 'all', q = '';
  try { group = sessionStorage.getItem('ares-pipe-group') || 'all'; } catch { /* private window */ }
  const reload = () => pipelinePage(holder);
  const list = P.audits;
  const count = k => list.filter(a => a.stage === k).length;
  const isApprover = P.approver && P.approver.id === state.me.id;

  // What needs someone now.
  const attention = [];
  for (const a of list) {
    const name = a.client_name || a.id, href = `#/audit/${encodeURIComponent(a.id)}`;
    if (a.stage === 'approval') attention.push({ tone: 'warn', a, text: isApprover ? 'Waiting for your approval' : `Waiting for ${P.approver ? P.approver.name : 'approval'}`, href, name });
    else if (a.issues) attention.push({ tone: 'bad', a, text: `${a.issues} sync problem${a.issues > 1 ? 's' : ''}`, href, name });
    else if (a.next && a.next.ready && a.next.next && a.stage !== 'post_audit') attention.push({ tone: 'ok', a, text: `Ready for ${stageOf(P, a.next.next).label}`, href, name });
    else if (!['completed', 'post_audit'].includes(a.stage) && daysSince(a.stage_at) > 14) attention.push({ tone: 'warn', a, text: `${daysSince(a.stage_at)} days at ${stageOf(P, a.stage).short}`, href, name });
    if (!(a.team || []).some(t => t.role === 'lead') && !['completed', 'post_audit'].includes(a.stage)) attention.push({ tone: 'soft', a, text: 'No team lead yet', href, name });
  }

  const shown = () => {
    const g = STAGE_GROUPS.find(x => x[0] === group) || STAGE_GROUPS[0];
    return list.filter(a => (!g[2] || g[2].includes(a.stage)) && (!q || `${a.client_name} ${a.site_name} ${a.id} ${a.industry_tag}`.toLowerCase().includes(q)));
  };
  const listBox = h('div', { class: 'cocards' });
  const paint = () => {
    const rows = shown();
    listBox.replaceChildren(...(rows.length ? rows.map(a => companyRow(a, P, reload)) : [h('div', { class: 'card' }, h('p', { class: 'empty' }, 'No company here.'))]));
  };
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' }, STAGE_GROUPS.map(([k, label, keys]) => h('button', {
    type: 'button', 'aria-pressed': String(group === k), onclick: e => {
      group = k; try { sessionStorage.setItem('ares-pipe-group', k); } catch { /* private window */ }
      e.currentTarget.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
      paint();
    } }, label, h('span', { class: 'segn' }, String(keys ? list.filter(a => keys.includes(a.stage)).length : list.length)))));
  const search = h('input', { type: 'search', class: 'pipesearch', placeholder: 'Find a company', 'aria-label': 'Find a company', oninput: e => { q = e.target.value.trim().toLowerCase(); paint(); } });

  holder.replaceChildren(h('div', {},
    h('div', { class: 'head' },
      h('div', {}, h('h1', {}, 'Overview'), h('p', { class: 'muted small' }, 'Every company and where it stands in the audit process, from initiation to post audit.')),
      h('div', { class: 'row' }, h('a', { class: 'btn ghost', href: '#/team-activity' }, 'Team activity'), h('button', { class: 'btn', onclick: newAudit }, 'New audit'))),
    // The process at a glance: how many companies are at each stage.
    h('section', { class: 'stagebar', 'aria-label': 'Companies at each stage' }, P.stages.map((st, i) => h('a', {
      class: `sb ${count(st.key) ? 'has' : ''} s-${st.key}`, href: '#/overview', onclick: e => {
        e.preventDefault();
        const g = STAGE_GROUPS.find(x => x[2] && x[2].includes(st.key));
        if (g) { group = g[0]; seg.querySelectorAll('button').forEach((b, bi) => b.setAttribute('aria-pressed', String(STAGE_GROUPS[bi][0] === group))); paint(); }
      } },
      h('span', { class: 'sbn' }, String(i + 1)), h('span', { class: 'sbl' }, st.label), h('b', { class: 'sbc' }, String(count(st.key)))))),
    attention.length ? h('section', { class: 'card attention' },
      h('div', { class: 'cap' }, h('h2', {}, 'Needs attention'), h('span', { class: 'small muted' }, `${attention.length} item${attention.length === 1 ? '' : 's'}`)),
      h('div', { class: 'alist' }, attention.slice(0, 12).map(x => h('a', { class: 'arow', href: x.href },
        logoImg(x.a.logo_file_id, 28), h('b', {}, x.name), h('span', { class: `pill ${x.tone}` }, x.text))))) : null,
    h('div', { class: 'row pipetools' }, seg, search),
    listBox));
  paint();
}

/** One company on the Overview: who, the progress line, the next step and the facts. */
function companyRow(a, P, reload) {
  const lead = (a.team || []).find(t => t.role === 'lead');
  const others = (a.team || []).filter(t => t !== lead);
  return h('section', { class: 'card corow' },
    h('div', { class: 'cohead' },
      h('a', { class: 'coname', href: `#/audit/${encodeURIComponent(a.id)}` }, logoImg(a.logo_file_id, 40),
        h('div', { style: 'min-width:0' }, h('b', {}, a.client_name || a.title), a.synthetic ? h('span', { class: 'pill warn', style: 'margin-left:6px' }, 'Demo') : null,
          h('div', { class: 'small muted' }, [a.site_name, a.work_type === 'walkthrough' ? 'Walkthrough audit' : 'Detailed audit', a.fy, a.id].filter(Boolean).join(' · ')))),
      h('div', { class: 'coteam' },
        lead ? h('span', { class: 'av lead', title: `${lead.name} · team lead` }, initials(lead.name)) : h('span', { class: 'pill soft' }, 'No lead'),
        others.slice(0, 5).map(t => h('span', { class: 'av', title: `${t.name} · ${P.roles[t.role] || t.role}` }, initials(t.name))),
        others.length > 5 ? h('span', { class: 'small muted' }, `+${others.length - 5}`) : null)),
    progressLine(a, P, { compact: true }),
    h('div', { class: 'cofoot' },
      h('span', { class: `pill ${a.stage === 'approval' ? 'warn' : a.next && a.next.ready ? 'ok' : 'soft'}` },
        `${stageOf(P, a.stage).label} · ${daysSince(a.stage_at)} d`),
      h('span', { class: 'small' }, a.next ? a.next.hint : ''),
      h('span', { class: 'cofacts small muted' }, `${a.records} records · ${a.apps} app${a.apps === 1 ? '' : 's'} · ${a.photos} photos${a.issues ? ` · ${a.issues} sync problem${a.issues > 1 ? 's' : ''}` : ''}`),
      h('a', { class: 'btn sm', href: `#/audit/${encodeURIComponent(a.id)}` }, 'Open company')));
}

async function audits(holder) {
  const [{ audits: list }, { users }, P] = await Promise.all([api('GET', '/api/audits'), api('GET', '/api/users'), api('GET', '/api/pipeline')]);
  const piped = new Map(P.audits.map(x => [x.id, x]));

  const done = list.filter(a => CLOSED.has(a.status)).length;
  const rows = list.filter(a => !CLOSED.has(a.status)).map(a => {
    const pa = piped.get(a.id) || { ...a, stages: [], history: [] };
    const add = h('select', {
      'aria-label': 'Add person to audit', onchange: async e => {
        if (!e.target.value) return;
        const role = a.team.some(t => t.role === 'lead') ? 'field' : 'lead';
        try { await api('POST', `/api/audits/${a.id}/assign`, { user_id: e.target.value, assign: true, role }); toast(role === 'lead' ? 'Added as team lead' : 'Added as field engineer'); route(); } catch (ex) { toast(ex.message); }
      },
    }, h('option', { value: '' }, '+ Add person'), users.filter(u => u.status === 'active' && !a.team.some(t => t.id === u.id) && (u.role !== 'super_admin' || state.me.role === 'super_admin'))
      .map(u => h('option', { value: u.id }, `${u.name} · ${ROLE[u.role] || u.role}`)));
    return h('tr', {},
      h('td', {}, h('span', { class: 'pill tag' }, a.industry_tag), h('div', { class: 'small muted', style: 'margin-top:4px' }, a.id, ' · ', a.fy)),
      h('td', {}, h('div', { class: 'row', style: 'flex-wrap:nowrap;gap:10px;align-items:center' }, logoImg(a.logo_file_id),
        h('div', {}, h('a', { href: `#/audit/${encodeURIComponent(a.id)}` }, h('b', {}, a.client_name || a.title)), a.synthetic ? h('span', { class: 'pill warn', style: 'margin-left:8px' }, 'Demo') : null,
          h('div', { class: 'small muted' }, a.site_name, ' · ', a.title)))),
      h('td', { class: 'stagecell' }, pa.stages.length ? progressLine(pa, P, { compact: true }) : null,
        h('div', { class: 'small', style: 'margin-top:4px' }, h('b', {}, stageOf(P, a.stage || 'initiated').label), h('span', { class: 'muted' }, ` · ${daysSince(a.stage_at)} d`))),
      h('td', {},
        h('div', { class: 'chips', style: 'margin-bottom:6px' }, a.team.map(t => h('span', { class: `chip on ro${t.role === 'lead' ? ' lead' : ''}`, title: P.roles[t.role] || '' }, t.role === 'lead' ? '★ ' : '', t.name,
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
      h('div', {}, h('h1', {}, 'Audits'), h('p', { class: 'muted small' }, 'Running audits. Each plant gets a system-made industry tag; the public site shows only that tag, never the client name. ',
        'Add the team on each audit: the ★ team lead moves it through its stages; engineers see only the companies they are on. ', done ? h('a', { href: '#/reports' }, `${done} finalised in Previous reports`) : null)),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: newAudit }, 'New audit'))),
    h('div', { class: 'card scroll' }, list.length ? h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Tag'), h('th', {}, 'Audit'), h('th', {}, 'Progress'), h('th', {}, 'Team (★ lead)'),
        h('th', { class: 'n' }, 'Records'), h('th', { class: 'n' }, 'Open tasks'), h('th', {}, 'Last sync'))),
      h('tbody', {}, rows)) : h('p', { class: 'empty' }, done ? 'No running audits. Finalised ones are in Previous reports.' : 'No audits yet. Create the first one.')));
}

// A picture picked in a form, made small enough for the report (PNG for a logo, JPEG for a photo).
function shrinkPicture(file, maxSide, mime) {
  return new Promise((res, rej) => {
    if (!file || !/^image\//.test(file.type)) return rej(new Error('Please pick a picture (PNG or JPEG).'));
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      const s = Math.min(1, maxSide / Math.max(im.naturalWidth, im.naturalHeight));
      const cv = document.createElement('canvas');
      cv.width = Math.round(im.naturalWidth * s); cv.height = Math.round(im.naturalHeight * s);
      const cx = cv.getContext('2d');
      if (mime === 'image/jpeg') { cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height); }
      cx.drawImage(im, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      cv.toBlob(b => b ? res(b) : rej(new Error('The picture could not be read.')), mime, 0.86);
    };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('The picture could not be read.')); };
    im.src = url;
  });
}
// The company's logo (kind "logo") or a photograph of the site (kind "site"): kept on the audit and
// shown by every app and by Report Studio, which puts them on the report cover.
async function uploadAuditPicture(auditId, kind, file) {
  const blob = await shrinkPicture(file, kind === 'logo' ? 800 : 1800, kind === 'logo' ? 'image/png' : 'image/jpeg');
  const bytes = await blob.arrayBuffer();
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  const id = crypto.randomUUID();
  const r = await api('POST', '/api/files', { id, audit_id: auditId, app: 'report', kind, caption: kind === 'logo' ? 'Company logo' : 'Site photograph',
    mime: blob.type, size: bytes.byteLength, sha256: sha, name: `${kind}.${blob.type === 'image/png' ? 'png' : 'jpg'}`, taken_at: Date.now() });
  if (r.file.status === 'ready') return id;
  const up = await fetch(`/api/files/${id}/content?offset=0`, {
    method: 'PUT', credentials: 'same-origin', headers: { 'X-ARES': '1', 'Content-Type': 'application/octet-stream' }, body: bytes,
  });
  if (!up.ok) throw new Error((await up.json().catch(() => ({}))).error || 'The picture did not upload.');
  return id;
}
const fyChoices = () => {
  const now = Number((state.fy || currentFy()).slice(2, 6));
  return [now + 1, now, now - 1, now - 2].map(y => `FY${y}-${String((y + 1) % 100).padStart(2, '0')}`);
};
const pick = (name, label, accept, hint) => field(label, h('input', { type: 'file', name, accept }), hint);
// The company, plant and audit details, as the New audit form and Edit details ask them.
function detailFields(v = {}) {
  return [
    h('div', { class: 'fgrid', style: 'margin-top:12px' },
      field('Plant type', h('select', { name: 'sector', required: true },
        Object.entries(state.sectors).map(([k, n]) => h('option', { value: k, selected: v.sector === k }, n)))),
      field('Type of work', h('select', { name: 'work_type', required: true },
        Object.entries(state.workTypes).map(([k, n]) => h('option', { value: k, selected: (v.work_type || 'detailed') === k }, n))))),
    h('div', { class: 'fgrid', style: 'margin-top:12px' },
      field('District', h('input', { type: 'text', name: 'district', required: true, value: v.district || '' })),
      field('State', h('select', { name: 'state', required: true },
        h('option', { value: '' }, 'Choose…'), state.states.map(x => h('option', { value: x, selected: (v.state || 'Gujarat') === x }, x))))),
    h('div', { class: 'fgrid', style: 'margin-top:12px' },
      field('Pincode', h('input', { type: 'text', name: 'pincode', required: true, inputmode: 'numeric', maxlength: 6, pattern: '[1-9][0-9]{5}', value: v.pincode || '' })),
      field('Financial year', h('select', { name: 'fy', required: true },
        fyChoices().map(y => h('option', { value: y, selected: (v.fy || state.fy || currentFy()) === y }, y))))),
    h('div', { class: 'fgrid', style: 'margin-top:12px' },
      field('Plant contract demand (kVA)', h('input', { type: 'text', name: 'contract_demand_kva', inputmode: 'decimal', value: v.contract_demand_kva ?? '' }), 'From the electricity bill'),
      field('MSME (Udyam) number', h('input', { type: 'text', name: 'msme_no', value: v.msme_no || '', placeholder: 'UDYAM-GJ-22-0001234' }), 'Leave empty if the plant has none')),
  ];
}
const detailValues = f => ({
  sector: val(f, 'sector'), work_type: val(f, 'work_type'), district: val(f, 'district'), state: val(f, 'state'),
  pincode: val(f, 'pincode'), fy: val(f, 'fy'), contract_demand_kva: val(f, 'contract_demand_kva'), msme_no: val(f, 'msme_no'),
});

async function newAudit() {
  const { clients } = await api('GET', '/api/clients');
  openDialog('New audit', f => {
    const newClient = h('div', {}, h('div', { style: 'margin-top:12px' },
      field('Company name (private)', h('input', { type: 'text', name: 'client_name' }))));
    const newSite = h('div', {}, h('div', { style: 'margin-top:12px' },
      field('Plant name (private)', h('input', { type: 'text', name: 'site_name' }))));
    const siteSel = h('select', { name: 'site_id', onchange: e => { newSite.hidden = !!e.target.value; } });
    const fillSites = cid => {
      const c = clients.find(x => x.id === cid);
      siteSel.replaceChildren(h('option', { value: '' }, 'New plant…'), ...(c?.sites || []).map(s => h('option', { value: s.id }, `${s.name} (${s.industry_tag})`)));
      newSite.hidden = false;
    };
    const clientSel = h('select', {
      name: 'client_id', onchange: e => { newClient.hidden = !!e.target.value; fillSites(e.target.value); },
    }, h('option', { value: '' }, 'New company…'), clients.map(c => h('option', { value: c.id }, c.name)));
    fillSites('');
    // The company logo first, as a round picture (the same circle the apps and the report show).
    const logoIn = h('input', { type: 'file', name: 'logo', accept: 'image/png,image/jpeg,image/webp', hidden: true });
    const logoFace = h('span', { class: 'logopick-face' }, h('b', {}, '+'), h('small', {}, 'Logo'));
    logoIn.addEventListener('change', () => {
      const file = logoIn.files[0];
      logoFace.replaceChildren(file ? h('img', { src: URL.createObjectURL(file), alt: '' }) : h('b', {}, '+'), file ? null : h('small', {}, 'Logo'));
    });
    f.append(
      h('div', { class: 'row', style: 'gap:16px;align-items:center;flex-wrap:nowrap;margin-bottom:14px' },
        h('label', { class: 'logopick', title: 'Choose the company logo' }, logoFace, logoIn),
        h('div', {}, h('b', {}, 'Company logo'), h('div', { class: 'small muted' }, 'Tap the circle to choose it. Shown beside the company in every app and on the report cover.'))),
      field('Company', clientSel), newClient, h('label', { class: 'f', style: 'margin-top:12px' }, 'Plant', siteSel), newSite,
      ...detailFields(),
      h('div', { style: 'margin-top:12px' },
        pick('site', 'Site photograph (optional)', 'image/jpeg,image/png,image/webp', 'Main gate or the plant, for the report cover')));
  }, async f => {
    const logo = f.elements.logo.files[0], site = f.elements.site.files[0];
    if (!logo && !confirm('No company logo chosen. Create the audit without it? It can be added later from the audit page (Edit details).')) return false;
    const r = await api('POST', '/api/audits', {
      client_id: val(f, 'client_id') || null, client_name: val(f, 'client_name'),
      site_id: val(f, 'site_id') || null, site_name: val(f, 'site_name'),
      ...detailValues(f),
    });
    try {
      if (logo) await uploadAuditPicture(r.id, 'logo', logo);
      if (site) await uploadAuditPicture(r.id, 'site', site);
    } catch (ex) { toast(`Audit ${r.id} created, but a picture did not upload: ${ex.message}`); route(); return; }
    toast(`Audit ${r.id} created`);
    route();
  }, { submitLabel: 'Create audit' });
}

// Correct the details later, change the logo or the site photo.
function editAuditDetails(a) {
  openDialog('Edit details', f => {
    f.append(
      h('div', { class: 'fgrid' },
        field('Company name (private)', h('input', { type: 'text', name: 'client_name', value: a.client_name || '' })),
        field('Plant name (private)', h('input', { type: 'text', name: 'site_name', value: a.site_name || '' }))),
      ...detailFields(a),
      h('div', { class: 'fgrid', style: 'margin-top:12px' },
        pick('logo', a.logo_file_id ? 'Replace the company logo' : 'Company logo', 'image/png,image/jpeg,image/webp'),
        pick('site', 'Replace the site photograph', 'image/jpeg,image/png,image/webp')));
  }, async f => {
    await api('POST', `/api/audits/${encodeURIComponent(a.id)}/details`, {
      client_name: val(f, 'client_name'), site_name: val(f, 'site_name'), ...detailValues(f),
    });
    const logo = f.elements.logo.files[0], site = f.elements.site.files[0];
    if (logo) await uploadAuditPicture(a.id, 'logo', logo);
    if (site) await uploadAuditPicture(a.id, 'site', site);
    toast('Details saved. The apps pick them up on their next sync.');
    route();
  }, { submitLabel: 'Save details' });
}
const logoImg = (id, size = 36) => id
  ? h('img', { src: `/api/files/${id}`, alt: '', class: 'complogo', style: `width:${size}px;height:${size}px` })
  : h('span', { class: 'complogo blank', style: `width:${size}px;height:${size}px` }, '—');

// ---------- one audit: the team, sync problems, and each app's data ----------
const verNum = v => (String(v || '').match(/\d+(?:\.\d+)+/) || [''])[0];
const verOlder = (a, b) => { // a older than b?
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); }
  return false;
};

/** Who is on this audit: working now, last seen, last sync, records and app version per app. */
function teamCard(st, rel) {
  const live = st.people.filter(p => p.apps.some(x => x.live));
  return h('section', { class: 'card team-card' },
    h('div', { class: 'cap' }, h('h2', {}, 'Team on this audit'),
      h('span', { class: 'small muted' }, live.length ? `${live.length} working now` : 'Nobody working right now')),
    st.people.length ? h('div', { class: 'tlist' }, st.people.map(p => h('div', { class: 'trow' },
      h('span', { class: `av${p.apps.some(x => x.live) ? ' on' : ''}`, title: p.apps.some(x => x.live) ? 'Working now' : '' }, initials(p.name)),
      h('div', { class: 'tmain' },
        h('b', {}, p.name, p.assigned ? null : h('span', { class: 'small muted' }, ' · not assigned')),
        p.apps.length ? p.apps.slice(0, 4).map(x => {
          const latest = rel[x.app]?.version, mine = verNum(x.app_version);
          const old = mine && latest && verOlder(mine, latest);
          return h('div', { class: 'tapp' },
            h('span', { class: 'tname' }, appName(x.app)),
            x.live ? h('span', { class: 'pill ok' }, 'Working now') : x.last_seen ? h('span', { class: 'small muted' }, `seen ${ago(x.last_seen)}`) : null,
            x.records ? h('span', { class: 'small' }, `${x.records} record${x.records === 1 ? '' : 's'}`) : null,
            x.last_sync ? h('span', { class: 'small muted' }, `synced ${ago(x.last_sync)}`) : null,
            x.app_version ? h('span', { class: `pill ${old ? 'warn' : 'soft'}`, title: old ? `Version ${latest} is out` : '' }, old ? `${x.app_version} · update` : x.app_version) : null);
        }).concat(p.apps.length > 4 ? [h('span', { class: 'small muted' }, `and ${p.apps.length - 4} more app${p.apps.length - 4 === 1 ? '' : 's'} (${p.apps.slice(4).reduce((n, x) => n + x.records, 0)} records): `,
          p.apps.slice(4).map(x => appName(x.app)).join(', '))] : []) : h('span', { class: 'small muted' }, 'Assigned; nothing from them yet')))))
      : h('p', { class: 'empty' }, 'Nobody is assigned and nothing has been synced yet.'));
}

/** Sync problems with what to do about each, or a clean bill. */
function problemsCard(st, a, rel, reload) {
  const closed = CLOSED.has(a.status);
  const solve = i => async () => {
    try { await api('POST', `/api/sync-issues/${i.id}/resolve`); toast('Marked as solved'); reload(); } catch (ex) { toast(ex.message); }
  };
  const fixFor = i => {
    const who = i.user_name || 'the engineer';
    if (/closed/i.test(i.reason)) return closed
      ? [h('span', { class: 'small' }, 'The audit is finalised, so saves to it are refused. '), h('button', { type: 'button', class: 'btn sm', onclick: async () => {
        if (!confirm('Reopen this audit so the team can save to it again?')) return;
        try { await api('POST', `/api/audits/${encodeURIComponent(a.id)}/reopen`); toast('Audit reopened: ask the team to sync again'); reload(); } catch (ex) { toast(ex.message); }
      } }, 'Reopen audit')]
      : h('span', { class: 'small' }, `The audit is open again: ask ${who} to sync.`);
    if (/not assigned/i.test(i.reason)) return [h('span', { class: 'small' }, `${who} is not on this audit. `), h('button', { type: 'button', class: 'btn sm', onclick: async () => {
      try { await api('POST', `/api/audits/${encodeURIComponent(a.id)}/assign`, { user_id: i.user_id, assign: true }); toast(`${who} added: ask them to sync again`); reload(); } catch (ex) { toast(ex.message); }
    } }, `Add ${who.split(' ')[0]}`)];
    if (/already recorded/i.test(i.reason)) return [h('span', { class: 'small' }, `Two records use the same tag. Rename it on ${who}'s phone, or remove the duplicate: `),
      h('a', { href: `#/apps/${i.app}/${encodeURIComponent(a.id)}` }, 'open the records')];
    if (/clock/i.test(i.reason)) return h('span', { class: 'small' }, `Ask ${who} to turn on automatic date and time on the phone, then sync.`);
    if (i.status === 'conflict') return h('span', { class: 'small' }, `${who}'s app asks them which version to keep; it clears when they choose.`);
    return h('span', { class: 'small' }, `Ask ${who} to sync again; if it repeats, look at the record.`);
  };
  const issues = st.issues.map(i => h('div', { class: 'prow' },
    h('div', { class: 'pmain' },
      h('b', {}, `${appName(i.app)} · ${(i.kind || 'record').replace(/_/g, ' ')}${i.tag ? ` ${i.tag}` : ''}`),
      h('span', { class: 'small' }, h('span', { class: `pill ${i.status === 'conflict' ? 'warn' : 'bad'}` }, i.status === 'conflict' ? 'Clash' : 'Not saved'), ' ', i.reason),
      h('span', { class: 'small muted' }, [i.user_name, i.app_version, `${i.count > 1 ? `${i.count} tries, last ` : ''}${ago(i.last_at)}`].filter(Boolean).join(' · ')),
      h('div', { class: 'pfix' }, fixFor(i))),
    h('button', { type: 'button', class: 'btn ghost sm', onclick: solve(i) }, 'Mark solved')));
  const photos = st.photos.map(m => h('div', { class: 'prow' },
    h('div', { class: 'pmain' },
      h('b', {}, `${appName(m.app)} · ${m.photos} photo${m.photos === 1 ? '' : 's'} ${m.arriving ? 'still arriving' : 'not on the server'}`),
      h('span', { class: 'small' }, h('span', { class: `pill ${m.arriving ? 'soft' : 'warn'}` }, m.arriving ? 'Arriving' : 'Missing'), ' ',
        `From ${m.name}${m.tags.length ? ` (${m.tags.join(', ')})` : ''}.${m.half_sent ? ` ${m.half_sent} started uploading and stopped.` : ''}`),
      h('div', { class: 'pfix' }, h('span', { class: 'small' }, m.arriving ? 'Saved a few minutes ago; photos follow their record.' : `Ask ${m.name} to open ${appName(m.app)} with a connection: waiting photos send by themselves.`)))));
  const old = [];
  for (const p of st.people) for (const x of p.apps) {
    const latest = rel[x.app]?.version, mine = verNum(x.app_version);
    if (mine && latest && verOlder(mine, latest)) old.push(h('div', { class: 'prow' }, h('div', { class: 'pmain' },
      h('b', {}, `${p.name} · ${appName(x.app)} ${x.app_version}`),
      h('span', { class: 'small' }, h('span', { class: 'pill warn' }, 'Update'), ` Version ${latest} is out. The app offers it by itself; or install it from `, h('a', { href: '/apps/', target: '_blank', rel: 'noopener' }, 'the download page'), '.'))));
  }
  const n = issues.length + st.photos.filter(m => !m.arriving).length + old.length;
  return h('section', { class: 'card problems-card' },
    h('div', { class: 'cap' }, h('h2', {}, 'Sync problems'),
      h('span', { class: `pill ${n ? 'bad' : 'ok'}` }, n ? `${n} to look at` : 'All in sync')),
    issues.length || photos.length || old.length
      ? h('div', { class: 'plist' }, issues, photos, old)
      : h('p', { class: 'empty' }, `Every save reached the server and every photo arrived.${st.solved ? ` ${st.solved} earlier problem${st.solved === 1 ? '' : 's'} solved.` : ''}`));
}

/** One app's card on the audit page: its figures, a donut, who recorded, and the way in. */
function appDataCard(code, recs, a, ov, openTasks, rel) {
  const byPerson = new Map();
  let last = 0;
  for (const r of recs) {
    if (r.kind === 'company_profile') continue;
    const p = byPerson.get(r.recorded_by) || 0; byPerson.set(r.recorded_by, p + 1);
    last = Math.max(last, r.saved_at || r.taken_at || 0);
  }
  const items = recs.filter(r => r.kind !== 'company_profile');
  const kinds = new Map(); for (const r of items) kinds.set(r.kind, (kinds.get(r.kind) || 0) + 1);
  const donut = ov && ov.donuts && (ov.donuts.find(d => d.kind === 'status') || ov.donuts[0]);
  return h('section', { class: 'card appcard' },
    h('div', { class: 'cap' },
      h('div', { class: 'row', style: 'gap:10px;flex-wrap:nowrap;min-width:0' }, appIcon(rel[code], 34, code),
        h('div', { style: 'min-width:0' }, h('h2', {}, appName(code)),
          h('span', { class: 'small muted' }, `${items.length} record${items.length === 1 ? '' : 's'} · last saved ${ago(last)}`))),
      openTasks.length ? h('span', { class: 'pill warn' }, `${openTasks.length} task${openTasks.length > 1 ? 's' : ''} open`) : null),
    h('div', { class: 'chips' }, [...kinds].map(([k, n]) => h('span', { class: 'pill soft' }, `${k.replace(/_/g, ' ')} ${n}`))),
    ov ? h('div', { class: 'appkpis' }, ov.kpis.slice(0, 4).map(k => h('div', {}, h('span', { class: 'small muted' }, k.label), h('b', {}, k.value)))) : null,
    donut ? h('div', { class: 'appdonut' }, donutChart(donut)) : null,
    ov && ov.flags.length ? h('p', { class: 'small appflag' }, h('span', { class: `pill ${ov.flags[0].tone === 'muted' ? 'soft' : ov.flags[0].tone === 'good' ? 'ok' : ov.flags[0].tone}` }, ov.flags[0].tag), ' ', ov.flags[0].text,
      ov.flags.length > 1 ? h('span', { class: 'muted' }, ` · ${ov.flags.length - 1} more`) : null) : null,
    h('div', { class: 'small muted' }, 'Recorded by ', [...byPerson].map(([who, n]) => `${who} (${n})`).join(', ')),
    h('div', { class: 'row', style: 'margin-top:12px;gap:8px' },
      h('a', { class: 'btn sm', href: `#/apps/${code}/${encodeURIComponent(a.id)}` }, ov ? 'Overview' : 'View records'),
      !CLOSED.has(a.status) && (state.apps || []).find(x => x.code === code)?.web
        ? h('button', { type: 'button', class: 'btn ghost sm', onclick: () => openTool(code, a.id) }, `Open ${appName(code)}`, icon('external')) : null));
}

async function auditPage(holder, id) {
  const [data, { tasks: allTasks }, st, rel, PP, { users: allUsers }] = await Promise.all([api('GET', `/api/audits/${encodeURIComponent(id)}/data`), api('GET', '/api/tasks'),
    api('GET', `/api/audits/${encodeURIComponent(id)}/status`), releases(), api('GET', `/api/audits/${encodeURIComponent(id)}/pipeline`), api('GET', '/api/users')]);
  const tasksCard = await auditTasksCard(data.audit, (await api('GET', '/api/audits')).audits);
  const pa = PP.audit;
  const reloadPage = () => auditPage(holder, id);
  const progressCard = h('section', { class: 'card progresscard' },
    h('div', { class: 'cap' }, h('h2', {}, 'Audit progress'),
      h('span', { class: 'small muted' }, pa.work_type === 'walkthrough' ? 'Walkthrough audit: no detailed audit stage' : 'Detailed audit')),
    progressLine(pa, PP),
    h('div', { class: 'grid2 progressgrid' }, nextStepBox(pa, PP, reloadPage), auditTeamBox(pa, PP, allUsers, reloadPage)),
    pa.history.length ? h('details', { class: 'phist' }, h('summary', {}, `History (${pa.history.length})`),
      h('div', { class: 'ilist' }, [...pa.history].reverse().map(l => h('div', { class: 'it' },
        h('div', { class: 'main-t' }, h('b', {}, `${stageOf(PP, l.from_stage).short} → ${stageOf(PP, l.to_stage).label}`), h('span', {}, [l.by_name, l.note].filter(Boolean).join(' · '))),
        h('div', { class: 'trail' }, fmtDate(l.at)))))) : null);
  // Removed records stay on the server as versions; the audit page shows only current ones.
  for (const k of Object.keys(data.apps)) data.apps[k] = data.apps[k].filter(r => !r.payload._deleted);
  for (const k of Object.keys(data.apps)) if (!data.apps[k].length) delete data.apps[k];
  const a = data.audit;
  const listed = (await api('GET', '/api/audits')).audits.find(x => x.id === a.id) || {};
  const finalised = CLOSED.has(a.status);
  const tasksHere = allTasks.filter(t => t.audit_id === a.id);
  const open = tasksHere.filter(t => t.status !== 'done');
  const apps = Object.entries(data.apps);

  // One card per app that has data (the analyser and Report Studio have their own cards below).
  const ovLib = await loadOverview().catch(() => null);
  const dataApps = apps.filter(([code, recs]) => code !== 'power' && code !== 'report' && recs.some(r => r.kind !== 'company_profile'));
  const appCards = dataApps.map(([code, recs]) => {
    let ov = null;
    try { ov = ovLib ? ovLib.overview(code, recs.map(r => ({ id: r.id, kind: r.kind, tag: r.tag, payload: r.payload }))) : null; } catch { ov = null; }
    return appDataCard(code, recs, a, ov, open.filter(t => t.app === code), rel);
  });

  // The report in Report Studio: its saved version, who saved it, and the way in.
  const rpt = (data.apps.report || []).find(r => r.kind === 'report');
  const reportCard = h('section', { class: 'card', style: 'margin-top:16px' },
    h('div', { class: 'cap' }, h('div', { class: 'row', style: 'gap:10px' }, appIcon(rel.report, 34, 'report'), h('h2', {}, 'Report (Report Studio)')),
      !finalised ? h('button', { class: 'btn', type: 'button', onclick: () => openTool('report', a.id) }, 'Open in Report Studio', icon('external')) : null),
    rpt ? h('p', { class: 'small' }, `Saved as version ${rpt.version} by ${rpt.updated_by_name || rpt.recorded_by} ${ago(rpt.saved_at)}. Every app's data above goes into it when Report Studio opens this company.`)
      : h('p', { class: 'empty' }, 'No report saved yet. Open Report Studio to start it: the apps\' data comes in by itself.'));

  // Power quality recordings saved here by the analyser (ops.arenergyservices.in/pqa).
  const pq = (data.apps.power || []).filter(r => r.kind === 'pq_recording');
  const ROLE_AT = { main: 'Plant main input', pcc: 'PCC panel', mcc: 'MCC panel' };
  const pqCard = h('section', { class: 'card', style: 'margin-top:16px' },
    h('div', { class: 'cap' }, h('h2', {}, 'Power quality'),
      h('button', { class: 'btn', type: 'button', onclick: () => openTool('power', a.id) }, icon('live'), 'Open the analyser for this audit')),
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
        h('div', { class: 'row', style: 'flex-wrap:nowrap;gap:14px;align-items:center' }, logoImg(listed.logo_file_id, 56),
          h('h1', {}, listed.client_name || a.title)),
        h('p', { class: 'muted small' }, h('span', { class: 'pill tag' }, a.industry_tag), ` ${a.id} · ${a.fy} · ${AUDIT_STATUS[a.status] || a.status}`,
          a.client_name ? ` · ${a.client_name} — ${a.site_name}` : '')),
      h('div', { class: 'row' },
        finalised ? null : h('button', { type: 'button', class: 'btn ghost', onclick: () => editAuditDetails({ ...listed, ...a, client_name: listed.client_name, site_name: listed.site_name }) }, 'Edit details'),
        h('a', { class: 'btn ghost', href: `/api/audits/${encodeURIComponent(a.id)}/export.zip` }, icon('download'), 'Download all (ZIP)'),
        finalised
          ? h('button', { type: 'button', class: 'btn ghost', onclick: async () => {
            if (!confirm('Reopen this audit? It returns to the running lists and its data can be changed again.')) return;
            try { await api('POST', `/api/audits/${encodeURIComponent(a.id)}/reopen`); toast('Audit reopened'); route(); } catch (ex) { toast(ex.message); }
          } }, 'Reopen')
          : h('button', { type: 'button', class: 'btn', onclick: () => finaliseAudit({ ...listed, ...a }) }, 'Finalise audit'))),
    finalised ? h('div', { class: 'note', style: 'margin-top:12px' },
      `Finalised${listed.finalized_at ? ` on ${fmtDate(listed.finalized_at)}` : ''}${listed.finalized_by_name ? ` by ${listed.finalized_by_name}` : ''}. This is a previous report: its data is kept as it was. `,
      listed.report_file_id ? h('a', { href: `/api/files/${listed.report_file_id}`, target: '_blank', rel: 'noopener' }, 'Open the final report') : 'No report file attached.') : null,

    progressCard,
    h('div', { class: 'grid2 statusgrid' }, teamCard(st, rel), problemsCard(st, a, rel, () => auditPage(holder, id))),
    h('section', { class: 'metrics' },
      h('div', { class: 'metric' }, h('div', { class: 'top' }, icon('doc'), 'Records'), h('div', { class: 'v' }, apps.reduce((n, [, r]) => n + r.length, 0)),
        h('div', { class: 'mnote' }, `across ${apps.length} app${apps.length === 1 ? '' : 's'}`)),
      h('div', { class: 'metric' }, h('div', { class: 'top' }, icon('overview'), 'Photos & files'), h('div', { class: 'v' }, data.files.length),
        h('div', { class: 'mnote' }, `${photos.length} images`)),
      h('div', { class: 'metric' }, h('div', { class: 'top' }, icon('tasks'), 'Tasks still open'), h('div', { class: 'v' }, open.length),
        h('div', { class: `mnote${open.some(t => t.due_at && t.due_at < Date.now()) ? ' bad' : ''}` },
          open.some(t => t.due_at && t.due_at < Date.now()) ? 'some are overdue' : `${tasksHere.length - open.length} done`))),

    tasksCard,

    dataApps.length ? [h('h2', { class: 'section-title' }, `Data by app (${dataApps.length})`), h('div', { class: 'appcards' }, appCards)]
      : h('section', { class: 'card', style: 'margin-top:16px' }, h('p', { class: 'empty' }, 'No app has synced data for this audit yet.')),
    reportCard,
    pqCard,
    finalised ? null : connectorCard(a),

    h('section', { class: 'card', style: 'margin-top:16px' },
      h('div', { class: 'cap' }, h('h2', {}, 'Company and plant'), h('span', { class: 'small muted' }, 'The apps fill their company setup from this')),
      h('div', { class: 'list' }, [
        ['Company', listed.client_name], ['Plant', listed.site_name], ['Plant type', state.sectors[listed.sector] || listed.sector],
        ['Type of work', state.workTypes[listed.work_type] || listed.title], ['Financial year', listed.fy],
        ['District, state', [listed.district, listed.state].filter(Boolean).join(', ')], ['Pincode', listed.pincode],
        ['Contract demand', listed.contract_demand_kva != null ? `${listed.contract_demand_kva} kVA` : ''], ['MSME (Udyam) number', listed.msme_no],
      ].map(([k, v]) => h('div', {}, h('span', { class: 'muted' }, k), h('span', {}, v || '—'))))),

    photos.length ? h('section', { class: 'card', style: 'margin-top:16px' }, h('h2', {}, 'Photos'),
      h('p', { class: 'sub' }, 'Every photo from the field apps is stored here, with what it shows, the record it belongs to, who took it, when, and where (when the phone allowed location).'),
      h('div', { class: 'photos' }, photos.map(f => h('figure', {},
        h('a', { href: f.url, target: '_blank', rel: 'noopener' }, h('img', { src: f.url, alt: f.caption || 'Photo', loading: 'lazy' })),
        h('figcaption', {}, h('b', {}, f.caption || 'No caption'),
          h('span', {}, [f.kind === 'thermal' ? 'Thermal' : 'Photo', f.equipment_tag, appName(f.app)].filter(Boolean).join(' · ')),
          f.record_kind && h('span', {}, `For: ${f.record_kind.replace(/_/g, ' ')}${f.equipment_tag ? ` ${f.equipment_tag}` : ''}${f.field && !/^photo(Path)?$/.test(f.field) ? ` (${f.field})` : ''}`),
          h('span', {}, `Taken ${f.taken_at ? fmtDate(f.taken_at) : '—'}${f.uploaded_by_name ? ` by ${f.uploaded_by_name}` : ''}`),
          f.captured_in && h('span', {}, `On: ${f.captured_in}`),
          f.location
            ? h('a', { href: f.location.map_url, target: '_blank', rel: 'noopener' }, `Where it was taken (map)${f.location.accuracy_m != null ? `, within ${f.location.accuracy_m} m` : ''}`)
            : h('span', { class: 'muted' }, 'No location recorded')))))) : null,

    others.length ? h('section', { class: 'card', style: 'margin-top:16px' }, h('h2', {}, 'Other files'),
      h('div', { class: 'ilist' }, others.map(f => h('div', { class: 'it' },
        h('div', { class: 'main-t' }, h('a', { href: f.url }, h('b', {}, f.original_name || f.id)), h('span', {}, [f.caption, f.equipment_tag, appName(f.app)].filter(Boolean).join(' · '))),
        h('div', { class: 'trail' }, `${Math.ceil(f.size / 1024)} KB`))))) : null));
}

// ---------- the AI report connector, per audit (lib/mcp.js) ----------
// Claude connects with a personal token made here for this one audit. It sees only the cleaned
// facts sheet under a code name, never the company, people, bills or photos; its drafts come back
// to Report Studio as suggestions for the engineer to accept or reject.
function connectorCard(a) {
  const box = h('section', { class: 'card', style: 'margin-top:16px' }, h('p', { class: 'muted small' }, 'Loading the AI report connector…'));
  const load = async () => {
    let d;
    try { d = await api('GET', `/api/audits/${encodeURIComponent(a.id)}/mcp`); } catch (ex) { box.replaceChildren(h('p', { class: 'err' }, ex.message)); return; }
    const superAdmin = state.me.role === 'super_admin';
    const usable = d.enabled && (d.demo || d.real_allowed);
    const live = d.tokens.filter(t => !t.revoked_at && t.expires_at > Date.now());
    const makeToken = () => {
      let made = null;
      openDialog('Connect Claude to this audit', f => {
        f.append(h('p', { class: 'muted small' }, 'A personal token for this audit only. It lasts 30 days and you can revoke it any time.'),
          field('Name it', h('input', { type: 'text', name: 'label', value: 'Claude', maxlength: 60 }), 'So you know where it is used, e.g. "Claude on my laptop"'));
      }, async f => {
        made = await api('POST', `/api/audits/${encodeURIComponent(a.id)}/mcp/tokens`, { label: val(f, 'label') || null });
        showConnector(made);
        load();
      }, { submitLabel: 'Make token' });
    };
    const revoke = async t => {
      if (!confirm('Revoke this token? Claude stops reaching this audit at once.')) return;
      try { await api('POST', `/api/mcp/tokens/${t.id}/revoke`); toast('Token revoked'); load(); } catch (ex) { toast(ex.message); }
    };
    const setDemo = async on => {
      if (!on && !confirm('Turn off demo for this audit? Every connector token of this audit stops working.')) return;
      try { await api('POST', `/api/audits/${encodeURIComponent(a.id)}/demo`, { demo: on }); load(); } catch (ex) { toast(ex.message); }
    };
    // Empty parts (null) are left out: replaceChildren would print them as the word "null".
    box.replaceChildren(...[
      h('div', { class: 'cap' }, h('h2', {}, 'AI report connector'),
        h('span', { class: 'row', style: 'gap:6px' },
          d.demo ? h('span', { class: 'pill warn' }, 'Demo audit') : h('span', { class: 'pill soft' }, 'Real audit'),
          usable ? h('span', { class: 'pill ok' }, 'Available') : h('span', { class: 'pill soft' }, d.enabled ? 'Demo audits only' : 'Switched off'))),
      h('p', { class: 'sub' }, `Claude can read this audit's figures (as ${d.handle}, never the company's name), suggest text, recommendations and charts, and save them to Report Studio as suggestions. `,
        'It never sees the company, address, people, phone numbers, consumer numbers, bills or photos, and nothing prints until an engineer accepts it.'),
      h('div', { class: 'row', style: 'gap:8px;margin-bottom:12px' },
        usable && h('button', { class: 'btn cta', type: 'button', onclick: makeToken }, 'Connect Claude'),
        superAdmin && h('button', { class: 'btn ghost small', type: 'button', onclick: () => setDemo(!d.demo) }, d.demo ? 'Turn off demo' : 'Mark as demo audit'),
        !usable && !superAdmin && h('span', { class: 'small muted' }, 'Only demo audits can use the connector for now; the Super Admin marks them.')),
      live.length ? h('div', { class: 'ilist' }, live.map(t => h('div', { class: 'it' },
        h('div', { class: 'main-t' }, h('b', {}, t.label || 'Token'), h('span', {}, `${t.user_name} · made ${fmtDay(t.created_at)} · ${t.last_used_at ? `last used ${ago(t.last_used_at)}` : 'not used yet'} · ends ${fmtDay(t.expires_at)}`)),
        h('button', { class: 'btn small danger', type: 'button', onclick: () => revoke(t) }, 'Revoke')))) : null,
      d.log.length ? h('details', { style: 'margin-top:12px' }, h('summary', { class: 'small', style: 'cursor:pointer;font-weight:600' }, `What Claude asked for (${d.log.length} latest)`),
        h('div', { class: 'ilist' }, d.log.map(l => h('div', { class: 'it' },
          h('div', { class: 'main-t' }, h('b', {}, l.tool.replace(/_/g, ' ')), h('span', {}, `${l.user_name} · ${(l.bytes / 1024).toFixed(1)} KB sent`)),
          h('div', { class: 'trail' }, l.blocked ? h('span', { class: 'pill bad' }, 'blocked') : l.ok ? ago(l.at) : h('span', { class: 'pill warn' }, 'error')))))) : null].filter(x => x != null && x !== false));
  };
  load();
  return box;
}

// The token, shown once, and how to add the connector in Claude.
function showConnector(made) {
  const copy = async (text, what) => { try { await navigator.clipboard.writeText(text); toast(`${what} copied`); } catch { toast('Copy not allowed here — select the text instead'); } };
  const dlg = h('dialog', {},
    h('div', { class: 'body' },
      h('h2', {}, 'Add the connector in Claude'),
      h('p', { class: 'muted small' }, 'The token is shown only this once. Keep it private; anyone with it can read this audit\'s cleaned figures.'),
      h('label', { class: 'f', style: 'margin-top:14px' }, 'Connector address', h('div', { class: 'secret' }, made.url)),
      h('label', { class: 'f', style: 'margin-top:12px' }, 'Token', h('div', { class: 'secret' }, made.token)),
      h('ol', { class: 'gsteps', style: 'margin-top:16px;font-size:14px' },
        h('li', {}, 'In Claude: Settings › Connectors › Add custom connector.'),
        h('li', {}, 'Name it "AR report" and paste the connector address.'),
        h('li', {}, 'Under the advanced settings add a request header: Authorization with the value "Bearer " followed by the token.'),
        h('li', {}, 'In a new chat, switch the connector on and ask, for example: "Draft the motor chapter and the top three recommendations."'),
        h('li', {}, 'Open Report Studio › AI suggestions for this audit and accept or reject each item.')),
      h('div', { class: 'foot' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => copy(made.url, 'Address') }, 'Copy address'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => copy(`Bearer ${made.token}`, 'Header value') }, 'Copy header value'),
        h('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); dlg.remove(); } }, 'Done'))));
  document.body.append(dlg);
  dlg.showModal();
}

// ---------- tasks ----------
// ---------- tasks: process tasks, data-entry targets, ordinary tasks (lib/tasks.js) ----------
const SOURCE = { process: 'Process', data: 'Data entry', manual: 'Task' };
const STAGE_SHORT = { initiated: 'Initiated', walkthrough: 'Walkthrough', detailed: 'Detailed', processing: 'Processing', draft: 'Draft', approval: 'Approval', final: 'Final', completed: 'Completed', post_audit: 'Post audit' };

/** One task row: status button, what, where, who, progress, due and the actions. */
function taskRow(t, kinds, reload, { showCompany = true } = {}) {
  const late = t.status !== 'done' && t.due_at && t.due_at < Date.now();
  const setStatus = async status => { try { await api('POST', `/api/tasks/${t.id}/status`, { status }); reload(); } catch (ex) { toast(ex.message); } };
  const p = t.progress, pct = p ? Math.min(100, Math.round((p.count / p.target) * 100)) : null;
  const kindWord = t.record_kind && kinds[t.app] ? kinds[t.app][t.record_kind] : 'records';
  return h('div', { class: `trowt ${t.status}${late ? ' late' : ''}` },
    h('button', { type: 'button', class: `tstat ${t.status}`, 'aria-label': t.status === 'done' ? 'Done: mark as to do' : t.status === 'running' ? 'Running: mark done' : 'To do: start',
      title: t.status === 'done' ? 'Done (click to reopen)' : t.status === 'running' ? 'Running (click when done)' : 'To do (click to start)',
      onclick: () => setStatus(t.status === 'todo' ? 'running' : t.status === 'running' ? 'done' : 'todo') }, t.status === 'done' ? CHECK() : null),
    h('div', { class: 'tbody' },
      h('div', { class: 'ttitle' }, t.title),
      h('div', { class: 'tmeta small' },
        h('span', { class: `pill ${t.source === 'process' ? 'soft' : t.source === 'data' ? 'ok' : 'tag'}` }, SOURCE[t.source] || 'Task'),
        showCompany ? h('a', { href: `#/audit/${encodeURIComponent(t.audit_id)}` }, t.client_name || t.audit_id) : null,
        t.stage ? h('span', { class: 'muted' }, STAGE_SHORT[t.stage] || t.stage) : null,
        t.app ? h('span', {}, appName(t.app)) : null,
        h('span', { class: t.assignee ? '' : 'muted' }, t.assignee_name || 'Nobody yet'),
        t.due_at ? h('span', { class: late ? 'lateword' : 'muted' }, `${late ? 'overdue · ' : 'due '}${fmtDay(t.due_at)}`) : null,
        t.status === 'done' && t.done_note ? h('span', { class: 'muted' }, t.done_note) : null),
      p ? h('div', { class: 'tprog' }, h('span', { class: 'tbar' }, h('i', { style: `width:${pct}%` })),
        h('span', { class: 'small' }, `${p.count} of ${p.target} ${kindWord}${t.assignee_name ? ` by ${t.assignee_name.split(' ')[0]}` : ''}`)) : null,
      t.note ? h('div', { class: 'small muted' }, t.note) : null),
    h('div', { class: 'tact' },
      h('button', { type: 'button', class: 'btn ghost sm', onclick: () => editTask(t, reload) }, 'Edit'),
      t.source !== 'process' ? h('button', { type: 'button', class: 'btn ghost sm danger', onclick: async () => {
        if (!confirm(`Remove the task "${t.title}"?`)) return;
        try { await api('DELETE', `/api/tasks/${t.id}`); toast('Task removed'); reload(); } catch (ex) { toast(ex.message); }
      } }, 'Remove') : null));
}

async function tasks(holder) {
  const [T, { audits: auditList }, { users }] = await Promise.all([api('GET', '/api/tasks'), api('GET', '/api/audits'), api('GET', '/api/users')]);
  const reload = () => tasks(holder);
  let view = 'mine', who = '', q = '';
  try { view = sessionStorage.getItem('ares-task-view') || (state.me.role === 'super_admin' ? 'open' : 'mine'); } catch { /* private window */ }
  const now = Date.now(), week = now - 7 * 86400000;
  const all = T.tasks;
  const open = all.filter(t => t.status !== 'done');
  const VIEWS = [
    ['mine', 'My tasks', t => t.assignee === state.me.id && t.status !== 'done'],
    ['open', 'All open', t => t.status !== 'done'],
    ['overdue', 'Overdue', t => t.status !== 'done' && t.due_at && t.due_at < now],
    ['data', 'Data entry', t => t.source === 'data' && t.status !== 'done'],
    ['done', 'Done', t => t.status === 'done'],
  ];
  const listBox = h('div', { class: 'tgroups' });
  const paint = () => {
    const test = (VIEWS.find(v => v[0] === view) || VIEWS[1])[2];
    const rows = all.filter(t => test(t) && (!who || t.assignee === who) && (!q || `${t.title} ${t.client_name} ${t.assignee_name}`.toLowerCase().includes(q)));
    const byCo = new Map();
    for (const t of (view === 'done' ? rows.slice(0, 80) : rows)) { if (!byCo.has(t.audit_id)) byCo.set(t.audit_id, []); byCo.get(t.audit_id).push(t); }
    listBox.replaceChildren(...(byCo.size ? [...byCo].map(([aid, ts]) => h('section', { class: 'card tgroup' },
      h('div', { class: 'cap' },
        h('a', { class: 'coname', href: `#/audit/${encodeURIComponent(aid)}` }, logoImg(ts[0].logo_file_id, 30), h('b', {}, ts[0].client_name || aid)),
        h('span', { class: 'pill soft' }, STAGE_SHORT[ts[0].audit_stage] || ts[0].audit_stage || '')),
      ts.map(t => taskRow(t, T.kinds, reload, { showCompany: false }))))
      : [h('div', { class: 'card' }, h('p', { class: 'empty' }, view === 'mine' ? 'Nothing assigned to you right now.' : 'Nothing here.'))]));
  };
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' }, VIEWS.map(([k, label, test]) => h('button', { type: 'button', 'aria-pressed': String(view === k),
    onclick: e => { view = k; try { sessionStorage.setItem('ares-task-view', k); } catch { /* private window */ }
      e.currentTarget.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget))); paint(); } },
    label, h('span', { class: 'segn' }, String(all.filter(test).length)))));
  const people = h('select', { 'aria-label': 'Person', onchange: e => { who = e.target.value; paint(); } }, h('option', { value: '' }, 'Everyone'),
    users.filter(u => u.status === 'active').map(u => h('option', { value: u.id }, u.name)));
  const search = h('input', { type: 'search', class: 'pipesearch', placeholder: 'Find a task', 'aria-label': 'Find a task', oninput: e => { q = e.target.value.trim().toLowerCase(); paint(); } });
  const metric = (label, v, note, tone) => h('div', { class: 'metric' }, h('div', { class: 'top' }, label), h('div', { class: `v${tone ? ` ${tone}` : ''}` }, String(v)), note ? h('div', { class: 'mnote' }, note) : null);
  const dataOpen = open.filter(t => t.progress);
  const dataPct = dataOpen.length ? Math.round(dataOpen.reduce((n, t) => n + Math.min(1, t.progress.count / t.progress.target), 0) / dataOpen.length * 100) : null;

  holder.replaceChildren(h('div', {},
    h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Tasks'),
      h('p', { class: 'muted small' }, 'Process tasks appear by themselves at each stage; data-entry tasks count what each person syncs; tasks close by themselves when the data shows they are done.')),
      h('button', { class: 'btn', disabled: !auditList.length, title: auditList.length ? null : 'Create an audit first', onclick: () => newTask(auditList, users, T.kinds, reload) }, 'New task')),
    h('section', { class: 'metrics' },
      metric('Open', open.length, `${open.filter(t => t.status === 'running').length} running`),
      metric('Overdue', open.filter(t => t.due_at && t.due_at < now).length, 'past their due date'),
      metric('Done this week', all.filter(t => t.status === 'done' && t.done_at > week).length, `${all.filter(t => t.status === 'done' && t.done_at > week && /data shows|recorded/.test(t.done_note || '')).length} closed by the data`),
      metric('Data entry', dataPct === null ? '—' : `${dataPct} %`, dataOpen.length ? `average progress of ${dataOpen.length} open target${dataOpen.length > 1 ? 's' : ''}` : 'no open targets')),
    h('div', { class: 'grid2 taskgrid' },
      h('div', {}, h('div', { class: 'row pipetools' }, seg, h('div', { class: 'row', style: 'gap:8px' }, people, search)), listBox),
      h('section', { class: 'card workload' },
        h('div', { class: 'cap' }, h('h2', {}, 'Who is doing what'), h('span', { class: 'small muted' }, 'last 7 days')),
        T.workload.length ? h('div', { class: 'tlist' }, T.workload.map(p => h('div', { class: 'wrow' },
          h('span', { class: 'av' }, initials(p.name)),
          h('div', { class: 'tmain' },
            h('b', {}, p.name),
            h('div', { class: 'small' }, `${p.open} open`, p.overdue ? h('span', { class: 'lateword' }, ` · ${p.overdue} overdue`) : null, ` · ${p.done_week} done this week`),
            p.entered.length ? h('div', { class: 'small muted' }, 'Entered: ', p.entered.slice(0, 4).map(e => `${e.n} in ${appName(e.app)} (${e.client_name})`).join(', '),
              p.entered.length > 4 ? ` and ${p.entered.length - 4} more` : '') : h('div', { class: 'small muted' }, 'No data entered this week')))))
          : h('p', { class: 'empty' }, 'No tasks assigned and no data entered this week.')))));
  paint();
}

function newTask(auditList, users, kinds, reload, preset = {}) {
  const running = auditList.filter(a => !CLOSED.has(a.status) || a.stage === 'completed' || a.stage === 'post_audit');
  openDialog('New task', f => {
    const appSel = h('select', { name: 'app' }, h('option', { value: '' }, '—'), state.apps.filter(a => a.field || a.code === 'power').map(a => h('option', { value: a.code, selected: preset.app === a.code }, a.name)));
    const kindSel = h('select', { name: 'record_kind' }, h('option', { value: '' }, 'Any record of the app'));
    const fillKinds = () => kindSel.replaceChildren(h('option', { value: '' }, 'Any record of the app'),
      ...Object.entries(kinds[appSel.value] || {}).map(([k, v]) => h('option', { value: k }, v)));
    appSel.addEventListener('change', fillKinds); fillKinds();
    f.append(
      field('Company', h('select', { name: 'audit_id', required: true }, running.map(a => h('option', { value: a.id, selected: preset.audit_id === a.id }, `${a.client_name || a.title} · ${a.industry_tag}`)))),
      field('Task', h('input', { type: 'text', name: 'title', required: true, placeholder: 'e.g. Record the motors of the spinning section' })),
      h('div', { class: 'fgrid' },
        field('App (optional)', appSel),
        field('Assign to', h('select', { name: 'assignee' }, h('option', { value: '' }, 'Nobody yet'),
          users.filter(u => u.status === 'active').map(u => h('option', { value: u.id }, `${u.name} (${ROLE[u.role]})`))), 'Also adds them to the audit team'),
        field('Data entry target (optional)', h('input', { type: 'number', name: 'target', min: 1, max: 10000, step: 1, placeholder: 'e.g. 25' }), 'Counted from what they sync in that app'),
        field('Of', kindSel),
        field('Due date (optional)', h('input', { type: 'date', name: 'due' })),
        field('Note (optional)', h('input', { type: 'text', name: 'note', maxlength: 500 }))));
  }, async f => {
    await api('POST', '/api/tasks', { audit_id: val(f, 'audit_id'), title: val(f, 'title'), app: val(f, 'app') || null, due: val(f, 'due') || null,
      assignee: val(f, 'assignee') || null, target: val(f, 'target') || null, record_kind: val(f, 'record_kind') || null, note: val(f, 'note') || null });
    toast('Task added');
    reload ? reload() : route();
  }, { submitLabel: 'Add task' });
}

async function editTask(t, reload) {
  const { users } = await api('GET', '/api/users');
  const isoDay = ms => ms ? new Date(ms + 5.5 * 3600000).toISOString().slice(0, 10) : '';
  openDialog('Edit task', f => {
    f.append(
      t.source !== 'process' ? field('Task', h('input', { type: 'text', name: 'title', value: t.title, required: true })) : h('p', {}, h('b', {}, t.title)),
      h('div', { class: 'fgrid' },
        field('Assigned to', h('select', { name: 'assignee' }, h('option', { value: '' }, 'Nobody yet'),
          users.filter(u => u.status === 'active').map(u => h('option', { value: u.id, selected: u.id === t.assignee }, `${u.name} (${ROLE[u.role]})`)))),
        field('Due date', h('input', { type: 'date', name: 'due', value: isoDay(t.due_at) })),
        t.source === 'data' ? field('Target', h('input', { type: 'number', name: 'target', min: 1, max: 10000, value: t.target })) : null,
        field('Note', h('input', { type: 'text', name: 'note', value: t.note || '', maxlength: 500 }))));
  }, async f => {
    const body = { assignee: val(f, 'assignee') || null, due: val(f, 'due') || null, note: val(f, 'note') || null };
    if (t.source !== 'process') body.title = val(f, 'title');
    if (t.source === 'data') body.target = val(f, 'target');
    await api('POST', `/api/tasks/${t.id}`, body);
    toast('Task saved'); reload();
  }, { submitLabel: 'Save' });
}

/** The tasks card on an audit's page: this company's tasks by stage, with a quick add. */
async function auditTasksCard(a, auditList) {
  const box = h('section', { class: 'card', style: 'margin-top:16px' }, h('p', { class: 'muted small' }, 'Loading tasks…'));
  const load = async () => {
    let T;
    try { T = await api('GET', `/api/tasks?audit=${encodeURIComponent(a.id)}`); } catch (ex) { box.replaceChildren(h('p', { class: 'err' }, ex.message)); return; }
    const { users } = await api('GET', '/api/users');
    const open = T.tasks.filter(t => t.status !== 'done'), done = T.tasks.filter(t => t.status === 'done');
    box.replaceChildren(
      h('div', { class: 'cap' }, h('h2', {}, `Tasks (${open.length} open)`),
        h('button', { type: 'button', class: 'btn sm', onclick: () => newTask(auditList, users, T.kinds, load, { audit_id: a.id }) }, 'New task')),
      open.length ? h('div', {}, open.map(t => taskRow(t, T.kinds, load, { showCompany: false }))) : h('p', { class: 'empty' }, 'Nothing open for this company.'),
      done.length ? h('details', { class: 'phist' }, h('summary', {}, `Done (${done.length})`), done.slice(0, 40).map(t => taskRow(t, T.kinds, load, { showCompany: false }))) : null);
  };
  load();
  return box;
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
  'audit.stage': 'moved an audit on', 'audit.stage_back': 'sent an audit back', 'audit.post_audit': 'recorded the post audit',
  'audit.finalised': 'completed an audit', 'audit.reopened': 'reopened an audit', 'task.edited': 'changed a task', 'task.removed': 'removed a task',
  'sync_issue.solved': 'marked a sync problem solved', 'record.edited': 'corrected a record', 'record.removed': 'removed a record',
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
  const me = state.me;
  const myCard = h('div', { class: 'card', style: 'max-width:460px;margin-bottom:16px' },
    h('h2', {}, 'My profile card'),
    h('div', { class: 'pc-top', style: 'margin-top:10px' }, avatar(me),
      h('div', { style: 'min-width:0' },
        h('h3', {}, me.name),
        h('div', { class: 'pc-pos' }, me.position || h('span', { class: 'muted' }, 'Position not set')),
        h('div', { class: 'small muted', style: 'margin-top:4px' }, me.in_report ? 'Shown in reports' : 'Not shown in reports'))),
    h('div', { class: 'foot', style: 'margin-top:14px' }, h('button', { class: 'btn', type: 'button', onclick: () => editMyCard() }, 'Edit my card')));
  holder.replaceChildren(
    h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'My account'),
      h('p', { class: 'muted small' }, `${me.name} · ${me.login_id} · ${ROLE[me.role]}`))),
    myCard, form);
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

// The app's own logo (public/icons/<code>.png); a published release's icon otherwise; a phone at last.
const ICON_CODES = new Set(['survey', 'motor', 'heat', 'textile', 'air', 'pump', 'cool', 'xmer', 'light', 'dryer', 'power', 'report', 'audit']);
function appIcon(rel, size = 44, code = null) {
  const src = code && ICON_CODES.has(code) ? `/icons/${code}.png` : rel?.icon ? `/apps/${rel.icon}` : null;
  return src
    ? h('img', { class: 'appicon', src, alt: '', width: size, height: size })
    : h('span', { class: 'appicon blank', style: `width:${size}px;height:${size}px` }, icon('phone'));
}
const miniIcon = code => h('img', { class: 'mini-icon', src: `/icons/${code}.png`, alt: '', width: 20, height: 20 });

async function appsPage(holder) {
  const [{ apps }, rel] = await Promise.all([api('GET', '/api/apps'), releases()]);
  const field = apps.filter(a => a.field);
  const web = apps.filter(a => a.web && !a.field);
  const planned = apps.filter(a => !a.field && !a.web);
  holder.replaceChildren(
    h('div', { class: 'head' },
      h('div', {}, h('h1', {}, 'App console'),
        h('p', { class: 'muted small' }, 'Every field app and its data. Choose an app to see each company it has data for: the company profile, what was recorded, by whom and when.')),
    ),
    h('div', { class: 'appgrid' }, field.map(a => {
      const r = rel[a.code];
      return h('div', { class: 'appcard' },
        h('div', { class: 'row' }, appIcon(r, 44, a.code), h('div', { style: 'min-width:0' }, h('b', {}, a.name), h('div', { class: 'small muted' }, a.tagline))),
        h('div', { class: 'list' },
          h('div', {}, h('span', { class: 'muted' }, 'Version'), r ? h('span', {}, `v${r.version} · ${fmtDay(Date.parse(r.released_at))}`) : h('span', { class: 'muted' }, 'Not published')),
          h('div', {}, h('span', { class: 'muted' }, 'Records'), h('span', { class: 'num' }, a.records.toLocaleString('en-IN'))),
          h('div', {}, h('span', { class: 'muted' }, 'Audits with data'), h('span', { class: 'num' }, a.audits)),
          h('div', {}, h('span', { class: 'muted' }, 'People with access'), h('span', { class: 'num' }, a.people.filter(p => p.status === 'active').length)),
          h('div', {}, h('span', { class: 'muted' }, 'Last sync'), h('span', {}, a.last_sync ? ago(a.last_sync) : 'Nothing yet'))),
        h('div', { class: 'row' },
          h('a', { class: 'btn sm', href: `#/apps/${a.code}` }, 'View data'),
          a.web && h('button', { class: 'btn ghost sm', type: 'button', onclick: () => openTool(a) }, `Open ${a.name}`, icon('external'))));
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
        appWeb && !CLOSED.has(x.status) && h('button', { class: 'btn ghost sm', type: 'button', onclick: () => openTool(code, x.audit_id) }, `Open ${appName}`, icon('external')))),
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
    h('div', { class: 'head' },
      h('div', { class: 'row' }, appIcon(r, 52, a.code),
        h('div', {}, h('p', { class: 'small' }, h('a', { href: '#/apps' }, '‹ App console')),
          h('h1', {}, a.name), h('p', { class: 'muted small' }, a.tagline || 'Planned app'))),
      a.web && h('button', { class: 'btn', type: 'button', onclick: () => openTool(a) }, `Open ${a.name}`, icon('external')),
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

    h('div', {},
      h('div', {},
        h('h2', { class: 'section-title' }, 'People with access'),
        h('div', { class: 'card' }, a.people.length ? h('div', { class: 'list' }, a.people.map(p => h('div', {},
          h('span', {}, p.name, h('span', { class: 'small muted' }, p.role === 'super_admin' ? ' · Super Admin' : p.employment === 'freelancer' ? ' · Freelancer' : ' · Staff')),
          h('span', { class: `pill ${p.status}` }, p.status === 'active' ? 'Active' : p.status === 'hold' ? 'On hold' : 'Removed'))))
          : h('p', { class: 'empty' }, 'Nobody yet.'),
          h('p', { class: 'small muted', style: 'margin-top:10px' }, 'Give or remove access in ', h('a', { href: '#/team' }, 'Team & access'), '.'))))));
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

// ---------- an app's overview at one company: figures, charts and points to look at ----------
// public/overview.js runs each field app's own calculation engine (tools/bundle-overview.mjs), so
// these are the figures the app itself shows. Loaded the first time an overview is opened.
let overviewLib = null;
function loadOverview() {
  if (!overviewLib) overviewLib = new Promise((resolve, reject) => {
    const s = h('script', { src: '/overview.js' });
    s.onload = () => (window.ARES_OVERVIEW ? resolve(window.ARES_OVERVIEW) : reject(new Error('Overview did not load.')));
    s.onerror = () => { overviewLib = null; reject(new Error('Overview did not load.')); };
    document.head.append(s);
  });
  return overviewLib;
}

/** One horizontal bar chart: a row per item, the bar scaled to the largest value or mark. */
function barChart(c) {
  const fmt = v => Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-IN') : Number(v.toFixed(Math.abs(v) >= 10 ? 1 : 2)).toLocaleString('en-IN');
  const max = Math.max(...c.bars.map(b => b.value), ...(c.marks || []).map(m => m.value), 0) * 1.08 || 1;
  const pct = v => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  const unit = c.unit && c.unit !== '₹' ? ` ${c.unit}` : '';
  return h('section', { class: 'card hchart' },
    h('div', { class: 'cap' }, h('h3', {}, c.title), c.unit ? h('span', { class: 'small muted' }, c.unit) : null),
    h('div', { class: 'hbars', role: 'img', 'aria-label': `${c.title}: ${c.bars.map(b => `${b.label} ${b.text || fmt(b.value) + unit}`).join(', ')}` },
      c.bars.map(b => h('div', { class: 'hrow' },
        h('span', { class: 'hl', title: b.label }, b.label),
        h('span', { class: 'htrack' },
          h('i', { class: `t-${b.tone || 'plain'}`, style: `width:${pct(b.value)}` }),
          (c.marks || []).map(m => h('b', { class: 'hmark', style: `left:${pct(m.value)}`, title: m.label }))),
        h('span', { class: 'hv num' }, b.text || `${fmt(b.value)}${unit}`)))),
    c.marks && c.marks.length ? h('p', { class: 'small muted hnote' }, 'Lines: ', c.marks.map(m => m.label).join(' · ')) : null);
}

/** A donut chart, as in the ARES app: a split of a whole (one colour per item) or a status mix (by tone). */
const SPLIT_COLORS = ['#2B2644', '#0e7490', '#c2410c', '#15803d', '#7c3aed', '#be185d', '#64748b'];
const TONE_COLORS = { good: '#0b7a45', warn: '#d67800', bad: '#c4161c', muted: '#9ca3af' };
function donutChart(d) {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const total = d.slices.reduce((a, x) => a + x.value, 0);
  const color = (x, i) => d.kind === 'status' ? TONE_COLORS[x.tone] || TONE_COLORS.muted : SPLIT_COLORS[i % SPLIT_COLORS.length];
  const fmt = v => v >= 100 ? Math.round(v).toLocaleString('en-IN') : Number(v.toFixed(v >= 10 ? 1 : 2)).toLocaleString('en-IN');
  const unit = d.unit ? ` ${d.unit}` : '';
  const R = 60, C = 2 * Math.PI * R, gap = d.slices.length > 1 ? 3 : 0;
  const svg = el('svg', { viewBox: '0 0 160 160', class: 'donut-svg', 'aria-hidden': 'true' });
  svg.append(el('circle', { cx: 80, cy: 80, r: R, fill: 'none', stroke: 'rgba(0,0,0,.05)', 'stroke-width': 22 }));
  let start = 0;
  d.slices.forEach((x, i) => {
    const len = (x.value / total) * C;
    const arc = el('circle', { cx: 80, cy: 80, r: R, fill: 'none', stroke: color(x, i), 'stroke-width': 22,
      'stroke-dasharray': `${Math.max(len - gap, 0.5)} ${C}`, 'stroke-dashoffset': String(-start), transform: 'rotate(-90 80 80)' });
    arc.append(el('title', {}));
    arc.lastChild.textContent = `${x.label}: ${fmt(x.value)}${unit} (${Math.round((x.value / total) * 100)} %)`;
    svg.append(arc);
    start += len;
  });
  const big = el('text', { x: 80, y: d.unit ? 80 : 86, 'text-anchor': 'middle', class: 'donut-total' });
  big.textContent = fmt(total);
  svg.append(big);
  const small = el('text', { x: 80, y: d.unit ? 100 : 106, 'text-anchor': 'middle', class: 'donut-unit' });
  small.textContent = d.unit || (total === 1 ? 'item' : 'items');
  svg.append(small);
  return h('section', { class: 'card donut', role: 'img', 'aria-label': `${d.title}: ${d.slices.map(x => `${x.label} ${fmt(x.value)}${unit}`).join(', ')}` },
    h('h3', {}, d.title),
    h('div', { class: 'donut-body' }, svg,
      h('ul', { class: 'donut-legend' }, d.slices.map((x, i) => h('li', {},
        h('i', { style: `background:${color(x, i)}` }),
        h('span', { class: 'dl', title: x.label }, x.label),
        h('span', { class: 'dv num' }, `${fmt(x.value)}${unit}`, h('small', {}, ` ${Math.round((x.value / total) * 100)} %`)))))));
}

function overviewView(o) {
  const metric = k => h('div', { class: 'metric' }, h('div', { class: 'top' }, k.label), h('div', { class: 'v' }, k.value), k.note ? h('div', { class: 'mnote' }, k.note) : null);
  return h('div', {},
    h('section', { 'aria-label': 'At a glance', class: 'metrics' }, o.kpis.map(metric)),
    o.donuts && o.donuts.length ? h('div', { class: 'donuts' }, o.donuts.map(donutChart)) : null,
    o.charts.length ? h('div', { class: 'hcharts' }, o.charts.map(barChart)) : null,
    h('h2', { class: 'section-title' }, 'Points to look at'),
    h('div', { class: 'card' }, o.flags.length
      ? h('div', { class: 'list flags' }, o.flags.map(x => h('div', {},
        h('span', {}, h('span', { class: `pill ${x.tone === 'muted' ? 'soft' : x.tone === 'good' ? 'ok' : x.tone}` }, x.tag)),
        h('span', { class: 'small' }, x.text))))
      : h('p', { class: 'empty' }, 'Nothing stands out: every reading is within its normal range.')));
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
  let ov = null, ovError = null;
  if (items.length) {
    try { ov = (await loadOverview()).overview(code, recs.map(r => ({ id: r.id, kind: r.kind, tag: r.tag, payload: r.payload }))); }
    catch (ex) { ovError = ex.message; }
  }
  const tabKey = `ares-tab-${code}`;
  let tab = 'records';
  if (ov) { tab = 'overview'; try { tab = sessionStorage.getItem(tabKey) || 'overview'; } catch { /* private window */ } }

  const remove = r => async () => {
    if (!confirm(`Remove ${r.kind.replace(/_/g, ' ')}${r.tag ? ` ${r.tag}` : ''}? Phones delete it at their next sync; the earlier versions stay on the server.`)) return;
    try { await api('DELETE', `/api/records/${encodeURIComponent(r.id)}`); toast('Record removed'); reload(); } catch (ex) { toast(ex.message); }
  };
  const actions = r => locked ? null : h('div', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' },
    h('button', { type: 'button', class: 'btn ghost sm', onclick: () => editRecord(r, reload) }, 'Edit'),
    h('button', { type: 'button', class: 'btn ghost sm danger', onclick: remove(r) }, 'Remove'));

  holder.replaceChildren(h('div', {},
    h('div', { class: 'head' },
      h('div', {},
        h('p', { class: 'small' }, h('a', { href: '#/apps' }, '‹ App console'), ' · ', h('a', { href: `#/apps/${code}` }, app.name)),
        h('h1', {}, a.client_name || d.audit.client_name || a.title),
        h('p', { class: 'muted small' }, h('span', { class: 'pill tag' }, a.industry_tag), ` ${a.site_name} · ${a.title} · ${a.id} · ${a.fy} · ${AUDIT_STATUS[a.status] || a.status}`)),
      h('div', { class: 'row' },
        h('a', { class: 'btn ghost', href: `#/audit/${encodeURIComponent(a.id)}` }, 'Whole audit'),
        // Straight into the app, already signed in and on this company (running audits only).
        app.web && !locked ? h('button', { type: 'button', class: 'btn', onclick: () => openTool(code, a.id) }, `Open ${app.name}`, icon('external')) : null)),
    locked && h('div', { class: 'note', style: 'margin-top:12px' }, 'This audit is finalised: its data is kept as it was and cannot be changed. Reopen it from the audit page to make corrections.'),
    ovError ? h('div', { class: 'note', style: 'margin-top:12px' }, `The overview could not be worked out (${ovError}). The records are below.`) : null,
    ov ? h('div', { class: 'seg tabseg', role: 'group', 'aria-label': 'View' },
      [['overview', 'Overview'], ['records', `Records (${items.length})`]].map(([k, label]) => h('button', {
        type: 'button', 'aria-pressed': String(tab === k), onclick: e => {
          tab = k;
          try { sessionStorage.setItem(tabKey, k); } catch { /* private window */ }
          e.currentTarget.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
          holder.querySelector('[data-pane="overview"]').hidden = k !== 'overview';
          holder.querySelector('[data-pane="records"]').hidden = k !== 'records';
        } }, label))) : null,
    ov ? h('div', { 'data-pane': 'overview', hidden: tab !== 'overview' }, overviewView(ov)) : null,

    h('div', { 'data-pane': 'records', hidden: tab !== 'records' },
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
          f.location ? h('a', { href: f.location.map_url, target: '_blank', rel: 'noopener' }, 'Where it was taken (map)') : null)))))] : null)));
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
    h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Previous reports'),
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
