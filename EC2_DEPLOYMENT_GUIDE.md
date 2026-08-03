# Deploying a Flask App to EC2 under `yourdomain.com/<prefix>`

A reusable playbook, extracted from the StemSplitter deployment. Use it to deploy
**any** Python/Flask app to an Ubuntu EC2 instance and serve it from a sub-path of
your domain (e.g. `https://yourdomain.com/puzzle`).

The moving parts, front to back:

```
Browser ──HTTPS──> nginx (:443, one server per domain)
                     └─ location /puzzle ──proxy_pass──> gunicorn 127.0.0.1:5001
                                                          └─ your Flask app (systemd service)
```

- **nginx** terminates TLS and owns the domain. One nginx server block routes many
  apps by path: `/puzzle` → app A on port 5001, `/other` → app B on port 5002, etc.
- **gunicorn** runs the app, bound to **localhost only** (never exposed publicly).
- **systemd** keeps gunicorn alive and restarts it on crash/reboot.
- **`APP_PREFIX`** tells the Flask app it lives under `/puzzle` so it generates
  correct URLs (static assets, redirects, links).

Everything below is app-agnostic. Replace the placeholders in the table before you start.

| Placeholder | Example | Meaning |
|---|---|---|
| `APP_NAME` | `puzzle` | Short slug; names the service, env file, log files |
| `APP_PREFIX` | `/puzzle` | URL sub-path the app is served from |
| `APP_DIR` | `/opt/puzzle` | Where code lives on the server |
| `PORT` | `5002` | Localhost port gunicorn binds to (**unique per app**) |
| `EC2_HOST` | `<your-ec2-ip>` | Public IP / DNS of the instance |
| `EC2_KEY` | `~/.ssh/mykey.pem` | SSH private key |
| `DOMAIN` | `yourdomain.com` | The domain nginx serves |
| `WSGI_TARGET` | `myapp.webapp:app` | `module.path:flask_app_variable` |

> **Pick a unique `PORT` per app.** Every app on the box binds a different localhost
> port; nginx is what multiplexes them onto one domain by path.

---

## Prerequisites (once per instance)

- An Ubuntu EC2 instance (22.04/24.04). GPU only if the app needs it.
- **Security group**: inbound `22` (SSH), `80` and `443` (web) open. Do **not** open
  the app ports (5001, 5002, …) — they stay on localhost.
- A domain with an A record pointing at the instance's public IP.
- Your SSH key (`.pem`) on your local machine.

---

## Step 1 — Make the Flask app prefix-aware

For the app to work under a sub-path, add this near where you create the Flask `app`.
It's the single most important change; without it, static files and redirects break
when served from `/puzzle`.

```python
import os
from werkzeug.middleware.proxy_fix import ProxyFix

# Trust the X-Forwarded-* headers nginx sends (so url_for builds https:// URLs)
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)
app.config["PREFERRED_URL_SCHEME"] = "https"

# Serve the app under a sub-path, e.g. APP_PREFIX=/puzzle
_APP_PREFIX = os.getenv("APP_PREFIX", "").rstrip("/")
if _APP_PREFIX:
    app.config["APPLICATION_ROOT"] = _APP_PREFIX
    _inner_wsgi = app.wsgi_app
    def _prefix_middleware(environ, start_response):
        environ["SCRIPT_NAME"] = _APP_PREFIX
        path = environ.get("PATH_INFO", "")
        if path.startswith(_APP_PREFIX):
            environ["PATH_INFO"] = path[len(_APP_PREFIX):] or "/"
        return _inner_wsgi(environ, start_response)
    app.wsgi_app = _prefix_middleware
```

In templates, prefix any hand-written links/fetch URLs with the same value (pass
`app_prefix=_APP_PREFIX` into `render_template` and prepend it). `url_for()` handles
this automatically once `SCRIPT_NAME` is set.

---

## Step 2 — One-time server setup (`setup_ec2.sh`)

Run this **once** on a fresh instance. It installs system packages, creates the venv,
installs deps, writes the env file, and registers the systemd service.

