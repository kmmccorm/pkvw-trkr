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

/** Where a value came from, for tests and for the environment on the Pi. */
export type Env = Record<string, string | undefined>;

/**
 * Thrown for any setting that would leave the service running but useless.
 *
 * Every numeric variable used to be read with Number() and used as-is. The
 * consequences were all silent: PORT=abc made Bun pick a random port while
 * Chromium kept pointing at 3000, WINDOW_START_HOUR=abc meant the window never
 * opened, MAX_ROWS=abc dropped every row. Failing at startup puts the mistake
 * in journalctl next to the unit's restart message, where it will be found.
 */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Treat an empty or whitespace-only variable as unset. */
function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function requireEnv(env: Env, name: string): string {
  const value = read(env, name);
  if (!value) {
    throw new ConfigError(
      `${name} is not set. Locally: copy .env.example to .env. ` +
        `On the Pi: add it to /etc/pkvw-trkr.env.`,
    );
  }
  return value;
}

function readInt(
  env: Env,
  name: string,
  fallback: number,
  range: { min: number; max: number },
): number {
  const raw = read(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw new ConfigError(
      `${name} must be a whole number from ${range.min} to ${range.max}, got "${raw}".`,
    );
  }
  return value;
}

function readTimezone(env: Env, name: string, fallback: string): string {
  const value = read(env, name) ?? fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    throw new ConfigError(`${name} must be an IANA time zone such as America/Chicago, got "${value}".`);
  }
  return value;
}

/**
 * Read the service window from the environment, falling back to the real one.
 *
 * Exists so the display can be exercised outside 06:00-18:00 on a weekday
 * without editing source: `WINDOW_START_HOUR=0 WINDOW_END_HOUR=24
 * WINDOW_DAYS=1,2,3,4,5,6,7 bun run dev`.
 */
function windowFromEnv(env: Env): ServiceWindow {
  const startHour = readInt(env, 'WINDOW_START_HOUR', DEFAULT_WINDOW.startHour, { min: 0, max: 23 });
  const endHour = readInt(env, 'WINDOW_END_HOUR', DEFAULT_WINDOW.endHour, { min: 1, max: 24 });
  if (startHour >= endHour) {
    throw new ConfigError(
      `WINDOW_START_HOUR (${startHour}) must be earlier than WINDOW_END_HOUR (${endHour}).`,
    );
  }

  const rawDays = read(env, 'WINDOW_DAYS');
  let days = DEFAULT_WINDOW.days;
  if (rawDays !== undefined) {
    const parsed = rawDays.split(',').map((d) => Number(d.trim()));
    if (parsed.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      throw new ConfigError(
        `WINDOW_DAYS must be a comma-separated list of ISO weekdays 1-7 (Monday = 1), got "${rawDays}".`,
      );
    }
    days = [...new Set(parsed)].sort((a, b) => a - b);
  }

  return { startHour, endHour, days };
}

export function loadConfig(env: Env = Bun.env): Config {
  return {
    apiKey: requireEnv(env, 'CTA_API_KEY'),
    port: readInt(env, 'PORT', 3000, { min: 1, max: 65535 }),
    host: read(env, 'HOST') ?? '127.0.0.1',
    baseUrl: read(env, 'CTA_BASE_URL') ?? 'https://www.ctabustracker.com/bustime/api/v3',
    timezone: readTimezone(env, 'TZ_NAME', 'America/Chicago'),
    watch: DEFAULT_WATCH,
    window: windowFromEnv(env),
    refreshMs: 120_000,
    tickMs: 30_000,
    staleAfterMs: 300_000,
    fetchTimeoutMs: 10_000,
    maxRows: readInt(env, 'MAX_ROWS', 5, { min: 1, max: 50 }),
  };
}
