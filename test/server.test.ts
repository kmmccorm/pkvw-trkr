import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { recordFailure, recordSuccess, resetCache } from '../src/cache';
import { loadConfig } from '../src/config';
import { buildArrivalsResponse, startServer } from '../src/server';
import type { Arrival } from '../src/types';

const KEY = 'abcdefghijklmnopqrstuvwxy';

/** Real window, so `now` decides whether the display is open. */
const cfg = loadConfig({ CTA_API_KEY: KEY });
const OPEN = new Date('2026-09-09T15:00:00Z');   // Wednesday 10:00 CDT
const CLOSED = new Date('2026-09-05T17:00:00Z'); // Saturday noon CDT

const ROWS: Arrival[] = [
  { rt: '72', rtdir: 'Eastbound', prdtm: '20260909 10:03', prdtmDisplay: '10:03 AM', prdctdn: '3', dly: false },
  { rt: '94', rtdir: 'Northbound', prdtm: '20260909 10:09', prdtmDisplay: '10:09 AM', prdctdn: '9', dly: true },
];

beforeEach(resetCache);

describe('buildArrivalsResponse', () => {
  test('reports closed outside the window, whatever the cache holds', () => {
    recordSuccess(ROWS, OPEN.getTime());
    const res = buildArrivalsResponse(cfg, CLOSED);
    expect(res.status).toBe('closed');
    expect(res.arrivals).toEqual([]);
    expect(res.message).toBe("You don't need bus data now!");
  });

  test('always stamps the server clock so the client can measure staleness', () => {
    recordSuccess(ROWS, OPEN.getTime() - 60_000);
    const res = buildArrivalsResponse(cfg, OPEN);
    expect(res.now).toBe(OPEN.getTime());
    expect(res.fetchedAt).toBe(OPEN.getTime() - 60_000);
    expect(res.staleAfterMs).toBe(cfg.staleAfterMs);
    expect(buildArrivalsResponse(cfg, CLOSED).now).toBe(CLOSED.getTime());
  });

  test('passes arrivals through with no message when there is data', () => {
    recordSuccess(ROWS, OPEN.getTime());
    const res = buildArrivalsResponse(cfg, OPEN);
    expect(res.status).toBe('ok');
    expect(res.arrivals).toEqual(ROWS);
    expect(res.message).toBeNull();
  });

  test('explains an empty board as nothing scheduled, not a fault', () => {
    recordSuccess([], OPEN.getTime());
    const res = buildArrivalsResponse(cfg, OPEN);
    expect(res.status).toBe('empty');
    expect(res.arrivals).toEqual([]);
    expect(res.message).toBe('No arrival times available right now.');
  });

  test('reports an error with no message before any fetch has succeeded', () => {
    recordFailure('CTA returned HTTP 502.');
    const res = buildArrivalsResponse(cfg, OPEN);
    expect(res.status).toBe('error');
    expect(res.arrivals).toEqual([]);
    expect(res.fetchedAt).toBeNull();
    expect(res.message).toBe('Unable to reach the CTA right now.');
  });

  // The display shows the last good rows with a warning rather than blanking
  // the board the moment one poll fails.
  test('keeps stale rows on an error and lets the client judge their age', () => {
    recordSuccess(ROWS, OPEN.getTime() - 90_000);
    recordFailure('The operation timed out.');
    const res = buildArrivalsResponse(cfg, OPEN);
    expect(res.status).toBe('error');
    expect(res.arrivals).toEqual(ROWS);
    expect(res.fetchedAt).toBe(OPEN.getTime() - 90_000);
    expect(res.message).toBeNull();
  });

  test('never leaks the failure reason to the display', () => {
    recordFailure(`key ${KEY} rejected`);
    expect(JSON.stringify(buildArrivalsResponse(cfg, OPEN))).not.toContain(KEY);
  });
});

describe('HTTP routes', () => {
  // Window wide open so the live clock cannot flip the arrivals route to closed.
  const liveCfg = loadConfig({
    CTA_API_KEY: KEY,
    WINDOW_START_HOUR: '0',
    WINDOW_END_HOUR: '24',
    WINDOW_DAYS: '1,2,3,4,5,6,7',
  });
  let server: ReturnType<typeof startServer>;
  const get = (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`);

  beforeAll(() => {
    server = startServer({ ...liveCfg, port: 0 });
  });
  afterAll(() => {
    server.stop(true);
  });

  test('serves the display page at / and /index.html, uncached', async () => {
    for (const path of ['/', '/index.html']) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toContain('<title>Bus Arrivals</title>');
    }
  });

  test('serves arrivals as uncached JSON', async () => {
    recordSuccess(ROWS);
    const res = await get('/api/arrivals');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.arrivals).toEqual(ROWS);
    expect(typeof body.now).toBe('number');
  });

  test('answers 404 for anything else', async () => {
    expect((await get('/nope')).status).toBe(404);
    expect((await get('/api')).status).toBe(404);
  });

  test('ignores the query string when routing', async () => {
    expect((await get('/api/arrivals?x=1')).status).toBe(200);
  });
});

// This is what monitoring points at, so its contract is pinned down here.
describe('/healthz', () => {
  const liveCfg = loadConfig({ CTA_API_KEY: KEY });
  let server: ReturnType<typeof startServer>;
  const health = async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    return { status: res.status, body: await res.json() };
  };

  beforeAll(() => {
    server = startServer({ ...liveCfg, port: 0 });
  });
  afterAll(() => {
    server.stop(true);
  });

  test('is 503 until the first fetch has completed', async () => {
    const { status, body } = await health();
    expect(status).toBe(503);
    expect(body).toEqual({
      healthy: false,
      status: 'error',
      fetchedAt: null,
      lastError: 'No fetch has completed yet.',
    });
  });

  test('is 200 after a successful fetch, even an empty one', async () => {
    recordSuccess([], 1_000);
    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body).toEqual({ healthy: true, status: 'empty', fetchedAt: 1_000, lastError: null });
  });

  test('is 503 with the reason after a failed fetch, keeping the last good time', async () => {
    recordSuccess(ROWS, 1_000);
    recordFailure('CTA returned HTTP 502.');
    const { status, body } = await health();
    expect(status).toBe(503);
    expect(body).toEqual({
      healthy: false,
      status: 'error',
      fetchedAt: 1_000,
      lastError: 'CTA returned HTTP 502.',
    });
  });

  test('recovers to 200 once a later fetch succeeds', async () => {
    recordFailure('CTA returned HTTP 502.');
    recordSuccess(ROWS, 2_000);
    expect((await health()).status).toBe(200);
  });
});