```bash
#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-puzzle}"
APP_DIR="${APP_DIR:-/opt/$APP_NAME}"
DATA_DIR="${DATA_DIR:-/data/$APP_NAME}"
PORT="${PORT:-5002}"
APP_PREFIX="${APP_PREFIX:-/$APP_NAME}"
WSGI_TARGET="${WSGI_TARGET:-myapp.webapp:app}"
PYTHON="${PYTHON:-python3.11}"

echo "==> System packages"
sudo apt-get update -y
sudo apt-get install -y --no-install-recommends \
    git curl nginx \
    python3.11 python3.11-venv python3.11-dev \
    build-essential
# Add app-specific packages here (e.g. ffmpeg, libsndfile1).

# Node (only if the app builds frontend assets like Tailwind)
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> App + data directories"
sudo mkdir -p "$APP_DIR" "$DATA_DIR"
sudo chown -R ubuntu:ubuntu "$APP_DIR" "$DATA_DIR"

echo "==> Python venv + deps"
cd "$APP_DIR"
[[ -d venv ]] || "$PYTHON" -m venv venv
source venv/bin/activate
pip install --upgrade pip wheel
pip install -r requirements.txt gunicorn

# Build frontend assets if present
if [[ -f package.json ]]; then npm install && npm run build:css; fi

echo "==> Environment file (secrets live here, NOT in git)"
sudo tee /etc/$APP_NAME.env > /dev/null << ENV
PORT=$PORT
APP_PREFIX=$APP_PREFIX
FLASK_SECRET_KEY=CHANGE_ME_TO_A_LONG_RANDOM_STRING
DATA_DIR=$DATA_DIR
ENV
sudo chmod 600 /etc/$APP_NAME.env

echo "==> systemd service"
sudo tee /etc/systemd/system/$APP_NAME.service > /dev/null << SERVICE
[Unit]
Description=$APP_NAME
After=network.target

[Service]
User=ubuntu
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/$APP_NAME.env
ExecStart=$APP_DIR/venv/bin/gunicorn \\
    --workers 1 \\
    --threads 8 \\
    --timeout 3600 \\
    --bind 127.0.0.1:$PORT \\
    --access-logfile /var/log/$APP_NAME-access.log \\
    --error-logfile  /var/log/$APP_NAME-error.log \\
    $WSGI_TARGET
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

sudo touch /var/log/$APP_NAME-access.log /var/log/$APP_NAME-error.log
sudo chown ubuntu:ubuntu /var/log/$APP_NAME-*.log

sudo systemctl daemon-reload
sudo systemctl enable "$APP_NAME"
sudo systemctl restart "$APP_NAME"
sudo systemctl enable nginx

echo "==> Done. Now add the nginx location block (Step 4)."
```

Notes on the systemd/gunicorn choices:
- `--bind 127.0.0.1:$PORT` — localhost only. nginx is the only thing that reaches it.
- `--workers 1 --threads 8` — good for I/O-bound or GPU apps where one process must own
  the GPU/model. For CPU-bound APIs, use more workers (`~2×cores`) instead.
- `--timeout 3600` — generous for long jobs; lower it (e.g. 120) for normal web apps.
- `EnvironmentFile=/etc/$APP_NAME.env` — the app reads secrets from here. Keep it out
  of git; `chmod 600`.

---

## Step 3 — Repeatable deploy from your laptop (`deploy_to_ec2.sh`)

Push code updates from your Mac. rsync copies the tree (minus junk), then restarts the
service. Pass `FIRST_RUN=true` the first time to also run `setup_ec2.sh`.

```bash
#!/usr/bin/env bash
set -euo pipefail

EC2_HOST="${EC2_HOST:-<your-ec2-ip>}"
EC2_USER="${EC2_USER:-ubuntu}"
EC2_KEY="${EC2_KEY:-$HOME/.ssh/mykey.pem}"
APP_NAME="${APP_NAME:-puzzle}"
APP_DIR="/opt/$APP_NAME"
FIRST_RUN="${FIRST_RUN:-false}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SSH="ssh -i $EC2_KEY -o StrictHostKeyChecking=no $EC2_USER@$EC2_HOST"

echo "==> Syncing code to $APP_DIR"
$SSH "sudo mkdir -p $APP_DIR && sudo chown ubuntu:ubuntu $APP_DIR"
rsync -az --progress -e "ssh -i $EC2_KEY -o StrictHostKeyChecking=no" \
    --exclude='.git' --exclude='venv/' --exclude='__pycache__/' \
    --exclude='*.pyc' --exclude='node_modules/' --exclude='.env' \
    --exclude='*.env' \
    "$ROOT_DIR/" "$EC2_USER@$EC2_HOST:$APP_DIR/"

if [[ "$FIRST_RUN" == "true" ]]; then
  echo "==> First-time server setup"
  $SSH "APP_NAME=$APP_NAME bash -s" < "$ROOT_DIR/scripts/private/setup_ec2.sh"
fi

# Upload local .env to the server's env file (optional; keeps secrets in one place)
if [[ -f "$ROOT_DIR/.env" ]]; then
  scp -i "$EC2_KEY" -o StrictHostKeyChecking=no "$ROOT_DIR/.env" "$EC2_USER@$EC2_HOST:/tmp/$APP_NAME.env"
  $SSH "sudo mv /tmp/$APP_NAME.env /etc/$APP_NAME.env && sudo chmod 600 /etc/$APP_NAME.env"
fi

echo "==> Reinstall deps, rebuild assets, restart"
$SSH bash -s << REMOTE
set -euo pipefail
cd "$APP_DIR"
source venv/bin/activate
pip install -q -r requirements.txt gunicorn
[[ -f package.json ]] && npm install --silent && npm run build:css || true
sudo systemctl restart $APP_NAME
sleep 2
sudo systemctl status $APP_NAME --no-pager | head -10
REMOTE

echo "==> Deploy complete: https://<domain>/$APP_NAME"
```

