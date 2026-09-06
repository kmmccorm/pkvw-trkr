// The display's decisions, kept free of the DOM so they can be unit tested.
// app.js feeds this a payload and paints whatever comes back.
//
// Plain JavaScript with JSDoc types rather than TypeScript because the page
// is served as-is with no build step.

/** @typedef {import('../src/types').ArrivalsResponse} ArrivalsResponse */

export const WAITING_MESSAGE = 'Waiting for the arrivals service…';
export const OFFLINE_STATUS = 'Cannot reach the local service · retrying';
export const CLOSED_STATUS = 'Outside service hours · 6:00 AM to 6:00 PM, weekdays';
const NO_ARRIVALS = 'No arrival times available right now.';

/**
 * How old the arrivals in `payload` are, in ms, as of `now`.
 *
 * Built from the server's own clock delta (`now - fetchedAt`, both server
 * stamps) plus how long ago the client received it. A skewed Pi clock cannot
 * make the data look fresher or staler than it is.
 *
 * @param {ArrivalsResponse | null} payload
 * @param {number} receivedAt client clock when the payload landed
 * @param {number} now client clock now
 * @returns {number} Infinity when there is nothing to measure
 */
export function ageMs(payload, receivedAt, now) {
  if (!payload || payload.fetchedAt === null) return Infinity;
  return payload.now - payload.fetchedAt + (now - receivedAt);
}

/**
 * CTA counts down in whole minutes and sends "DUE" on approach. Between polls
 * we keep counting locally so the display never looks frozen.
 *
 * @param {string} prdctdn CTA's value: a number as a string, or "DUE"
 * @param {number} elapsedMin whole minutes since the prediction was made
 * @returns {string}
 */
export function minutesUntil(prdctdn, elapsedMin) {
  if (!/^\d+$/.test(prdctdn)) return prdctdn;
  const remaining = parseInt(prdctdn, 10) - elapsedMin;
  return remaining <= 0 ? 'DUE' : String(remaining);
}

/**
 * @typedef {object} Row
 * @property {string} rt
 * @property {string} rtdir
 * @property {string} time
 * @property {string} mins "DUE", a count, or "—" when stale
 * @property {boolean} due
 * @property {boolean} delayed
 */

/**
 * @typedef {object} ViewModel
 * @property {'notice' | 'table'} view
 * @property {string} notice shown when view is 'notice'
 * @property {Row[]} rows shown when view is 'table'
 * @property {string} status footer text
 * @property {boolean} stale
 * @property {boolean} offline
 */

/**
 * Everything the page needs to paint, from the last payload and the clocks.
 *
 * @param {object} state
 * @param {ArrivalsResponse | null} state.payload last payload, or null before the first
 * @param {number} state.receivedAt client clock when it landed
 * @param {boolean} state.offline the last poll of the local service failed
 * @param {number} now client clock
 * @param {(epochMs: number) => string} formatTime clock formatter, e.g. "10:03 AM"
 * @returns {ViewModel}
 */
export function viewModel(state, now, formatTime) {
  const { payload, receivedAt, offline } = state;

  if (!payload) {
    return {
      view: 'notice',
      notice: offline ? WAITING_MESSAGE : 'Connecting…',
      rows: [],
      status: offline ? OFFLINE_STATUS : 'Starting up',
      stale: false,
      offline,
    };
  }

  const age = ageMs(payload, receivedAt, now);
  // Outside service hours there is deliberately no recent fetch, so the
  // staleness warning would be reporting a fault that does not exist.
  const stale = payload.status !== 'closed' && age > payload.staleAfterMs;

  if (payload.status === 'closed' || payload.arrivals.length === 0) {
    return {
      view: 'notice',
      notice: payload.message || NO_ARRIVALS,
      rows: [],
      status: offline
        ? OFFLINE_STATUS
        : payload.status === 'closed'
          ? CLOSED_STATUS
          : payload.message || '',
      stale,
      offline,
    };
  }

  const elapsedMin = Math.floor(age / 60000);
  const rows = payload.arrivals.map((a) => {
    const mins = stale ? '—' : minutesUntil(a.prdctdn, elapsedMin);
    return {
      rt: a.rt,
      rtdir: a.rtdir,
      time: a.prdtmDisplay,
      mins,
      due: mins === 'DUE',
      delayed: a.dly,
    };
  });

  const at = payload.fetchedAt !== null ? formatTime(payload.fetchedAt) : 'never';
  const status = offline
    ? OFFLINE_STATUS
    : stale
      ? `Data may be out of date · last updated ${at}`
      : `Updated ${at}`;

  return { view: 'table', notice: '', rows, status, stale, offline };
}
