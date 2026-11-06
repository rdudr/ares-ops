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

function gate(title, sub, formKids, onSubmit, btnLabel, { busyLabel = 'Please wait…', below = null, note = null } = {}) {
  const err = h('div', { class: 'err', hidden: true, role: 'alert' });
  const arrow = h('span', { class: 'go-ic', 'aria-hidden': 'true' }, icon('arrow'));
  const label = h('span', {}, btnLabel);
  const submit = h('button', { class: 'btn go', type: 'submit' }, label, arrow);
  const form = h('form', { class: 'gate-form', novalidate: false },
    h('div', { class: 'gate-title' }, h('h2', {}, title), h('p', {}, sub)),
    formKids, err, submit, below,
    note && h('p', { class: 'gate-note' }, icon('lock'), h('span', {}, note)));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.hidden = true;
    submit.disabled = true;
    label.textContent = busyLabel;
    form.setAttribute('aria-busy', 'true');
    try { await onSubmit(form); } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
      form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
    } finally { submit.disabled = false; label.textContent = btnLabel; form.removeAttribute('aria-busy'); }
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
          h('p', {}, 'The private side of AR Energy Services', h('span', { class: 'd-only' }, ': who is in the field, every audit and what it has collected, and who may use which app'), '.'),
          h('ul', { class: 'gate-points' },
            point('team', 'One login', 'One Login ID for every field app.'),
            point('shield', 'Private by default', 'Client names and readings stay behind this sign-in.'),
            point('live', 'Live', 'See who is recording, in which app, for which audit.'))),
        form)),
    h('footer', { class: 'gate-foot' }, h('span', {}, '© AR Energy Services · private, not indexed'),
      h('a', { href: '/apps/', target: '_blank', rel: 'noopener' }, 'Download the field apps'))));
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
  gate('Sign in', 'For Super Admins and Admins. Field engineers sign in from their app.', [
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
  }, 'Sign in', { busyLabel: 'Signing in…', note: 'Five wrong passwords lock the account from that network for 15 minutes; an admin can unlock it sooner. You are signed out after 30 minutes idle.' });
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
  arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
  back: ['M19 12H5', 'M11 6l-6 6 6 6'],
  plus: ['M12 5v14', 'M5 12h14'],
  tick: ['M5 12.5l4.5 4.5L19 7.5'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  check: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M8.5 12.2l2.4 2.4 4.6-4.8'],
  warn: ['M12 4 2.5 20h19z', 'M12 10v4.5', 'M12 17.5h.01'],
  cloud: ['M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6 9.5 4.25 4.25 0 0 0 7 18z'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
  chevron: ['M6 9l6 6 6-6'],
  'chevron-up': ['M6 15l6-6 6 6'],
  'chevron-r': ['M9 6l6 6-6 6'],
  shield: ['M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6z', 'M9 12l2 2 4-4'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
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
  'app-xmer': ['M4 7v10M8 7v10', 'M4 12h4', 'M16 7v10M20 7v10', 'M16 12h4', 'M8 12h8'],
  'app-light': ['M9 18h6M10 21h4', 'M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z'],
  'app-dryer': ['M5 3h14v18H5z', 'M12 17a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z', 'M8 6h.01M11 6h.01'],
  'app-report': ['M7 3h7l4 4v14H7z', 'M14 3v4h4', 'M10 12h5M10 16h5'],
  'app-solar': ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5'],
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

// ---------- shell: the website's dark header with a pill menu; a dock on phones ----------
const PAGES = [
  { id: 'overview', label: 'Overview', group: 'Monitor', icon: 'overview' },
  { id: 'team-activity', label: 'Team activity', group: 'Monitor', icon: 'team' },
  { id: 'tasks', label: 'Tasks', group: 'Monitor', icon: 'tasks' },
  { id: 'activity', label: 'Activity log', group: 'Monitor', icon: 'activity' },
  { id: 'team', label: 'Team & access', group: 'Manage', icon: 'team' },
  { id: 'audits', label: 'Audits', group: 'Manage', icon: 'audits' },
  { id: 'reports', label: 'Previous reports', group: 'Manage', icon: 'doc' },
  { id: 'ledger', label: 'Energy Ledger', group: 'Manage', icon: 'doc', needs: 'ledger' },
  { id: 'apps', label: 'App console', group: 'Field apps', icon: 'apps' },
  { id: 'guide', label: 'Getting started', group: null, icon: 'guide' },
  { id: 'account', label: 'My account', group: null, icon: 'account' },
  { id: 'pipeline', label: 'Companies', group: null, icon: 'audits' },
  { id: 'more', label: 'More', group: null, icon: 'more' },
];
const GROUPS = ['Monitor', 'Manage', 'Field apps', 'Tools'];
// Field apps get a sub-page each (from /api/me), listed under "All apps".
const menuPages = () => PAGES.filter(p => !p.needs || mine(p.needs));
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

let heroSlot = null;
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
// A tool in a menu: opens signed in where it can (openTool), otherwise as a plain link.
const toolItem = t => {
  const a = mi(t.href, 'external', t.label, true);
  if (!NO_LAUNCH.has(t.code)) a.addEventListener('click', e => { e.preventDefault(); openTool(t.code); });
  return a;
};

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
    if (n) {
      badge.replaceChildren(h('span', { class: 'sr' }, 'overdue: '), String(n)); badge.hidden = false;
      const db = document.querySelector('.dock .dbadge');
      if (db) { db.textContent = String(n); db.hidden = false; }
    }
  }).catch(() => {});
  const ddBtn = (label, isOn) => h('button', { type: 'button', class: isOn ? 'on' : null }, label, icon('chevron'));

  const fieldMenu = dropdown(ddBtn('Field apps', on('apps')),
    () => [mi('#/apps', 'apps', 'App console'), fieldPages().map(p => mi(`#/${p.id}`, 'phone', p.label))]);
  const moreMenu = dropdown(ddBtn('More', ['activity', 'team-activity', 'pipeline', 'ledger', 'guide', 'more'].includes(active)),
    () => [mi('#/pipeline', 'audits', 'Companies'), mine('ledger') && mi('#/ledger', 'doc', 'Energy Ledger'), mi('#/team-activity', 'team', 'Team activity'), mi('#/activity', 'activity', 'Activity log'),
      toolLinks().map(toolItem),
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
    h('a', { href: '#/tasks', ...cur('tasks') }, icon('tasks'), 'Tasks', h('span', { class: 'dbadge', hidden: true, 'aria-hidden': 'true' })), dockLink('team', 'team', 'Team'),
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
  const solo = page === 'ledger' && param && /[?&]solo\b/.test(location.hash);
  const fn = page === 'ledger' && mine('ledger') ? h2 => loadLedger().then(m => (param ? m.ledgerCompany(h2, decodeURIComponent(param), ledgerHelpers(), { solo }) : m.ledgerHome(h2, ledgerHelpers())))
    : page === 'audit' && param ? h2 => auditPage(h2, decodeURIComponent(param))
    : page === 'apps' && param && param2 ? h2 => appAuditPage(h2, decodeURIComponent(param), decodeURIComponent(param2))
    : page === 'apps' && param ? h2 => appPage(h2, decodeURIComponent(param))
      : ({ overview, pipeline: pipelinePage, 'team-activity': teamActivity, team, audits, tasks, activity, account, apps: appsPage, guide: guidePage, reports: reportsPage, more: morePage }[page] || overview);
  const holder = h('div', { class: 'page' }, h('p', { class: 'muted' }, 'Loading…'));
  const activeId = page === 'audit' ? 'audits' : page === 'apps' && param ? `apps/${param}` : page;
  // Energy Ledger opened in its own window: the company's data and nothing around it.
  if (solo) root.replaceChildren(holder);
  else shell([...menuPages(), ...fieldPages()].some(p => p.id === activeId) || page === 'guide' ? activeId : 'overview', holder);
  try {
    await fn(holder);
    if (page === 'overview' && mine('ledger')) loadLedger().then(m => m.overviewNotice(ledgerHelpers())).then(n => { if (n) holder.prepend(n); }).catch(() => {});
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


// Phones: the team as cards, sorted by a picker.
function teamCardsM(people) {
  const list = h('div', {});
  const SORTS = [['hours', 'hours'], ['records', 'records'], ['records_per_hour', 'records per hour'], ['on_time_pct', 'on time'], ['overdue', 'overdue'], ['last_active', 'last active']];
  let key = 'hours';
  const draw = () => {
    const rows = [...people].sort((a, b) => ((b[key] ?? -1) > (a[key] ?? -1) ? 1 : (b[key] ?? -1) < (a[key] ?? -1) ? -1 : 0));
    list.replaceChildren(...rows.slice(0, 6).map(p => h('div', { class: 'tm' },
      h('span', { class: 'tm-top' }, h('span', { class: `av s40${p.status !== 'active' ? ' dim' : ''}`, 'aria-hidden': 'true' }, initials(p.name)),
        h('span', { class: 'tm-n' }, h('b', {}, p.name), h('span', {}, `${p.employment === 'freelancer' ? 'Freelancer' : 'Staff'} · ${ROLE[p.role]}`,
          p.working_now ? [' · ', h('span', { class: 'ok' }, 'in the field')] : p.status !== 'active' ? [' · ', h('span', { class: 'warn' }, STATUS[p.status].toLowerCase())] : null)),
        h('span', { class: 'tm-h' }, h('b', {}, String(p.hours)), h('span', {}, 'hours'))),
      h('span', { class: 'tm-s' }, [`${p.records} records`, p.records_per_hour != null && `${p.records_per_hour} / h`, p.on_time_pct != null && `${p.on_time_pct}% on time`].filter(Boolean).join(' · '),
        p.overdue ? h('span', { class: 'due bad' }, `${p.overdue} overdue`) : null))));
  };
  draw();
  return h('div', { class: 'm-only' },
    h('label', { class: 'fsel full' }, h('span', { class: 'sr' }, 'Sort people by'),
      h('select', { onchange: e => { key = e.target.value; draw(); } }, SORTS.map(([k, l]) => h('option', { value: k }, `Sorted by ${l}`))), icon('chevron')),
    list, h('a', { class: 'tm-all', href: '#/team' }, `All ${people.length} people`));
}

const dur = ms => { const m = Math.round(ms / 60000); return m < 60 ? `${m} m` : `${Math.floor(m / 60)} h ${m % 60} m`; };
const hourLabel = hr => hr === 12 ? '12 pm' : hr === 0 || hr === 24 ? '12 am' : hr < 12 ? `${hr} am` : `${hr - 12} pm`;

async function overview(holder, { background = false } = {}) {
  const [d, P, { tasks: taskList }, { users }] = await Promise.all([
    api('GET', `/api/dashboard?days=${state.days}`, null, { background }),
    api('GET', '/api/pipeline', null, { background }),
    api('GET', '/api/tasks', null, { background }).catch(() => ({ tasks: [] })),
    api('GET', '/api/users', null, { background }).catch(() => ({ users: [] }))]);
  const t = d.totals;
  const now = Date.now();
  const periodName = (PERIODS.find(p => p[0] === d.days)?.[1] || `${d.days} days`).toLowerCase();
  const me = state.me;
  const running = P.audits.filter(a => !CLOSED.has(a.status));
  const GROUPS5 = STAGE_GROUPS.filter(g => g[2]);
  const inGroup = (key, xs = running) => xs.filter(a => GROUPS5.find(g => g[0] === key)[2].includes(a.stage));
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
  const kpi = (ic, v, b, note, bad, k, mb, mnote) => h('div', { class: `okpi ${k}${bad ? ' bad' : ''}` }, h('span', { class: 'ok-ic', 'aria-hidden': 'true' }, icon(ic)),
    h('span', { class: 'ok-v' }, v), h('span', { class: 'ok-t' }, h('b', {}, h('span', { class: 'd-only' }, b), h('span', { class: 'm-only' }, mb || b)),
      h('span', { class: 'd-only' }, note), h('span', { class: 'm-only' }, mnote || note)));
  const last14 = d.records_per_day.reduce((s, x) => s + x.n, 0);
  const opening = heroHead(h('div', { class: 'ov-top' },
    h('div', { class: 'ov-greet' },
      h('span', { class: 'livechip' }, `Live · ${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}, ${timeOf(now)}`),
      h('h1', {}, `${greet}, ${first}. `, working.length
        ? [h('em', {}, `${inWords(working.length)} ${working.length === 1 ? 'engineer' : 'engineers'}`), ` ${working.length === 1 ? 'is' : 'are'} in the field`, h('span', { class: 'd-only' }, ' right now'), '.']
        : 'Nobody is in the field right now.'),
      h('p', {}, sub),
      h('div', { class: 'ov-acts' },
        overdue.length ? goBtn('Review overdue tasks', 'arrow', { href: '#/tasks', class: 'btn go white' }) : goBtn('Open tasks', 'arrow', { href: '#/tasks', class: 'btn go white' }),
        h('button', { type: 'button', class: 'ghostw', onclick: newAudit }, icon('plus'), 'New audit'))),
    seg),
  h('div', { class: 'ov-kpis-wrap' }, h('section', { class: 'ov-kpis', 'aria-label': `At a glance, this ${periodName}` },
    kpi('live', String(working.length), 'Working now', working.length ? working.map(w => `${firstName(w.name)} in ${appName(w.app)}`).join(', ') : 'nobody in an app', false, 'k1', null,
      working.length ? working.map(w => firstName(w.name)).join(', ') : 'nobody'),
    kpi('doc', t.records.toLocaleString('en-IN'), `Records this ${periodName}`, `${last14.toLocaleString('en-IN')} in the last 14 days`, false, 'k2', 'Records', `this ${periodName}`),
    kpi('clock', `${t.hours} h`, 'Hours logged', `in field apps this ${periodName}`, false, 'k3', null, 'in field apps'),
    kpi('audits', String(running.length), 'Running audits', [inGroup('field').length && `${inGroup('field').length} in the field`, inGroup('approval').length && `${inGroup('approval').length} for approval`].filter(Boolean).join(', ') || 'none in the field', false, 'k5'),
    kpi('warn', String(overdue.length), 'Overdue tasks', overdue.length ? `oldest was due ${fmtDay(overdue[0].due_at)}` : 'nothing overdue', overdue.length > 0, 'k4', null,
      overdue.length ? `oldest ${fmtDay(overdue[0].due_at)}` : 'none'))));

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
    h('div', { class: 'tlm m-only' },
      h('div', { class: 'tlm-axis', 'aria-hidden': 'true' }, h('span', { style: 'left:0' }, hourLabel(from)), h('span', { class: 'mid', style: 'left:50%' }, hourLabel((from + to) / 2)),
        h('span', { class: 'now', style: `left:${nowPct}` }, 'Now'), h('span', { style: 'right:0' }, hourLabel(to))),
      peopleIds.map(uid => {
        const ss = sess.filter(s => s.user_id === uid);
        const ms = ss.reduce((n, s) => n + (sessEnd(s) - s.started_at), 0);
        const op = ss.find(s => s.open);
        const lastS = ss[ss.length - 1];
        return h('div', { class: 'tlm-row' }, h('span', { class: 'av s38', 'aria-hidden': 'true' }, initials(ss[0].name)),
          h('span', { class: 'tlm-t' }, h('span', { class: 'tlm-n' }, h('b', {}, ss[0].name), h('span', {}, dur(ms))),
            op ? h('span', { class: 'tlm-s live' }, [`In ${appName(op.app)} now`, op.industry_tag, `since ${timeOf(op.started_at)}`].filter(Boolean).join(' · '))
              : h('span', { class: 'tlm-s' }, [`Last in ${appName(lastS.app)}`, lastS.industry_tag].filter(Boolean).join(' · ')),
            h('span', { class: 'tlm-track', 'aria-hidden': 'true' }, ss.map(s => h('span', { class: s.open ? 'open' : null, style: `left:${pct(s.started_at)};width:calc(${pct(sessEnd(s))} - ${pct(s.started_at)})` })),
              h('span', { class: 'tlm-now', style: `left:${nowPct}` }))));
      }),
      quiet.map(p => h('div', { class: 'tlm-row' }, h('span', { class: 'av s38 dim', 'aria-hidden': 'true' }, initials(p.name)),
        h('span', { class: 'tlm-t' }, h('span', { class: 'tlm-n' }, h('b', {}, p.name), h('span', {}, '0 h')),
          h('span', { class: 'tlm-s q' }, p.last_active ? `No session today · active ${ago(p.last_active)}` : 'No session today'))))),
    h('p', { class: 'tl-note' }, 'Bars are the work sessions each field app logs. Select a bar to open that audit.'));

  // ---- Needs attention ----
  const unlock = async u => { try { await api('POST', `/api/users/${u.id}/unlock`); toast(`${u.name} can sign in again`); overview(holder); } catch (ex) { toast(ex.message); } };
  const attn = [
    overdue.length && h('div', { class: 'at' }, h('span', { class: 'at-ic bad', 'aria-hidden': 'true' }, icon('clock')),
      h('span', { class: 'at-t' }, h('b', {}, `${overdue.length} task${overdue.length === 1 ? '' : 's'} overdue`),
        h('span', { class: 'd-only' }, overdue.slice(0, 4).map(x => `${x.title} (${fmtDay(x.due_at)})`).join(', ')),
        h('span', { class: 'm-only' }, overdue.length > 1 ? `${overdue[0].title} and ${overdue.length - 1} more` : overdue[0].title),
        h('a', { href: '#/tasks', class: 'd-only' }, 'Open tasks', icon('arrow'))),
      h('a', { href: '#/tasks', class: 'at-go m-only', 'aria-label': 'Open tasks' }, icon('chevron-r'))),
    ...locked.map(u => h('div', { class: 'at' }, h('span', { class: 'at-ic bad', 'aria-hidden': 'true' }, icon('lock')),
      h('span', { class: 'at-t' }, h('b', {}, `${u.name} is locked out`), h('span', { class: 'd-only' }, 'Too many wrong passwords. The lock lifts by itself after 15 minutes, or unlock now.'),
        h('span', { class: 'm-only' }, 'Lifts by itself after 15 minutes')),
      u.can_manage && h('button', { type: 'button', class: 'tbtn dark at-btn', onclick: () => unlock(u) }, 'Unlock'))),
    ...tempPw.map(u => h('div', { class: 'at' }, h('span', { class: 'at-ic warn', 'aria-hidden': 'true' }, icon('warn')),
      h('span', { class: 'at-t' }, h('b', {}, `${u.name} can’t sync yet`), h('span', { class: 'd-only' }, 'The temporary password hasn’t been replaced, so nothing they record can arrive.'),
        h('span', { class: 'm-only' }, 'Temporary password not replaced'),
        h('a', { href: `#/team?p=${u.id}`, class: 'd-only' }, 'Open in Team', icon('arrow'))),
      h('a', { href: `#/team?p=${u.id}`, class: 'at-go m-only', 'aria-label': `Open ${u.name} in Team` }, icon('chevron-r')))),
    ...pipelineAttention(P).map(x => h('div', { class: 'at' }, h('span', { class: `at-ic ${x.tone === 'bad' ? 'bad' : x.tone === 'ok' ? 'good' : 'warn'}`, 'aria-hidden': 'true' }, icon(x.tone === 'ok' ? 'check' : x.tone === 'bad' ? 'warn' : 'clock')),
      h('span', { class: 'at-t' }, h('b', {}, x.name), h('span', {}, x.text), h('a', { href: x.href, class: 'd-only' }, 'Open company', icon('arrow'))),
      h('a', { href: x.href, class: 'at-go m-only', 'aria-label': `Open ${x.name}` }, icon('chevron-r')))),
  ].filter(Boolean);
  const attention = h('section', { class: 'ov-card attn', 'aria-labelledby': 'h-attn' },
    h('span', { class: 'kicker red' }, 'Needs attention'),
    h('h2', { id: 'h-attn' }, attn.length ? `${inWords(attn.length)} thing${attn.length === 1 ? '' : 's'} to sort out` : 'Nothing to sort out'),
    attn.length ? h('div', {}, attn.slice(0, 5)) : h('p', { class: 'empty' }, 'No overdue tasks, and everyone can sign in and sync.'),
    attn.length > 5 ? h('a', { class: 'sc-all', href: '#/pipeline' }, `and ${attn.length - 5} more`, icon('arrow')) : null);

  // ---- Audit pipeline ----
  const pipe = h('section', { class: 'pipe', 'aria-labelledby': 'h-pipe' },
    h('div', { class: 'pipe-h' }, h('div', {}, h('span', { class: 'kicker sage' }, 'Audit pipeline'),
      h('h2', { id: 'h-pipe' }, `${inWords(running.length)} audit${running.length === 1 ? '' : 's'}, `, h('em', {}, 'first visit to report')),
      h('p', {}, 'Every running audit and the stage it is at. Open one to see what has been collected and what is still to do.')),
      goBtn('All companies', 'arrow', { href: '#/pipeline', class: 'btn go white' })),
    h('ol', {}, GROUPS5.map(([k, label], i) => {
      const xs = inGroup(k, P.audits);
      return h('li', { class: k === 'field' ? 'hot' : xs.length ? null : 'none' },
        h('div', { class: 'p-top' }, h('span', { class: 'p-n' }, String(i + 1).padStart(2, '0')), h('span', {}, `${xs.length} audit${xs.length === 1 ? '' : 's'}`)),
        h('h3', {}, label),
        xs.length ? [xs.slice(0, 4).map(a => {
          const lt = taskList.filter(x => x.audit_id === a.id && isLate(x)).length;
          return h('a', { class: 'p-a', href: `#/audit/${encodeURIComponent(a.id)}` },
            h('span', { class: 'p-tag' }, h('span', {}, a.industry_tag), lt ? h('span', { class: 'p-late' }, `${lt} late`) : null),
            h('span', { class: 'p-sub' }, `${stageOf(P, a.stage).short} · ${a.records ? `${a.records} records · ${a.open_tasks} open` : 'no data yet'}`));
        }), xs.length > 4 ? h('a', { class: 'p-more', href: '#/pipeline' }, `and ${xs.length - 4} more`) : null]
          : h('p', { class: 'p-none' }, 'No audit here.'));
    })),
    h('ol', { class: 'pipe-m m-only' }, GROUPS5.map(([k, label], i) => {
      const xs = inGroup(k, P.audits);
      return h('li', {}, h('span', { class: 'pm-h' }, h('span', { class: 'p-n' }, String(i + 1).padStart(2, '0')), h('h3', {}, label), h('span', {}, String(xs.length))),
        xs.length ? h('span', { class: 'pm-tags' }, xs.slice(0, 6).map(a => {
          const lt = taskList.filter(x => x.audit_id === a.id && isLate(x)).length;
          return h('a', { href: `#/audit/${encodeURIComponent(a.id)}` }, a.industry_tag, lt ? h('span', {}, `${lt} late`) : null);
        })) : h('span', { class: 'p-none' }, 'No audit here.'));
    })),
    (() => { const n = P.audits.length - running.length; return n ? h('p', { class: 'pipe-foot' }, `${inWords(n)} finalised audit${n === 1 ? ' is' : 's are'} kept as ${n === 1 ? 'it was' : 'they were'} in `, h('a', { href: '#/reports' }, 'Previous reports'), '.') : null; })(),
    h('a', { class: 'pm-all m-only', href: '#/pipeline' }, 'All companies', icon('arrow')));

  // ---- How the team is doing ----
  const people = d.people.filter(p => p.role !== 'super_admin' || p.records || p.hours);
  const teamSec = h('section', { class: 'tdo', 'aria-labelledby': 'h-team' },
    h('div', { class: 'tdo-h' }, h('div', {}, h('span', { class: 'kicker' }, `This ${periodName}`), h('h2', { id: 'h-team' }, 'How the team is doing')),
      h('p', {}, 'Hours come from the work sessions each app logs; records are readings saved by that person. Select a column heading to sort.')),
    h('div', { class: 'tcard d-only' }, peopleTable(people)),
    teamCardsM(people));

  // ---- Records collected + Latest changes ----
  const chart = h('section', { class: 'ov-card rec', 'aria-labelledby': 'h-rec' }, h('span', { class: 'kicker' }, 'Last 14 days'),
    h('h2', { id: 'h-rec' }, 'Records collected'), recordsChart(d.records_per_day));
  const recent = h('section', { class: 'ov-card act', 'aria-labelledby': 'h-act' },
    h('div', { class: 'act-h' }, h('div', {}, h('span', { class: 'kicker' }, 'Activity'), h('h2', { id: 'h-act' }, 'Latest changes')), h('a', { href: '#/team-activity' }, 'Team activity')),
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
    pageTitle({ title: 'More' }),
    group('Field apps', fieldPages().map(p => row(`#/${p.id}`, 'phone', p.label, tagline(p.id.slice(5)))), h('a', { href: '#/apps', class: 'small' }, 'App console')),
    group('Records', [row('#/pipeline', 'audits', 'Companies', 'Every company and its progress'), row('#/reports', 'doc', 'Previous reports', 'Finalised audits'),
      mine('ledger') && row('#/ledger', 'doc', 'Energy Ledger', 'Bills, baseline and GHG per company'),
      row('#/team-activity', 'team', 'Team activity', 'Hours, records and who is working'), row('#/activity', 'activity', 'Activity log', 'Every sign-in, change and sync')]),
    group('Tools', toolLinks().map(t => {
      const r = row(t.href, 'external', t.label, tagline(t.app), true);
      if (!NO_LAUNCH.has(t.code)) r.addEventListener('click', e => { e.preventDefault(); openTool(t.code); });
      return r;
    })),
    group('Help', [row('#/guide', 'guide', 'Getting started', 'From new login to recording on site'), row('/apps/', 'download', 'Download page', 'Newest version of every field app', true)]),
    h('section', { class: 'card mgroup' },
      h('div', { class: 'macct' }, h('span', { class: 'av lg' }, initials(me.name)),
        h('span', {}, h('h2', {}, me.name), h('span', { class: 'small' }, `${ROLE[me.role]} · ${me.login_id}`))),
      h('a', { class: 'mrow plain', href: '#/account' }, icon('account'), 'My account and password'),
      h('button', { class: 'mrow plain danger', type: 'button', onclick: signOut }, icon('signout'), 'Sign out')));
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
// Short app names for chips in tables; any other app shows its full name.
const APP_SHORT = { motor: 'Motor', heat: 'Boiler', textile: 'Dye', pump: 'Hydro', cool: 'Cool', xmer: 'Trafo', light: 'Lux', dryer: 'Dryer', power: 'Grid', bills: 'GST', report: 'Report' };
const appShort = code => APP_SHORT[code] || appName(code);
const appSym = code => icon(ICONS[`app-${code}`] ? `app-${code}` : 'apps');
const firstName = name => name.split(/\s+/)[0];
const STAGE_TONE = { setup: 'draft', field: 'ok', processing: 'proc', review: 'warn', approved: 'proc' };
const stagePill = (key, lg) => h('span', { class: `spill ${lg ? 'lg ' : ''}${STAGE_TONE[key] || 'soft'}` }, STAGE_SHORT[key] || key);
const timeOf = ms => new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
const dayTime = ms => {
  if (!ms) return 'never';
  const d = new Date(ms), today = new Date();
  return d.toDateString() === today.toDateString() ? `Today, ${timeOf(ms)}` : fmtDate(ms);
};
const NUM_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
const inWords = (n, lower) => { const w = NUM_WORDS[n] || String(n); return lower && NUM_WORDS[n] ? w.toLowerCase() : w; };

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
    return h('button', { type: 'button', 'aria-pressed': String(filter === k), onclick: () => { filter = k; drawFilters(); drawRows(); drawPanel(); } },
      label, h('span', { class: k === 'action' && n ? 'cnt alert' : 'cnt' }, String(n)));
  }));
  const drawRows = () => {
    const fn = FILTERS.find(f => f[0] === filter)[2];
    const list = users.filter(fn).filter(u => !q || `${u.name} ${u.login_id}`.toLowerCase().includes(q));
    tbody.replaceChildren(...(list.length ? list.map(u => {
      const on = sel && u.id === sel.id;
      const w = live(u.id);
      return h('tr', { class: on ? 'sel' : u.locked ? 'tint-bad' : u.must_change_pw && u.status === 'active' ? 'tint-warn' : null },
        h('td', { class: 'pcell' }, h('button', { type: 'button', class: 'pbtn', 'aria-pressed': String(on), onclick: () => { sel = u; state.teamSel = u.id; drawRows(); drawPanel(); } },
          h('span', { class: `av${on ? ' deep' : avTone(u)}`, 'aria-hidden': 'true' }, initials(u.name)),
          h('span', { class: 'pn' }, h('b', {}, u.name), h('span', {}, u.login_id)))),
        h('td', { class: 'role' }, ROLE[u.role],
          u.owner ? h('span', { class: 'own' }, 'Main Super Admin') : h('span', {}, u.employment === 'freelancer' ? 'Freelancer' : 'Staff')),
        h('td', {}, u.role === 'super_admin' ? h('span', { class: 'mutedcell' }, 'All apps')
          : u.apps.length ? h('span', { class: 'achips' }, u.apps.map(c => h('span', {}, appShort(c)))) : h('span', { class: 'mutedcell' }, 'None')),
        h('td', {}, statusCell(u, on)),
        h('td', { class: w ? 'last live' : 'last' }, w ? 'In the field' : ago(u.last_login_at)));
    }) : [h('tr', {}, h('td', { colspan: 5, class: 'empty' }, 'No one here.'))]));
  };

  // ---- the person panel (desktop: beside the table; phones: opens under the person) ----
  const panel = h('aside', { class: 'ppanel d-only', 'aria-labelledby': 'p-name' });
  const acc = h('div', { class: 'tacc m-only' });
  const parts = u => {
    const m = u.can_manage;
    const w = live(u.id);
    const fn = firstName(u.name);
    // Every app, as on the server: what this viewer may not change shows but stays off.
    const apps = state.apps.filter(a => mine(a.code));
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
      return h('label', { class: `apr${has ? ' on' : ''}` }, box, h('span', { class: 'aic', 'aria-hidden': 'true' }, appSym(a.code)),
        h('span', { class: 'an' }, a.name), !a.field && h('span', { class: 'anote' }, a.web ? 'web app' : 'planned'));
    };
    const audits = u.audits.map(x => ({ ...x, a: auditList.find(a => a.id === x.id) }));
    const edit = m && h('button', { type: 'button', class: 'obtn sm', onclick: () => editPerson(u) }, 'Edit');
    const liveLine = w && h('span', { class: 'livedot' }, `In ${appName(w.app)} since ${timeOf(w.started_at)}`);
    const dl = h('dl', { class: 'pp-dl' },
      h('div', {}, h('dt', {}, 'Last sign-in'), h('dd', {}, dayTime(u.last_login_at))),
      h('div', {}, h('dt', {}, 'Password'), h('dd', {}, u.must_change_pw ? 'Temporary, not changed yet' : 'Own password set')),
      h('div', {}, h('dt', {}, 'Phone'), h('dd', { class: u.phone ? null : 'mutedcell' }, u.phone || 'Not added')));
    return {
      top: () => h('div', { class: 'pp-top' },
        h('div', { class: 'pp-id' }, h('span', { class: 'av xl', 'aria-hidden': 'true' }, u.photo ? h('img', { src: u.photo, alt: '' }) : initials(u.name)),
          h('span', { class: 'pp-nm' }, h('h2', { id: 'p-name' }, u.name),
            h('span', { class: 'pp-role' }, `${ROLE[u.role]} · ${u.employment === 'freelancer' ? 'Freelancer' : 'Staff'}`),
            h('span', { class: 'pp-login' }, `Login ID ${u.login_id}`)),
          edit),
        h('div', { class: 'pp-state' }, statusCell(u, false), liveLine), dl),
      topM: () => h('div', { class: 'pp-topm' }, h('div', { class: 'pp-state' }, liveLine || h('span', { class: 'pp-login' }, `Login ID ${u.login_id}`), edit), dl),
      apps: () => h('fieldset', { class: 'pp-sec' }, h('legend', {}, u.role === 'super_admin' ? 'Apps (all, as Super Admin)' : `Apps ${fn} can use`),
        h('div', { class: 'aprs' }, apps.map(appRow)),
        h('p', { class: 'pp-note d-only' }, `Changes reach ${fn}’s phone at the next sync.`)),
      audits: () => h('div', { class: 'pp-sec' },
        h('div', { class: 'pp-h' }, h('h3', {}, `Audits ${fn} works on`),
          m && h('button', { type: 'button', class: 'linkbtn', onclick: () => addToAudit(u, auditList) },
            h('span', { class: 'd-only' }, '+ Add to an audit'), h('span', { class: 'm-only' }, '+ Add'))),
        audits.length || u.role === 'engineer'
          ? (audits.length ? audits.map(x => h('a', { class: 'aud', href: `#/audit/${encodeURIComponent(x.id)}` },
            h('span', { class: 'tagpill' }, x.tag), h('span', { class: 'aud-t' }, x.a?.title || x.id), x.a && stagePill(x.a.stage || 'setup')))
            : h('p', { class: 'pp-note' }, 'Not on any audit yet.'))
          : h('p', { class: 'pp-note' }, u.role === 'head' ? 'Admins see the audits of their apps.' : 'Super Admins see every audit.'),
        u.role === 'engineer' && h('p', { class: 'pp-note d-only' }, 'Engineers see and add data only for these industries.')),
      access: () => m && h('div', { class: 'pp-sec last' }, h('h3', { class: 'd-only' }, 'Sign-in and access'),
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
        h('p', { class: 'pp-note' }, `Hold or Revoke signs ${fn} out of every app now. Work not yet synced stays on the phone.`)),
    };
  };
  const shortStatus = u => u.locked ? h('span', { class: 'spill bad' }, icon('lock'), 'Locked') : u.status === 'hold' ? h('span', { class: 'spill warn' }, 'On hold')
    : u.status === 'revoked' ? h('span', { class: 'spill bad' }, 'Revoked') : u.must_change_pw ? h('span', { class: 'spill warn' }, 'Temp. password') : h('span', { class: 'spill ok' }, 'Active');
  const appsLine = u => u.role === 'super_admin' ? 'all apps' : u.apps.length ? u.apps.map(appShort).join(', ') : 'no apps';
  const drawPanel = () => {
    if (!sel) panel.replaceChildren(h('p', { class: 'empty' }, 'Select a person.'));
    else { const pt = parts(sel); panel.replaceChildren(...[pt.top(), pt.apps(), pt.audits(), pt.access()].filter(Boolean)); }
    // Phones: one list, the selected person opens in place.
    const fnf = FILTERS.find(f => f[0] === filter)[2];
    const list = users.filter(fnf).filter(u => !q || `${u.name} ${u.login_id}`.toLowerCase().includes(q));
    acc.replaceChildren(...list.map(u => {
      const open = sel && u.id === sel.id;
      const head = h('button', { type: 'button', class: 'acc-h', 'aria-expanded': String(open), onclick: () => { sel = open ? null : u; state.teamSel = sel?.id; drawRows(); drawPanel(); } },
        h('span', { class: `av s40${open ? ' deep' : avTone(u)}`, 'aria-hidden': 'true' }, initials(u.name)),
        h('span', { class: 'acc-n' }, h('b', {}, u.name), h('span', {}, open ? `${ROLE[u.role]} · ${u.employment === 'freelancer' ? 'Freelancer' : 'Staff'} · ${u.login_id}` : `${ROLE[u.role]} · ${appsLine(u)}`)),
        shortStatus(u), icon(open ? 'chevron-up' : 'chevron'));
      if (!open) return h('div', { class: 'acc-i' }, head);
      const pt = parts(u);
      return h('div', { class: 'acc-i open' }, head, h('div', { class: 'acc-b' }, ...[pt.topM(), pt.apps(), pt.audits(), pt.access()].filter(Boolean)));
    }));
  };

  const search = h('input', { type: 'search', placeholder: 'Name or Login ID', oninput: e => { q = e.target.value.trim().toLowerCase(); drawRows(); drawPanel(); } });
  drawFilters(); drawRows(); drawPanel();
  holder.replaceChildren(
    pageTitle({
      kicker: 'Manage', title: 'Team & ', em: 'access',
      sub: me.role === 'super_admin'
        ? h('span', {}, 'One Login ID for every app. ', h('span', { class: 'd-only' }, 'Choose the apps each person may use; hold, revoke or app changes reach their phone at the next sync.'), h('span', { class: 'm-only' }, 'Changes reach phones at the next sync.'))
        : 'Your team: Engineers who work on your apps. You can give or take only your own apps, and change only people who work on nothing else.',
      action: goBtn('Add person', 'plus', { onclick: () => addPerson(auditList) }),
    }),
    h('div', { class: 'fbar' }, counts, h('label', { class: 'fsearch' }, icon('search'), h('span', { class: 'sr' }, 'Find a person'), search)),
    h('div', { class: 'tgrid d-only' },
      h('section', { class: 'tcard', 'aria-label': 'People' }, h('div', { class: 'scroll' },
        h('table', { class: 'ptable' }, h('thead', {}, h('tr', {}, ['Person', 'Role', 'Apps', 'Status', 'Last sign-in'].map(c => h('th', { scope: 'col' }, c)))), tbody))),
      panel),
    acc);
}

