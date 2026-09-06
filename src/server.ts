import type { Config } from './config';
import { getState } from './cache';
import { isWithinWindow } from './schedule';
import type { ArrivalsResponse } from './types';

const CLOSED_MESSAGE = "You don't need bus data now!";
const EMPTY_MESSAGE = 'No arrival times available right now.';

export function buildArrivalsResponse(cfg: Config, now: Date = new Date()): ArrivalsResponse {
  const state = getState();

  // Evaluated per request rather than read from the cache, so the display
  // flips at exactly 6:00 and 18:00 instead of on the next poll boundary.
  if (!isWithinWindow(now, cfg.timezone, cfg.window)) {
    return {
      status: 'closed',
      arrivals: [],
      fetchedAt: state.fetchedAt,
      now: now.getTime(),
      staleAfterMs: cfg.staleAfterMs,
      message: CLOSED_MESSAGE,
    };
  }

  return {
    status: state.status,
    arrivals: state.arrivals,
    fetchedAt: state.fetchedAt,
    now: now.getTime(),
    staleAfterMs: cfg.staleAfterMs,
    message:
      state.status === 'empty'
        ? EMPTY_MESSAGE
        : state.status === 'error' && state.arrivals.length === 0
          ? 'Unable to reach the CTA right now.'
          : null,
  };
}

/**
 * Sent with every response. The page is only ever loaded by a kiosk on
 * loopback, so this is defence in depth: it means data from CTA could not run
 * as script even if some future change stopped escaping it.
 *
 * `default-src 'none'` and no 'unsafe-inline' anywhere is why index.html
 * carries no inline script or style: everything is a same-origin file.
 */
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, 'content-type': 'application/json' },
  });

/**
 * The files the page is allowed to load, by URL path. An explicit map rather
 * than a directory walk: nothing outside it is reachable, whatever the path.
 */
const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/countdown.js': { file: 'countdown.js', type: 'text/javascript; charset=utf-8' },
};

export function startServer(cfg: Config) {
  const publicDir = new URL('../public/', import.meta.url);

  return Bun.serve({
    port: cfg.port,
    hostname: cfg.host,
    fetch(request) {
      const { pathname } = new URL(request.url);

      const asset = STATIC[pathname];
      if (asset) {
        return new Response(Bun.file(new URL(asset.file, publicDir)), {
          headers: { ...SECURITY_HEADERS, 'content-type': asset.type },
        });
      }

      if (pathname === '/api/arrivals') {
        return json(buildArrivalsResponse(cfg));
      }

      if (pathname === '/healthz') {
        const state = getState();
        const healthy = state.fetchedAt !== null && state.status !== 'error';
        return json(
          {
            healthy,
            status: state.status,
            fetchedAt: state.fetchedAt,
            lastError: state.lastError,
          },
          healthy ? 200 : 503,
        );
      }

      return new Response('Not found', { status: 404, headers: SECURITY_HEADERS });
    },
  });
}
