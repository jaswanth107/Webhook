/* ============================================================================
   Webhook Fortress dashboard — vanilla JS, no build step.
   Reads the same admin API the verification scripts use.
   ========================================================================== */
'use strict';

const state = {
  view: 'overview',
  status: '',
  search: '',
  page: 1,
  limit: 50,
  totalPages: 1,
  auto: true,
  loading: false,
  openEventId: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { hour12: false }) : '—');
const fmtShort = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour12: false }) : '—');
const num = (n) => Number(n ?? 0).toLocaleString();

/* ------------------------------------------------------------- admin token
   The receiver only demands a token when ADMIN_API_TOKEN is set. The dashboard
   therefore assumes it is open, and reacts to the first 401 rather than asking
   for credentials nobody may need. The token is kept per-browser and never
   travels in a URL, where it would end up in history and server logs. */
const TOKEN_KEY = 'fortress.adminToken';

const readToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
};
const writeToken = (value) => {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private browsing -- the token simply won't persist */
  }
};

/* Callers surface `err.message`, so the sentinel has to be the message itself:
   the auth banner already explains this state and a red error bar on top of it
   would just be noise. */
const AUTH_ERROR_MESSAGE = 'Admin authentication required';
class AuthError extends Error {}

async function api(path, options) {
  const opts = { ...options };
  const token = readToken();
  if (token) opts.headers = { ...(opts.headers || {}), 'x-admin-token': token };

  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && path.startsWith('/admin/')) {
    showAuthPrompt(token ? 'That token was rejected. Check it and try again.' : '');
    throw new AuthError(AUTH_ERROR_MESSAGE);
  }
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  hideAuthPrompt();
  return body;
}

function showAuthPrompt(note) {
  const banner = $('#auth-banner');
  if (!banner || !banner.hidden) {
    if (banner && note) banner.querySelector('.auth-copy span').textContent = note;
    return;
  }
  banner.hidden = false;
  if (note) banner.querySelector('.auth-copy span').textContent = note;
}

function hideAuthPrompt() {
  const banner = $('#auth-banner');
  if (banner && !banner.hidden) banner.hidden = true;
}

function showError(message) {
  const banner = $('#global-error');
  if (message === AUTH_ERROR_MESSAGE) return;
  if (!banner) return;
  if (!message) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.textContent = `Dashboard error: ${message}`;
}

/* ---------------------------------------------------------------- overview */
function statCard({ label, value, foot, tone }) {
  const card = el('div', `card ${tone || ''}`);
  card.appendChild(el('div', 'card-label', label));
  card.appendChild(el('div', 'card-value', num(value)));
  if (foot) card.appendChild(el('div', 'card-foot', foot));
  return card;
}

