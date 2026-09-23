import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { loadConfig, type Config } from '../src/config';
import { fetchPredictions } from '../src/cta';
import predictions from './fixtures/predictions.json';
import badKey from './fixtures/bad-key.json';

const KEY = 'abcdefghijklmnopqrstuvwxy';

/**
 * A stand-in for the CTA endpoint whose behaviour each test picks by setting
 * `handler`. Runs on a random loopback port; the config's baseUrl points at it.
 */
let handler: (req: Request) => Response | Promise<Response>;
let server: ReturnType<typeof Bun.serve>;
let cfg: Config;
const timers: ReturnType<typeof setTimeout>[] = [];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => handler(req) });
  cfg = {
    ...loadConfig({ CTA_API_KEY: KEY, CTA_BASE_URL: `http://127.0.0.1:${server.port}/bustime/api/v3` }),
    fetchTimeoutMs: 200,
  };
});

afterAll(() => {
  for (const t of timers) clearTimeout(t);
  server.stop(true);
});

describe('fetchPredictions', () => {
  test('requests getpredictions with the key, routes, stops and json format', async () => {
    // Bun recycles the Request once the handler returns, so copy what we need.
    let seen = { url: '', accept: '' };
    handler = (req) => {
      seen = { url: req.url, accept: req.headers.get('accept') ?? '' };
      return json(predictions);
    };

    const result = await fetchPredictions(cfg);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.predictions).toHaveLength(4);

    const url = new URL(seen.url);
    expect(url.pathname).toBe('/bustime/api/v3/getpredictions');
    expect(url.searchParams.get('key')).toBe(KEY);
    expect(url.searchParams.get('rt')).toBe('94,72');
    expect(url.searchParams.get('stpid')).toBe('15231,890');
    expect(url.searchParams.get('format')).toBe('json');
    expect(seen.accept).toBe('application/json');
  });

  test('reports a rejected key from a 200 response as a failure', async () => {
    handler = () => json(badKey);
    const result = await fetchPredictions(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Invalid API access key');
  });

  test('treats a non-200 as an upstream failure without reading the body', async () => {
    handler = () => new Response('<html>502 Bad Gateway</html>', { status: 502 });
    const result = await fetchPredictions(cfg);
    expect(result).toEqual({ ok: false, reason: 'CTA returned HTTP 502.' });
  });

  test('reports a non-JSON body with a short excerpt', async () => {
    handler = () => new Response('<html><body>Service Unavailable</body></html>', {
      headers: { 'content-type': 'text/html' },
    });
    const result = await fetchPredictions(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toStartWith('CTA returned non-JSON: <html><body>Service Unavailable');
      expect(result.reason.length).toBeLessThan(160);
    }
  });

  // A proxy error page that echoes the request URL is the realistic way the
  // key could reach journald. The excerpt must be scrubbed.
  test('redacts the key from a body that echoes the request URL', async () => {
    handler = (req) => new Response(`<html>Bad request: ${req.url}</html>`, {
      headers: { 'content-type': 'text/html' },
    });
    const result = await fetchPredictions(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain(KEY);
      expect(result.reason).toContain('[REDACTED]');
    }
  });

  test('gives up after fetchTimeoutMs on a hung response', async () => {
    handler = () => new Promise((resolve) => {
      timers.push(setTimeout(() => resolve(json(predictions)), 2_000));
    });
    const started = Date.now();
    const result = await fetchPredictions(cfg);
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_500);
    if (!result.ok) {
      expect(result.reason).toMatch(/timed out|timeout|abort/i);
      expect(result.reason).not.toContain(KEY);
    }
  });

  test('reports a connection failure as a plain reason without the key', async () => {
    // Nothing listens on the port of a server we have already closed.
    const dead = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const port = dead.port;
    dead.stop(true);

    const result = await fetchPredictions({ ...cfg, baseUrl: `http://127.0.0.1:${port}` });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason).not.toContain(KEY);
    }
  });

  test('resolves rather than rejecting on a server error', async () => {
    handler = () => new Response('Internal Server Error', { status: 500 });
    await expect(fetchPredictions(cfg)).resolves.toEqual({ ok: false, reason: 'CTA returned HTTP 500.' });
  });
});
