import os
import re
import subprocess
import sys
import threading
import time
import uuid
import zipfile
import math
import shutil
import logging
import json
import hashlib
from functools import wraps
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

from authlib.integrations.flask_client import OAuth
from flask import Flask, abort, jsonify, redirect, render_template, request, send_file, session, url_for
from werkzeug.middleware.proxy_fix import ProxyFix

if __package__:
    from .video_downloader import VideoDownloadError, YtDlpVideoDownloader
else:
    from video_downloader import VideoDownloadError, YtDlpVideoDownloader


app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "change-this-dev-secret")
app.logger.setLevel(logging.INFO)
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)  # type: ignore[assignment]
app.config["PREFERRED_URL_SCHEME"] = "https"
PROJECT_ROOT = Path(__file__).resolve().parent.parent
JOB_ROOT = Path(os.getenv("WEB_JOBS_ROOT", str(PROJECT_ROOT / "web_jobs")))
LOGIN_ROOT = Path(os.getenv("WEB_LOGINS_ROOT", str(PROJECT_ROOT / "web_logins")))
JOB_META_NAME = "job.json"
ALLOWED_SUFFIXES = {".mp3", ".mpe", ".wav", ".flac", ".m4a", ".aac", ".ogg"}
PROGRESS_RE = re.compile(r"(\d{1,3})%\|")
jobs = {}
jobs_lock = threading.Lock()
JOB_ID_RE = re.compile(r"(?:[0-9a-f]{32}|[0-9]{8}_[0-9]{6}_[0-9a-f]{32})")
STEM_KEY_RE = re.compile(r"[a-z_]{1,24}")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "").strip()
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "").strip()
AUTH_ENABLED = bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)
AUTH_REQUIRED = os.getenv("REQUIRE_GOOGLE_LOGIN", "false").strip().lower() in {"1", "true", "yes", "on"}
# Google doesn't expose "name-only" scope; profile is needed for a reliable display name.
GOOGLE_OAUTH_SCOPE = os.getenv("GOOGLE_OAUTH_SCOPE", "openid email profile").strip() or "openid email profile"
API_CORS_ORIGIN = os.getenv("API_CORS_ORIGIN", "").strip()


def _resolve_ui_version() -> str:
    # Prefer an explicit deploy-time value injected by CI/CD or hosting platform.
    for key in (
        "UI_VERSION",
        "APP_DEPLOYED_AT",
        "RELEASE_VERSION",
        "RELEASE_CREATED_AT",
        "SOURCE_VERSION",
        "GIT_COMMIT",
    ):
        value = os.getenv(key, "").strip()
        if value:
            return f"v{value}"

    # Fallback: last modified time of app/template files (stable until next code change).
    tracked_files = [Path(__file__), Path(__file__).parent / "templates" / "index.html"]
    latest_mtime = max(file_path.stat().st_mtime for file_path in tracked_files if file_path.exists())
    return datetime.fromtimestamp(latest_mtime).strftime("v%Y.%m.%d-%H%M%S")

oauth = OAuth(app)
if AUTH_ENABLED:
    oauth.register(
        name="google",
        client_id=GOOGLE_CLIENT_ID,
        client_secret=GOOGLE_CLIENT_SECRET,
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": GOOGLE_OAUTH_SCOPE},
    )


def _is_valid_job_id(job_id: str) -> bool:
    return bool(JOB_ID_RE.fullmatch(job_id))


def _is_http_url(value: str) -> bool:
    parsed = urlparse((value or "").strip())
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _is_logged_in() -> bool:
    return bool(session.get("user"))


def _auth_response():
    if request.path.startswith("/api/") or request.path.startswith("/start") or request.path.startswith("/status") or request.path.startswith("/download"):
        return jsonify({"ok": False, "error": "Please login with Google first."}), 401
    return redirect(url_for("login", next=request.path))


@app.after_request
def _apply_api_cors(response):
    if API_CORS_ORIGIN and request.path.startswith("/api/"):
        response.headers["Access-Control-Allow-Origin"] = API_CORS_ORIGIN
        response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Credentials"] = "true"
    return response


def login_required(func):
    @wraps(func)
    def wrapped(*args, **kwargs):
        if not AUTH_REQUIRED:
            return func(*args, **kwargs)
        if _is_logged_in():
            return func(*args, **kwargs)
        return _auth_response()

    return wrapped


def _to_job_relative(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(PROJECT_ROOT.resolve()))
    except ValueError:
        return str(path)


def _format_hhmmss(seconds: float) -> str:
    total_seconds = max(0, int(seconds))
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60
    return f"{hours:02d}{minutes:02d}{secs:02d}"


def _get_stem_path(job: dict, stem_key: str) -> Path | None:
    stem_root = job.get("stem_root")
    stem_file = job.get("stem_files", {}).get(stem_key)
    if not stem_root or not stem_file:
        return None
    stem_path = Path(stem_root) / stem_file
    if not stem_path.exists():
        return None
    return stem_path


def _ensure_pitch_variant(stem_path: Path, job_id: str, semitones: int) -> Path:
    pitch_root = JOB_ROOT / job_id / "pitch_cache"
    pitch_root.mkdir(parents=True, exist_ok=True)
    sign = "p" if semitones >= 0 else "m"
    variant_name = f"{stem_path.stem}_pitch_{sign}{abs(semitones):02d}{stem_path.suffix.lower()}"
    output_path = pitch_root / variant_name
    if output_path.exists():
        return output_path

    probe_cmd = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=sample_rate",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(stem_path),
    ]
    probe_result = subprocess.run(probe_cmd, capture_output=True, text=True)
    sample_rate = 44100
    if probe_result.returncode == 0:
        try:
            probed_rate = int((probe_result.stdout or "").strip())
            if probed_rate > 0:
                sample_rate = probed_rate
        except ValueError:
            sample_rate = 44100

    pitch_factor = math.pow(2.0, semitones / 12.0)
    atempo_factor = 1.0 / pitch_factor
    ffmpeg_filter = (
        f"asetrate={sample_rate}*{pitch_factor:.10f},"
        f"aresample={sample_rate},"
        f"atempo={atempo_factor:.10f}"
    )
    command = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(stem_path),
        "-filter:a",
        ffmpeg_filter,
    ]
    suffix = stem_path.suffix.lower()
    if suffix == ".mp3":
        command.extend(["-codec:a", "libmp3lame", "-b:a", "320k"])
    elif suffix == ".wav":
        command.extend(["-codec:a", "pcm_s16le"])
    command.append(str(output_path))
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0 or not output_path.exists():
        raise RuntimeError(result.stderr.strip() or "Pitch render failed.")
    return output_path