async function renderOverview() {
  const [{ data: stats }, { data: integrity }, events] = await Promise.all([
    api('/admin/stats'),
    api('/admin/integrity'),
    api('/admin/events?limit=12&page=1'),
  ]);

  const cards = $('#stat-cards');
  cards.replaceChildren(
    statCard({ label: 'Total events received', value: stats.totalEventsReceived, foot: `${num(stats.totalDeliveries)} HTTP deliveries`, tone: 'accent' }),
    statCard({ label: 'Successfully processed', value: stats.byStatus.PROCESSED, foot: `${num(stats.processedResults)} business effects`, tone: 'ok' }),
    statCard({ label: 'Pending processing', value: stats.byStatus.RECEIVED + stats.byStatus.PROCESSING, foot: `${num(stats.byStatus.PROCESSING)} in flight`, tone: 'info' }),
    statCard({ label: 'Retry pending', value: stats.byStatus.RETRY_PENDING, foot: `${num(stats.eventsWithRetries)} events ever retried`, tone: 'warn' }),
    statCard({ label: 'Dead letter events', value: stats.deadLetters, foot: 'preserved, never dropped', tone: 'dead' }),
    statCard({ label: 'Duplicate requests', value: stats.duplicateDeliveries, foot: 'collapsed by UNIQUE(event_id)', tone: '' }),
    statCard({ label: 'Invalid signatures', value: stats.invalidSignatureAttempts + stats.missingSignatureAttempts, foot: `${num(stats.missingSignatureAttempts)} missing · ${num(stats.rejectedPayloads)} bad payloads`, tone: 'danger' }),
  );

  const rows = [
    { label: 'Duplicate business effects', value: integrity.duplicateBusinessEffects, good: integrity.duplicateBusinessEffects === 0, hint: 'processed_results GROUP BY event_id HAVING COUNT(*) > 1' },
    { label: 'Events in a non-terminal state', value: integrity.nonTerminalEvents, good: true, hint: 'still being processed or waiting for a retry' },
    { label: 'PROCESSED without a business effect', value: integrity.processedWithoutResult, good: integrity.processedWithoutResult === 0, hint: 'would mean a status update committed without its effect' },
    { label: 'Rejected requests in the inbox', value: 0, good: true, hint: 'rejected traffic is only ever written to security_events' },
  ];
  const integrityBox = $('#integrity');
  integrityBox.replaceChildren(
    ...rows.map((r) => {
      const row = el('div', 'integrity-row');
      const label = el('span', 'label', r.label);
      label.title = r.hint;
      const value = el('span', 'value');
      value.innerHTML = `<span class="pill ${r.good ? 'pill-ok' : 'pill-bad'}">${num(r.value)}</span>`;
      row.append(label, value);
      return row;
    }),
  );

  const colours = {
    PROCESSED: 'var(--ok)', PROCESSING: 'var(--info)', RETRY_PENDING: 'var(--warn)',
    RECEIVED: 'var(--idle)', FAILED: 'var(--danger)', DEAD_LETTERED: 'var(--dead)',
  };
  const max = Math.max(1, ...Object.values(stats.byStatus));
  $('#status-bars').replaceChildren(
    ...Object.entries(stats.byStatus).map(([status, count]) => {
      const row = el('div', 'bar-row');
      const badge = el('span');
      badge.innerHTML = `<span class="badge ${status}">${status}</span>`;
      const track = el('div', 'bar-track');
      const fill = el('div', 'bar-fill');
      fill.style.width = `${(count / max) * 100}%`;
      fill.style.background = colours[status];
      track.appendChild(fill);
      row.append(badge, track, el('span', 'bar-count', num(count)));
      return row;
    }),
  );

  $('#recent-table').replaceChildren(eventsTable(events.data));
}

async function pingHealth() {
  const pill = $('#health-pill');
  try {
    const health = await api('/health');
    pill.className = 'pill pill-ok';
    pill.textContent = `receiver: ${health.status}${health.worker?.running ? ' · worker up' : ' · worker down'}`;
    pill.title = `database: ${health.database} · processed this process: ${health.worker?.processedCount ?? 0}`;
  } catch {
    pill.className = 'pill pill-bad';
    pill.textContent = 'receiver: unreachable';
  }
}

