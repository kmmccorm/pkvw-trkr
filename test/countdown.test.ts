import { describe, expect, test } from 'bun:test';
import {
  ageMs,
  CLOSED_STATUS,
  minutesUntil,
  OFFLINE_STATUS,
  viewModel,
  WAITING_MESSAGE,
} from '../public/countdown.js';
import type { Arrival, ArrivalsResponse } from '../src/types';

const STALE_AFTER = 300_000;
const T0 = 1_700_000_000_000;

const ROWS: Arrival[] = [
  { rt: '72', rtdir: 'Eastbound', prdtm: '20260909 10:03', prdtmDisplay: '10:03 AM', prdctdn: '3', dly: false },
  { rt: '94', rtdir: 'Northbound', prdtm: '20260909 10:09', prdtmDisplay: '10:09 AM', prdctdn: '9', dly: true },
  { rt: '72', rtdir: 'Eastbound', prdtm: '20260909 10:15', prdtmDisplay: '10:15 AM', prdctdn: 'DUE', dly: false },
];

/** A payload the server would send at `serverNow`, fetched `ageMs` earlier. */
function payload(over: Partial<ArrivalsResponse> = {}, age = 0): ArrivalsResponse {
  return {
    status: 'ok',
    arrivals: ROWS,
    fetchedAt: T0 - age,
    now: T0,
    staleAfterMs: STALE_AFTER,
    message: null,
    ...over,
  };
}

const fmt = (ms: number) => `t${ms - T0}`;
const vm = (p: ArrivalsResponse | null, opts: { now?: number; receivedAt?: number; offline?: boolean } = {}) =>
  viewModel({ payload: p, receivedAt: opts.receivedAt ?? T0, offline: opts.offline ?? false }, opts.now ?? T0, fmt);

describe('ageMs', () => {
  test('is infinite with no payload or no successful fetch', () => {
    expect(ageMs(null, T0, T0)).toBe(Infinity);
    expect(ageMs(payload({ fetchedAt: null }), T0, T0)).toBe(Infinity);
  });

  test('adds the server-side age to the time since receipt', () => {
    expect(ageMs(payload({}, 40_000), T0, T0)).toBe(40_000);
    expect(ageMs(payload({}, 40_000), T0, T0 + 25_000)).toBe(65_000);
  });

  // The whole point of carrying `now` from the server: the client's clock
  // only contributes the interval since receipt, never an absolute.
  test('is unaffected by a skewed client clock', () => {
    const skew = 3_600_000;
    expect(ageMs(payload({}, 40_000), T0 + skew, T0 + skew + 25_000)).toBe(65_000);
  });
});

describe('minutesUntil', () => {
  test('counts down by the elapsed minutes', () => {
    expect(minutesUntil('9', 0)).toBe('9');
    expect(minutesUntil('9', 4)).toBe('5');
  });

  test('becomes DUE at zero and stays DUE past it', () => {
    expect(minutesUntil('3', 3)).toBe('DUE');
    expect(minutesUntil('3', 7)).toBe('DUE');
    expect(minutesUntil('0', 0)).toBe('DUE');
  });

  test('passes DUE and any other non-numeric value through verbatim', () => {
    expect(minutesUntil('DUE', 5)).toBe('DUE');
    expect(minutesUntil('DLY', 5)).toBe('DLY');
    expect(minutesUntil('', 5)).toBe('');
  });
});

describe('viewModel before the first payload', () => {
  test('shows connecting until the first poll resolves either way', () => {
    const v = vm(null);
    expect(v.view).toBe('notice');
    expect(v.notice).toBe('Connecting…');
    expect(v.status).toBe('Starting up');
    expect(v.stale).toBe(false);
    expect(v.offline).toBe(false);
  });

  test('shows waiting when the local service cannot be reached yet', () => {
    const v = vm(null, { offline: true });
    expect(v.notice).toBe(WAITING_MESSAGE);
    expect(v.status).toBe(OFFLINE_STATUS);
    expect(v.offline).toBe(true);
  });
});

