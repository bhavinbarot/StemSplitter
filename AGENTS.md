# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this project is

A custom Flask web app called **StemSplitter** built on top of Facebook's [Demucs](https://github.com/facebookresearch/demucs) music source-separation library. The app lets users upload audio or paste a YouTube URL, split it into stems (vocals, bass, drums, other), then play back and mix the stems in a browser-based mixer.

The repo has two distinct layers:
- `demucs/` — the upstream Facebook Demucs ML library (unchanged, used as a Python module)
- `stemsplitter/` — the custom web app (Flask routes, UI, database, analysis)

## Running locally

```bash
./scripts/private/run_local.sh
```

This script:
1. Kills any process on port 5001
2. Creates/activates `venv/` and installs Python dependencies (including madmom with `--no-build-isolation`)
3. Runs `npm run build:css` to compile Tailwind
4. Attempts to mount the Synology NAS at `/Volumes/mp3_app_storage`; falls back to local `web_jobs/`
5. Loads `.env`, then overrides paths for macOS (local DB at `data/gauth.db`, NAS-aware `WEB_JOBS_ROOT`)
6. Starts the app: `python -m stemsplitter.webapp`

The app runs at `http://127.0.0.1:5001`. Auth is disabled by default locally (`REQUIRE_GOOGLE_LOGIN=false`).

## Key environment variables

| Variable | Default | Purpose |
|---|---|---|
| `REQUIRE_GOOGLE_LOGIN` | `false` | Enforce login |
| `LITE_MODE` | `false` | Disables splitting/analysis (read-only mode) |
| `WEB_JOBS_ROOT` | `./web_jobs` | Where job directories are stored |
| `APP_DB_PATH` | `web_jobs/gauth.db` | SQLite for users/projects |
| `ADMIN_EMAILS` | — | Comma-separated emails that always get admin role |
| `APP_PREFIX` | — | Sub-path prefix (e.g. `/stemsplitter`) for reverse proxy |
| `YTDLP_COOKIES_FILE` | — | Path to Netscape-format cookies for yt-dlp |
| `REQUEST_WORKER` | `false` | Enable background "song request" worker thread |

## Frontend build

```bash
npm run build:css      # one-off Tailwind compile
npm run watch:css      # watch mode during active UI development
```

Source: `stemsplitter/static/src/input.css`  
Output: `stemsplitter/static/css/tailwind.css`

JS is vanilla (no bundler) in `stemsplitter/static/js/`.

## Architecture: stemsplitter/

### webapp.py
The entire Flask application (~4500 lines). Key subsystems:

- **Job lifecycle**: Jobs are Python dicts held in `jobs` (in-memory, `jobs_lock`) and persisted to `web_jobs/<job_id>/job.json`. `_get_job()` reads from memory, falls back to disk, then tries to infer from directory contents. NAS-aware: mtime comparison evicts stale in-memory cache when another machine writes the same job.
- **Separation pipeline**: `_run_demucs_job()` spawns `python -m demucs` as a subprocess, streams stdout to parse progress, then zips output stems. Quality is one of three profiles (`mdx_q`, `htdemucs`, `htdemucs_ft`) selected by a 0–100 quality slider.
- **Pitch shifting**: `_ensure_pitch_variant()` uses ffmpeg `rubberband` filter (preferred) or `asetrate+atempo` fallback. Variants are cached under `web_jobs/<job_id>/pitch_cache/`.
- **Auth**: Two auth paths — Google OAuth (via Authlib) and local username/password. Roles: `user`, `contributor`, `admin`. `ADMIN_EMAILS` env var always grants admin regardless of DB role.
- **Access control**: `project_access` table + `_has_job_access()`. When `REQUIRE_GOOGLE_LOGIN=false`, everyone has access to everything.
- **Song requests**: Optional queue stored in `web_requests/requests.json`, processed by a background thread when `REQUEST_WORKER=true`.

### db.py
SQLite (single-writer, `threading.Lock`). Tables:
- `users` — Google/local account unified store (keyed by `sub` for Google, `local:<id>` for local)
- `local_users` — username/password accounts
- `projects` — lightweight index of all jobs (avoids reading every `job.json` for list/search)
- `project_access` — per-user access grants
- `user_overlays` — per-user mixer/lyric deltas (non-destructive; doesn't touch canonical `job.json`)
- Analytics tables: `sessions`, `play_events`

### Analysis modules
- **bpm.py** — librosa-based BPM detection; prefers drums stem, falls back to source mix
- **key_detection.py** — Musical key + Hindustani thaat detection optimised for Indian devotional music; ensemble of Essentia's `TonicIndianArtMusic` and `KeyExtractor` with confidence-weighted voting
- **drum_analysis.py** — Drum hit detection
- **marker_detection.py** — Auto-marker detection on waveform
- **cache.py** — SQLite cache for stem splits; key = SHA256(video_id + model + separation_mode + format)
- **admin_config.py** — Feature toggles and tuning parameters persisted to `web_jobs/admin_config.json`; hot-reloadable from admin UI

### Templates
- `index.html` — Main mixer UI (single-page app, Tailwind + vanilla JS)
- `admin.html` — Admin panel (user management, analytics, job browser, config)
- `login.html` — Google OAuth + local login/register

## Special dependency: madmom

madmom requires Cython and `--no-build-isolation`:
```bash
pip install "Cython>=0.29"
pip install --no-build-isolation "madmom>=0.16"
```
This is handled automatically by `run_local.sh`.

## Deployment

- Production runs on AWS EC2 with a Synology NAS mounted at `/mnt/mp3_app_storage` for persistent storage
- Deploy scripts: `scripts/private/deploy_to_ec2.sh`, `scripts/private/setup_ec2.sh`
- Production starts with gunicorn (1 worker, 4 threads, 3600s timeout)
- `LITE_MODE=true` on EC2 disables local splitting (reads stems written by the local machine instead)