// Put an Engineer on one more audit.
function addToAudit(u, auditList) {
  const open = auditList.filter(a => !['published', 'archived'].includes(a.status) && !u.audits.some(x => x.id === a.id));
  openDialog(`Add ${u.name} to an audit`, f => f.append(open.length
    ? field('Audit', h('select', { name: 'audit' }, open.map(a => h('option', { value: a.id }, `${a.industry_tag} · ${a.title}`))))
    : h('p', { class: 'muted' }, 'They are already on every running audit.')), async f => {
    if (!f.elements.audit) return;
    const a = auditList.find(x => x.id === f.elements.audit.value);
    await api('POST', `/api/audits/${encodeURIComponent(a.id)}/assign`, { user_id: u.id, assign: true, role: a.team.some(t => t.role === 'lead') ? 'field' : 'lead' });
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
// ---------- the audit process (lib/stages.js): stages, the progress line, moving on ----------
const CHECK = () => { const NS = 'http://www.w3.org/2000/svg', v = document.createElementNS(NS, 'svg'); v.setAttribute('viewBox', '0 0 24 24'); v.setAttribute('class', 'pcheck');
  const pth = document.createElementNS(NS, 'path'); pth.setAttribute('d', 'M5 12.5l4.2 4.2L19 7'); v.append(pth); return v; };
const stageOf = (P, key) => P.stages.find(s => s.key === key) || { key, label: key, short: key };
const daysSince = ms => ms ? Math.max(0, Math.floor((Date.now() - ms) / 86400000)) : 0;
const reachedAt = (a, key) => { const l = [...(a.history || [])].reverse().find(x => x.to_stage === key); return l ? l.at : (key === 'setup' ? a.created_at : null); };

/** Where a stage stands for this company: done, current, waiting (approval), skipped or still to come. */
function stageState(a, key) {
  const cur = a.stages.indexOf(a.stage || 'setup'), i = a.stages.indexOf(key);
  if (i < 0) return 'skip';
  if (i < cur) return 'done';
  if (i > cur) return 'todo';
  if (key === 'review') return 'wait';
  if (key === 'published') return 'done';
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

/** Who approves a draft and moves audits on (as the server decides it): a Super Admin, an Admin who sees it, or its audit lead. */
const canApproveStage = () => ['super_admin', 'head'].includes(state.me.role);
function canMoveStage(a) {
  if (canApproveStage()) return true;
  const lead = (a.team || []).find(t => t.role === 'lead');
  return !!lead && lead.id === state.me.id;
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
// ---------- Overview: every company and where it is in the process ----------
const STAGE_GROUPS = [
  ['all', 'All', null],
  ['field', 'Draft & field', ['setup', 'field']],
  ['report', 'Processing', ['processing']],
  ['approval', 'Review & approval', ['review', 'approved']],
  ['done', 'Published', ['published']],
];
/** What needs someone now, company by company. */
function pipelineAttention(P) {
  const approves = canApproveStage();
  const out = [];
  for (const a of P.audits) {
    const name = a.client_name || a.id, href = `#/audit/${encodeURIComponent(a.id)}`;
    if (a.stage === 'review') out.push({ tone: 'warn', a, text: approves ? 'Waiting for your approval' : 'Waiting for an Admin to approve', href, name });
    else if (a.issues) out.push({ tone: 'bad', a, text: `${a.issues} sync problem${a.issues > 1 ? 's' : ''}`, href, name });
    else if (a.next && a.next.ready && a.next.next) out.push({ tone: 'ok', a, text: `Ready for ${stageOf(P, a.next.next).label}`, href, name });
    else if (a.stage !== 'published' && daysSince(a.stage_at) > 14) out.push({ tone: 'warn', a, text: `${daysSince(a.stage_at)} days at ${stageOf(P, a.stage).short}`, href, name });
    if (!(a.team || []).some(t => t.role === 'lead') && a.stage !== 'published') out.push({ tone: 'soft', a, text: 'No audit lead yet', href, name });
  }
  return out;
}

async function pipelinePage(holder) {
  const P = await api('GET', '/api/pipeline');
  let group = 'all', q = '';
  try { group = sessionStorage.getItem('ares-pipe-group') || 'all'; } catch { /* private window */ }
  const reload = () => pipelinePage(holder);
  const list = P.audits;
  const count = k => list.filter(a => a.stage === k).length;

  const attention = pipelineAttention(P);

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
      h('div', {}, h('h1', {}, 'Companies'), h('p', { class: 'muted small' }, 'Every company and where it stands in the audit process, from Draft to Published.')),
      h('div', { class: 'row' }, h('a', { class: 'btn ghost', href: '#/team-activity' }, 'Team activity'), h('button', { class: 'btn', onclick: newAudit }, 'New audit'))),
    // The process at a glance: how many companies are at each stage.
    h('section', { class: 'stagebar', 'aria-label': 'Companies at each stage' }, P.stages.map((st, i) => h('a', {
      class: `sb ${count(st.key) ? 'has' : ''} s-${st.key}`, href: '#/pipeline', onclick: e => {
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
        lead ? h('span', { class: 'av lead', title: `${lead.name} · audit lead` }, initials(lead.name)) : h('span', { class: 'pill soft' }, 'No lead'),
        others.slice(0, 5).map(t => h('span', { class: 'av', title: `${t.name} · ${P.roles[t.role] || t.role}` }, initials(t.name))),
        others.length > 5 ? h('span', { class: 'small muted' }, `+${others.length - 5}`) : null)),
    progressLine(a, P, { compact: true }),
    h('div', { class: 'cofoot' },
      h('span', { class: `pill ${a.stage === 'review' ? 'warn' : a.next && a.next.ready ? 'ok' : 'soft'}` },
        `${stageOf(P, a.stage).label} · ${daysSince(a.stage_at)} d`),
      h('span', { class: 'small' }, a.next ? a.next.hint : ''),
      h('span', { class: 'cofacts small muted' }, `${a.records} records · ${a.apps} app${a.apps === 1 ? '' : 's'} · ${a.photos} photos${a.issues ? ` · ${a.issues} sync problem${a.issues > 1 ? 's' : ''}` : ''}`),
      h('a', { class: 'btn sm', href: `#/audit/${encodeURIComponent(a.id)}` }, 'Open company')));
}

// @@AUDITS@@
const isLate = t => t.status !== 'done' && t.due_at && t.due_at < Date.now();

async function audits(holder) {
  const [{ audits: list }, { users }, P, { tasks: taskList }] = await Promise.all([api('GET', '/api/audits'), api('GET', '/api/users'), api('GET', '/api/pipeline'),
    api('GET', '/api/tasks').catch(() => ({ tasks: [] }))]);
  const piped = new Map(P.audits.map(x => [x.id, x]));
  const stageKey = a => piped.get(a.id)?.stage || a.stage || 'setup';
  const running = list.filter(a => !CLOSED.has(a.status));
  const done = list.length - running.length;
  let stage = state.query.get('stage') || '';
  const shown = () => stage ? list.filter(a => stageKey(a) === stage) : running;
  const pickStage = k => { stage = stage === k ? '' : k; drawStages(); drawRows(); };
  const addTo = a => addPersonTo(a, users, P, route);

  const tbody = h('tbody');
  const cardsM = h('div', { class: 'acards m-only' });
  const pillsM = h('div', { class: 'fpills m-only', role: 'group', 'aria-label': 'Filter by stage' });
  const strip = h('div', { class: 'stagestrip d-only', role: 'group', 'aria-label': 'Filter by stage' });
  const drawStages = () => {
    strip.replaceChildren(
      h('button', { type: 'button', class: 'all', 'aria-pressed': String(!stage), onclick: () => { stage = ''; drawStages(); drawRows(); } },
        h('span', { class: 'sn' }, String(running.length)), h('span', { class: 'sl' }, 'All running')),
      ...P.stages.map((st, i) => {
        const n = list.filter(a => stageKey(a) === st.key).length;
        return h('button', { type: 'button', 'aria-pressed': String(stage === st.key), title: st.label, onclick: () => pickStage(st.key) },
          h('span', { class: `sn${n ? '' : ' zero'}` }, String(n)), h('span', { class: 'sl' }, h('span', { class: 'snum' }, String(i + 1).padStart(2, '0')), st.short));
      }),
      h('a', { class: 'fin', href: '#/reports' }, h('span', { class: 'sn' }, String(done)), h('span', { class: 'sl' }, 'Previous reports', icon('arrow'))));
    pillsM.replaceChildren(
      h('button', { type: 'button', 'aria-pressed': String(!stage), onclick: () => { stage = ''; drawStages(); drawRows(); } }, 'All running', h('span', { class: 'cnt' }, String(running.length))),
      ...P.stages.map(st => h('button', { type: 'button', 'aria-pressed': String(stage === st.key), onclick: () => pickStage(st.key) },
        st.short, h('span', { class: 'cnt' }, String(list.filter(a => stageKey(a) === st.key).length)))));
  };
  const teamAvs = a => a.team.map((t, i) => h('span', { class: `av sm${i % 2 ? ' alt' : ''}${t.role === 'lead' ? ' lead' : ''}`, title: `${t.name}${P.roles[t.role] ? ` · ${P.roles[t.role]}` : ''}` }, initials(t.name)));
  const drawRows = () => {
    const rows = shown();
    const none = running.length || stage ? 'No audit at this stage.' : done ? 'No running audits. Finalised ones are in Previous reports.' : 'No audits yet. Create the first one.';
    tbody.replaceChildren(...(rows.length ? rows.map(a => {
      const late = taskList.filter(t => t.audit_id === a.id && isLate(t)).length;
      const href = `#/audit/${encodeURIComponent(a.id)}`, key = stageKey(a);
      return h('tr', {},
        h('td', { class: 'tagc' }, h('span', { class: 'tagstack' }, h('span', { class: 'tagpill bd' }, a.industry_tag), h('span', { class: 'aid' }, a.id))),
        h('td', {}, h('a', { class: 'atitle', href }, a.title), a.synthetic ? h('span', { class: 'pill warn demo' }, 'Demo') : null,
          h('span', { class: 'asub' }, `${a.client_name} — ${a.site_name} · ${a.fy}`)),
        h('td', {}, stagePill(key, true), h('span', { class: 'sdays' }, `${daysSince(a.stage_at)} d`)),
        h('td', {}, h('span', { class: 'avstack' }, teamAvs(a),
          h('button', { type: 'button', class: 'addc', 'aria-label': `Add a person to ${a.industry_tag}`, onclick: () => addTo(a) }, icon('plus')))),
        h('td', { class: a.records ? 'n strong' : 'n' }, String(a.records)),
        h('td', { class: 'n' }, String(a.open_tasks), late ? h('span', { class: 'late' }, `${late} late`) : null),
        h('td', { class: 'sync' }, ago(a.last_sync)),
        h('td', { class: 'go' }, h('a', { class: 'rgo', href, 'aria-label': `Open ${a.industry_tag}` }, icon('arrow'))));
    }) : [h('tr', {}, h('td', { colspan: 8, class: 'empty' }, none))]));
    // Phones: one card per audit.
    cardsM.replaceChildren(...(rows.length ? rows.map(a => {
      const late = taskList.filter(t => t.audit_id === a.id && isLate(t)).length;
      const href = `#/audit/${encodeURIComponent(a.id)}`, key = stageKey(a);
      return h('article', { class: `acm${key === 'setup' ? ' draft' : ''}` },
        h('span', { class: 'acm-top' }, h('span', { class: 'tagpill bd' }, a.industry_tag), h('span', { class: 'aid' }, a.id), stagePill(key)),
        h('a', { class: 'atitle', href }, a.title), h('span', { class: 'asub' }, `${a.client_name} — ${a.site_name}`),
        h('span', { class: 'acm-st' }, h('span', { class: 'avstack' }, teamAvs(a)),
          h('span', {}, a.records ? [h('b', {}, String(a.records)), ' records'] : 'No records yet', ` · ${a.open_tasks ? `${a.open_tasks} open` : 'nothing open'}`, late ? h('span', { class: 'late' }, ` · ${late} late`) : null)),
        h('span', { class: 'acm-foot' }, h('span', {}, a.last_sync ? `Synced ${ago(a.last_sync)}` : 'Not synced yet'), h('a', { class: 'rgo', href, 'aria-label': `Open ${a.industry_tag}` }, icon('arrow'))));
    }) : [h('p', { class: 'empty' }, none)]));
  };
  drawStages(); drawRows();
  holder.replaceChildren(
    pageTitle({
      kicker: 'Manage', title: 'Running ', em: 'audits',
      sub: h('span', {}, h('span', { class: 'd-only' }, 'Each plant gets a system-made industry tag; the public site shows only the tag, never the client. The ★ audit lead moves an audit through its stages; engineers see only the audits they are on.'),
        h('span', { class: 'm-only' }, 'The public site shows only the tag, never the client.')),
      action: goBtn('New audit', 'plus', { onclick: newAudit }),
    }),
    strip, pillsM,
    h('a', { class: 'finm m-only', href: '#/reports' }, h('span', {}, h('b', {}, String(done)), ' finalised · Previous reports'), icon('arrow')),
    cardsM,
    h('section', { class: 'tcard wide d-only', 'aria-label': 'Running audits' }, h('div', { class: 'scroll' },
      h('table', { class: 'atable' }, h('thead', {}, h('tr', {},
        h('th', { scope: 'col' }, 'Tag'), h('th', { scope: 'col' }, 'Audit'), h('th', { scope: 'col' }, 'Stage'), h('th', { scope: 'col' }, 'Team'),
        h('th', { scope: 'col', class: 'n' }, 'Records'), h('th', { scope: 'col', class: 'n' }, 'Open tasks'), h('th', { scope: 'col' }, 'Last sync'),
        h('th', { scope: 'col', class: 'go' }, h('span', { class: 'sr' }, 'Open')))), tbody))),
    h('p', { class: 'foot-note d-only' }, 'Move an audit to its next stage, finalise it or download its data from the audit page. ', h('a', { href: '#/pipeline' }, 'See every company'), ' with its progress line.'));
}

// Put someone on an audit with a role. The first person becomes the audit lead unless changed.
function addPersonTo(a, users, P, reload) {
  const free = users.filter(u => u.status === 'active' && !(a.team || []).some(t => t.id === u.id) && (u.role !== 'super_admin' || state.me.role === 'super_admin'));
  const hasLead = (a.team || []).some(t => t.role === 'lead');
  openDialog(`Add a person to ${a.industry_tag}`, f => f.append(free.length
    ? h('div', {}, field('Person', h('select', { name: 'user' }, free.map(u => h('option', { value: u.id }, `${u.name} · ${ROLE[u.role] || u.role}`)))),
      field('Their role', h('select', { name: 'role' }, Object.entries(P.roles).map(([k, v]) => h('option', { value: k, selected: k === (hasLead ? 'field' : 'lead') }, v)))))
    : h('p', { class: 'muted' }, 'Everyone active is already on this audit.')), async f => {
    if (!f.elements.user) return;
    await api('POST', `/api/audits/${encodeURIComponent(a.id)}/assign`, { user_id: f.elements.user.value, assign: true, role: f.elements.role.value });
    toast('Added to the audit'); reload();
  }, { submitLabel: 'Add' });
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
        try { const note = (prompt('Why is this audit being reopened? (a short written reason)') || '').trim(); if (!note) return; await api('POST', `/api/audits/${encodeURIComponent(a.id)}/reopen`, { note }); toast('Audit reopened: ask the team to sync again'); reload(); } catch (ex) { toast(ex.message); }
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

// @@APPCARD@@
/** One app's card on the audit page: what was recorded, who by, its figures, and the way in. */
function appDataCard(code, recs, a, ov, openTasks, rel) {
  const enc = encodeURIComponent(a.id);
  const byPerson = new Map(), byKind = new Map();
  for (const r of recs) {
    byKind.set(r.kind, (byKind.get(r.kind) || 0) + 1);
    if (r.kind === 'company_profile') continue;
    const p = byPerson.get(r.recorded_by) || { n: 0, last: 0 };
    byPerson.set(r.recorded_by, { n: p.n + 1, last: Math.max(p.last, r.saved_at || r.taken_at || 0) });
  }
  const kindLabel = k => String(k || '—').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
  const minor = k => /profile|company/i.test(k);
  const kinds = [...byKind].sort((x, y) => minor(x[0]) - minor(y[0]) || y[1] - x[1]);
  const max = Math.max(...kinds.filter(k => !minor(k[0])).map(k => k[1]), 1);
  const items = recs.filter(r => r.kind !== 'company_profile');
  const meta = state.apps.find(x => x.code === code);
  const donut = ov && ov.donuts && (ov.donuts.find(d => d.kind === 'status') || ov.donuts[0]);
  const t = openTasks.find(isLate) || openTasks[0];
  const taskLine = !t ? null : isLate(t)
    ? h('p', { class: 'ac-task' }, h('span', { class: 'spill bad sq' }, 'Overdue'), `${t.title} · ${t.assignee_name || 'not assigned'} · was due ${fmtDay(t.due_at)}`)
    : h('p', { class: 'ac-task' }, h('span', { class: 'spill ok sq' }, `${openTasks.length} open`), `${t.title} · ${t.assignee_name || 'not assigned'}${t.due_at ? ` · due ${fmtDay(t.due_at)}` : ''}`);
  const openApp = !CLOSED.has(a.status) && meta?.web ? h('button', { type: 'button', class: 'obtn sm arrowed', onclick: () => openTool(code, a.id) }, `Open ${appName(code)}`, icon('external')) : null;
  return h('article', { class: 'acard', 'aria-labelledby': `app-${code}` },
    h('div', { class: 'ac-head' }, h('span', { class: 'ac-ic', 'aria-hidden': 'true' }, appSym(code)),
      h('span', { class: 'ac-nm' }, h('h3', { id: `app-${code}` }, appName(code)), h('span', {}, `${(meta?.tagline || '').split(':')[0]} · ${items.length} record${items.length === 1 ? '' : 's'}`)),
      h('a', { class: 'obtn sm arrowed d-only', href: `#/apps/${code}/${enc}` }, 'View and correct records', icon('arrow')),
      h('span', { class: 'ac-cnt m-only' }, h('b', {}, String(items.length)), h('span', {}, 'records'))),
    h('div', { class: 'ac-chips m-only' }, kinds.map(([k, n]) => h('span', {}, kindLabel(k), ' ', h('b', {}, String(n))))),
    h('div', { class: 'ac-body' },
      h('div', { class: 'ac-kinds d-only' }, h('h4', {}, 'Equipment recorded'),
        h('ul', {}, kinds.map(([k, n]) => minor(k)
          ? h('li', { class: 'minor' }, h('span', {}, kindLabel(k)), h('span', {}), h('b', {}, String(n)))
          : h('li', {}, h('span', {}, kindLabel(k)), h('span', { class: 'bar', 'aria-hidden': 'true' }, h('span', { style: `width:${Math.max(2, Math.round(n / max * 100))}%` })), h('b', {}, String(n)))))),
      h('div', { class: 'ac-who' }, h('h4', {}, 'Collected by'),
        [...byPerson].sort((x, y) => y[1].n - x[1].n).map(([who, v], i) => h('div', { class: 'ac-p' },
          h('span', { class: `av s34${i % 2 ? ' alt' : ''}`, 'aria-hidden': 'true' }, initials(who)),
          h('span', { class: 'ac-pn' }, h('b', {}, who), h('span', {}, `last ${dayTime(v.last).replace('Today', 'today')}`)), h('b', {}, String(v.n)))))),
    ov ? h('div', { class: 'appkpis' }, ov.kpis.slice(0, 4).map(k => h('div', {}, h('span', { class: 'small muted' }, k.label), h('b', {}, k.value)))) : null,
    donut ? h('div', { class: 'appdonut' }, donutChart(donut)) : null,
    ov && ov.flags.length ? h('p', { class: 'small appflag' }, h('span', { class: `pill ${ov.flags[0].tone === 'muted' ? 'soft' : ov.flags[0].tone === 'good' ? 'ok' : ov.flags[0].tone}` }, ov.flags[0].tag), ' ', ov.flags[0].text,
      ov.flags.length > 1 ? h('span', { class: 'muted' }, ` · ${ov.flags.length - 1} more`) : null) : null,
    taskLine,
    h('div', { class: 'ac-foot' }, ov ? h('a', { class: 'obtn sm', href: `#/apps/${code}/${enc}` }, 'Overview') : null, openApp),
    h('a', { class: 'ac-view m-only', href: `#/apps/${code}/${enc}` }, 'View and correct records', icon('arrow')));
}

// @@AUDITPAGE@@
/** The buttons that move this company on, as the server allows them for this person. */
function stageActions(a, P, reload) {
  const nx = a.next || {}, next = nx.next ? stageOf(P, nx.next) : null;
  const approves = canApproveStage(), may = canMoveStage(a);
  const main = (label, fn) => h('button', { type: 'button', class: 'ah-next', onclick: fn }, label, icon('arrow'));
  const side = (label, fn) => h('button', { type: 'button', class: 'ah-next quiet', onclick: fn }, label);
  const out = [];
  if (a.stage === 'review') {
    if (approves) out.push(main('Approve draft', () => moveTo(a, 'approved', null, reload)), side('Send back to Processing', () => sendBack(a, P, reload, 'processing')));
    else if (may) out.push(side('Take back to Processing', () => sendBack(a, P, reload, 'processing')));
  } else if (next && may) {
    const label = next.key === 'review' ? 'Send for review' : next.key === 'published' ? 'Publish audit' : `Move to ${next.short}`;
    out.push(main(label, () => next.key === 'published' ? finaliseAudit(a) : moveTo(a, next.key, null, reload)));
  }
  if (may && a.stages.indexOf(a.stage) > 0 && a.stage !== 'review') out.push(side('Go back', () => sendBack(a, P, reload)));
  return out;
}

async function auditPage(holder, id) {
  const enc = encodeURIComponent(id);
  const [data, T, st, rel, PP, { users }, { audits: allAudits }] = await Promise.all([api('GET', `/api/audits/${enc}/data`), api('GET', `/api/tasks?audit=${enc}`),
    api('GET', `/api/audits/${enc}/status`), releases(), api('GET', `/api/audits/${enc}/pipeline`), api('GET', '/api/users'), api('GET', '/api/audits')]);
  const reload = () => auditPage(holder, id);
  const pa = PP.audit;
  // Removed records stay on the server as versions; the audit page shows only current ones.
  for (const k of Object.keys(data.apps)) data.apps[k] = data.apps[k].filter(r => !r.payload._deleted);
  for (const k of Object.keys(data.apps)) if (!data.apps[k].length) delete data.apps[k];
  const listed = allAudits.find(x => x.id === data.audit.id) || {};
  const a = { ...listed, ...data.audit, team: pa.team };
  const finalised = CLOSED.has(a.status);
  const open = T.tasks.filter(t => t.status !== 'done');
  const late = open.filter(isLate);
  const pq = (data.apps.power || []).filter(r => r.kind === 'pq_recording');
  const entries = Object.entries(data.apps);
  const dataApps = entries.filter(([code, recs]) => code !== 'power' && code !== 'report' && code !== 'ledger' && recs.some(r => r.kind !== 'company_profile'));
  const total = entries.reduce((n, [, r]) => n + r.length, 0);
  const photos = data.files.filter(f => f.mime.startsWith('image/'));
  const others = data.files.filter(f => !f.mime.startsWith('image/'));

  // ---- dark header: tag, title, the stages ----
  const curIdx = Math.max(0, pa.stages.indexOf(pa.stage));
  const nx = pa.next || {};
  const sector = state.sectors?.[a.sector];
  const header = h('header', { class: 'ahero' },
    h('div', { class: 'ah-top' },
      h('div', { class: 'ah-id' },
        h('a', { class: 'ah-back', href: finalised ? '#/reports' : '#/audits' }, icon('back'), finalised ? 'Previous reports' : 'Running audits'),
        h('span', { class: 'ah-tag' }, `${a.industry_tag} · ${a.id}`),
        h('h1', {}, `${a.title}, `, h('em', {}, a.client_name || a.site_name || '')),
        h('p', {}, [a.site_name, sector, a.fy, a.created_at && `started ${fmtDay(a.created_at)}`].filter(Boolean).join(' · '))),
      h('div', { class: 'ah-acts' },
        finalised ? null : h('button', { type: 'button', class: 'ah-zip', onclick: () => editAuditDetails({ ...a }) }, 'Edit details'),
        h('a', { class: 'ah-zip', href: `/api/audits/${enc}/export.zip` }, icon('download'), 'Download all (ZIP)'),
        finalised
          ? h('button', { type: 'button', class: 'ah-fin', onclick: async () => {
            if (!confirm('Reopen this audit? It returns to the running lists and its data can be changed again.')) return;
            try { const note = (prompt('Why is this audit being reopened? (a short written reason)') || '').trim(); if (!note) return; await api('POST', `/api/audits/${enc}/reopen`, { note }); toast('Audit reopened'); route(); } catch (ex) { toast(ex.message); }
          } }, 'Reopen', h('span', { class: 'go-ic', 'aria-hidden': 'true' }, icon('arrow')))
          : h('button', { type: 'button', class: 'ah-fin', onclick: () => finaliseAudit(a) }, 'Finalise audit', h('span', { class: 'go-ic', 'aria-hidden': 'true' }, icon('tick'))))),
    h('div', { class: 'ah-steps' },
      h('ol', { 'aria-label': 'Stage of this audit' }, pa.stages.map((key, i) => {
        const s = stageState(pa, key), now = i === curIdx;
        const when = s === 'todo' ? null : reachedAt(pa, key);
        return h('li', { class: `${s === 'done' && !now ? 'done' : now ? 'now' : ''}${s === 'bad' ? ' bad' : ''}`, 'aria-current': now ? 'step' : null, title: `${stageOf(PP, key).label}${when ? ` (since ${fmtDay(when)})` : ''}` },
          h('span', { class: 'st-top' }, h('span', { class: 'st-n' }, String(i + 1).padStart(2, '0')),
            s === 'done' && !now ? icon('tick') : now ? h('span', { class: 'st-now' }, s === 'wait' ? 'Waiting' : s === 'bad' ? 'Not done' : 'Now') : null),
          h('span', { class: 'st-l' }, stageOf(PP, key).short, s === 'done' && !now ? h('span', { class: 'sr' }, ', done') : null));
      })),
      h('div', { class: 'ah-prog m-only' }, h('span', { class: 'ap-l' }, `Stage ${String(curIdx + 1).padStart(2, '0')} of ${String(pa.stages.length).padStart(2, '0')}`, h('b', {}, stageOf(PP, pa.stage).short)),
        h('span', { class: 'ap-bar', style: `grid-template-columns:repeat(${pa.stages.length},1fr)`, 'aria-hidden': 'true' }, pa.stages.map((_, i) => h('i', { class: i < curIdx ? 'done' : i === curIdx ? 'now' : null })))),
      h('div', { class: 'ah-move' }, stageActions(pa, PP, reload))),
    h('p', { class: 'ah-hint' }, nx.ready && nx.next && pa.stage !== 'review' ? h('span', { class: 'ah-ready' }, `Ready for ${stageOf(PP, nx.next).short}`) : null,
      `${daysSince(pa.stage_at)} day${daysSince(pa.stage_at) === 1 ? '' : 's'} at ${stageOf(PP, pa.stage).short}${nx.hint ? `. ${nx.hint}` : '.'}`,
      !canMoveStage(pa) ? (pa.stage === 'review' ? ' Only an Admin or Super Admin approves.' : ' Only the audit lead, an Admin or a Super Admin moves this audit on.') : ''));

  // ---- the four counts ----
  const lastRec = entries.flatMap(([code, rs]) => rs.map(r => ({ code, r })))
    .sort((x, y) => (y.r.saved_at || y.r.taken_at || 0) - (x.r.saved_at || x.r.taken_at || 0))[0];
  const nApps = entries.length;
  const stat = (v, b, sub, bad) => h('div', { class: 'astat' }, h('span', { class: `as-v${bad ? ' bad' : ''}` }, String(v)),
    h('span', { class: 'as-t' }, h('b', {}, b), h('span', { class: bad ? 'bad' : null }, sub)));
  const glance = h('section', { class: 'astats', 'aria-label': 'This audit at a glance' },
    stat(total, 'Records', `from ${nApps} app${nApps === 1 ? '' : 's'}`),
    stat(data.files.length, 'Photos & files', `${photos.length} photo${photos.length === 1 ? '' : 's'}, ${others.length} file${others.length === 1 ? '' : 's'}`),
    stat(open.length, 'Open tasks', late.length ? `${late.length} overdue` : `${T.tasks.length - open.length} done`, late.length > 0),
    h('div', { class: 'astat' }, h('span', { class: 'as-ic', 'aria-hidden': 'true' }, icon('cloud')),
      h('span', { class: 'as-t' }, h('b', {}, listed.last_sync ? `Synced ${ago(listed.last_sync)}` : 'Not synced yet'),
        h('span', {}, lastRec ? `${lastRec.r.recorded_by}, ${appName(lastRec.code)}` : 'Nothing has arrived'))));

  // ---- what each app collected ----
  const ovLib = await loadOverview().catch(() => null);
  const appCards = dataApps.map(([code, recs]) => {
    let ov = null;
    try { ov = ovLib ? ovLib.overview(code, recs.map(r => ({ id: r.id, kind: r.kind, tag: r.tag, payload: r.payload }))) : null; } catch { ov = null; }
    return appDataCard(code, recs, a, ov, open.filter(t => t.app === code), rel);
  });
  const waiting = [...new Set(open.filter(t => t.app && !dataApps.some(([c]) => c === t.app) && t.app !== 'power' && t.app !== 'report').map(t => t.app))].map(code => {
    const ts = open.filter(t => t.app === code);
    return h('div', { class: 'aempty' }, h('span', { class: 'ac-ic white', 'aria-hidden': 'true' }, appSym(code)),
      h('span', { class: 'ae-t' }, h('b', {}, `${appName(code)}: nothing yet`),
        h('span', {}, `${ts.length} task${ts.length === 1 ? '' : 's'} waiting: ${ts.map(t => `${t.title}${t.due_at ? `, due ${fmtDay(t.due_at)}` : ''}, ${t.assignee_name || 'not assigned'}`).join('; ')}`)),
      !finalised && h('button', { type: 'button', class: 'obtn sm', onclick: () => addPersonTo(a, users, PP, reload) }, 'Assign someone'));
  });

  // The report in Report Studio: its saved version, who saved it, and the way in.
  const rpt = (data.apps.report || []).find(r => r.kind === 'report');
  const reportCard = h('section', { class: 'acard' },
    h('div', { class: 'ac-head' }, h('span', { class: 'ac-ic', 'aria-hidden': 'true' }, appSym('report')),
      h('span', { class: 'ac-nm' }, h('h3', {}, 'Report Studio'), h('span', {}, rpt ? `Version ${rpt.version} saved by ${rpt.updated_by_name || rpt.recorded_by} ${ago(rpt.saved_at)}` : 'No report saved yet; the apps’ data comes in by itself')),
      !finalised ? h('button', { class: 'obtn sm arrowed', type: 'button', onclick: () => openTool('report', a.id) }, 'Open in Report Studio', icon('external')) : null));
  // Energy Ledger: this company's bills, baseline and GHG inputs, for those who have it.
  const led = mine('ledger') ? await api('GET', '/api/ledger/summary').then(r => r.companies[a.id] || {}).catch(() => ({})) : null;
  const ledgerCard = led && h('section', { class: 'acard' },
    h('div', { class: 'ac-head' }, h('span', { class: 'ac-ic', 'aria-hidden': 'true' }, appIcon(null, 34, 'ledger')),
      h('span', { class: 'ac-nm' }, h('h3', {}, 'Energy Ledger'), h('span', {}, 'Electricity bills with OCR, energy and water baseline, and GHG accounting')),
      h('span', { class: 'ac-acts' }, h('a', { class: 'obtn sm', href: `#/ledger/${enc}` }, 'Open here'),
        h('button', { class: 'obtn sm arrowed', type: 'button', onclick: () => window.open(`#/ledger/${enc}?solo`, '_blank', 'noopener') }, finalised ? 'View in a new window' : 'Enter data', icon('external')))),
    h('div', { class: 'chips ac-chips' },
      h('span', { class: `pill ${led.bills ? (led.verified === led.bills ? 'ok' : 'warn') : 'soft'}` }, led.bills ? `${led.bills} bills, ${led.verified} verified` : 'No bills yet'),
      h('span', { class: `pill ${led.baseline ? 'ok' : 'soft'}` }, led.baseline ? `Baseline ${led.baseline} months` : 'No baseline yet'),
      h('span', { class: 'pill soft' }, led.cea ? `CEA Version ${led.cea}` : 'GHG not started')));
  const companyCard_ = h('section', { class: 'acard' },
    h('div', { class: 'cap' }, h('h3', { class: 'cc-h' }, 'Company and plant'), h('span', { class: 'small muted' }, 'The apps fill their company setup from this')),
    h('div', { class: 'list' }, [
      ['Company', listed.client_name], ['Plant', listed.site_name], ['Plant type', state.sectors[listed.sector] || listed.sector],
      ['Type of work', state.workTypes[listed.work_type] || listed.title], ['Financial year', listed.fy],
      ['District, state', [listed.district, listed.state].filter(Boolean).join(', ')], ['Pincode', listed.pincode],
      ['Contract demand', listed.contract_demand_kva != null ? `${listed.contract_demand_kva} kVA` : ''], ['MSME (Udyam) number', listed.msme_no],
    ].map(([k, v]) => h('div', {}, h('span', { class: 'muted' }, k), h('span', {}, v || '—')))));
  const history = pa.history.length ? h('details', { class: 'phist acard' }, h('summary', {}, `History (${pa.history.length})`),
    h('div', { class: 'ilist' }, [...pa.history].reverse().map(l => h('div', { class: 'it' },
      h('div', { class: 'main-t' }, h('b', {}, `${stageOf(PP, l.from_stage).short} → ${stageOf(PP, l.to_stage).label}`), h('span', {}, [l.by_name, l.note].filter(Boolean).join(' · '))),
      h('div', { class: 'trail' }, fmtDate(l.at)))))) : null;

  // ---- side column ----
  const auditList = allAudits.filter(x => x.id === a.id);
  const stillToCollect = h('section', { class: 'side-card', 'aria-labelledby': 'h-open' },
    h('div', { class: 'sc-h' }, h('h2', { id: 'h-open' }, 'Still to collect'),
      !finalised && h('button', { type: 'button', class: 'tbtn dark', onclick: () => newTask(auditList, users, T.kinds, reload, { audit_id: a.id }) }, '+ Task')),
    open.length ? h('ul', { class: 'stc' }, [...open].sort((x, y) => isLate(y) - isLate(x)).map(t => h('li', {}, h('b', {}, t.title),
      h('span', {}, isLate(t) ? h('span', { class: 'due bad' }, `Overdue · ${fmtDay(t.due_at)}`) : t.due_at ? h('span', { class: 'due' }, `Due ${fmtDay(t.due_at)}`) : null,
        [t.assignee_name || 'Not assigned', t.app && appName(t.app), t.status === 'running' ? 'running' : 'to do'].filter(Boolean).join(' · ')),
      t.progress ? h('span', { class: 'tprog' }, h('span', { class: 'tbar' }, h('i', { style: `width:${Math.min(100, Math.round(t.progress.count / t.progress.target * 100))}%` })),
        h('span', { class: 'small' }, `${t.progress.count} of ${t.progress.target}`)) : null)))
      : h('p', { class: 'empty' }, 'Nothing open on this audit.'),
    h('a', { class: 'sc-all', href: `#/tasks?audit=${enc}` }, 'All tasks for this audit', icon('arrow')));
  const crew = (pa.team || []).map((t, i) => {
    const u = users.find(x => x.id === t.id), sp = st.people.find(p => p.id === t.id || p.name === t.name);
    const liveApp = sp?.apps.find(x => x.live);
    const note = liveApp ? h('span', { class: 'cr-live' }, `In ${appName(liveApp.app)} now`) : u?.locked ? h('span', { class: 'cr-bad' }, 'Locked out')
      : sp?.apps.length ? h('span', {}, `${sp.apps.reduce((n, x) => n + x.records, 0)} records${sp.apps[0].last_sync ? ` · synced ${ago(sp.apps[0].last_sync)}` : ''}`)
        : h('span', {}, 'Nothing from them yet');
    const roleSel = h('select', { class: 'cr-role', 'aria-label': `${t.name}'s role`, disabled: finalised, onchange: async e => {
      try { await api('POST', `/api/audits/${enc}/assign`, { user_id: t.id, assign: true, role: e.target.value }); toast('Role changed'); reload(); } catch (ex) { toast(ex.message); }
    } }, Object.entries(PP.roles).map(([k, v]) => h('option', { value: k, selected: t.role === k }, v)));
    return h('div', { class: 'cr' }, h('span', { class: `av s38${i % 2 ? ' alt' : ''}${t.role === 'lead' ? ' lead' : ''}`, 'aria-hidden': 'true' }, initials(t.name)),
      h('span', { class: 'cr-n' }, h('b', {}, t.name), note, roleSel),
      !finalised && h('button', {
        type: 'button', class: 'cr-x', 'aria-label': `Remove ${t.name} from this audit`, onclick: async () => {
          if (!confirm(`Take ${t.name} off this audit?`)) return;
          try { await api('POST', `/api/audits/${enc}/assign`, { user_id: t.id, assign: false }); reload(); } catch (ex) { toast(ex.message); }
        },
      }, icon('close')));
  });
  const unassigned = st.people.filter(p => !p.assigned && p.apps.length);
  const teamCard_ = h('section', { class: 'side-card pad24', 'aria-labelledby': 'h-crew' }, h('h2', { id: 'h-crew' }, 'Team on this audit'),
    crew.length ? crew : h('p', { class: 'empty' }, 'Nobody yet. Add an audit lead first: they move the audit through its stages.'),
    unassigned.map(p => h('div', { class: 'cr' }, h('span', { class: 'av s38 dim', 'aria-hidden': 'true' }, initials(p.name)),
      h('span', { class: 'cr-n' }, h('b', {}, p.name), h('span', {}, `Not assigned · ${p.apps.reduce((n, x) => n + x.records, 0)} records`)))),
    !finalised && h('button', { type: 'button', class: 'cr-add', onclick: () => addPersonTo(a, users, PP, reload) }, icon('plus'), 'Add a person'),
    h('p', { class: 'pp-note cr-foot' }, 'The audit lead moves this audit on; an Admin or Super Admin approves the draft.'));
  const ROLE_AT = { main: 'Plant main input', pcc: 'PCC panel', mcc: 'MCC panel' };
  const pqCard = h('section', { class: 'pqcard', 'aria-labelledby': 'h-pq' },
    h('div', { class: 'pq-h' }, h('span', { class: 'pq-ic', 'aria-hidden': 'true' }, appSym('power')),
      h('span', {}, h('h2', { id: 'h-pq' }, 'Power quality'), h('span', {}, 'IEEE 519, EN 50160, IEC 61000'))),
    pq.length ? pq.map(r => {
      const p = r.payload, c = p.compliance?.summary, hl = p.health;
      return h('div', { class: 'pq-rec' }, h('b', {}, p.panel || r.tag || 'Recording'),
        h('span', {}, [ROLE_AT[p.role] || p.role, p.instrument, p.start && `${p.start} to ${p.end}`, p.samples && `${p.samples.toLocaleString('en-IN')} samples`, r.recorded_by].filter(Boolean).join(' · ')),
        h('span', { class: 'pq-pills' }, c && h('span', { class: 'pq-pass' }, `${c.pass} of ${c.total} checks pass`),
          hl?.overall != null && h('span', { class: 'pq-hl' }, `Health ${Math.round(hl.overall)}`)));
    }) : h('p', { class: 'pq-none' }, 'No power quality recording saved for this audit yet.'),
    h('button', { type: 'button', class: 'pq-open', onclick: () => openTool('power', a.id) }, 'Open the analyser for this audit',
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
        h('span', {}, [f.kind === 'thermal' ? 'Thermal' : null, f.equipment_tag, appName(f.app), f.uploaded_by_name, f.taken_at && fmtDay(f.taken_at)].filter(Boolean).join(' · ')),
        f.record_kind ? h('span', {}, `For: ${f.record_kind.replace(/_/g, ' ')}${f.field && !/^photo(Path)?$/.test(f.field) ? ` (${f.field})` : ''}`) : null,
        f.captured_in ? h('span', {}, `On: ${f.captured_in}`) : null,
        f.location ? h('a', { href: f.location.map_url, target: '_blank', rel: 'noopener' }, `Where it was taken${f.location.accuracy_m != null ? `, within ${f.location.accuracy_m} m` : ''}`) : h('span', {}, 'No location recorded')))));
    grid.hidden = !ps.length;
    const fs = show === 'all' || show === 'files' ? others : [];
    fileBox.replaceChildren(...fs.map(f => h('div', { class: 'pf' }, icon('doc'), h('a', { href: f.url }, f.original_name || f.id),
      h('span', {}, [f.caption, appName(f.app), f.uploaded_by_name, `${(f.size / 1048576).toFixed(1)} MB`].filter(Boolean).join(' · ')))));
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
    problemsCard(st, a, rel, reload),
    h('div', { class: 'acols' },
      h('div', { class: 'a-main' }, h('div', { class: 'sec-h' }, h('span', { class: 'kicker' }, 'Data by app'), h('h2', {}, 'What has been collected')),
        appCards.length ? appCards : waiting.length ? null : h('div', { class: 'aempty' }, h('span', { class: 'ae-t' }, h('b', {}, 'No app has synced data for this audit yet.'),
          h('span', {}, 'Records appear here as soon as an engineer syncs from a field app.'))),
        waiting, ledgerCard, reportCard, finalised ? null : connectorCard(a), companyCard_, history),
      h('aside', { class: 'a-side' }, stillToCollect, teamCard_, pqCard)),
    photoSec));
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
const STAGE_SHORT = { setup: 'Draft', field: 'In field', processing: 'Processing', review: 'Review', approved: 'Approved', published: 'Published' };

async function tasks(holder) {
  const [T, { audits: auditList }, { users }] = await Promise.all([api('GET', '/api/tasks'), api('GET', '/api/audits'), api('GET', '/api/users')]);
  const reload = () => tasks(holder);
  const list = T.tasks;
  const f = { audit: state.query.get('audit') || '', person: '', app: '', source: '', overdue: false, q: '' };
  const setStatus = async (t, status) => {
    try { await api('POST', `/api/tasks/${t.id}/status`, { status }); reload(); } catch (ex) { toast(ex.message); }
  };
  const remove = async t => {
    if (!confirm(`Remove the task "${t.title}"?`)) return;
    try { await api('DELETE', `/api/tasks/${t.id}`); toast('Task removed'); reload(); } catch (ex) { toast(ex.message); }
  };
  const now = Date.now(), monthAgo = now - 30 * 86400000, week = now - 7 * 86400000;
  const open = list.filter(t => t.status !== 'done');
  const overdue = open.filter(isLate);
  const tagOf = t => t.industry_tag || t.client_name || t.audit_id;

  const who = t => t.assignee_name
    ? [h('span', { class: `av xs${t.assignee_name.length % 2 ? ' alt' : ''}`, 'aria-hidden': 'true' }, initials(t.assignee_name)), t.assignee_name]
    : [h('button', { type: 'button', class: 'tlink flat', onclick: () => editTask(t, reload) }, '+ Assign')];
  const due = t => isLate(t) ? h('span', { class: 'due bad' }, `Overdue · ${fmtDay(t.due_at)}`)
    : t.due_at ? h('span', { class: 'due' }, `Due ${fmtDay(t.due_at)}`) : h('span', { class: 'nodue' }, 'no due date');
  const head = (t, right) => h('span', { class: 'tk-tag' }, h('a', { class: 'tagpill sm', href: `#/audit/${encodeURIComponent(t.audit_id)}`, title: t.client_name || '' }, tagOf(t)),
    t.app ? appName(t.app) : null, t.source === 'process' && t.stage ? h('span', { class: 'tk-src' }, STAGE_SHORT[t.stage] || t.stage) : t.source === 'data' ? h('span', { class: 'tk-src' }, 'Data entry') : null, right);
  const body = t => {
    const p = t.progress, kindWord = t.record_kind && T.kinds[t.app] ? T.kinds[t.app][t.record_kind] : 'records';
    return [h('h3', { class: t.status === 'done' ? 'dn' : null }, t.title),
      p ? h('span', { class: 'tprog' }, h('span', { class: 'tbar' }, h('i', { style: `width:${Math.min(100, Math.round(p.count / p.target * 100))}%` })),
        h('span', { class: 'small' }, `${p.count} of ${p.target} ${kindWord}`)) : null,
      t.note ? h('span', { class: 'tk-note' }, t.note) : null];
  };
  const extras = t => [h('button', { type: 'button', class: 'tlink', onclick: () => editTask(t, reload) }, 'Edit'),
    t.source !== 'process' ? h('button', { type: 'button', class: 'tlink', onclick: () => remove(t) }, 'Remove') : null];
  const cls = t => `tk${isLate(t) ? ' late' : ''}${!t.assignee && t.status !== 'done' ? ' unassigned' : ''}`;
  const doneLine = t => {
    const onTime = !t.due_at || t.done_at <= t.due_at + 86400000;
    const days = t.due_at ? Math.round((t.done_at - t.due_at) / 86400000) : 0;
    return `${t.assignee_name || 'Nobody'} · done ${fmtDay(t.done_at)}, ${t.done_note || (onTime ? 'on time' : `${days} day${days === 1 ? '' : 's'} late`)}`;
  };
  const card = t => {
    if (t.status === 'running') return h('article', { class: cls(t) }, head(t), body(t), h('span', { class: 'tk-who' }, who(t), due(t)),
      h('span', { class: 'tk-foot' }, h('span', { class: 'tk-when' }, `started ${ago(t.started_at)}`),
        h('span', { class: 'tk-acts' }, extras(t), h('button', { type: 'button', class: 'tlink', onclick: () => setStatus(t, 'todo') }, 'To do'),
          h('button', { type: 'button', class: 'tbtn dark', onclick: () => setStatus(t, 'done') }, 'Mark done'))));
    if (t.status === 'todo') return h('article', { class: cls(t) }, head(t), body(t), h('span', { class: 'tk-who' }, who(t), due(t)),
      h('span', { class: 'tk-foot' }, h('span', { class: 'tk-acts' }, extras(t)),
        h('button', { type: 'button', class: `tbtn${isLate(t) ? ' dark' : ''}`, onclick: () => setStatus(t, 'running') }, 'Start')));
    return h('article', { class: cls(t) }, head(t), body(t),
      h('span', { class: 'tk-row muted13' }, h('span', { class: 'tk-done' }, icon('check'), doneLine(t)),
        h('button', { type: 'button', class: 'tlink', onclick: () => setStatus(t, 'todo') }, 'Reopen')));
  };
  // Phones: one list in sections, each card with its next step.
  const cardM = (t, kind) => {
    const right = kind === 'overdue' ? h('span', { class: t.status === 'running' ? 'tm-st bad' : 'tm-st' }, t.status === 'running' ? 'Running' : 'To do')
      : t.status === 'running' ? h('span', { class: 'tm-st' }, `started ${ago(t.started_at)}`) : null;
    const act = t.status === 'running' ? h('button', { type: 'button', class: 'tbtn dark lg', onclick: () => setStatus(t, 'done') }, 'Mark done')
      : t.status === 'todo' ? h('button', { type: 'button', class: `tbtn lg${isLate(t) ? ' dark' : ''}`, onclick: () => setStatus(t, 'running') }, 'Start')
        : h('button', { type: 'button', class: 'tbtn lg', onclick: () => setStatus(t, 'todo') }, 'Reopen');
    return h('article', { class: `${cls(t)} m` }, head(t, right), body(t),
      h('span', { class: 'tk-row' }, h('span', { class: 'tk-who' }, who(t),
        isLate(t) ? h('span', { class: 'due bad' }, fmtDay(t.due_at)) : t.due_at ? h('span', { class: 'due' }, `Due ${fmtDay(t.due_at)}`) : null), act));
  };
  const cols = h('div', { class: 'tcols d-only' });
  const listM = h('div', { class: 'tmlist m-only' });
  let showOld = false, doneOpen = false;
  const draw = () => {
    const person = f.person === 'me' ? state.me.id : f.person;
    const keep = t => (!f.audit || t.audit_id === f.audit) && (!person || (person === '-' ? !t.assignee : t.assignee === person))
      && (!f.app || t.app === f.app) && (!f.source || t.source === f.source) && (!f.overdue || isLate(t))
      && (!f.q || `${t.title} ${t.client_name} ${t.assignee_name}`.toLowerCase().includes(f.q));
    // Overdue work stays at the top of its column.
    const sortLate = xs => [...xs.filter(isLate), ...xs.filter(t => !isLate(t))];
    const run = sortLate(list.filter(t => t.status === 'running' && keep(t)));
    const todo = sortLate(list.filter(t => t.status === 'todo' && keep(t)));
    const doneAll = list.filter(t => t.status === 'done' && keep(t)).sort((a, b) => (b.done_at || 0) - (a.done_at || 0));
    const doneRecent = doneAll.filter(t => (t.done_at || 0) >= monthAgo);
    const col = (id, n, title, count, items, empty, extra) => h('section', { class: 'tcol', 'aria-labelledby': id },
      h('div', { class: 'tcol-h' }, h('h2', { id }, h('span', {}, n), title), count),
      items.length ? items.map(card) : h('p', { class: 'empty' }, empty), extra);
    const lateAll = [...run, ...todo].filter(isLate);
    const calm = xs => xs.filter(t => !isLate(t));
    const sec = (title, tone, items) => items.length ? [h('h2', { class: `tsec ${tone}` }, title, h('span', {}, String(items.length))), items] : [];
    listM.replaceChildren(...[
      sec('Overdue', 'bad', lateAll.map(t => cardM(t, 'overdue'))),
      sec('Running', '', calm(run).map(t => cardM(t, 'running'))),
      sec('To do', '', calm(todo).map(t => cardM(t, 'todo'))),
      h('h2', { class: 'tsec' }, 'Done'),
      h('button', { type: 'button', class: 'tdone', 'aria-expanded': String(doneOpen), onclick: () => { doneOpen = !doneOpen; draw(); } },
        icon('check'), `${doneRecent.length} finished in the last 30 days`, icon(doneOpen ? 'chevron-up' : 'chevron')),
      doneOpen ? doneRecent.map(t => cardM(t, 'done')) : null].flat(Infinity).filter(Boolean));
    cols.replaceChildren(
      col('col-run', '01', 'Running', h('span', { class: 'tcnt' }, String(run.length)), run, 'Nothing running.'),
      col('col-todo', '02', 'To do', h('span', { class: 'tcnt' }, String(todo.length)), todo, 'Nothing waiting.'),
      col('col-done', '03', 'Done', h('span', { class: 'tsub' }, showOld ? 'all' : 'last 30 days'), showOld ? doneAll : doneRecent, 'Nothing finished yet.',
        !showOld && doneAll.length > doneRecent.length && h('button', { type: 'button', class: 'tlink older', onclick: () => { showOld = true; draw(); } }, 'Older finished tasks')));
  };
  const pick = (label, key, opts) => h('label', { class: 'fsel' }, h('span', { class: 'sr' }, label),
    h('select', { onchange: e => { f[key] = e.target.value; draw(); } }, opts), icon('chevron'));
  const people = [...new Map(list.filter(t => t.assignee).map(t => [t.assignee, t.assignee_name])).entries()];
  const mkOverdue = () => h('button', {
    type: 'button', class: 'odbtn', 'aria-pressed': String(f.overdue), onclick: () => {
      f.overdue = !f.overdue;
      holder.querySelectorAll('.odbtn').forEach(b => b.setAttribute('aria-pressed', String(f.overdue)));
      draw();
    },
  }, 'Only overdue', h('span', { class: 'cnt' }, String(overdue.length)));
  draw();
  const dataOpen = open.filter(t => t.progress);
  const dataPct = dataOpen.length ? Math.round(dataOpen.reduce((n, t) => n + Math.min(1, t.progress.count / t.progress.target), 0) / dataOpen.length * 100) : null;
  const doneWeek = list.filter(t => t.status === 'done' && t.done_at > week);
  const fig = (label, v, note, bad) => h('div', { class: 'okpi plain' }, h('span', { class: `ok-v${bad ? ' red' : ''}` }, String(v)), h('span', { class: 'ok-t' }, h('b', {}, label), h('span', {}, note)));
  holder.replaceChildren(
    pageTitle({
      kicker: 'Monitor', title: 'Tasks, ', em: 'now and next',
      sub: h('span', {}, `${inWords(open.length)} open${overdue.length ? `, ${inWords(overdue.length, true)} of them overdue` : ''}.`,
        h('span', { class: 'd-only' }, ' Process tasks appear by themselves at each stage; data-entry tasks count what each person syncs and close at their target.')),
      action: goBtn('New task', 'plus', { onclick: () => newTask(auditList, users, T.kinds, reload), disabled: !auditList.length, title: auditList.length ? null : 'Create an audit first' }),
    }),
    h('div', { class: 'tfilters' },
      overdue.length ? h('span', { class: 'm-only' }, mkOverdue()) : null,
      pick('Audit', 'audit', [h('option', { value: '' }, 'All audits'), auditList.filter(a => !CLOSED.has(a.status)).map(a => h('option', { value: a.id, selected: a.id === f.audit }, `${a.industry_tag} · ${a.title}`))]),
      pick('Person', 'person', [h('option', { value: '' }, 'Everyone'), h('option', { value: 'me' }, 'My tasks'), people.map(([id, n]) => h('option', { value: id }, n)), h('option', { value: '-' }, 'Not assigned')]),
      pick('App', 'app', [h('option', { value: '' }, 'All apps'), state.apps.filter(a => a.field).map(a => h('option', { value: a.code }, a.name))]),
      pick('Type', 'source', [h('option', { value: '' }, 'All types'), Object.entries(SOURCE).map(([k, v]) => h('option', { value: k }, v))]),
      overdue.length ? h('span', { class: 'd-only' }, mkOverdue()) : null,
      h('label', { class: 'fsearch t' }, icon('search'), h('span', { class: 'sr' }, 'Find a task'),
        h('input', { type: 'search', placeholder: 'Find a task', oninput: e => { f.q = e.target.value.trim().toLowerCase(); draw(); } }))),
    cols, listM,
    h('section', { class: 'tdo', 'aria-labelledby': 'h-who' },
      h('div', { class: 'tdo-h' }, h('div', {}, h('span', { class: 'kicker' }, 'Last 7 days'), h('h2', { id: 'h-who' }, 'Who is doing what'))),
      h('div', { class: 'tw-figs' },
        fig('Open', open.length, `${open.filter(t => t.status === 'running').length} running`),
        fig('Overdue', overdue.length, 'past their due date', overdue.length > 0),
        fig('Done this week', doneWeek.length, `${doneWeek.filter(t => /data shows|recorded/.test(t.done_note || '')).length} closed by the data`),
        fig('Data entry', dataPct === null ? '—' : `${dataPct} %`, dataOpen.length ? `average of ${dataOpen.length} open target${dataOpen.length > 1 ? 's' : ''}` : 'no open targets')),
      T.workload.length ? h('div', { class: 'tw-list' }, T.workload.map(p => h('div', { class: 'tw' }, h('span', { class: 'av s38', 'aria-hidden': 'true' }, initials(p.name)),
        h('span', { class: 'tw-t' }, h('b', {}, p.name),
          h('span', {}, `${p.open} open`, p.overdue ? h('span', { class: 'late' }, ` · ${p.overdue} overdue`) : null, ` · ${p.done_week} done this week`),
          p.entered.length ? h('span', {}, 'Entered: ', p.entered.slice(0, 4).map(e => `${e.n} in ${appName(e.app)} (${e.client_name})`).join(', '), p.entered.length > 4 ? ` and ${p.entered.length - 4} more` : '')
            : h('span', {}, 'No data entered this week')))))
        : h('p', { class: 'empty' }, 'No tasks assigned and no data entered this week.')));
}

function newTask(auditList, users, kinds, reload, preset = {}) {
  const running = auditList.filter(a => !CLOSED.has(a.status));
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
  'ledger.saved': 'saved in Energy Ledger', 'cea.new_version': 'CEA published a new baseline version', 'cea.version_added': 'added a CEA baseline version',
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
const ICON_CODES = new Set(['survey', 'motor', 'heat', 'textile', 'air', 'pump', 'cool', 'xmer', 'light', 'dryer', 'power', 'report', 'audit', 'ledger']);
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

// Energy Ledger: a module of its own, loaded when it is opened (public/ledger.js).
let ledgerLib = null;
const loadLedger = () => (ledgerLib ||= import('/ledger.js').catch(ex => { ledgerLib = null; throw ex; }));
const ledgerHelpers = () => ({ h, api, toast, icon, ago, fmtDate, field, logoImg, state });
