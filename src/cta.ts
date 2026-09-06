import type { Config } from './config';
import type { CtaError, CtaPrediction } from './types';

export type FetchResult =
  | { ok: true; predictions: CtaPrediction[]; errors: CtaError[] }
  | { ok: false; reason: string };

/**
 * Strip the API key from any string before it reaches a log.
 *
 * The key travels as a query parameter, so any thrown error or debug line that
 * echoes the request URL would otherwise write it into journald, where it
 * persists across reboots. Every log path in this file goes through here.
 */
export function redact(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join('[REDACTED]');
}

export function buildUrl(cfg: Pick<Config, 'baseUrl' | 'apiKey' | 'watch'>): string {
  const routes = [...new Set(cfg.watch.map((w) => w.rt))].join(',');
  const stops = [...new Set(cfg.watch.map((w) => w.stpid))].join(',');
  const url = new URL(`${cfg.baseUrl.replace(/\/$/, '')}/getpredictions`);
  url.searchParams.set('key', cfg.apiKey);
  url.searchParams.set('rt', routes);
  url.searchParams.set('stpid', stops);
  url.searchParams.set('format', 'json');
  return url.toString();
}

/** Errors that mean the integration is broken, as opposed to "no bus is coming". */
function isHardError(errors: CtaError[]): boolean {
  return errors.some((e) => /api access key|invalid|unauthor|exceed|not authorized/i.test(e.msg));
}

/**
 * Interpret a decoded CTA payload.
 *
 * Split out from the network call so it can be tested against recorded
 * fixtures without touching the API.
 */
export function parsePayload(body: unknown): FetchResult {
  if (typeof body !== 'object' || body === null || !('bustime-response' in body)) {
    return { ok: false, reason: 'Response did not contain a bustime-response envelope.' };
  }
  const envelope = (body as Record<string, unknown>)['bustime-response'];
  if (typeof envelope !== 'object' || envelope === null) {
    return { ok: false, reason: 'bustime-response was not an object.' };
  }
  const record = envelope as Record<string, unknown>;
  const predictions = Array.isArray(record.prd) ? (record.prd as CtaPrediction[]) : [];
  const errors = Array.isArray(record.error) ? (record.error as CtaError[]) : [];

  if (predictions.length === 0 && isHardError(errors)) {
    return { ok: false, reason: errors.map((e) => e.msg).join('; ') };
  }
  // Anything else is a good response: either predictions, or a benign
  // "no service scheduled" style error, or a mix of both across stops.
  return { ok: true, predictions, errors };
}

export async function fetchPredictions(cfg: Config): Promise<FetchResult> {
  const url = buildUrl(cfg);
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(cfg.fetchTimeoutMs),
      headers: { accept: 'application/json' },
    });

    // The API answers 200 even for key and no-service errors, so the status
    // line tells us almost nothing. A non-200 means something upstream of
    // BusTime (proxy, outage) rather than an API-level problem.
    if (!response.ok) {
      return { ok: false, reason: `CTA returned HTTP ${response.status}.` };
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return {
        ok: false,
        reason: `CTA returned non-JSON: ${redact(text.slice(0, 120), cfg.apiKey)}`,
      };
    }
    return parsePayload(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: redact(message, cfg.apiKey) };
  }
}
