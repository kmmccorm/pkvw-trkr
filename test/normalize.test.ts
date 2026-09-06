import { describe, expect, test } from 'bun:test';
import { formatPrdtm, normalize } from '../src/normalize';
import type { WatchedRoute } from '../src/config';
import type { CtaPrediction } from '../src/types';
import fixture from './fixtures/predictions.json';

const WATCH: WatchedRoute[] = [
  { rt: '94', stpid: '15231', label: 'California northbound' },
  { rt: '72', stpid: '890', label: 'North Ave eastbound' },
];

const predictions = fixture['bustime-response'].prd as CtaPrediction[];

describe('formatPrdtm', () => {
  test('renders a 12-hour clock time', () => {
    expect(formatPrdtm('20260905 22:55')).toBe('10:55 PM');
    expect(formatPrdtm('20260905 07:05')).toBe('7:05 AM');
  });

  test('handles the hours that break naive modulo arithmetic', () => {
    expect(formatPrdtm('20260905 00:07')).toBe('12:07 AM');
    expect(formatPrdtm('20260905 12:00')).toBe('12:00 PM');
  });

  test('passes through anything it does not recognise rather than showing NaN', () => {
    expect(formatPrdtm('')).toBe('');
    expect(formatPrdtm('tomorrow')).toBe('tomorrow');
  });
});

describe('normalize', () => {
  test('sorts by predicted arrival ascending', () => {
    const result = normalize(predictions, WATCH);
    expect(result.map((a) => a.prdtm)).toEqual([
      '20260909 07:51',
      '20260909 07:55',
      '20260909 08:09',
    ]);
  });

  test('drops predictions for routes that are not watched at that stop', () => {
    // The 72 also serves California & North Ave, and CTA's rt filter is global,
    // so a 72 prediction comes back on stop 15231. We only want it at stop 890.
    const result = normalize(predictions, WATCH);
    expect(result).toHaveLength(3);
    expect(result.some((a) => a.rt === '72' && a.prdtm === '20260909 07:52')).toBe(false);
  });

  test('preserves DUE verbatim instead of coercing it to a number', () => {
    const result = normalize(predictions, WATCH);
    expect(result[0]!.prdctdn).toBe('DUE');
    expect(result[0]!.rt).toBe('72');
  });

  test('carries the delay flag through', () => {
    const result = normalize(predictions, WATCH);
    expect(result.find((a) => a.prdtm === '20260909 07:55')!.dly).toBe(true);
  });

  test('returns an empty list rather than throwing when there is nothing', () => {
    expect(normalize([], WATCH)).toEqual([]);
  });

  test('orders ties deterministically so rows do not reshuffle between polls', () => {
    const tied: CtaPrediction[] = [
      { rt: '94', rtdir: 'Northbound', prdtm: '20260909 08:00', prdctdn: '4', stpid: '15231' },
      { rt: '72', rtdir: 'Eastbound', prdtm: '20260909 08:00', prdctdn: '4', stpid: '890' },
    ];
    expect(normalize(tied, WATCH).map((a) => a.rt)).toEqual(['72', '94']);
    expect(normalize([...tied].reverse(), WATCH).map((a) => a.rt)).toEqual(['72', '94']);
  });
});
