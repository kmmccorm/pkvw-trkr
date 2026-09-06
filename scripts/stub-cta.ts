/**
 * A stand-in for the CTA getpredictions endpoint, for working on the display
 * without waiting for real buses.
 *
 * Live data cannot produce every state on demand: a full five-row board only
 * happens at rush hour, "DUE" only when a bus is seconds away, and a delayed
 * bus whenever CTA says so. This serves all of them immediately.
 *
 *   bun run dev:stub                       # terminal 1
 *   CTA_BASE_URL=http://127.0.0.1:3999 \
 *     WINDOW_START_HOUR=0 WINDOW_END_HOUR=24 WINDOW_DAYS=1,2,3,4,5,6,7 \
 *     bun run dev                          # terminal 2
 *
 * Set STUB_SCENARIO to pick what it returns.
 */
import type { CtaPrediction } from '../src/types';

type Scenario = 'board' | 'empty' | 'badkey' | 'garbage';

const scenario = (Bun.env.STUB_SCENARIO ?? 'board') as Scenario;
const port = Number(Bun.env.STUB_PORT ?? 3999);

/** Times are relative to startup so the countdown stays plausible while you work. */
function at(minutesFromNow: number): string {
  const t = new Date(Date.now() + minutesFromNow * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())} ` +
    `${p(t.getHours())}:${p(t.getMinutes())}`
  );
}

function prediction(
  rt: string,
  stpid: string,
  rtdir: string,
  minutes: number,
  prdctdn: string,
  dly = false,
): CtaPrediction {
  return {
    rt,
    stpid,
    rtdir,
    prdtm: at(minutes),
    prdctdn,
    dly,
    stpnm: 'Stub stop',
    vid: '0000',
    des: 'Stub destination',
  };
}

// More rows than MAX_ROWS on purpose, so truncation is exercised too.
const board = {
  'bustime-response': {
    prd: [
      prediction('72', '890', 'Eastbound', 1, 'DUE'),
      prediction('94', '15231', 'Northbound', 5, '5'),
      prediction('72', '890', 'Eastbound', 9, '9', true),
      prediction('94', '15231', 'Northbound', 14, '14'),
      prediction('72', '890', 'Eastbound', 21, '21'),
      prediction('94', '15231', 'Northbound', 30, '30'),
      // Route 72 at the California stop: filtered out by the route/stop pairs.
      prediction('72', '15231', 'Eastbound', 3, '3'),
    ],
  },
};

const bodies: Record<Scenario, string> = {
  board: JSON.stringify(board),
  empty: JSON.stringify({
    'bustime-response': {
      error: [
        { rt: '94', stpid: '15231', msg: 'No service scheduled' },
        { stpid: '890', msg: 'No arrival times' },
      ],
    },
  }),
  badkey: JSON.stringify({
    'bustime-response': { error: [{ msg: 'Invalid API access key supplied' }] },
  }),
  garbage: '<html><body>502 Bad Gateway</body></html>',
};

Bun.serve({
  port,
  hostname: '127.0.0.1',
  fetch() {
    // Mirrors the real API, which answers 200 even for errors.
    return new Response(bodies[scenario], {
      headers: {
        'content-type': scenario === 'garbage' ? 'text/html' : 'application/json',
      },
    });
  },
});

console.log(`[stub-cta] serving "${scenario}" on http://127.0.0.1:${port}`);
console.log(`[stub-cta] scenarios: board | empty | badkey | garbage (STUB_SCENARIO)`);
