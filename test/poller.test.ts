import { describe, expect, test } from 'bun:test';
import { loadConfig, type Config } from '../src/config';
import type { FetchResult } from '../src/cta';
import { createPoller, type PollerDeps } from '../src/poller';
import type { Arrival, CtaPrediction } from '../src/types';
import fixture from './fixtures/predictions.json';

const KEY = 'abcdefghijklmnopqrstuvwxy';
const OPEN = new Date('2026-09-09T15:00:00Z');   // Wednesday 10:00 CDT
const CLOSED = new Date('2026-09-05T17:00:00Z'); // Saturday noon CDT

const fixturePredictions = fixture['bustime-response'].prd as CtaPrediction[];
const ok = (predictions: CtaPrediction[], extra: Partial<Extract<FetchResult, { ok: true }>> = {}): FetchResult =>
  ({ ok: true, predictions, errors: [], malformed: 0, ...extra });

/** A poller wired to fakes, plus everything it wrote to them. */
function harness(result: FetchResult | (() => Promise<FetchResult>), cfgOverrides: Partial<Config> = {}) {
  const cfg = { ...loadConfig({ CTA_API_KEY: KEY }), ...cfgOverrides };
  const calls = { fetches: 0, successes: [] as Arrival[][], failures: [] as string[], log: [] as string[], errors: [] as string[] };
  let clock = OPEN;
  const deps: Partial<PollerDeps> = {
    fetchPredictions: async () => {
      calls.fetches += 1;
      return typeof result === 'function' ? result() : result;
    },
    recordSuccess: (arrivals) => { calls.successes.push(arrivals); },
    recordFailure: (reason) => { calls.failures.push(reason); },
    now: () => clock,
    log: { log: (m: string) => calls.log.push(m), error: (m: string) => calls.errors.push(m) },
  };
  const poller = createPoller(cfg, deps);
  return { poller, calls, setClock: (d: Date) => { clock = d; } };
}

