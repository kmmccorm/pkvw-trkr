import { describe, expect, test } from 'bun:test';
import { buildUrl, parsePayload, redact } from '../src/cta';
import { DEFAULT_WATCH } from '../src/config';
import predictions from './fixtures/predictions.json';
import noService from './fixtures/no-service.json';
import badKey from './fixtures/bad-key.json';
import mixed from './fixtures/mixed.json';

const KEY = 'abcdefghijklmnopqrstuvwxy';

describe('buildUrl', () => {
  const url = new URL(
    buildUrl({ baseUrl: 'https://www.ctabustracker.com/bustime/api/v3', apiKey: KEY, watch: DEFAULT_WATCH }),
  );

  test('requests every watched route and stop in one call', () => {
    expect(url.searchParams.get('rt')).toBe('94,72');
    expect(url.searchParams.get('stpid')).toBe('15231,890');
    expect(url.searchParams.get('format')).toBe('json');
  });

  test('uses https so the key is not sent in the clear', () => {
    expect(url.protocol).toBe('https:');
  });

  test('tolerates a base url with a trailing slash', () => {
    expect(buildUrl({ baseUrl: 'https://example.test/v3/', apiKey: KEY, watch: DEFAULT_WATCH }))
      .toContain('https://example.test/v3/getpredictions');
  });
});

describe('redact', () => {
  test('removes the key from anything bound for a log', () => {
    const line = `failed to GET https://x/getpredictions?key=${KEY}&rt=94`;
    expect(redact(line, KEY)).not.toContain(KEY);
    expect(redact(line, KEY)).toContain('[REDACTED]');
  });
});

describe('parsePayload', () => {
  test('reads predictions out of the envelope', () => {
    const result = parsePayload(predictions);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.predictions).toHaveLength(4);
  });

  // Both messages below are verbatim from a live response. They are the
  // "nothing is coming" case and must not be reported as a broken integration.
  test('treats an empty result as a valid answer, not a failure', () => {
    const result = parsePayload(noService);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.predictions).toEqual([]);
      expect(result.errors).toHaveLength(2);
      expect(result.errors.map((e) => e.msg)).toEqual([
        'No data found for parameter',
        'No arrival times',
      ]);
    }
  });

  test('carries the stpid on per-stop errors so a bad stop id is diagnosable', () => {
    const result = parsePayload(noService);
    if (result.ok) {
      expect(result.errors[0]!.stpid).toBe('15231');
      expect(result.errors[0]!.rt).toBe('72');
    }
  });

  test('treats a rejected key as a failure', () => {
    const result = parsePayload(badKey);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Invalid API access key');
  });

  test('keeps the predictions when only one stop errored', () => {
    const result = parsePayload(mixed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.predictions).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
    }
  });

  test('rejects anything that is not a bustime envelope', () => {
    expect(parsePayload(null).ok).toBe(false);
    expect(parsePayload({}).ok).toBe(false);
    expect(parsePayload('<html>502 Bad Gateway</html>').ok).toBe(false);
    expect(parsePayload({ 'bustime-response': 'nope' }).ok).toBe(false);
  });

  test('survives an envelope with neither prd nor error', () => {
    const result = parsePayload({ 'bustime-response': {} });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.predictions).toEqual([]);
  });
});
