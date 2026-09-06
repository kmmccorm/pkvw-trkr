// Fetches /api/arrivals, keeps the last payload, and paints the view model
// from countdown.js once a second. All decisions live there; this file only
// touches the DOM.
import { viewModel } from './countdown.js';

const POLL_MS = 15000;

/** @param {string} id */
function element(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`index.html has no #${id}`);
  return el;
}
const rows = element('rows');
const notice = element('notice');
const statusEl = element('status');
const clockEl = element('clock');

/** @type {{ payload: import('../src/types').ArrivalsResponse | null, receivedAt: number, offline: boolean }} */
const state = { payload: null, receivedAt: 0, offline: false };

const timeFmt = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
/** @param {number} epochMs */
const formatTime = (epochMs) => timeFmt.format(new Date(epochMs));

/**
 * @param {string} className
 * @param {string} text
 */
function cell(className, text) {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

function render() {
  const now = Date.now();
  clockEl.textContent = timeFmt.format(new Date(now));

  const vm = viewModel(state, now, formatTime);
  document.body.classList.toggle('stale', vm.stale);
  document.body.classList.toggle('offline', vm.offline);
  statusEl.textContent = vm.status;

  if (vm.view === 'notice') {
    notice.textContent = vm.notice;
    document.body.dataset.view = 'notice';
    return;
  }

  rows.replaceChildren(...vm.rows.map((r) => {
    const tr = document.createElement('tr');
    if (r.delayed) tr.classList.add('delayed');
    const mins = cell('mins', '');
    if (r.due) {
      const span = document.createElement('span');
      span.className = 'due';
      span.textContent = 'DUE';
      mins.appendChild(span);
    } else {
      mins.textContent = r.mins;
    }
    tr.append(cell('route', r.rt), cell('', r.rtdir), cell('', r.time), mins);
    return tr;
  }));
  document.body.dataset.view = 'table';
}

async function poll() {
  try {
    const response = await fetch('/api/arrivals', { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    state.payload = await response.json();
    state.receivedAt = Date.now();
    state.offline = false;
  } catch {
    // Most likely the service is not up yet at boot. Keep whatever is on
    // screen, flag it, and retry - never surface a browser error page.
    state.offline = true;
  }
  render();
}

poll();
setInterval(poll, POLL_MS);
setInterval(render, 1000);
