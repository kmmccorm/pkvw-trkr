import type { Arrival, FeedState } from './types';

/**
 * The whole cache. Held in memory only: these predictions are worthless within
 * minutes, so persisting them across a restart would just risk showing
 * confidently wrong arrival times after a reboot.
 */
let state: FeedState = {
  status: 'error',
  arrivals: [],
  fetchedAt: null,
  lastError: 'No fetch has completed yet.',
};

export function getState(): FeedState {
  return state;
}

export function recordSuccess(arrivals: Arrival[], at: number = Date.now()): void {
  state = {
    status: arrivals.length > 0 ? 'ok' : 'empty',
    arrivals,
    fetchedAt: at,
    lastError: null,
  };
}

/** Keep the previous arrivals so the display can show stale data with a warning. */
export function recordFailure(reason: string): void {
  state = { ...state, status: 'error', lastError: reason };
}

/** Test seam. */
export function resetCache(): void {
  state = {
    status: 'error',
    arrivals: [],
    fetchedAt: null,
    lastError: 'No fetch has completed yet.',
  };
}
