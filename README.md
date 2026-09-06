# pkvw-trkr

A kiosk display for CTA bus arrivals: northbound California (94) and eastbound
North Ave (72). A small Bun service polls the CTA BusTime API, caches the
result, and serves it to a full-screen Chromium instance on a Raspberry Pi.

Target display: **800x480** (the official Raspberry Pi 7" touchscreen). The
layout is tuned for that panel specifically, though it scales up cleanly to
720p and 1080p.

Zero runtime dependencies.

## Quick start

```bash
bun install
cp .env.example .env      # then add your CTA_API_KEY
bun run dev
```

Open http://127.0.0.1:3000.

Outside 06:00–18:00 on weekdays you will see the out-of-hours message rather
than a table. To exercise the table at any hour, widen the window:

```bash
WINDOW_START_HOUR=0 WINDOW_END_HOUR=24 WINDOW_DAYS=1,2,3,4,5,6,7 bun run dev
```

These three variables are development conveniences only; leave them unset on
the Pi so the real window applies.

```bash
bun test          # unit tests, no network access
bun run typecheck
```

### Working on the display without real buses

Live data cannot produce every state on demand — a full board only happens at
rush hour, `DUE` only when a bus is seconds away. `scripts/stub-cta.ts` stands
in for the CTA endpoint and serves any of them immediately:

```bash
bun run dev:stub                                            # terminal 1
CTA_BASE_URL=http://127.0.0.1:3999   WINDOW_START_HOUR=0 WINDOW_END_HOUR=24 WINDOW_DAYS=1,2,3,4,5,6,7   bun run dev                                               # terminal 2
```

`STUB_SCENARIO` selects what it returns:

| Scenario | Exercises |
|---|---|
| `board` (default) | Full table, a `DUE` bus, a delayed bus, row truncation, and one prediction the route/stop filter should drop |
| `empty` | The "no arrival times" state |
| `badkey` | A rejected key, i.e. the hard-failure path |
| `garbage` | A non-JSON response, e.g. a proxy error page |

On Windows PowerShell, set the variables with `$env:NAME = "value"` before the
`bun run dev` line rather than inline.

## How it works

```
scheduler ──every 2 min, weekdays 06:00–18:00 CT──► CTA getpredictions
                                                          │
                                                    parse + filter + sort
                                                          │
                                                    in-memory cache
                                                          │
                                              Bun.serve on 127.0.0.1:3000
                                                          │
                                              Chromium --kiosk, polls /api/arrivals every 15s
```

| Module | Role |
|---|---|
| `src/config.ts` | Environment and constants. Fails fast if `CTA_API_KEY` is missing. |
| `src/cta.ts` | Builds the request, fetches, interprets the envelope. Never throws. |
| `src/normalize.ts` | Pure: filter to watched route/stop pairs, project, sort. |
| `src/cache.ts` | The single in-memory state record. |
| `src/schedule.ts` | Timezone-aware service window. |
| `src/server.ts` | Routes: `/`, `/api/arrivals`, `/healthz`. |
| `public/index.html` | The display. Vanilla, no build step. |
| `scripts/stub-cta.ts` | Fake CTA endpoint for display work. Dev only. |

## Decisions worth knowing

**Bound to 127.0.0.1.** The service holds the API key, so it is not reachable
from the LAN.

**The key is redacted before logging.** It travels as a query parameter, so any
error echoing the request URL would otherwise write it into journald, where it
survives reboots. See `redact()` in `src/cta.ts`.

**HTTP status is not a success signal.** The CTA API answers `200` even for a
rejected key or a stop with no service. Every response body is inspected for an
`error` array. A "no service scheduled" error is treated as a valid empty
answer; a key or authorisation error is treated as a failure.

**`prdtm` is never parsed into an instant.** CTA sends bare local Chicago time
with no offset. Display formatting is string arithmetic and sorting is
lexicographic — `YYYYMMDD HH:MM` is fixed-width, so that is already
chronological. This removes a whole class of DST bugs. The only timezone-aware
logic is the service window, which uses `Intl` with an explicit
`America/Chicago`, so the display does not depend on the Pi's own clock
settings.

**Configuration is validated at startup.** `PORT`, `MAX_ROWS`, the window
hours, `WINDOW_DAYS` and `TZ_NAME` are range-checked and the service exits with
a one-line message if any is wrong. Each of these used to be read with
`Number()` and used as-is, and every failure mode was silent: `PORT=abc` made
Bun pick a random port while Chromium kept pointing at 3000,
`WINDOW_START_HOUR=abc` meant the window never opened, and `MAX_ROWS=abc`
dropped every row. Failing fast puts the mistake in `journalctl` next to the
unit's restart message, where it will be found.

**Every payload element is validated, not cast.** `parsePayload()` checks that
each `prd[]` entry carries the fields the display needs, as strings, and drops
any that do not. Before this, one entry missing `prdtm` threw inside
`normalize()`, the throw escaped the poller as an unhandled rejection, Bun
exited, and systemd restarted the service straight back into the same payload.
Dropped entries are counted and logged as `malformed`. As a second layer,
`refresh()` in `src/index.ts` catches anything unexpected and records it as a
failed poll rather than letting it reach the process.

**`prdctdn` is a string, not a number.** CTA sends `"DUE"` when a bus is
arriving. It is carried through verbatim, per CTA's own wording.

**At most five rows are sent to the display** (`MAX_ROWS`, default 5). Five is
what fits on an 800x480 panel at a size readable at a glance. Truncation
happens after sorting, so the rows kept are always the soonest to arrive.
Rows dropped for lack of space are counted separately from rows dropped by the
route/stop filter, so the filter's diagnostic stays meaningful.

**A delayed bus is shown by colour, not a badge.** CTA's `dly` flag originally
rendered as a "DELAYED" pill, but there is no room for it beside the route
number at 800px wide - it overflowed the cell and was clipped into an
unreadable fragment. The route number and the minute count are now amber
instead, which puts the warning on the value the delay actually makes
unreliable. On a larger screen a text badge would be worth restoring.

**Route/stop pairs are re-filtered after fetching.** CTA's `rt` parameter
filters globally rather than per stop, so a route 72 prediction can come back
attached to the California stop. `src/config.ts` pins each route to the stop
that serves it in the direction we want. Dropped predictions are logged — a
sudden jump in that count is the signal that a stop id is wrong.

**Stale data is shown, but not trusted.** If a fetch fails the previous
arrivals stay on screen with a warning, and once the cache passes five minutes
the minute counts are replaced with `—`. A stale "3 minutes" is worse than no
number at all.

**The display counts down between polls.** The backend refreshes every two
minutes; the page decrements locally from the server-reported fetch age, so the
numbers stay live without extra API calls. Ages are computed from the server's
own clock delta, so a skewed Pi clock cannot distort them.

## Display states

| State | Shown |
|---|---|
| Arrivals available | The table |
| Nothing scheduled | "No arrival times available right now." |
| Outside 06:00–18:00 weekdays | "You don't need bus data now!" |
| Cache older than 5 minutes | Table with `—` for minutes, warning in the footer |
| Service unreachable | "Waiting for the arrivals service…", retrying |

## Deployment

See [deploy/README.md](deploy/README.md).

## Confirmed against the live API

Checked directly against CTA rather than taken from documentation:

- The API serves HTTPS with a valid certificate.
- It returns HTTP 200 even for a rejected key, with an `error` array in the
  body. Status codes cannot be used to detect failure.
- Stop `890` is **North Ave & California, route 72 eastbound** — the configured
  pairing is correct.
- Per-stop errors carry `stpid`, and often `rt` as well. Key errors carry
  neither.
- Errors are reported per route/stop *combination*. A "No data found for
  parameter" notice for route 94 at stop 890 arrives alongside a valid route 72
  prediction at that same stop; both are normal.
- Observed benign error messages: `No data found for parameter`,
  `No arrival times`, `No service scheduled`. The first two are fixtures in
  `test/fixtures/no-service.json`. None match `isHardError()`, so all three are
  correctly treated as "nothing is coming" rather than as a fault.

### Still unconfirmed

- **`prdctdn` returning `"DUE"`.** Not yet observed live — it only appears when
  a bus is actually arriving. The code carries any non-numeric value through
  verbatim and the frontend renders it, so a different sentinel would display
  correctly rather than breaking, but it would not be styled as `DUE` is.
- **`isHardError()` coverage.** It classifies an error as a real failure by
  matching on wording. The two benign messages above are handled, and a rejected
  key is handled, but CTA could return other phrasings that are misclassified.
  A message wrongly treated as benign would show an empty table instead of an
  error; the reverse would show an error banner during quiet periods.
