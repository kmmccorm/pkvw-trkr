// Fetches /api/arrivals, keeps the last payload, and paints the view model
// from countdown.js once a second. All decisions live there; this file only
// touches the DOM.
import { viewModel } from './countdown.js';

const POLL_MS = 15000;
/** Strips per route column. Fixed so the two columns always balance. */
const SLOTS = 3;

/** @param {string} id */
function element(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`index.html has no #${id}`);
  return el;
}
const notice = element('notice');
const statusEl = element('status');
const clockEl = element('clock');

/** Route column -> its .slots container, keyed by data-rt. */
const columns = new Map(
  [...document.querySelectorAll('.route[data-rt]')].map((sec) => [
    /** @type {HTMLElement} */ (sec).dataset.rt,
    /** @type {HTMLElement} */ (sec.querySelector('.slots')),
  ]),
);

/** @type {{ payload: import('../src/types').ArrivalsResponse | null, receivedAt: number, offline: boolean }} */
const state = { payload: null, receivedAt: 0, offline: false };

const timeFmt = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
/** @param {number} epochMs */
const formatTime = (epochMs) => timeFmt.format(new Date(epochMs));

/**
 * @param {string} className
 * @param {string} text
 */
function flap(className, text) {
  const div = document.createElement('div');
  div.className = `flap ${className}`;
  div.textContent = text;
  return div;
}

/**
 * The minute flaps: two digit tiles for a count (leading zero dimmed), one
 * wide tile for DUE, "—" or anything else.
 * @param {import('./countdown.js').Row} r
 */
function minuteFlaps(r) {
  if (/^\d{1,2}$/.test(r.mins)) {
    const [tens, ones] = r.mins.padStart(2, '0');
    return [flap(tens === '0' ? 'digit lead' : 'digit', tens), flap('digit', ones)];
  }
  return [flap(r.due ? 'word lit' : 'word', r.mins)];
}

/** @param {import('./countdown.js').Row} r */
function strip(r) {
  const div = document.createElement('div');
  div.className = r.delayed ? 'strip delayed' : 'strip';
  const when = flap('when', '');
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = r.time;
  const unit = document.createElement('span');
  unit.className = 'unit';
  unit.textContent = r.delayed ? 'Delayed' : 'Min';
  when.append(time, unit);
  div.append(when, ...minuteFlaps(r));
  return div;
}

function emptyStrip() {
  const div = document.createElement('div');
  div.className = 'strip empty';
  div.append(flap('when', 'No further predictions'), flap('digit', '—'), flap('digit', '—'));
  return div;
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

  for (const [rt, slots] of columns) {
    const rows = vm.rows.filter((r) => r.rt === rt).slice(0, SLOTS);
    const children = rows.map(strip);
    while (children.length < SLOTS) children.push(emptyStrip());
    slots.replaceChildren(...children);
  }
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