describe('refresh', () => {
  test('filters, sorts, and caches the arrivals', async () => {
    const { poller, calls } = harness(ok(fixturePredictions));
    await poller.refresh();
    expect(calls.failures).toEqual([]);
    expect(calls.successes).toHaveLength(1);
    expect(calls.successes[0]!.map((a) => a.prdtm)).toEqual([
      '20260909 07:51',
      '20260909 07:55',
      '20260909 08:09',
    ]);
  });

  test('truncates to maxRows, keeping the soonest', async () => {
    const { poller, calls } = harness(ok(fixturePredictions), { maxRows: 2 });
    await poller.refresh();
    expect(calls.successes[0]!.map((a) => a.prdtm)).toEqual(['20260909 07:51', '20260909 07:55']);
  });

  test('logs rows dropped by the route/stop filter, counted before truncation', async () => {
    // The fixture has one route 72 prediction on the California stop.
    const { poller, calls } = harness(ok(fixturePredictions), { maxRows: 1 });
    await poller.refresh();
    expect(calls.log).toContain('[cta] dropped 1 prediction(s) outside the watched route/stop pairs');
    expect(calls.log.some((m) => m.includes('dropped 3'))).toBe(false);
  });

  test('stays quiet about dropped rows when there are none', async () => {
    const { poller, calls } = harness(ok(fixturePredictions.filter((p) => p.stpid !== '15231' || p.rt !== '72')));
    await poller.refresh();
    expect(calls.log.some((m) => m.includes('outside the watched'))).toBe(false);
  });

  test('logs malformed entries the parser threw away', async () => {
    const { poller, calls } = harness(ok(fixturePredictions, { malformed: 2 }));
    await poller.refresh();
    expect(calls.log).toContain('[cta] dropped 2 malformed prediction(s)');
    expect(calls.successes).toHaveLength(1);
  });

  test('logs each CTA notice with its route and stop scope', async () => {
    const { poller, calls } = harness(ok([], {
      errors: [
        { rt: '72', stpid: '15231', msg: 'No data found for parameter' },
        { stpid: '890', msg: 'No arrival times' },
        { msg: 'Something general' },
      ],
    }));
    await poller.refresh();
    expect(calls.log).toEqual([
      '[cta] notice (rt 72, stop 15231): No data found for parameter',
      '[cta] notice (stop 890): No arrival times',
      '[cta] notice: Something general',
    ]);
    // An empty answer is still a success: the cache decides "empty" vs "ok".
    expect(calls.successes).toEqual([[]]);
  });

  test('records a failed fetch and keeps its reason', async () => {
    const { poller, calls } = harness({ ok: false, reason: 'CTA returned HTTP 502.' });
    await poller.refresh();
    expect(calls.successes).toEqual([]);
    expect(calls.failures).toEqual(['CTA returned HTTP 502.']);
    expect(calls.errors).toEqual(['[cta] fetch failed: CTA returned HTTP 502.']);
  });

  // The crash-loop guard. Before this, a throw here escaped as an unhandled
  // rejection, Bun exited, and systemd restarted the service into the same
  // input.
  test('turns an unexpected throw into a failed poll instead of rejecting', async () => {
    const { poller, calls } = harness(async () => { throw new Error(`boom for ${KEY}`); });
    await expect(poller.refresh()).resolves.toBeUndefined();
    expect(calls.failures).toHaveLength(1);
    expect(calls.failures[0]).toContain('Unexpected error while processing arrivals: boom for [REDACTED]');
    expect(calls.failures[0]).not.toContain(KEY);
    expect(calls.errors[0]).not.toContain(KEY);
  });

  test('copes with a throw that is not an Error', async () => {
    const { poller, calls } = harness(async () => { throw 'a string'; });
    await poller.refresh();
    expect(calls.failures[0]).toContain('a string');
  });

  test('ignores a refresh while one is already in flight', async () => {
    let release!: (r: FetchResult) => void;
    const pending = new Promise<FetchResult>((resolve) => { release = resolve; });
    const { poller, calls } = harness(() => pending);

    const first = poller.refresh();
    const second = poller.refresh();
    await second; // resolves immediately: guarded out
    expect(calls.fetches).toBe(1);

    release(ok(fixturePredictions));
    await first;
    expect(calls.successes).toHaveLength(1);

    // The guard is released once the first completes.
    await poller.refresh();
    expect(calls.fetches).toBe(2);
  });

  test('releases the in-flight guard even after a throw', async () => {
    const { poller, calls } = harness(async () => { throw new Error('once'); });
    await poller.refresh();
    await poller.refresh();
    expect(calls.fetches).toBe(2);
  });
});

describe('tick', () => {
  test('fetches on the first tick inside the window', async () => {
    const { poller, calls } = harness(ok(fixturePredictions));
    expect(poller.lastAttemptAt()).toBeNull();
    await poller.tick();
    expect(calls.fetches).toBe(1);
    expect(poller.lastAttemptAt()).toBe(OPEN.getTime());
  });

  test('never fetches outside the window', async () => {
    const { poller, calls, setClock } = harness(ok(fixturePredictions));
    setClock(CLOSED);
    await poller.tick();
    await poller.tick();
    expect(calls.fetches).toBe(0);
    expect(poller.lastAttemptAt()).toBeNull();
  });

  test('waits out the refresh interval between fetches', async () => {
    const { poller, calls, setClock } = harness(ok(fixturePredictions));
    await poller.tick();
    setClock(new Date(OPEN.getTime() + 119_000));
    await poller.tick();
    expect(calls.fetches).toBe(1);
    setClock(new Date(OPEN.getTime() + 120_000));
    await poller.tick();
    expect(calls.fetches).toBe(2);
  });

  test('counts a failed attempt against the interval, so a broken API is not hammered', async () => {
    const { poller, calls, setClock } = harness({ ok: false, reason: 'down' });
    await poller.tick();
    setClock(new Date(OPEN.getTime() + 30_000));
    await poller.tick();
    expect(calls.fetches).toBe(1);
  });
});

describe('start', () => {
  test('ticks immediately and then on a timer until stopped', async () => {
    const { poller, calls } = harness(ok(fixturePredictions), { tickMs: 20, refreshMs: 0 });
    const stop = poller.start();
    await Bun.sleep(70);
    stop();
    const seen = calls.fetches;
    expect(seen).toBeGreaterThanOrEqual(3);
    await Bun.sleep(50);
    expect(calls.fetches).toBe(seen);
  });
});
