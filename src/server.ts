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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export function startServer(cfg: Config) {
  const index = Bun.file(new URL('../public/index.html', import.meta.url));

  return Bun.serve({
    port: cfg.port,
    hostname: cfg.host,
    fetch(request) {
      const { pathname } = new URL(request.url);

      if (pathname === '/' || pathname === '/index.html') {
        return new Response(index, {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
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

      return new Response('Not found', { status: 404 });
    },
  });
}
