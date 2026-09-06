import type { Config } from './config';
import type { CtaError, CtaPrediction } from './types';

export type FetchResult =
  | {
      ok: true;
      predictions: CtaPrediction[];
      errors: CtaError[];
      /** Entries in `prd` that were not usable predictions and were dropped. */
      malformed: number;
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Does this `prd[]` entry carry every field the display needs, as a string?
 *
 * The API is cast, not validated, everywhere else, and a single entry missing
 * `prdtm` used to throw inside normalize(). That throw escaped the poller as
 * an unhandled rejection, Bun exited, systemd restarted the service, the next
 * fetch got the same entry, and the display sat on "Waiting for the arrivals
 * service" for as long as CTA kept sending it. Dropping the entry here keeps
 * the rest of the board up.
 */
function toPrediction(value: unknown): CtaPrediction | null {
  if (!isRecord(value)) return null;
  const { rt, rtdir, prdtm, prdctdn, stpid } = value;
  if (
    typeof rt !== 'string' ||
    typeof rtdir !== 'string' ||
    typeof prdtm !== 'string' ||
    typeof prdctdn !== 'string' ||
    typeof stpid !== 'string'
  ) {
    return null;
  }
  return {
    rt,
    rtdir,
    prdtm,
    prdctdn,
    stpid,
    stpnm: typeof value.stpnm === 'string' ? value.stpnm : undefined,
    vid: typeof value.vid === 'string' ? value.vid : undefined,
    des: typeof value.des === 'string' ? value.des : undefined,
    dly: value.dly === true,
  };
}

/** An `error[]` entry is only useful if it has a message. */
function toError(value: unknown): CtaError | null {
  if (!isRecord(value) || typeof value.msg !== 'string') return null;
  return {
    msg: value.msg,
    stpid: typeof value.stpid === 'string' ? value.stpid : undefined,
    rt: typeof value.rt === 'string' ? value.rt : undefined,
  };
}

/**
 * Interpret a decoded CTA payload.
 *
 * Split out from the network call so it can be tested against recorded
 * fixtures without touching the API. Every element is validated, not cast:
 * whatever comes back from here can be handed to normalize() without a throw.
 */
export function parsePayload(body: unknown): FetchResult {
  if (!isRecord(body) || !('bustime-response' in body)) {
    return { ok: false, reason: 'Response did not contain a bustime-response envelope.' };
  }
  const record = body['bustime-response'];
  if (!isRecord(record)) {
    return { ok: false, reason: 'bustime-response was not an object.' };
  }

  const rawPredictions: unknown[] = Array.isArray(record.prd) ? record.prd : [];
  const predictions: CtaPrediction[] = [];
  for (const raw of rawPredictions) {
    const p = toPrediction(raw);
    if (p) predictions.push(p);
  }
  const malformed = rawPredictions.length - predictions.length;

  const rawErrors: unknown[] = Array.isArray(record.error) ? record.error : [];
  const errors = rawErrors.map(toError).filter((e): e is CtaError => e !== null);

  if (predictions.length === 0 && isHardError(errors)) {
    return { ok: false, reason: errors.map((e) => e.msg).join('; ') };
  }
  // Anything else is a good response: either predictions, or a benign
  // "no service scheduled" style error, or a mix of both across stops.
  return { ok: true, predictions, errors, malformed };
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