def _resolve_stem_paths(job: dict) -> dict[str, Path]:
    stem_root = job.get("stem_root", "")
    stem_files = job.get("stem_files", {})
    if not stem_root or not isinstance(stem_files, dict):
        return {}
    resolved: dict[str, Path] = {}
    for key, filename in stem_files.items():
        if not STEM_KEY_RE.fullmatch(str(key)):
            continue
        path = Path(stem_root) / str(filename)
        if path.exists():
            resolved[str(key)] = path
    return resolved


@app.get("/")
@login_required
def index():
    ui_version = _resolve_ui_version()
    return render_template("index.html", ui_version=ui_version, current_user=session.get("user"))


@app.get("/login")
def login():
    if not AUTH_REQUIRED:
        return redirect(url_for("index"))
    if _is_logged_in():
        return redirect(url_for("index"))
    return render_template("login.html", auth_enabled=AUTH_ENABLED)


@app.get("/auth/google")
def auth_google():
    if not AUTH_REQUIRED or not AUTH_ENABLED:
        return redirect(url_for("login"))
    app.logger.info("google_login_start ip=%s next=%s", request.remote_addr, request.args.get("next", ""))
    _write_login_event("google_login_start", next=request.args.get("next", ""))
    session["next_url"] = request.args.get("next") or url_for("index")
    redirect_uri = url_for("auth_google_callback", _external=True, _scheme="https")
    return oauth.google.authorize_redirect(redirect_uri, prompt="select_account")


@app.get("/auth/google/callback")
def auth_google_callback():
    if not AUTH_REQUIRED or not AUTH_ENABLED:
        return redirect(url_for("login"))
    try:
        token = oauth.google.authorize_access_token()
        userinfo = token.get("userinfo")
        if not userinfo:
            userinfo = oauth.google.userinfo()
        email = (userinfo.get("email") or "").strip()
        name = (userinfo.get("name") or "").strip()
        if not name and email:
            name = email.split("@", 1)[0]
        session["user"] = {
            "name": name or "User",
            "email": email,
        }
        app.logger.info(
            "google_login_success email=%s name=%s ip=%s",
            email or "-",
            (name or "User"),
            request.remote_addr,
        )
        _write_login_event("google_login_success", email=email, name=(name or "User"))
        next_url = session.pop("next_url", url_for("index"))
        return redirect(next_url)
    except Exception as exc:
        app.logger.exception("google_login_failed ip=%s error=%s", request.remote_addr, exc)
        _write_login_event("google_login_failed", error=str(exc))
        return redirect(url_for("login"))


@app.get("/logout")
def logout():
    if not AUTH_REQUIRED:
        return redirect(url_for("index"))
    current_user = session.get("user", {})
    app.logger.info(
        "user_logout email=%s name=%s ip=%s",
        current_user.get("email", "-"),
        current_user.get("name", "-"),
        request.remote_addr,
    )
    _write_login_event(
        "user_logout",
        email=current_user.get("email", ""),
        name=current_user.get("name", ""),
    )
    session.pop("user", None)
    return redirect(url_for("login"))


@app.get("/api/v1/auth/session")
def api_auth_session():
    return jsonify(
        {
            "ok": True,
            "auth_required": AUTH_REQUIRED,
            "auth_enabled": AUTH_ENABLED,
            "logged_in": _is_logged_in(),
            "user": session.get("user", {}),
        }
    )


@app.route("/api/v1/<path:_>", methods=["OPTIONS"])
def api_options(_):
    return ("", 204)


@app.get("/ui-icon/download-stem")
def download_stem_icon():
    icon_path = Path(__file__).parent / "templates" / "download_stem.png"
    if not icon_path.exists():
        abort(404)
    return send_file(icon_path, mimetype="image/png")


@app.get("/ui-icon/download-loop")
def download_loop_icon():
    icon_path = Path(__file__).parent / "templates" / "download_loop.png"
    if not icon_path.exists():
        abort(404)
    return send_file(icon_path, mimetype="image/png")


@app.get("/ui-icon/download-all")
def download_all_icon():
    icon_path = Path(__file__).parent / "templates" / "download_all.png"
    if not icon_path.exists():
        abort(404)
    return send_file(icon_path, mimetype="image/png")


@app.get("/ui-icon/zoom-in")
def zoom_in_icon():
    icon_path = Path(__file__).parent / "templates" / "zoom-in.png"
    if not icon_path.exists():
        abort(404)
    return send_file(icon_path, mimetype="image/png")


@app.get("/ui-icon/zoom-out")
def zoom_out_icon():
    icon_path = Path(__file__).parent / "templates" / "zoom-out.png"
    if not icon_path.exists():
        abort(404)
    return send_file(icon_path, mimetype="image/png")


@app.get("/ui-icon/brand")
def brand_icon():
    icon_path = Path(__file__).parent / "templates" / "StemSplitter.png"
    if not icon_path.exists():
        abort(404)
    return send_file(icon_path, mimetype="image/png")


def _update_job(job_id: str, **kwargs):
    job_snapshot = None
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].update(kwargs)
            if kwargs.get("status") in {"completed", "failed"} or "mixer_state" in kwargs:
                job_snapshot = dict(jobs[job_id])
    if job_snapshot:
        _persist_job_snapshot(job_id, job_snapshot)


def _job_progress(job_id: str) -> int:
    with jobs_lock:
        if job_id in jobs:
            return int(jobs[job_id].get("progress", 0))
    return 0


def _write_job_log(log_path: Path, line: str):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(f"[{timestamp}] {line}\n")