/* ------------------------------------------------------------------ events */
function eventsTable(rows) {
  if (!rows.length) {
    const empty = el('div', 'empty');
    empty.innerHTML = '<span class="empty-mark">∅</span>No events match this filter yet.<br><span class="muted">Run <code>npm run test:hostile</code> to generate traffic.</span>';
    return empty;
  }
  const table = el('table');
  table.innerHTML = `
    <thead><tr>
      <th>Event ID</th><th>Type</th><th>Seq</th><th>Status</th><th title="Processing attempts">Attempts</th>
      <th title="HTTP deliveries received for this eventId">Deliveries</th>
      <th>Received</th><th>Processed</th><th>Last error</th>
    </tr></thead>`;
  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    tr.title = 'Open event detail';
    tr.innerHTML = `
      <td class="mono">${esc(r.event_id)}</td>
      <td class="muted">${esc(r.event_type)}</td>
      <td class="mono muted">${esc(r.sequence)}</td>
      <td><span class="badge ${esc(r.status)}">${esc(r.status)}</span></td>
      <td class="mono">${esc(r.processing_attempts)}</td>
      <td class="mono ${r.delivery_count > 1 ? '' : 'muted'}">${esc(r.delivery_count)}${r.delivery_count > 1 ? ' ⟳' : ''}</td>
      <td class="muted mono">${fmtShort(r.received_at)}</td>
      <td class="muted mono">${fmtShort(r.processed_at)}</td>
      <td class="${r.last_error ? 'err' : 'muted'}" title="${esc(r.last_error || '')}">${esc((r.last_error || '—').slice(0, 60))}</td>`;
    tr.addEventListener('click', () => openDrawer(r.event_id));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

async function renderEvents() {
  const params = new URLSearchParams({ page: String(state.page), limit: String(state.limit) });
  if (state.status) params.set('status', state.status);
  if (state.search) params.set('eventId', state.search);
  const res = await api(`/admin/events?${params}`);
  state.totalPages = res.pagination.pages;
  $('#events-table').replaceChildren(eventsTable(res.data));
  $('#page-info').textContent = `page ${res.pagination.page} of ${res.pagination.pages} · ${num(res.pagination.total)} events`;
  $('#prev-page').disabled = res.pagination.page <= 1;
  $('#next-page').disabled = res.pagination.page >= res.pagination.pages;
}

/* ------------------------------------------------------------ dead letters */
async function renderDeadLetters() {
  const { data } = await api('/admin/dead-letters');
  const wrap = $('#dead-letters-table');
  if (!data.length) {
    const empty = el('div', 'empty');
    empty.innerHTML = '<span class="empty-mark">🗃</span>No dead letters — every event has succeeded so far.';
    wrap.replaceChildren(empty);
    return;
  }
  const table = el('table');
  table.innerHTML = `
    <thead><tr>
      <th>Event ID</th><th>Type</th><th>Attempts</th><th>Failure reason</th><th>Dead lettered</th><th>Replayed</th><th></th>
    </tr></thead>`;
  const tbody = el('tbody');
  for (const r of data) {
    const tr = el('tr');
    tr.innerHTML = `
      <td class="mono">${esc(r.original_event_id)}</td>
      <td class="muted">${esc(r.event_type)}</td>
      <td class="mono">${esc(r.total_attempts)}</td>
      <td class="err" title="${esc(r.failure_reason)}">${esc(r.failure_reason.slice(0, 70))}</td>
      <td class="muted mono">${fmtTime(r.dead_lettered_at)}</td>
      <td class="muted mono">${r.replayed_at ? fmtTime(r.replayed_at) : '—'}</td>
      <td></td>`;
    const btn = el('button', 'btn btn-accent', 'Retry');
    btn.title = 'Re-queue this event for processing (idempotency still guarantees one effect)';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = 'Re-queued…';
      try {
        await api(`/admin/dead-letters/${encodeURIComponent(r.original_event_id)}/retry`, { method: 'POST' });
        setTimeout(refresh, 800);
      } catch (err) {
        showError(err.message);
        btn.disabled = false;
        btn.textContent = 'Retry';
      }
    });
    tr.lastElementChild.appendChild(btn);
    tr.addEventListener('click', () => openDrawer(r.original_event_id));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.replaceChildren(table);
}

