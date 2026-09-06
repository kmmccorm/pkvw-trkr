import { describe, expect, test } from 'bun:test';
import { DEFAULT_WINDOW } from '../src/config';
import { isWithinWindow, shouldRefresh } from '../src/schedule';

const TZ = 'America/Chicago';
const inWindow = (iso: string) => isWithinWindow(new Date(iso), TZ, DEFAULT_WINDOW);

describe('isWithinWindow', () => {
  // Wednesday 2026-09-09, central daylight time (UTC-5).
  test('opens at 06:00 and closes at 18:00 local', () => {
    expect(inWindow('2026-09-09T10:59:00Z')).toBe(false); // 05:59 CDT
    expect(inWindow('2026-09-09T11:00:00Z')).toBe(true);  // 06:00 CDT
    expect(inWindow('2026-09-09T22:59:00Z')).toBe(true);  // 17:59 CDT
    expect(inWindow('2026-09-09T23:00:00Z')).toBe(false); // 18:00 CDT
  });

  test('is closed at weekends', () => {
    expect(inWindow('2026-09-05T17:00:00Z')).toBe(false); // Saturday noon CDT
    expect(inWindow('2026-09-06T17:00:00Z')).toBe(false); // Sunday noon CDT
  });

  // The same UTC instant falls on opposite sides of the boundary depending on
  // the season, which is what makes hardcoding an offset unsafe.
  test('follows the daylight saving shift', () => {
    expect(inWindow('2026-09-09T11:00:00Z')).toBe(true);  // 06:00 CDT, open
    expect(inWindow('2026-01-14T11:00:00Z')).toBe(false); // 05:00 CST, closed
    expect(inWindow('2026-01-14T12:00:00Z')).toBe(true);  // 06:00 CST, open
  });
});

describe('shouldRefresh', () => {
  const open = new Date('2026-09-09T15:00:00Z'); // 10:00 CDT
  const closed = new Date('2026-09-10T01:00:00Z'); // 20:00 CDT

  test('fetches immediately on the first tick inside the window', () => {
    expect(shouldRefresh(open, null, 120_000, TZ, DEFAULT_WINDOW)).toBe(true);
  });

  test('waits out the refresh interval', () => {
    expect(shouldRefresh(open, open.getTime() - 119_000, 120_000, TZ, DEFAULT_WINDOW)).toBe(false);
    expect(shouldRefresh(open, open.getTime() - 120_000, 120_000, TZ, DEFAULT_WINDOW)).toBe(true);
  });

  test('never fetches outside the window, however long it has been', () => {
    expect(shouldRefresh(closed, null, 120_000, TZ, DEFAULT_WINDOW)).toBe(false);
    expect(shouldRefresh(closed, 0, 120_000, TZ, DEFAULT_WINDOW)).toBe(false);
  });
});