def _write_login_event(event: str, **details):
    LOGIN_ROOT.mkdir(parents=True, exist_ok=True)
    log_path = LOGIN_ROOT / f"{datetime.now().strftime('%Y%m%d')}.log"
    payload = {
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "event": event,
        "ip": request.remote_addr,
        "path": request.path,
        "method": request.method,
        "user_agent": request.user_agent.string,
        "session_user": session.get("user", {}),
        "details": details,
    }
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=True) + "\n")


def _job_dir(job_id: str) -> Path:
    return JOB_ROOT / job_id


def _job_meta_path(job_id: str) -> Path:
    return _job_dir(job_id) / JOB_META_NAME


def _persist_job_snapshot(job_id: str, job: dict):
    try:
        job_dir = _job_dir(job_id)
        job_dir.mkdir(parents=True, exist_ok=True)
        snapshot = {
            "job_id": job_id,
            "status": job.get("status", "queued"),
            "progress": int(job.get("progress", 0)),
            "message": job.get("message", ""),
            "stems": job.get("stems", {}),
            "stem_files": job.get("stem_files", {}),
            "stem_root": job.get("stem_root", ""),
            "zip_file": job.get("zip_file", ""),
            "source_file": job.get("source_file", ""),
            "output_format": job.get("output_format", "mp3"),
            "separation_mode": job.get("separation_mode", "full"),
            "job_type": job.get("job_type", "split"),
            "project_name": job.get("project_name", ""),
            "mixer_state": job.get("mixer_state", {}),
            "created_at": job.get("created_at", ""),
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        }
        temp_path = _job_meta_path(job_id).with_suffix(".json.tmp")
        with temp_path.open("w", encoding="utf-8") as handle:
            json.dump(snapshot, handle, ensure_ascii=True, indent=2)
        temp_path.replace(_job_meta_path(job_id))
    except Exception:
        app.logger.exception("failed_to_persist_job_snapshot job_id=%s", job_id)


def _infer_job_from_disk(job_id: str) -> dict | None:
    job_dir = _job_dir(job_id)
    if not job_dir.exists():
        return None

    source_file = ""
    source_candidates = sorted(job_dir.glob("source_*.*"), key=lambda item: item.stat().st_mtime, reverse=True)
    if source_candidates:
        source_file = source_candidates[0].name

    zip_file = ""
    zip_candidates = sorted(job_dir.glob("*_stems_*.zip"), key=lambda item: item.stat().st_mtime, reverse=True)
    if zip_candidates:
        zip_file = zip_candidates[0].name

    stem_lookup: dict[str, Path] = {}
    for stem_path in sorted(job_dir.glob("output/**/*.*")):
        suffix = stem_path.suffix.lower()
        if suffix not in {".mp3", ".wav"}:
            continue
        key = stem_path.stem.lower()
        if key not in {"vocals", "bass", "drums", "other", "no_vocals"}:
            continue
        normalized = "others" if key == "other" else key
        current = stem_lookup.get(normalized)
        if current is None or stem_path.stat().st_mtime > current.stat().st_mtime:
            stem_lookup[normalized] = stem_path

    stem_files = {key: path.name for key, path in stem_lookup.items()}
    stems = {key: path.name for key, path in stem_lookup.items()}
    stem_root = str(next(iter(stem_lookup.values())).parent.resolve()) if stem_lookup else ""

    project_name = ""
    if zip_file and "_stems_" in zip_file:
        project_name = zip_file.split("_stems_", 1)[0]
    elif source_file:
        project_name = Path(source_file).stem
    elif stem_lookup:
        first = next(iter(stem_lookup.values()))
        project_name = first.parent.name or first.stem

    meta_path = _job_meta_path(job_id)
    updated_at = datetime.fromtimestamp(job_dir.stat().st_mtime).isoformat(timespec="seconds")
    if meta_path.exists():
        updated_at = datetime.fromtimestamp(meta_path.stat().st_mtime).isoformat(timespec="seconds")

    return {
        "job_id": job_id,
        "status": "completed" if (stem_files or source_file) else "queued",
        "progress": 100 if (stem_files or source_file) else 0,
        "message": "Project loaded from history.",
        "stems": stems,
        "stem_files": stem_files,
        "stem_root": stem_root,
        "zip_file": zip_file,
        "source_file": source_file,
        "output_format": "mp3",
        "separation_mode": "full",
        "job_type": "split" if stem_files else "download_only",
        "project_name": project_name,
        "created_at": "",
        "updated_at": updated_at,
    }


def _normalize_job(job_id: str, job: dict) -> dict:
    normalized = dict(job)
    normalized["job_id"] = job_id
    normalized["status"] = normalized.get("status", "queued")
    normalized["progress"] = int(normalized.get("progress", 0))
    normalized["message"] = normalized.get("message", "")
    normalized["stems"] = normalized.get("stems", {})
    normalized["stem_files"] = normalized.get("stem_files", {})
    normalized["stem_root"] = normalized.get("stem_root", "")
    normalized["zip_file"] = normalized.get("zip_file", "")
    normalized["source_file"] = normalized.get("source_file", "")
    normalized["job_type"] = normalized.get("job_type", "split")
    normalized["project_name"] = normalized.get("project_name", "")
    normalized["mixer_state"] = normalized.get("mixer_state", {})
    normalized["created_at"] = normalized.get("created_at", "")
    normalized["updated_at"] = normalized.get("updated_at", "")

    if normalized["stem_files"]:
        normalized["stem_urls"] = {key: f"/api/v1/jobs/{job_id}/stems/{key}/stream" for key in normalized["stem_files"]}
        normalized["stem_download_urls"] = {
            key: f"/api/v1/jobs/{job_id}/stems/{key}/download" for key in normalized["stem_files"]
        }
    else:
        normalized["stem_urls"] = normalized.get("stem_urls", {})
        normalized["stem_download_urls"] = normalized.get("stem_download_urls", {})

    normalized["download_url"] = ""
    if normalized["zip_file"] and (_job_dir(job_id) / normalized["zip_file"]).exists():
        normalized["download_url"] = f"/api/v1/jobs/{job_id}/download"

    normalized["source_download_url"] = ""
    if normalized["source_file"] and (_job_dir(job_id) / normalized["source_file"]).exists():
        normalized["source_download_url"] = f"/api/v1/jobs/{job_id}/source"
    return normalized


