/**
 * A route we care about, pinned to the specific stop that serves it in the
 * direction we want. CTA's `rt` parameter filters globally rather than per
 * stop, so the API can return route 72 predictions attached to the California
 * stop. We re-filter on these exact pairs after fetching.
 */
export interface WatchedRoute {
  rt: string;
  stpid: string;
  /** Human label, for logs only. Display direction comes from the API's rtdir. */
  label: string;
}

export interface ServiceWindow {
  /** Inclusive start hour, local to `timezone`. */
  startHour: number;
  /** Exclusive end hour. 18 means the window closes at 18:00:00. */
  endHour: number;
  /** ISO weekday numbers, Monday = 1. */
  days: number[];
}

export interface Config {
  apiKey: string;
  port: number;
  host: string;
  baseUrl: string;
  timezone: string;
  watch: WatchedRoute[];
  window: ServiceWindow;
  /** How often to hit CTA while inside the service window. */
  refreshMs: number;
  /** How often to wake and re-evaluate. Shorter than refreshMs so the display
   *  fills in soon after the window opens rather than waiting a full slot. */
  tickMs: number;
  /** Arrivals older than this are shown without minute counts. */
  staleAfterMs: number;
  fetchTimeoutMs: number;
  /**
   * Most rows to send to the display. The target panel is 800x480, which fits
   * five rows at a size that is readable at a glance; anything beyond that
   * would be pushed off screen, so it is dropped here rather than rendered
   * invisibly.
   */
  maxRows: number;
}

export const DEFAULT_WINDOW: ServiceWindow = {
  startHour: 6,
  endHour: 18,
  days: [1, 2, 3, 4, 5],
};

export const DEFAULT_WATCH: WatchedRoute[] = [
  { rt: '94', stpid: '15231', label: 'California northbound' },
  { rt: '72', stpid: '890', label: 'North Ave eastbound' },
];

/**
 * Read the service window from the environment, falling back to the real one.
 *
 * Exists so the display can be exercised outside 06:00-18:00 on a weekday
 * without editing source: `WINDOW_START_HOUR=0 WINDOW_END_HOUR=24
 * WINDOW_DAYS=1,2,3,4,5,6,7 bun run dev`.
 */
function windowFromEnv(): ServiceWindow {
  const days = Bun.env.WINDOW_DAYS?.split(',')
    .map((d) => Number(d.trim()))
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);

  return {
    startHour: Number(Bun.env.WINDOW_START_HOUR ?? DEFAULT_WINDOW.startHour),
    endHour: Number(Bun.env.WINDOW_END_HOUR ?? DEFAULT_WINDOW.endHour),
    days: days && days.length > 0 ? days : DEFAULT_WINDOW.days,
  };
}

function requireEnv(name: string): string {
  const value = Bun.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Locally: copy .env.example to .env. ` +
        `On the Pi: add it to /etc/pkvw-trkr.env.`,
    );
  }
  return value;
}

export function loadConfig(): Config {
  return {
    apiKey: requireEnv('CTA_API_KEY'),
    port: Number(Bun.env.PORT ?? 3000),
    host: Bun.env.HOST ?? '127.0.0.1',
    baseUrl: Bun.env.CTA_BASE_URL ?? 'https://www.ctabustracker.com/bustime/api/v3',
    timezone: Bun.env.TZ_NAME ?? 'America/Chicago',
    watch: DEFAULT_WATCH,
    window: windowFromEnv(),
    refreshMs: 120_000,
    tickMs: 30_000,
    staleAfterMs: 300_000,
    fetchTimeoutMs: 10_000,
    maxRows: Number(Bun.env.MAX_ROWS ?? 5),
  };
}