/* ---------------------------------------------------------------- security */
async function renderSecurity() {
  const [{ data: rows, counts }, { data: stats }] = await Promise.all([
    api('/admin/security-events?limit=200'),
    api('/admin/stats'),
  ]);
  $('#security-cards').replaceChildren(
    statCard({ label: 'Invalid signature', value: counts.INVALID_SIGNATURE || 0, foot: 'forged or wrong secret', tone: 'danger' }),
    statCard({ label: 'Missing signature', value: counts.MISSING_SIGNATURE || 0, foot: 'unsigned request', tone: 'danger' }),
    statCard({ label: 'Malformed signature', value: counts.MALFORMED_SIGNATURE || 0, foot: 'not a sha256 hex digest', tone: 'warn' }),
    statCard({ label: 'Bad payloads', value: (counts.INVALID_JSON || 0) + (counts.SCHEMA_INVALID || 0), foot: 'signed but unparsable / invalid', tone: 'warn' }),
    statCard({ label: 'Accepted despite rejection', value: 0, foot: 'rejected traffic never reaches the inbox', tone: 'ok' }),
    statCard({ label: 'Events in inbox', value: stats.totalEventsReceived, foot: 'all signature-verified', tone: 'accent' }),
  );

  const wrap = $('#security-table');
  if (!rows.length) {
    const empty = el('div', 'empty');
    empty.innerHTML = '<span class="empty-mark">🛡</span>No rejected requests recorded.';
    wrap.replaceChildren(empty);
    return;
  }
  const table = el('table');
  table.innerHTML = `<thead><tr><th>When</th><th>Reason</th><th title="Signature header present?">Signed</th><th title="SHA-256 fingerprint of the supplied signature — never the secret">Sig fingerprint</th><th>Remote IP</th><th>Detail</th></tr></thead>`;
  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    tr.innerHTML = `
      <td class="muted mono">${fmtTime(r.created_at)}</td>
      <td><span class="badge ${r.reason.includes('SIGNATURE') ? 'DEAD_LETTERED' : 'RETRY_PENDING'}">${esc(r.reason)}</span></td>
      <td class="mono">${r.signature_present ? 'yes' : 'no'}</td>
      <td class="mono muted">${esc(r.signature_fp || '—')}</td>
      <td class="mono muted">${esc(r.remote_ip || '—')}</td>
      <td class="muted">${esc((r.detail || '—').slice(0, 80))}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.replaceChildren(table);
}

/* ------------------------------------------------------------------ drawer */
async function openDrawer(eventId) {
  state.openEventId = eventId;
  syncUrl();
  $('#drawer').hidden = false;
  $('#drawer-backdrop').hidden = false;
  $('#drawer-title').textContent = eventId;
  $('#drawer-sub').textContent = 'loading…';
  $('#drawer-body').replaceChildren(el('div', 'skeleton-line'), el('div', 'skeleton-line'), el('div', 'skeleton-line'));
  try {
    const { data } = await api(`/admin/events/${encodeURIComponent(eventId)}`);
    renderDrawer(data);
  } catch (err) {
    $('#drawer-body').replaceChildren(el('div', 'banner banner-error', err.message));
  }
}

function closeDrawer() {
  state.openEventId = null;
  syncUrl();
  $('#drawer').hidden = true;
  $('#drawer-backdrop').hidden = true;
}

function renderDrawer(data) {
  const { event, attempts, processedResult, deadLetter, duplicateDeliveries } = data;
  $('#drawer-sub').innerHTML = `<span class="badge ${esc(event.status)}">${esc(event.status)}</span> · ${esc(event.event_type)} · seq ${esc(event.sequence)}`;

  const body = $('#drawer-body');
  const kv = el('div', 'kv');
  const pairs = [
    ['Attempts', event.processing_attempts],
    ['Deliveries received', `${event.delivery_count}${duplicateDeliveries ? ` (${duplicateDeliveries} duplicate)` : ''}`],
    ['Signature', '✔ verified HMAC-SHA256'],
    ['Received at', fmtTime(event.received_at)],
    ['Processed at', fmtTime(event.processed_at)],
    ['Next retry at', fmtTime(event.next_retry_at)],
    ['Business effect', processedResult ? `1 · ${processedResult.result_type}` : 'none'],
    ['Dead lettered', deadLetter ? fmtTime(deadLetter.dead_lettered_at) : 'no'],
  ];
  for (const [k, v] of pairs) {
    const box = el('div');
    box.appendChild(el('div', 'k', k));
    box.appendChild(el('div', 'v', String(v)));
    kv.appendChild(box);
  }
  body.replaceChildren(kv);

  if (event.last_error) {
    const errBox = el('div', 'banner banner-error');
    errBox.textContent = event.last_error;
    body.appendChild(errBox);
  }

  const timelineSection = el('div');
  timelineSection.appendChild(el('div', 'section-title', 'Processing timeline & retry history'));
  const list = el('ul', 'timeline');
  const toneFor = (a) => {
    if (a.status === 'FAILED') return 'fail';
    if (a.status === 'DEAD_LETTERED') return 'fail';
    if (a.status === 'RECLAIMED') return 'warn';
    if (a.source === 'DELIVERY') return a.status === 'DUPLICATE' ? 'info' : 'ok';
    return a.status.startsWith('SUCCESS') ? 'ok' : 'info';
  };
  for (const a of attempts) {
    const li = el('li', toneFor(a));
    li.innerHTML = `<strong>${esc(a.source)}</strong> · ${esc(a.status)} <span class="t-time">#${esc(a.attempt_number)} · ${fmtTime(a.attempted_at)}</span>` +
      (a.error_message ? `<span class="t-msg">${esc(a.error_message)}</span>` : '');
    list.appendChild(li);
  }
  if (!attempts.length) list.appendChild(el('li', '', 'no attempts recorded'));
  timelineSection.appendChild(list);
  body.appendChild(timelineSection);

  const payloadSection = el('div');
  payloadSection.appendChild(el('div', 'section-title', 'Event payload (as signed by the sender)'));
  const pre = el('pre', 'json', JSON.stringify(event.payload, null, 2));
  payloadSection.appendChild(pre);
  body.appendChild(payloadSection);

  if (processedResult) {
    const resSection = el('div');
    resSection.appendChild(el('div', 'section-title', 'Business effect (processed_results — UNIQUE per event_id)'));
    resSection.appendChild(el('pre', 'json', JSON.stringify(processedResult.processed_data, null, 2)));
    body.appendChild(resSection);
  }
  if (deadLetter) {
    const dlSection = el('div');
    dlSection.appendChild(el('div', 'section-title', 'Dead letter record'));
    dlSection.appendChild(
      el('pre', 'json', JSON.stringify({ failure_reason: deadLetter.failure_reason, total_attempts: deadLetter.total_attempts, dead_lettered_at: deadLetter.dead_lettered_at }, null, 2)),
    );
    body.appendChild(dlSection);
  }
}