def _normalize_mixer_state(payload: dict, valid_keys: set[str]) -> dict:
    if not isinstance(payload, dict):
        return {}

    try:
        tempo_pct = int(float(payload.get("tempo_pct", 100)))
    except (TypeError, ValueError):
        tempo_pct = 100
    try:
        pitch_semitones = int(float(payload.get("pitch_semitones", 0)))
    except (TypeError, ValueError):
        pitch_semitones = 0

    tempo_pct = max(50, min(150, tempo_pct))
    pitch_semitones = max(-12, min(12, pitch_semitones))

    def _safe_float(value):
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return None
        if not math.isfinite(parsed):
            return None
        return parsed

    loop_start = _safe_float(payload.get("loop_start"))
    loop_end = _safe_float(payload.get("loop_end"))
    if loop_start is not None and loop_start < 0:
        loop_start = 0.0
    if loop_end is not None and loop_end < 0:
        loop_end = 0.0
    if loop_start is not None and loop_end is not None and loop_end <= loop_start:
        loop_start = None
        loop_end = None

    tracks_payload = payload.get("tracks", {})
    normalized_tracks = {}
    if isinstance(tracks_payload, dict):
      for key, track_payload in tracks_payload.items():
        if key not in valid_keys or not isinstance(track_payload, dict):
            continue
        try:
            volume = float(track_payload.get("volume", 1.0))
        except (TypeError, ValueError):
            volume = 1.0
        volume = max(0.0, min(2.0, volume))
        markers_payload = track_payload.get("markers", [])
        normalized_markers = []
        if isinstance(markers_payload, list):
            for marker in markers_payload:
                if not isinstance(marker, dict):
                    continue
                label = str(marker.get("label", "")).strip()[:120]
                marker_time = _safe_float(marker.get("time"))
                if not label or marker_time is None or marker_time < 0:
                    continue
                normalized_markers.append(
                    {
                        "id": str(marker.get("id") or uuid.uuid4().hex),
                        "label": label,
                        "time": round(marker_time, 3),
                    }
                )
        normalized_tracks[key] = {
            "muted": bool(track_payload.get("muted", False)),
            "volume": volume,
            "markers": normalized_markers,
        }

    return {
        "tempo_pct": tempo_pct,
        "pitch_semitones": pitch_semitones,
        "loop_start": round(loop_start, 3) if loop_start is not None else None,
        "loop_end": round(loop_end, 3) if loop_end is not None else None,
        "loop_enabled": bool(payload.get("loop_enabled", False)),
        "tracks": normalized_tracks,
    }


def _normalize_project_title(value: str) -> str:
    title = " ".join(str(value or "").strip().split())
    return title[:120]


def _get_job(job_id: str) -> dict | None:
    with jobs_lock:
        in_memory = jobs.get(job_id)
    if in_memory:
        return _normalize_job(job_id, in_memory)

    meta_path = _job_meta_path(job_id)
    if meta_path.exists():
        try:
            with meta_path.open("r", encoding="utf-8") as handle:
                loaded = json.load(handle)
            normalized = _normalize_job(job_id, loaded)
            with jobs_lock:
                jobs[job_id] = dict(normalized)
            return normalized
        except Exception:
            app.logger.exception("failed_to_load_job_snapshot job_id=%s", job_id)

    inferred = _infer_job_from_disk(job_id)
    if inferred:
        normalized = _normalize_job(job_id, inferred)
        with jobs_lock:
            jobs[job_id] = dict(normalized)
        return normalized
    return None


def _quality_profile(quality_level: int) -> dict:
    if quality_level <= 33:
        return {"model": "mdx_q", "shifts": 1, "overlap": 0.10, "segment": 6, "mp3_preset": 7}
    if quality_level <= 66:
        return {"model": "htdemucs", "shifts": 1, "overlap": 0.25, "segment": 7, "mp3_preset": 4}
    return {"model": "htdemucs_ft", "shifts": 2, "overlap": 0.35, "segment": 7, "mp3_preset": 2}


def _download_source_audio_for_job(job_id: str, source_url: str, job_dir: Path, log_path: Path) -> Path | None:
    _update_job(
        job_id,
        status="running",
        progress=3,
        message="Downloading audio from link...",
        log_file=_to_job_relative(log_path),
    )
    _write_job_log(log_path, f"Source URL: {source_url}")

    downloader = YtDlpVideoDownloader(
        audio_only=True,
        audio_format="mp3",
        audio_quality="0",
        allow_playlists=False,
        quiet=True,
    )
    _write_job_log(
        log_path,
        "Video downloader initialized. Cookie config: "
        f"YTDLP_COOKIES_FILE={'set' if os.getenv('YTDLP_COOKIES_FILE') else 'unset'}, "
        f"YTDLP_COOKIES_B64={'set' if os.getenv('YTDLP_COOKIES_B64') else 'unset'}.",
    )
    try:
        downloaded = downloader.download(source_url, job_dir)
    except VideoDownloadError as exc:
        _write_job_log(log_path, f"Downloader diagnostics: {downloader.diagnostics_summary()}")
        _write_job_log(log_path, f"Download failed: {exc}")
        _update_job(job_id, status="failed", message="Failed to download audio from link.", progress=100)
        return None

    if not downloaded:
        _write_job_log(log_path, f"Downloader diagnostics: {downloader.diagnostics_summary()}")
        _write_job_log(log_path, "Download produced no files.")
        _update_job(job_id, status="failed", message="No downloadable media found at that link.", progress=100)
        return None

    _write_job_log(log_path, f"Downloader diagnostics: {downloader.diagnostics_summary()}")
    selected = downloaded[0]
    project_title = _normalize_project_title(selected.title or "")
    downloaded_path = selected.file_path.resolve()
    if not downloaded_path.exists():
        _write_job_log(log_path, f"Downloaded file missing: {downloaded_path}")
        _update_job(job_id, status="failed", message="Downloaded audio file was not found.", progress=100)
        return None

    suffix = downloaded_path.suffix.lower() or ".mp3"
    source_timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_title = re.sub(r"[^a-zA-Z0-9._-]+", "_", (selected.title or "source")).strip("._-")
    safe_title = (safe_title or "source")[:80]
    source_name = f"source_{source_timestamp}_{safe_title}{suffix}"
    source_path = job_dir / source_name
    if downloaded_path != source_path:
        try:
            downloaded_path.replace(source_path)
        except OSError:
            shutil.copy2(downloaded_path, source_path)
    else:
        source_path = downloaded_path

    if not source_path.exists():
        _write_job_log(log_path, f"Downloaded source file missing after rename: {source_path}")
        _update_job(job_id, status="failed", message="Downloaded audio file was not found.", progress=100)
        return None

    _write_job_log(log_path, f"Downloaded source file: {source_path}")
    _update_job(
        job_id,
        source_file=source_path.name,
        source_download_url=f"/api/v1/jobs/{job_id}/source",
        project_name=project_title,
    )
    return source_path


