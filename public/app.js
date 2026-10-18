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

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-ARES': '1' },
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

// ---------- shell ----------
const PAGES = [
  ['overview', 'Overview'], ['team', 'Team & access'], ['audits', 'Audits'], ['tasks', 'Tasks'], ['activity', 'Activity log'], ['account', 'My account'],
];

function shell(active, content) {
  const side = h('nav', { class: 'side', 'aria-label': 'Console' },
    h('div', { class: 'brand' }, h('img', { src: '/logo.png', alt: '' }), h('div', {}, h('b', {}, 'ARES Console'), h('small', {}, 'AR Energy Services'))),
    PAGES.map(([id, label]) => h('a', { class: `nav${id === active ? ' on' : ''}`, href: `#/${id}` }, label)),
    h('div', { class: 'who' }, h('b', {}, state.me.name), h('span', {}, ROLE[state.me.role]),
      h('button', {
        type: 'button', onclick: async () => {
          await api('POST', '/api/logout').catch(() => {});
          state.me = null;
          route();
        },
      }, 'Sign out')));
  root.replaceChildren(h('div', { class: 'shell' }, side, h('main', { class: 'main' }, content)));
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
  const page = (location.hash.replace('#/', '') || 'overview').split('?')[0];
  const fn = { overview, team, audits, tasks, activity, account }[page] || overview;
  const holder = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  shell(PAGES.some(p => p[0] === page) ? page : 'overview', holder);
  try {
    await fn(holder);
  } catch (ex) {
    if (ex.status !== 401) holder.replaceChildren(h('div', { class: 'err' }, ex.message));
  }
}
window.addEventListener('hashchange', route);

