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
sudo mkdir -p /opt/pkvw-trkr
sudo chown pi:pi /opt/pkvw-trkr
git clone <repo> /opt/pkvw-trkr
cd /opt/pkvw-trkr && bun install
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