def _run_demucs_job(job_id: str, input_path: Path, output_path: Path, original_name: str, options: dict):
    log_path = input_path.parent / "job.log"
    started_at = time.monotonic()
    try:
        profile = _quality_profile(int(options.get("quality_level", 50)))
        separation_mode = options.get("separation_mode", "full")
        output_format = options.get("output_format", "mp3")

        command = [
            sys.executable,
            "-m",
            "demucs",
            "-n",
            profile["model"],
            "--shifts",
            str(profile["shifts"]),
            "--overlap",
            f"{profile['overlap']:.2f}",
            "--segment",
            str(int(profile["segment"])),
            "-o",
            str(output_path),
        ]
        if separation_mode == "vocals":
            command.append("--two-stems=vocals")
        if output_format == "mp3":
            command.extend(
                [
                    "--mp3",
                    "--mp3-bitrate",
                    "320",
                    "--mp3-preset",
                    str(profile["mp3_preset"]),
                ]
            )
        command.append(str(input_path))

        _write_job_log(log_path, f"Input file: {input_path}")
        _write_job_log(log_path, f"Command: {' '.join(command)}")
        _update_job(job_id, status="running", progress=5, message="Starting separation...", log_file=_to_job_relative(log_path))

        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        while True:
            line = process.stdout.readline()
            if not line and process.poll() is not None:
                break
            if not line:
                time.sleep(0.1)
                continue

            line = line.rstrip("\n")
            _write_job_log(log_path, line)

            if "Selected model is a bag" in line:
                _update_job(job_id, progress=max(_job_progress(job_id), 15), message="Model initialized.")
            if "Separating track" in line:
                _update_job(job_id, progress=max(_job_progress(job_id), 25), message="Separating stems...")

            percent_match = PROGRESS_RE.search(line)
            if percent_match:
                pct = int(percent_match.group(1))
                mapped_pct = min(95, 25 + int(pct * 0.7))
                _update_job(job_id, progress=max(_job_progress(job_id), mapped_pct), message="Separating stems...")

        return_code = process.wait()
        if return_code != 0:
            _write_job_log(log_path, f"Separation exited with code {return_code}.")
            _update_job(job_id, status="failed", message="Separation failed. Check job.log in job folder.", progress=100)
            return

        _update_job(job_id, progress=max(_job_progress(job_id), 98), message="Packaging ZIP...")

        song_name = input_path.stem
        stem_root = output_path / profile["model"] / song_name
        if not stem_root.exists():
            possible_roots = list((output_path / profile["model"]).glob("*"))
            if possible_roots:
                stem_root = possible_roots[0]
        if not stem_root.exists():
            model_roots = list(output_path.glob("*/*"))
            if model_roots:
                stem_root = model_roots[0]

        stems = {}
        stem_files = {}
        original_stem = Path(original_name).stem
        zip_timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        zip_filename = f"{original_stem}_stems_{zip_timestamp}.zip"
        zip_path = input_path.parent / zip_filename
        extension = ".mp3" if output_format == "mp3" else ".wav"
        target_stems = ["vocals", "bass", "drums", "other"]
        if separation_mode == "vocals":
            target_stems = ["vocals", "no_vocals"]

        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zip_file:
            for stem in target_stems:
                stem_file = stem_root / f"{stem}{extension}"
                if stem_file.exists():
                    stem_suffix = "others" if stem == "other" else stem
                    output_stem_name = f"{original_stem}_{stem_suffix}{extension}"
                    stems[stem_suffix] = output_stem_name
                    stem_files[stem_suffix] = stem_file.name
                    zip_file.write(stem_file, arcname=output_stem_name)

        if not stems:
            _write_job_log(log_path, "No stem files found after separation run.")
            _update_job(job_id, status="failed", message="No stem files found.", progress=100)
            return

        _write_job_log(log_path, f"Created ZIP: {zip_path}")
        existing_job = _get_job(job_id) or {}
        project_name = _normalize_project_title(existing_job.get("project_name", ""))
        if not project_name:
            project_name = original_stem or Path(original_name).stem or "Untitled project"
        _update_job(
            job_id,
            status="completed",
            progress=100,
            message=f"Split completed for {original_name} in {round(time.monotonic() - started_at, 1)} seconds.",
            stems=stems,
            stem_root=str(stem_root.resolve()),
            stem_files=stem_files,
            stem_urls={key: f"/api/v1/jobs/{job_id}/stems/{key}/stream" for key in stem_files},
            stem_download_urls={key: f"/api/v1/jobs/{job_id}/stems/{key}/download" for key in stem_files},
            zip_file=zip_filename,
            log_file=_to_job_relative(log_path),
            download_url=f"/api/v1/jobs/{job_id}/download",
            project_name=project_name,
            updated_at=datetime.now().isoformat(timespec="seconds"),
        )
    except Exception as exc:
        _write_job_log(log_path, f"Unexpected error: {exc}")
        _update_job(job_id, status="failed", message="Unexpected server error.", progress=100)


def _run_url_demucs_job(job_id: str, source_url: str, job_dir: Path, output_path: Path, options: dict):
    log_path = job_dir / "job.log"
    source_path = _download_source_audio_for_job(job_id, source_url, job_dir, log_path)
    if source_path is None:
        return

    suffix = source_path.suffix.lower() or ".mp3"
    input_path = job_dir / f"input{suffix}"
    try:
        shutil.copy2(source_path, input_path)
    except OSError:
        _write_job_log(log_path, f"Failed to prepare input from downloaded file: {source_path}")
        _update_job(job_id, status="failed", message="Could not prepare downloaded audio for processing.", progress=100)
        return

    _write_job_log(log_path, f"Prepared Demucs input: {input_path}")
    _run_demucs_job(job_id, input_path, output_path, source_path.name, options)


