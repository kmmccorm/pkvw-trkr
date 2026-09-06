/** A single prediction object as returned inside `bustime-response.prd[]`. */
export interface CtaPrediction {
  rt: string;
  rtdir: string;
  prdtm: string;
  prdctdn: string;
  stpid: string;
  stpnm?: string;
  vid?: string;
  des?: string;
  dly?: boolean;
}

/** An entry from `bustime-response.error[]`. `stpid` is absent on key/system errors. */
export interface CtaError {
  msg: string;
  stpid?: string;
  rt?: string;
}

/** One row of the display table. */
export interface Arrival {
  rt: string;
  rtdir: string;
  /** Raw CTA value, e.g. "20260905 22:55". Kept for sorting and debugging. */
  prdtm: string;
  /** Human form of prdtm, e.g. "10:55 PM". */
  prdtmDisplay: string;
  /** Minutes until arrival. Literally "DUE" when the bus is arriving. */
  prdctdn: string;
  dly: boolean;
}

export type FeedStatus =
  | 'ok'      // fetched successfully, at least one arrival
  | 'empty'   // fetched successfully, nothing scheduled
  | 'error';  // fetch or parse failed; `arrivals` may hold stale data

export interface FeedState {
  status: FeedStatus;
  arrivals: Arrival[];
  /** Epoch ms of the last *successful* fetch, or null if we have never had one. */
  fetchedAt: number | null;
  lastError: string | null;
}

/** Status the frontend sees. `closed` is computed per-request, never cached. */
export type ViewStatus = FeedStatus | 'closed';

export interface ArrivalsResponse {
  status: ViewStatus;
  arrivals: Arrival[];
  fetchedAt: number | null;
  /** Server clock at response time, so the client can measure staleness without trusting its own. */
  now: number;
  staleAfterMs: number;
  message: string | null;
}