describe('viewModel notices', () => {
  test('shows the closed message with the hours in the footer', () => {
    const v = vm(payload({ status: 'closed', arrivals: [], message: "You don't need bus data now!" }));
    expect(v.view).toBe('notice');
    expect(v.notice).toBe("You don't need bus data now!");
    expect(v.status).toBe(CLOSED_STATUS);
  });

  test('never marks closed as stale, however old the cache', () => {
    const v = vm(payload({ status: 'closed', arrivals: [] }, 10 * STALE_AFTER));
    expect(v.stale).toBe(false);
  });

  test('shows the empty message in both places', () => {
    const v = vm(payload({ status: 'empty', arrivals: [], message: 'No arrival times available right now.' }));
    expect(v.notice).toBe('No arrival times available right now.');
    expect(v.status).toBe('No arrival times available right now.');
  });

  test('shows the error message when there are no rows to fall back on', () => {
    const v = vm(payload({ status: 'error', arrivals: [], fetchedAt: null, message: 'Unable to reach the CTA right now.' }));
    expect(v.notice).toBe('Unable to reach the CTA right now.');
    expect(v.status).toBe('Unable to reach the CTA right now.');
  });

  test('falls back to a default notice if the server sends none', () => {
    const v = vm(payload({ status: 'empty', arrivals: [], message: null }));
    expect(v.notice).toBe('No arrival times available right now.');
    expect(v.status).toBe('');
  });
});

describe('viewModel table', () => {
  test('projects each arrival onto a row', () => {
    const v = vm(payload());
    expect(v.view).toBe('table');
    expect(v.rows).toEqual([
      { rt: '72', rtdir: 'Eastbound', time: '10:03 AM', mins: '3', due: false, delayed: false },
      { rt: '94', rtdir: 'Northbound', time: '10:09 AM', mins: '9', due: false, delayed: true },
      { rt: '72', rtdir: 'Eastbound', time: '10:15 AM', mins: 'DUE', due: true, delayed: false },
    ]);
    expect(v.stale).toBe(false);
  });

  test('counts down locally between polls using whole elapsed minutes', () => {
    const v = vm(payload({}, 90_000), { now: T0 + 45_000 }); // 2m15s old
    expect(v.rows.map((r) => r.mins)).toEqual(['1', '7', 'DUE']);
  });

  test('turns a row DUE once its minutes run out', () => {
    const v = vm(payload({}, 3 * 60_000));
    expect(v.rows[0]).toMatchObject({ mins: 'DUE', due: true });
    expect(v.rows[1]).toMatchObject({ mins: '6', due: false });
  });

  test('reports the last update time in the footer', () => {
    const v = vm(payload({}, 90_000));
    expect(v.status).toBe(`Updated ${fmt(T0 - 90_000)}`);
  });

  // A stale "3 minutes" is worse than no number at all.
  test('blanks the minutes and warns once the cache passes the threshold', () => {
    const fresh = vm(payload({}, STALE_AFTER));
    expect(fresh.stale).toBe(false);

    const stale = vm(payload({}, STALE_AFTER + 1));
    expect(stale.stale).toBe(true);
    expect(stale.rows.map((r) => r.mins)).toEqual(['—', '—', '—']);
    expect(stale.rows.every((r) => !r.due)).toBe(true);
    expect(stale.status).toBe(`Data may be out of date · last updated ${fmt(T0 - STALE_AFTER - 1)}`);
  });

  test('goes stale from time passing on the client, not only on the server', () => {
    const v = vm(payload({}, 60_000), { now: T0 + STALE_AFTER });
    expect(v.stale).toBe(true);
  });

  test('keeps the rows but says so in the footer when the local service drops', () => {
    // The old inline script set this text and then overwrote it on the next
    // render whenever cached rows existed, so it was only ever visible before
    // the first payload.
    const v = vm(payload(), { offline: true });
    expect(v.view).toBe('table');
    expect(v.rows).toHaveLength(3);
    expect(v.status).toBe(OFFLINE_STATUS);
    expect(v.offline).toBe(true);
  });
});