def _run_url_download_only_job(job_id: str, source_url: str, job_dir: Path):
    log_path = job_dir / "job.log"
    started_at = time.monotonic()
    source_path = _download_source_audio_for_job(job_id, source_url, job_dir, log_path)
    if source_path is None:
        return

    elapsed = round(time.monotonic() - started_at, 1)
    _write_job_log(log_path, f"Download-only job completed in {elapsed} seconds.")
    existing_job = _get_job(job_id) or {}
    project_name = _normalize_project_title(existing_job.get("project_name", ""))
    if not project_name:
        project_name = Path(source_path).stem
    _update_job(
        job_id,
        status="completed",
        progress=100,
        message=f"MP3 download ready in {elapsed} seconds.",
        source_file=source_path.name,
        source_download_url=f"/api/v1/jobs/{job_id}/source",
        project_name=project_name,
        updated_at=datetime.now().isoformat(timespec="seconds"),
    )


@app.post("/api/v1/jobs")
@app.post("/start")
@login_required
def start_split():
    uploaded_file = request.files.get("audio_file")
    source_url = (request.form.get("source_url") or "").strip()
    has_uploaded_file = bool(uploaded_file and uploaded_file.filename)
    has_source_url = bool(source_url)
    if not has_uploaded_file and not has_source_url:
        return jsonify({"ok": False, "error": "Upload an audio file or paste a video URL."}), 400
    if has_source_url and not _is_http_url(source_url):
        return jsonify({"ok": False, "error": "Invalid URL. Use a full http(s) link."}), 400

    url_action = request.form.get("url_action", "split")
    if url_action not in {"split", "download_only"}:
        return jsonify({"ok": False, "error": "Invalid URL action."}), 400
    if has_uploaded_file:
        url_action = "split"

    separation_mode = request.form.get("separation_mode", "full")
    if separation_mode not in {"full", "vocals"}:
        return jsonify({"ok": False, "error": "Invalid separation mode."}), 400
    output_format = request.form.get("output_format", "mp3")
    if output_format not in {"mp3", "wav"}:
        return jsonify({"ok": False, "error": "Invalid output format."}), 400
    try:
        quality_level = int(request.form.get("quality_level", "50"))
    except ValueError:
        return jsonify({"ok": False, "error": "Invalid quality setting."}), 400
    quality_level = max(0, min(100, quality_level))

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    job_id = f"{timestamp}_{uuid.uuid4().hex}"
    job_dir = JOB_ROOT / job_id
    output_path = job_dir / "output"
    JOB_ROOT.mkdir(parents=True, exist_ok=True)
    job_dir.mkdir(parents=True, exist_ok=True)
    input_path = None
    original_name = ""
    job_type = "download_only" if has_source_url and url_action == "download_only" else "split"
    initial_message = "Preparing MP3 download..." if job_type == "download_only" else "Preparing link download..."
    if has_uploaded_file:
        suffix = Path(uploaded_file.filename).suffix.lower()
        if suffix not in ALLOWED_SUFFIXES:
            return jsonify({"ok": False, "error": "Unsupported file type."}), 400
        input_path = job_dir / f"input{suffix}"
        uploaded_file.save(input_path)
        original_name = Path(uploaded_file.filename).name
        initial_message = "File uploaded. Waiting to start..."

    with jobs_lock:
        now_iso = datetime.now().isoformat(timespec="seconds")
        jobs[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "progress": 1,
            "message": initial_message,
            "stems": {},
            "stem_files": {},
            "stem_urls": {},
            "stem_download_urls": {},
            "stem_root": "",
            "zip_file": "",
            "log_file": "",
            "download_url": "",
            "source_file": "",
            "source_download_url": "",
            "output_format": output_format,
            "separation_mode": separation_mode,
            "job_type": job_type,
            "project_name": Path(original_name).stem if original_name else "",
            "mixer_state": {},
            "created_at": now_iso,
            "updated_at": now_iso,
        }
        initial_snapshot = dict(jobs[job_id])
    _persist_job_snapshot(job_id, initial_snapshot)

    worker_target = _run_demucs_job
    worker_args = (
        job_id,
        input_path,
        output_path,
        original_name,
        {
            "separation_mode": separation_mode,
            "output_format": output_format,
            "quality_level": quality_level,
        },
    )
    if has_source_url:
        if url_action == "download_only":
            worker_target = _run_url_download_only_job
            worker_args = (job_id, source_url, job_dir)
        else:
            worker_target = _run_url_demucs_job
            worker_args = (
                job_id,
                source_url,
                job_dir,
                output_path,
                {
                    "separation_mode": separation_mode,
                    "output_format": output_format,
                    "quality_level": quality_level,
                },
            )

    worker = threading.Thread(
        target=worker_target,
        args=worker_args,
        daemon=True,
    )
    worker.start()
    return jsonify({"ok": True, "job_id": job_id})


@app.get("/api/v1/jobs/<job_id>")
@app.get("/status/<job_id>")
@login_required
def job_status(job_id: str):
    if not _is_valid_job_id(job_id):
        abort(404)
    job = _get_job(job_id)
    if not job:
        abort(404)
    return jsonify(
        {
            "job_id": job.get("job_id", ""),
            "status": job.get("status", "queued"),
            "progress": int(job.get("progress", 0)),
            "message": job.get("message", ""),
            "stems": job.get("stems", {}),
            "stem_urls": job.get("stem_urls", {}),
            "stem_download_urls": job.get("stem_download_urls", {}),
            "download_url": job.get("download_url", ""),
            "source_download_url": job.get("source_download_url", ""),
            "job_type": job.get("job_type", "split"),
            "project_name": job.get("project_name", ""),
            "mixer_state": job.get("mixer_state", {}),
        }
    )


