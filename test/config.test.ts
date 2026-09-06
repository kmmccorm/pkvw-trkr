import { describe, expect, test } from 'bun:test';
import { ConfigError, DEFAULT_WATCH, DEFAULT_WINDOW, loadConfig, type Env } from '../src/config';

const KEY = 'abcdefghijklmnopqrstuvwxy';
const load = (env: Env) => loadConfig({ CTA_API_KEY: KEY, ...env });

describe('loadConfig defaults', () => {
  test('binds to loopback on 3000 with the real window when nothing is set', () => {
    const cfg = load({});
    expect(cfg.apiKey).toBe(KEY);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(3000);
    expect(cfg.timezone).toBe('America/Chicago');
    expect(cfg.window).toEqual(DEFAULT_WINDOW);
    expect(cfg.watch).toBe(DEFAULT_WATCH);
    expect(cfg.maxRows).toBe(5);
    expect(cfg.baseUrl).toBe('https://www.ctabustracker.com/bustime/api/v3');
  });

  test('refuses to start without an API key', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ CTA_API_KEY: '' })).toThrow(/CTA_API_KEY is not set/);
    expect(() => loadConfig({ CTA_API_KEY: '   ' })).toThrow(/CTA_API_KEY is not set/);
  });

  test('treats an empty variable as unset rather than as zero', () => {
    const cfg = load({ PORT: '', WINDOW_START_HOUR: '  ', MAX_ROWS: '' });
    expect(cfg.port).toBe(3000);
    expect(cfg.window.startHour).toBe(6);
    expect(cfg.maxRows).toBe(5);
  });
});

describe('loadConfig numeric validation', () => {
  test('accepts well-formed overrides', () => {
    const cfg = load({ PORT: '8080', MAX_ROWS: '3', WINDOW_START_HOUR: '5', WINDOW_END_HOUR: '20' });
    expect(cfg.port).toBe(8080);
    expect(cfg.maxRows).toBe(3);
    expect(cfg.window.startHour).toBe(5);
    expect(cfg.window.endHour).toBe(20);
  });

  // Each of these used to be accepted and fail silently: a random port, a
  // window that never opened, or a board with every row dropped.
  test('rejects a port that is not a number', () => {
    expect(() => load({ PORT: 'abc' })).toThrow(/PORT must be a whole number from 1 to 65535, got "abc"/);
  });

  test('rejects a port outside the valid range', () => {
    expect(() => load({ PORT: '0' })).toThrow(ConfigError);
    expect(() => load({ PORT: '65536' })).toThrow(ConfigError);
    expect(() => load({ PORT: '30.5' })).toThrow(ConfigError);
  });

  test('rejects a window hour that is not a number', () => {
    expect(() => load({ WINDOW_START_HOUR: 'six' })).toThrow(/WINDOW_START_HOUR/);
    expect(() => load({ WINDOW_END_HOUR: 'abc' })).toThrow(/WINDOW_END_HOUR/);
  });

  test('bounds the window hours to a single day', () => {
    expect(() => load({ WINDOW_START_HOUR: '-1' })).toThrow(ConfigError);
    expect(() => load({ WINDOW_START_HOUR: '24' })).toThrow(ConfigError);
    expect(() => load({ WINDOW_END_HOUR: '0' })).toThrow(ConfigError);
    expect(() => load({ WINDOW_END_HOUR: '25' })).toThrow(ConfigError);
    // 24 is the documented way to keep the window open until midnight.
    expect(load({ WINDOW_START_HOUR: '0', WINDOW_END_HOUR: '24' }).window.endHour).toBe(24);
  });

  test('rejects a window that closes before it opens', () => {
    expect(() => load({ WINDOW_START_HOUR: '18', WINDOW_END_HOUR: '6' })).toThrow(/earlier than/);
    expect(() => load({ WINDOW_START_HOUR: '9', WINDOW_END_HOUR: '9' })).toThrow(/earlier than/);
  });

  test('rejects a max rows that would blank the board', () => {
    expect(() => load({ MAX_ROWS: 'abc' })).toThrow(/MAX_ROWS/);
    expect(() => load({ MAX_ROWS: '0' })).toThrow(/MAX_ROWS/);
  });
});

describe('loadConfig window days', () => {
  test('parses the documented all-week override', () => {
    expect(load({ WINDOW_DAYS: '1,2,3,4,5,6,7' }).window.days).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test('tolerates spaces, duplicates, and unsorted input', () => {
    expect(load({ WINDOW_DAYS: ' 5, 1 ,5,3' }).window.days).toEqual([1, 3, 5]);
  });

  test('rejects a day outside 1-7 rather than silently dropping it', () => {
    expect(() => load({ WINDOW_DAYS: '0,1' })).toThrow(/WINDOW_DAYS/);
    expect(() => load({ WINDOW_DAYS: '1,8' })).toThrow(/WINDOW_DAYS/);
    expect(() => load({ WINDOW_DAYS: 'mon,tue' })).toThrow(/WINDOW_DAYS/);
    expect(() => load({ WINDOW_DAYS: '1,,2' })).toThrow(/WINDOW_DAYS/);
  });
});

describe('loadConfig timezone', () => {
  test('accepts any IANA zone', () => {
    expect(load({ TZ_NAME: 'Europe/London' }).timezone).toBe('Europe/London');
  });

  test('rejects a zone Intl does not know, so the window cannot silently break', () => {
    expect(() => load({ TZ_NAME: 'Chicago' })).toThrow(/TZ_NAME must be an IANA time zone/);
  });
});
