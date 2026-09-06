import { loadConfig } from './config';
import { fetchPredictions } from './cta';
import { normalize } from './normalize';
import { recordFailure, recordSuccess } from './cache';
import { shouldRefresh } from './schedule';
import { startServer } from './server';

const cfg = loadConfig();
let lastAttemptAt: number | null = null;
let inFlight = false;

async function refresh(): Promise<void> {
  // A hung request must not stack up behind the ticker.
  if (inFlight) return;
  inFlight = true;
  lastAttemptAt = Date.now();
  try {
    const result = await fetchPredictions(cfg);
    if (!result.ok) {
      console.error(`[cta] fetch failed: ${result.reason}`);
      recordFailure(result.reason);
      return;
    }
    const matched = normalize(result.predictions, cfg.watch);
    // Counted before truncation: this number is the signal that a configured
    // stop id is wrong, so it must not be inflated by rows we merely lack the
    // screen space to show.
    const dropped = result.predictions.length - matched.length;
    // Already sorted, so the rows kept are the soonest to arrive.
    const arrivals = matched.slice(0, cfg.maxRows);
    if (dropped > 0) {
      // Usually route 72 predictions arriving on the California stop: the API's
      // rt filter is global, not per stop. Logged because a sudden jump here
      // is the signal that a configured stop id is wrong.
      console.log(`[cta] dropped ${dropped} prediction(s) outside the watched route/stop pairs`);
    }
    for (const e of result.errors) {
      // Include rt as well as stpid: CTA reports per route/stop combination, so
      // "no data" for route 94 at stop 890 is normal and appears alongside a
      // perfectly good route 72 prediction at that same stop.
      const scope = [e.rt && `rt ${e.rt}`, e.stpid && `stop ${e.stpid}`].filter(Boolean).join(', ');
      console.log(`[cta] notice${scope ? ` (${scope})` : ''}: ${e.msg}`);
    }
    recordSuccess(arrivals);
  } finally {
    inFlight = false;
  }
}

function tick(): void {
  if (shouldRefresh(new Date(), lastAttemptAt, cfg.refreshMs, cfg.timezone, cfg.window)) {
    void refresh();
  }
}

tick();
setInterval(tick, cfg.tickMs);

const server = startServer(cfg);
console.log(
  `[pkvw-trkr] listening on http://${server.hostname}:${server.port} ` +
    `(window ${cfg.window.startHour}:00-${cfg.window.endHour}:00 ${cfg.timezone}, ` +
    `refresh ${cfg.refreshMs / 1000}s)`,
);