@app.post("/api/v1/jobs/<job_id>/metadata")
@login_required
def save_job_metadata(job_id: str):
    if not _is_valid_job_id(job_id):
        abort(404)
    job = _get_job(job_id)
    if not job:
        abort(404)

    payload = request.get_json(silent=True) or {}
    valid_keys = set(_resolve_stem_paths(job).keys())
    mixer_state = _normalize_mixer_state(payload.get("mixer_state", {}), valid_keys)

    _update_job(
        job_id,
        mixer_state=mixer_state,
        updated_at=datetime.now().isoformat(timespec="seconds"),
    )
    return jsonify({"ok": True, "mixer_state": mixer_state})


@app.patch("/api/v1/jobs/<job_id>")
@login_required
def update_job_details(job_id: str):
    if not _is_valid_job_id(job_id):
        abort(404)
    job = _get_job(job_id)
    if not job:
        abort(404)

    payload = request.get_json(silent=True) or {}
    project_name = _normalize_project_title(payload.get("project_name", ""))
    if not project_name:
        return jsonify({"ok": False, "error": "Project title cannot be empty."}), 400

    updated_at = datetime.now().isoformat(timespec="seconds")
    _update_job(
        job_id,
        project_name=project_name,
        updated_at=updated_at,
    )
    return jsonify({"ok": True, "job_id": job_id, "project_name": project_name, "updated_at": updated_at})


@app.delete("/api/v1/jobs/<job_id>")
@login_required
def delete_job(job_id: str):
    if not _is_valid_job_id(job_id):
        abort(404)

    job_dir = _job_dir(job_id)
    if not job_dir.exists():
        abort(404)

    with jobs_lock:
        jobs.pop(job_id, None)

    shutil.rmtree(job_dir, ignore_errors=False)
    return jsonify({"ok": True, "job_id": job_id})


@app.get("/api/v1/projects")
@login_required
def list_projects():
    JOB_ROOT.mkdir(parents=True, exist_ok=True)
    projects = []
    for job_dir in sorted(JOB_ROOT.iterdir(), key=lambda item: item.stat().st_mtime, reverse=True):
        if not job_dir.is_dir():
            continue
        job_id = job_dir.name
        if not _is_valid_job_id(job_id):
            continue
        job = _get_job(job_id)
        if not job:
            continue
        if job.get("job_type") != "split":
            continue
        stem_files = job.get("stem_files", {})
        if not stem_files:
            continue
        project_name = (job.get("project_name") or "").strip()
        if not project_name:
            source_name = (job.get("source_file") or "").strip()
            project_name = Path(source_name).stem if source_name else f"Project {job_id[:8]}"
        updated_at = job.get("updated_at") or datetime.fromtimestamp(job_dir.stat().st_mtime).isoformat(timespec="seconds")
        projects.append(
            {
                "job_id": job_id,
                "name": project_name,
                "updated_at": updated_at,
                "stem_count": len(stem_files),
            }
        )

    projects.sort(key=lambda item: item.get("updated_at", ""), reverse=True)
    return jsonify({"ok": True, "projects": projects[:200]})


@app.get("/api/v1/jobs/<job_id>/download")
@app.get("/download/<job_id>")
@login_required
def download_zip(job_id: str):
    if not _is_valid_job_id(job_id):
        abort(404)

    zip_path = None
    job = _get_job(job_id)
    if job and job.get("zip_file"):
        zip_path = JOB_ROOT / job_id / job["zip_file"]

    if zip_path is None or not zip_path.exists():
        candidates = sorted(
            (JOB_ROOT / job_id).glob("*_stems_*.zip"),
            key=lambda item: item.stat().st_mtime,
            reverse=True,
        )
        if candidates:
            zip_path = candidates[0]

    if zip_path is None:
        zip_path = JOB_ROOT / job_id / "stems.zip"
    if not zip_path.exists():
        abort(404)
    return send_file(zip_path, as_attachment=True, download_name=zip_path.name)


@app.get("/api/v1/jobs/<job_id>/source")
@app.get("/download-source/<job_id>")
@login_required
def download_source(job_id: str):
    if not _is_valid_job_id(job_id):
        abort(404)

    source_path = None
    job = _get_job(job_id)
    if job and job.get("source_file"):
        candidate = JOB_ROOT / job_id / str(job["source_file"])
        if candidate.exists():
            source_path = candidate

    if source_path is None:
        candidates = sorted((JOB_ROOT / job_id).glob("source_*.*"), key=lambda item: item.stat().st_mtime, reverse=True)
        if candidates:
            source_path = candidates[0]

    if source_path is None or not source_path.exists():
        abort(404)
    return send_file(source_path, as_attachment=True, download_name=source_path.name)


@app.get("/api/v1/jobs/<job_id>/stems/<stem_key>/stream")
@app.get("/stem/<job_id>/<stem_key>")
@login_required
def stream_stem(job_id: str, stem_key: str):
    if not _is_valid_job_id(job_id) or not STEM_KEY_RE.fullmatch(stem_key):
        abort(404)
    job = _get_job(job_id)
    if not job:
        abort(404)
    stem_path = _get_stem_path(job, stem_key)
    if not stem_path:
        abort(404)

    pitch_value = request.args.get("pitch")
    if pitch_value is None:
        return send_file(stem_path)
    try:
        semitones = int(float(pitch_value))
    except ValueError:
        abort(400)
    if semitones < -12 or semitones > 12:
        abort(400)
    if semitones == 0:
        return send_file(stem_path)
    try:
        variant_path = _ensure_pitch_variant(stem_path, job_id, semitones)
    except RuntimeError:
        abort(500)
    return send_file(variant_path)


@app.get("/api/v1/jobs/<job_id>/stems/<stem_key>/download")
@app.get("/download-stem/<job_id>/<stem_key>")
@login_required
def download_stem(job_id: str, stem_key: str):
    if not _is_valid_job_id(job_id) or not STEM_KEY_RE.fullmatch(stem_key):
        abort(404)
    job = _get_job(job_id)
    if not job:
        abort(404)
    stem_path = _get_stem_path(job, stem_key)
    if not stem_path:
        abort(404)
    download_name = job.get("stems", {}).get(stem_key, stem_path.name)
    return send_file(stem_path, as_attachment=True, download_name=download_name)


