import type { WatchedRoute } from './config';
import type { Arrival, CtaPrediction } from './types';

/**
 * Reformat CTA's "YYYYMMDD HH:MM" as a 12-hour clock time.
 *
 * Deliberately pure string arithmetic: CTA sends bare local Chicago time with
 * no offset, so converting to a real instant would need tz-aware parsing and
 * would break twice a year at the DST boundary. We only ever display this
 * value and sort on it, and neither needs an absolute instant.
 */
export function formatPrdtm(prdtm: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2})$/.exec(prdtm.trim());
  if (!m) return prdtm;
  const hour24 = Number(m[4]);
  const minute = m[5]!;
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${minute} ${suffix}`;
}

/** True when a prediction is one of the exact route+stop pairs we watch. */
function isWatched(p: CtaPrediction, watch: WatchedRoute[]): boolean {
  return watch.some((w) => w.rt === p.rt && w.stpid === p.stpid);
}

/**
 * Filter to watched route/stop pairs, project onto the display shape, and sort
 * by predicted arrival ascending.
 *
 * prdtm is fixed-width and zero-padded, so a lexicographic sort is already
 * chronological. Ties (CTA only resolves to the minute) fall back to route then
 * vehicle id so the row order is stable across polls and the table does not
 * visibly reshuffle between refreshes.
 */
export function normalize(
  predictions: CtaPrediction[],
  watch: WatchedRoute[],
): Arrival[] {
  return predictions
    .filter((p) => isWatched(p, watch))
    .map<Arrival>((p) => ({
      rt: p.rt,
      rtdir: p.rtdir,
      prdtm: p.prdtm,
      prdtmDisplay: formatPrdtm(p.prdtm),
      prdctdn: p.prdctdn,
      dly: p.dly === true,
    }))
    .sort((a, b) => a.prdtm.localeCompare(b.prdtm) || a.rt.localeCompare(b.rt));
}
