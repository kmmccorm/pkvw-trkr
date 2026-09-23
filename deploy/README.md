# Deploying to the Pi

Target: Raspberry Pi 4 Model B, 64-bit Raspberry Pi OS (`uname -m` must report
`aarch64` — Bun has no 32-bit ARM build).

## 1. Install Bun system-wide

```bash
curl -fsSL https://bun.sh/install | bash
sudo install -m 755 ~/.bun/bin/bun /usr/local/bin/bun
bun --version
```

Installing the binary into `/usr/local/bin` keeps the system unit independent of
any one user's home directory.

## 2. Install the app

```bash
sudo git clone https://github.com/kmmccorm/pkvw-trkr /opt/pkvw-trkr
```

Root-owned on purpose. The service runs as a throwaway system user (see
`DynamicUser=` in the unit) that cannot write to this directory, so a bug in
the service cannot rewrite its own code, and the `pi` account with its
passwordless sudo is not involved at runtime. No `bun install` is needed: the
runtime has zero dependencies. Run it only if you want to typecheck or test on
the Pi.

To update later:

```bash
sudo git -C /opt/pkvw-trkr pull
sudo systemctl restart pkvw-trkr
systemctl --user restart pkvw-trkr-kiosk
```

The kiosk restart is not optional when anything under `public/` changed. The
server reads those files per request, so it needs no restart to serve them —
but Chromium loaded the page at boot and only ever polls `/api/arrivals`, so
it keeps rendering the old display against new data until the browser
restarts. The nightly `pkvw-trkr-restart.timer` does not cover this: it
restarts the service alone.

If the pull changed anything in `deploy/`, the installed unit files are copies
and do not update with it:

```bash
sudo cp /opt/pkvw-trkr/deploy/pkvw-trkr.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart pkvw-trkr
```

## 3. Provide the API key

Create it on the Pi rather than copying it from a dev machine, so it never
lands in shell history or a sync folder.

```bash
sudo install -m 600 -o root -g root /dev/null /etc/pkvw-trkr.env
sudo nano /etc/pkvw-trkr.env
```

One line, no `export`, no quotes, no spaces around `=`:

```
CTA_API_KEY=your25characterkeygoeshere
```

## 4. Enable the services

```bash
sudo cp deploy/pkvw-trkr.service /etc/systemd/system/
sudo cp deploy/pkvw-trkr-restart.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pkvw-trkr.service pkvw-trkr-restart.timer

mkdir -p ~/.config/systemd/user
cp deploy/pkvw-trkr-kiosk.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pkvw-trkr-kiosk.service
```

Check the Chromium binary name first — `chromium` on Bookworm and later,
`chromium-browser` on older releases — and edit `ExecStart` if needed.

### Verify the sandbox

The unit runs the service as a dynamic user inside a systemd sandbox: the
filesystem is read-only, the kernel and
other processes are hidden, no capabilities are granted, and system calls are
filtered. Confirm it started and see the score:

```bash
systemctl status pkvw-trkr
journalctl -u pkvw-trkr -b
systemd-analyze security pkvw-trkr
```

A working service logs `listening on http://127.0.0.1:3000`. If it does not
start, the journal names the failing directive in most cases. The ones with
any real chance of biting on a new OS or Bun release, and what to do:

| Symptom | Directive | Fix |
|---|---|---|
| Killed with `SIGSYS`, or Bun exits at once with no message | `SystemCallFilter` | Add `SystemCallFilter=@system-service @resources` or, to diagnose, comment it out and re-test |
| Fetch fails with a DNS or connect error while `curl` from a shell works | `RestrictAddressFamilies` | Confirm `AF_NETLINK` is still listed; it is what the resolver uses to discover configured address families |
| Journal warnings about a read-only filesystem or a missing home | `ProtectSystem`, `ProtectHome` | The service should write nothing. Find what is trying to and stop it, rather than opening the sandbox |

Never add `MemoryDenyWriteExecute=`: Bun's JavaScript engine needs
writable-then-executable memory for its JIT and will crash.

### Upgrading a Pi set up with the earlier unit

The first version of the unit ran as `pi` from a `pi`-owned checkout. To move
to the sandboxed layout:

```bash
sudo systemctl stop pkvw-trkr
sudo chown -R root:root /opt/pkvw-trkr
sudo git -C /opt/pkvw-trkr pull
sudo cp /opt/pkvw-trkr/deploy/pkvw-trkr.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start pkvw-trkr
systemctl --user restart pkvw-trkr-kiosk
```

`/etc/pkvw-trkr.env` needs no change. The `pi` user keeps read access to the
checkout, so `bun test` there still works.

Run the last line as the desktop user, not under `sudo` — it is a user unit,
and `sudo systemctl --user` talks to root's session manager instead of the one
running Chromium.

## 5. Stop the screen blanking

X11:

```bash
xset s off -dpms
```

Wayland (the default compositor on Bookworm for the Pi 4): set screen blanking
to off via `raspi-config` → Display Options, or the compositor's own config.
Verify this one on the device; the mechanism differs between labwc and wayfire.

Also worth installing `unclutter` to hide the mouse cursor.

## Checking it works

```bash
systemctl status pkvw-trkr
journalctl -u pkvw-trkr -f
curl -s localhost:3000/healthz | jq
curl -s localhost:3000/api/arrivals | jq
```

`/healthz` returns 503 until the first successful fetch, and whenever the last
fetch failed — point any monitoring at that.

Note that outside 06:00–18:00 on weekdays the service does not poll CTA at all,
so `/healthz` will report the last known state rather than anything current.