@app.post("/api/v1/jobs/<job_id>/mix-download")
@login_required
def download_mix(job_id: str):
    if not _is_valid_job_id(job_id):
        abort(404)
    job = _get_job(job_id)
    if not job:
        abort(404)

    stem_paths = _resolve_stem_paths(job)
    if not stem_paths:
        return jsonify({"ok": False, "error": "No stem files available for this project."}), 400

    payload = request.get_json(silent=True) or {}
    tracks_payload = payload.get("tracks", {})
    if not isinstance(tracks_payload, dict):
        return jsonify({"ok": False, "error": "Invalid track settings."}), 400

    try:
        tempo_pct = int(float(payload.get("tempo_pct", 100)))
        pitch_semitones = int(float(payload.get("pitch_semitones", 0)))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Invalid tempo or pitch setting."}), 400

    tempo_pct = max(50, min(150, tempo_pct))
    pitch_semitones = max(-12, min(12, pitch_semitones))
    tempo_ratio = tempo_pct / 100.0

    valid_keys = sorted(stem_paths.keys())
    normalized_tracks: dict[str, dict] = {}
    for key in valid_keys:
        track_cfg = tracks_payload.get(key, {})
        if not isinstance(track_cfg, dict):
            track_cfg = {}
        muted = bool(track_cfg.get("muted", False))
        try:
            volume = float(track_cfg.get("volume", 1.0))
        except (TypeError, ValueError):
            volume = 1.0
        volume = max(0.0, min(2.0, volume))
        normalized_tracks[key] = {"muted": muted, "volume": volume}

    mix_signature_payload = {
        "tempo_pct": tempo_pct,
        "pitch_semitones": pitch_semitones,
        "tracks": normalized_tracks,
    }
    mix_signature = hashlib.sha1(
        json.dumps(mix_signature_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:12]

    mixes_dir = JOB_ROOT / job_id / "mixes"
    mixes_dir.mkdir(parents=True, exist_ok=True)
    output_name = f"mix_{mix_signature}.mp3"
    output_path = mixes_dir / output_name

    if not output_path.exists():
        active_inputs: list[Path] = []
        for key in valid_keys:
            cfg = normalized_tracks[key]
            if cfg["muted"] or cfg["volume"] <= 0:
                continue
            source_path = stem_paths[key]
            if pitch_semitones != 0:
                source_path = _ensure_pitch_variant(source_path, job_id, pitch_semitones)
            active_inputs.append(source_path)

        if not active_inputs:
            return jsonify({"ok": False, "error": "All tracks are muted."}), 400

        command = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
        for input_path in active_inputs:
            command.extend(["-i", str(input_path)])

        filter_parts = []
        mapped_labels = []
        for index, key in enumerate([k for k in valid_keys if not normalized_tracks[k]["muted"] and normalized_tracks[k]["volume"] > 0]):
            cfg = normalized_tracks[key]
            chain = f"[{index}:a]volume={cfg['volume']:.4f}"
            if abs(tempo_ratio - 1.0) > 1e-9:
                chain += f",atempo={tempo_ratio:.6f}"
            chain += f"[a{index}]"
            filter_parts.append(chain)
            mapped_labels.append(f"[a{index}]")

        mix_chain = (
            f"{''.join(mapped_labels)}amix=inputs={len(mapped_labels)}:dropout_transition=0:normalize=0,"
            "alimiter=limit=0.95[outa]"
        )
        filter_parts.append(mix_chain)
        command.extend(
            [
                "-filter_complex",
                ";".join(filter_parts),
                "-map",
                "[outa]",
                "-codec:a",
                "libmp3lame",
                "-b:a",
                "320k",
                str(output_path),
            ]
        )

        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0 or not output_path.exists():
            app.logger.error("mix_render_failed job_id=%s error=%s", job_id, (result.stderr or "").strip())
            return jsonify({"ok": False, "error": "Failed to render mixed audio."}), 500

    project_name = (job.get("project_name") or "").strip() or f"project_{job_id[:8]}"
    safe_name = re.sub(r"[^a-zA-Z0-9._-]+", "_", project_name).strip("._-") or f"project_{job_id[:8]}"
    download_name = f"{safe_name}_mix.mp3"
    return send_file(output_path, as_attachment=True, download_name=download_name)


@app.get("/api/v1/jobs/<job_id>/stems/<stem_key>/loop")
@app.get("/download-loop/<job_id>/<stem_key>")
@login_required
def download_stem_loop(job_id: str, stem_key: str):
    if not _is_valid_job_id(job_id) or not STEM_KEY_RE.fullmatch(stem_key):
        abort(404)
    job = _get_job(job_id)
    if not job:
        abort(404)

    stem_root = job.get("stem_root")
    stem_file = job.get("stem_files", {}).get(stem_key)
    if not stem_root or not stem_file:
        abort(404)
    stem_path = Path(stem_root) / stem_file
    if not stem_path.exists():
        abort(404)

    try:
        start = float(request.args.get("start", "0"))
        end = float(request.args.get("end", "0"))
    except ValueError:
        abort(400)
    if start < 0 or end <= start:
        abort(400)

    loops_dir = JOB_ROOT / job_id / "loops"
    loops_dir.mkdir(parents=True, exist_ok=True)
    stem_name = job.get("stems", {}).get(stem_key, stem_path.name)
    stem_base = Path(stem_name).stem
    suffix = stem_path.suffix.lower()
    start_stamp = _format_hhmmss(start)
    end_stamp = _format_hhmmss(end)
    output_name = f"{stem_base}_loop_{start_stamp}_{end_stamp}{suffix}"
    output_path = loops_dir / output_name

    command = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        f"{start:.3f}",
        "-to",
        f"{end:.3f}",
        "-i",
        str(stem_path),
    ]
    if suffix == ".mp3":
        command.extend(["-codec:a", "libmp3lame", "-b:a", "320k"])
    elif suffix == ".wav":
        command.extend(["-codec:a", "pcm_s16le"])
    else:
        command.extend(["-codec:a", "copy"])
    command.append(str(output_path))

    proc = subprocess.run(command, capture_output=True, text=True)
    if proc.returncode != 0 or not output_path.exists():
        abort(500)

    return send_file(output_path, as_attachment=True, download_name=output_name)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5001"))
    app.run(host="0.0.0.0", port=port, debug=False)