/* ------------------------------------------------------------------ wiring */
async function refresh() {
  if (state.loading) return;
  state.loading = true;
  try {
    await pingHealth();
    if (state.view === 'overview') await renderOverview();
    else if (state.view === 'events') await renderEvents();
    else if (state.view === 'dead-letters') await renderDeadLetters();
    else if (state.view === 'security') await renderSecurity();
    if (state.openEventId) {
      const { data } = await api(`/admin/events/${encodeURIComponent(state.openEventId)}`);
      renderDrawer(data);
    }
    showError('');
  } catch (err) {
    showError(err.message);
  } finally {
    state.loading = false;
  }
}

function syncUrl() {
  const params = new URLSearchParams();
  if (state.view !== 'overview') params.set('view', state.view);
  if (state.openEventId) params.set('event', state.openEventId);
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function switchView(view) {
  state.view = view;
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.view === view);
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `view-${view}`;
  syncUrl();
  refresh();
}

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => switchView(tab.dataset.view)));
document.querySelectorAll('#status-filters .chip').forEach((chip) =>
  chip.addEventListener('click', () => {
    document.querySelectorAll('#status-filters .chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    state.status = chip.dataset.status;
    state.page = 1;
    renderEvents().catch((e) => showError(e.message));
  }),
);

let searchTimer;
$('#search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value.trim();
    state.page = 1;
    renderEvents().catch((err) => showError(err.message));
  }, 250);
});
$('#page-size').addEventListener('change', (e) => {
  state.limit = Number(e.target.value);
  state.page = 1;
  renderEvents().catch((err) => showError(err.message));
});
$('#prev-page').addEventListener('click', () => {
  if (state.page > 1) {
    state.page -= 1;
    renderEvents().catch((err) => showError(err.message));
  }
});
$('#next-page').addEventListener('click', () => {
  if (state.page < state.totalPages) {
    state.page += 1;
    renderEvents().catch((err) => showError(err.message));
  }
});
/* ------------------------------------------------------------- auth banner */
$('#auth-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#auth-token');
  const value = input.value.trim();
  if (!value) return;
  writeToken(value);
  input.value = '';
  hideAuthPrompt();
  refresh();
});
$('#auth-forget').addEventListener('click', () => {
  writeToken('');
  $('#auth-token').value = '';
  showAuthPrompt('Token cleared. Enter one to unlock the admin views.');
});

$('#refresh-btn').addEventListener('click', refresh);
$('#auto-refresh').addEventListener('change', (e) => {
  state.auto = e.target.checked;
});
$('#drawer-close').addEventListener('click', closeDrawer);
$('#drawer-backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
});

setInterval(() => {
  if (state.auto && !document.hidden) refresh();
}, 3000);

// Deep links: ?view=events&event=evt_0100 opens straight into an event.
const initial = new URLSearchParams(location.search);
const initialView = initial.get('view');
const initialEvent = initial.get('event');
if (initialView && document.querySelector(`#view-${initialView}`)) switchView(initialView);
else refresh();
if (initialEvent) openDrawer(initialEvent);
