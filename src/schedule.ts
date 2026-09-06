import type { ServiceWindow } from './config';

/**
 * Is `now` inside the service window, evaluated in `timezone`?
 *
 * Uses Intl rather than the process clock's locale so the window stays pinned
 * to Chicago regardless of how the Pi (or a dev machine) is configured, and so
 * DST is handled by the runtime's tz database instead of by hand.
 */
export function isWithinWindow(
  now: Date,
  timezone: string,
  window: ServiceWindow,
): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const hourRaw = parts.find((p) => p.type === 'hour')?.value;
  if (!weekday || hourRaw === undefined) return false;

  const isoDay = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[weekday];
  if (isoDay === undefined || !window.days.includes(isoDay)) return false;

  const hour = Number(hourRaw);
  return hour >= window.startHour && hour < window.endHour;
}

/** Should we hit CTA on this tick? */
export function shouldRefresh(
  now: Date,
  lastAttemptAt: number | null,
  refreshMs: number,
  timezone: string,
  window: ServiceWindow,
): boolean {
  if (!isWithinWindow(now, timezone, window)) return false;
  if (lastAttemptAt === null) return true;
  return now.getTime() - lastAttemptAt >= refreshMs;
}