Everyday deploy:
```bash
EC2_KEY=~/.ssh/mykey.pem APP_NAME=puzzle scripts/private/deploy_to_ec2.sh
```
First-time:
```bash
FIRST_RUN=true EC2_KEY=~/.ssh/mykey.pem APP_NAME=puzzle scripts/private/deploy_to_ec2.sh
```

**Note on rsync exclusions:** never sync `venv/` (platform-specific binaries),
`node_modules/`, `.git/`, caches, or any `.env`/secret files. The server builds its own
venv and reads secrets from `/etc/$APP_NAME.env`.

---

## Step 4 — Wire the sub-path into nginx (the `/puzzle` part)

This is what makes `yourdomain.com/puzzle` route to your app. nginx config is **not**
in the repo — it's managed on the server, once per domain. Edit the domain's server
block (e.g. `/etc/nginx/sites-available/yourdomain.com`) and add a `location` block per
app:

```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;

    # ... your ssl_certificate lines (see Step 5) ...

    # App served at yourdomain.com/puzzle  ->  gunicorn on :5002
    location /puzzle/ {
        proxy_pass         http://127.0.0.1:5002/puzzle/;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;   # lets Flask build https:// URLs
        proxy_read_timeout 3600s;                        # match gunicorn --timeout
        client_max_body_size 500M;                       # if the app takes uploads
    }
    # Redirect the bare prefix (no trailing slash) so /puzzle also works
    location = /puzzle {
        return 301 /puzzle/;
    }

    # A second app on the same domain, different path + port:
    # location /other/ { proxy_pass http://127.0.0.1:5003/other/; ... }
}
```

Key points:
- The `proxy_pass` target **includes** the `/puzzle/` path, and the app runs with
  `APP_PREFIX=/puzzle`. The two must agree, or you'll get 404s / broken assets.
- `X-Forwarded-Proto $scheme` + `ProxyFix` in the app = correct `https://` links and
  redirects.
- To add another app later, copy the `location` block, change the path and port. No
  need to touch the first app.

Apply the config:
```bash
sudo nginx -t          # validate — never reload a broken config
sudo systemctl reload nginx
```

---

## Step 5 — HTTPS with Let's Encrypt (once per domain)

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```
certbot fills in the `ssl_certificate` lines and sets up auto-renewal. Run it once for
the domain; all sub-path apps share the same certificate.

---

## Step 6 — Verify & operate

```bash
# Is the service up?
sudo systemctl status puzzle

# Live logs
sudo journalctl -u puzzle -f
tail -f /var/log/puzzle-error.log

# Hit the app directly on the box (bypasses nginx) to isolate app vs proxy issues
curl -i http://127.0.0.1:5002/puzzle/

# Then through the domain
curl -i https://yourdomain.com/puzzle/
```

Common controls:
```bash
sudo systemctl restart puzzle     # after a manual change
sudo nano /etc/puzzle.env         # edit secrets, then restart
sudo systemctl reload nginx       # after editing nginx config
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| 502 Bad Gateway | gunicorn down or wrong port | `systemctl status puzzle`; check `--bind` port matches `proxy_pass` |
| CSS/JS 404, links point at `/` not `/puzzle` | `APP_PREFIX` not set, or template links not prefixed | Set `APP_PREFIX` in env; use `url_for`; restart |
| Redirects drop to `http://` | Missing forwarded headers | Add `X-Forwarded-Proto`; ensure `ProxyFix` in app |
| Uploads fail on large files | nginx body limit | Raise `client_max_body_size` |
| Long requests cut off at ~60s | proxy timeout | Set `proxy_read_timeout` and gunicorn `--timeout` |
| Works on `:5002` but not the domain | nginx location/path mismatch | `proxy_pass` path must include the prefix; `nginx -t` then reload |

---

## Checklist for a new app

1. [ ] Pick a unique `APP_NAME`, `APP_PREFIX`, and `PORT`.
2. [ ] Add the prefix-aware Flask snippet (Step 1).
3. [ ] Copy `setup_ec2.sh` / `deploy_to_ec2.sh`, adjust the placeholders.
4. [ ] `FIRST_RUN=true … deploy_to_ec2.sh` — installs deps + systemd service.
5. [ ] Add the nginx `location /<prefix>/` block; `nginx -t`; reload.
6. [ ] Confirm HTTPS (certbot already covers the domain).
7. [ ] Verify: `curl 127.0.0.1:PORT/prefix/` then `https://domain/prefix/`.
8. [ ] Everyday updates: `deploy_to_ec2.sh` (no `FIRST_RUN`).
