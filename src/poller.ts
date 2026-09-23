import { recordFailure, recordSuccess } from './cache';
import type { Config } from './config';
import { fetchPredictions, redact, type FetchResult } from './cta';
import { normalize } from './normalize';
import { shouldRefresh } from './schedule';
import type { Arrival } from './types';

/**
 * Everything the poller touches outside itself. Each has a real default, so
 * production passes only the config; tests substitute a fake fetch, a fake
 * clock, or a capturing logger without a network or a timer.
 */
export interface PollerDeps {
  fetchPredictions: (cfg: Config) => Promise<FetchResult>;
  recordSuccess: (arrivals: Arrival[]) => void;
  recordFailure: (reason: string) => void;
  now: () => Date;
  log: Pick<Console, 'log' | 'error'>;
}

export interface Poller {
  /** Hit CTA now, unless a request is already in flight. Never rejects. */
  refresh(): Promise<void>;
  /** Refresh only if the window is open and the interval has elapsed. */
  tick(): Promise<void>;
  /** Tick immediately, then on every tickMs. Returns a function that stops it. */
  start(): () => void;
  /** When the last attempt began, for tests and diagnostics. */
  lastAttemptAt(): number | null;
}

const defaults: PollerDeps = {
  fetchPredictions,
  recordSuccess,
  recordFailure,
  now: () => new Date(),
  log: console,
};

/**
 * The fetch-normalize-cache loop, separated from process bootstrap so it can
 * be driven by hand.
 *
 * Lives apart from index.ts because that file runs on import: it reads the
 * environment, starts the timer and opens the socket, so nothing in it could
 * be exercised in a test. The logic here is where the bugs would be (the
 * dropped-row count, truncation, the in-flight guard, the failure path), so
 * it is the part that needs to be reachable.
 */
export function createPoller(cfg: Config, overrides: Partial<PollerDeps> = {}): Poller {
  const deps: PollerDeps = { ...defaults, ...overrides };
  let lastAttemptAt: number | null = null;
  let inFlight = false;

  async function refresh(): Promise<void> {
    // A hung request must not stack up behind the ticker.
    if (inFlight) return;
    inFlight = true;
    lastAttemptAt = deps.now().getTime();
    try {
      const result = await deps.fetchPredictions(cfg);
      if (!result.ok) {
        deps.log.error(`[cta] fetch failed: ${result.reason}`);
        deps.recordFailure(result.reason);
        return;
      }
      if (result.malformed > 0) {
        // Logged rather than fatal: one odd entry must not take the board down.
        deps.log.log(`[cta] dropped ${result.malformed} malformed prediction(s)`);
      }
      const matched = normalize(result.predictions, cfg.watch);
      // Counted before truncation: this number is the signal that a configured
      // stop id is wrong, so it must not be inflated by rows we merely lack the
      // screen space to show.
      const dropped = result.predictions.length - matched.length;
      // Already sorted, so the rows kept are the soonest to arrive.
      const arrivals = matched.slice(0, cfg.maxRows);
      if (dropped > 0) {
        // Usually route 72 predictions arriving on the California stop: the
        // API's rt filter is global, not per stop. Logged because a sudden jump
        // here is the signal that a configured stop id is wrong.
        deps.log.log(`[cta] dropped ${dropped} prediction(s) outside the watched route/stop pairs`);
      }
      for (const e of result.errors) {
        // Include rt as well as stpid: CTA reports per route/stop combination,
        // so "no data" for route 94 at stop 890 is normal and appears alongside
        // a perfectly good route 72 prediction at that same stop.
        const scope = [e.rt && `rt ${e.rt}`, e.stpid && `stop ${e.stpid}`].filter(Boolean).join(', ');
        deps.log.log(`[cta] notice${scope ? ` (${scope})` : ''}: ${e.msg}`);
      }
      deps.recordSuccess(arrivals);
    } catch (error) {
      // refresh() is fired from the ticker without an awaiting caller, so a
      // throw here would be an unhandled rejection, which exits the process.
      // Under systemd that means a restart loop for as long as the input
      // reproduces it. Record it as a failed poll and let the next tick retry.
      const message = redact(error instanceof Error ? error.message : String(error), cfg.apiKey);
      deps.log.error(`[cta] refresh threw: ${message}`);
      deps.recordFailure(`Unexpected error while processing arrivals: ${message}`);
    } finally {
      inFlight = false;
    }
  }

  async function tick(): Promise<void> {
    if (shouldRefresh(deps.now(), lastAttemptAt, cfg.refreshMs, cfg.timezone, cfg.window)) {
      await refresh();
    }
  }

  function start(): () => void {
    void tick();
    const timer = setInterval(() => void tick(), cfg.tickMs);
    return () => clearInterval(timer);
  }

  return { refresh, tick, start, lastAttemptAt: () => lastAttemptAt };
}