// ---------- overview ----------
async function overview(holder) {
  const d = await api('GET', `/api/dashboard?days=${state.days}`);
  const period = h('select', {
    'aria-label': 'Period', onchange: e => { state.days = Number(e.target.value); route(); },
  }, [7, 30, 90, 365].map(n => h('option', { value: n, selected: n === state.days }, `Last ${n} days`)));

  const t = d.totals;
  const tile = (v, l) => h('div', { class: 'tile' }, h('div', { class: 'v num' }, v), h('div', { class: 'l' }, l));

  const peopleRows = d.people.filter(p => p.role !== 'super_admin' || p.records || p.hours);
  const table = h('div', { class: 'scroll' }, h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, 'Person'), h('th', { class: 'n' }, 'Hours'), h('th', { class: 'n' }, 'Records'),
      h('th', { class: 'n', title: 'Records per logged hour' }, 'Rec / hour'), h('th', { class: 'n' }, 'Active days'),
      h('th', { class: 'n' }, 'Tasks done'), h('th', { class: 'n' }, 'On time'), h('th', { class: 'n' }, 'Overdue'), h('th', {}, 'Last active'))),
    h('tbody', {}, peopleRows.length ? peopleRows.map(p => h('tr', {},
      h('td', {},
        h('div', {}, p.working_now && h('span', { class: 'dot', title: 'Working now' }), h('b', {}, p.name)),
        h('div', { class: 'row small muted', style: 'gap:6px;margin-top:3px' },
          h('span', {}, `${p.employment === 'freelancer' ? 'Freelancer' : 'Staff'} · ${ROLE[p.role]}`), p.status !== 'active' && statusPill(p.status))),
      h('td', { class: 'n' }, p.hours), h('td', { class: 'n' }, p.records),
      h('td', { class: 'n' }, p.records_per_hour ?? '—'), h('td', { class: 'n' }, p.active_days),
      h('td', { class: 'n' }, p.tasks_done), h('td', { class: 'n' }, p.on_time_pct == null ? '—' : `${p.on_time_pct}%`),
      h('td', { class: 'n', style: p.overdue ? 'color:var(--bad);font-weight:600' : '' }, p.overdue),
      h('td', { class: 'small' }, ago(p.last_active)))) : h('tr', {}, h('td', { colspan: 9, class: 'empty' }, 'No team members yet. Add people in Team & access.')))));

  const max = Math.max(1, ...d.records_per_day.map(x => x.n));
  const bars = h('div', { class: 'bars', role: 'img', 'aria-label': 'Records collected per day, last 14 days' },
    d.records_per_day.map(x => h('div', { title: `${x.d}: ${x.n} records` },
      h('b', {}, x.n || ''), h('i', { style: `height:${(x.n / max) * 90}%` }), h('span', {}, x.d.slice(8)))));

  holder.replaceChildren(
    h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Team overview'),
      h('p', { class: 'muted small' }, `Updated ${fmtDate(d.generated_at)} · refreshes every minute`)), period),
    h('div', { class: 'tiles' },
      tile(t.working_now, 'Working now'), tile(t.running_tasks, 'Tasks running'), tile(t.open_tasks, 'Tasks open'),
      tile(t.records, `Records, ${d.days} days`), tile(t.hours, `Hours logged, ${d.days} days`),
      tile(t.active_people, 'Active people'), tile(t.open_audits, 'Audits in progress')),
    h('div', { class: 'grid2' },
      h('div', { class: 'card' }, h('h2', {}, 'Working now'),
        d.working_now.length ? h('div', { class: 'list' }, d.working_now.map(w => h('div', {},
          h('div', {}, h('span', { class: 'dot' }), h('b', {}, w.name), h('div', { class: 'small muted' }, appName(w.app), w.industry_tag ? ` · ${w.industry_tag}` : '')),
          h('div', { class: 'small muted', style: 'text-align:right' }, `since ${fmtDate(w.started_at)}`, h('br'), `${w.records} records`))))
          : h('p', { class: 'empty' }, 'Nobody has an open session in an app right now.')),
      h('div', { class: 'card' }, h('div', { class: 'cap' }, h('h2', {}, 'Running tasks'), h('a', { href: '#/tasks', class: 'small' }, 'All tasks')),
        d.running_tasks.length ? h('div', { class: 'list' }, d.running_tasks.map(r => h('div', {},
          h('div', {}, h('b', {}, r.title), h('div', { class: 'small muted' }, r.assignee_name || 'Unassigned', ' · ', r.industry_tag, r.app ? ` · ${appName(r.app)}` : '')),
          h('div', { class: 'small muted', style: 'text-align:right;white-space:nowrap' }, `started ${ago(r.started_at)}`,
            r.due_at && h('div', { style: r.due_at < Date.now() ? 'color:var(--bad)' : '' }, `due ${fmtDay(r.due_at)}`)))))
          : h('p', { class: 'empty' }, 'No task is marked as running.'))),
    h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', {}, 'Work done by each person'),
      h('p', { class: 'small muted', style: 'margin:-6px 0 10px' },
        'Hours come from the work sessions each app logs; records are readings saved by that person. ',
        'Rec / hour is shown once at least 15 minutes are logged. Nothing here is estimated.'),
      table),
    h('div', { class: 'grid2', style: 'margin-top:16px' },
      h('div', { class: 'card' }, h('h2', {}, 'Records collected per day'), h('p', { class: 'small muted' }, 'Last 14 days, all apps'), bars),
      h('div', { class: 'card' }, h('div', { class: 'cap' }, h('h2', {}, 'Recent activity'), h('a', { href: '#/activity', class: 'small' }, 'Full log')),
        h('div', { class: 'list' }, d.recent.map(a => h('div', {},
          h('div', { class: 'small' }, h('b', {}, a.user_name || 'System'), ' ', describe(a)),
          h('div', { class: 'small muted', style: 'white-space:nowrap' }, ago(a.at))))))));
  state.timer = setInterval(() => { if (location.hash.startsWith('#/overview') || !location.hash) route(); }, 60000);
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
        h('div', { class: 'row', style: 'gap:8px' }, h('span', { class: 'nm' }, u.name), statusPill(u.status)),
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
      h('td', {}, h('b', {}, a.title), h('div', { class: 'small muted' }, a.client_name, ' — ', a.site_name)),
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
      field('Cluster code', h('input', { type: 'text', name: 'cluster', maxlength: 3, placeholder: 'SRT' }), '3 letters, e.g. SRT Surat, ANK Ankleshwar')));
    const siteSel = h('select', { name: 'site_id', onchange: e => { newSite.hidden = !!e.target.value; } });
    const fillSites = cid => {
      const c = clients.find(x => x.id === cid);
      siteSel.replaceChildren(h('option', { value: '' }, 'New plant…'), (c?.sites || []).map(s => h('option', { value: s.id }, `${s.name} (${s.industry_tag})`)));
      newSite.hidden = false;
    };
    const clientSel = h('select', {
      name: 'client_id', onchange: e => { newClient.hidden = !!e.target.value; fillSites(e.target.value); },
    }, h('option', { value: '' }, 'New client…'), clients.map(c => h('option', { value: c.id }, c.name)));
    fillSites('');
    f.append(field('Client', clientSel), newClient, h('label', { class: 'f', style: 'margin-top:12px' }, 'Plant', siteSel), newSite,
      h('div', { class: 'fgrid', style: 'margin-top:12px' },
        field('Financial year', h('input', { type: 'text', name: 'fy', value: currentFy(), required: true })),
        field('Audit title', h('input', { type: 'text', name: 'title', required: true, placeholder: 'Detailed energy audit' }))));
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

route();
