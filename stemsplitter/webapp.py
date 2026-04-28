import io
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import uuid
import zipfile
import math
import shutil
import tempfile
import logging
import json
import hashlib
from shutil import disk_usage, which
from functools import wraps
from datetime import datetime
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from authlib.integrations.flask_client import OAuth
from flask import Flask, abort, jsonify, redirect, render_template, request, send_file, session, url_for
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash

LITE_MODE = os.getenv("LITE_MODE", "false").strip().lower() in {"1", "true", "yes", "on"}

if __package__:
    from . import admin_config
    from . import bpm as bpm_detector
    from . import key_detection as key_detector
    from . import db as app_db
    from . import marker_detection as _marker_detector
    if not LITE_MODE:
        from .video_downloader import VideoDownloadError, YtDlpVideoDownloader
        from . import cache as stem_cache
else:
    import admin_config
    import bpm as bpm_detector
    import key_detection as key_detector
    import db as app_db
    import marker_detection as _marker_detector
    if not LITE_MODE:
        from video_downloader import VideoDownloadError, YtDlpVideoDownloader
        import cache as stem_cache


app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "change-this-dev-secret")
app.logger.setLevel(logging.INFO)
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)  # type: ignore[assignment]
app.config["PREFERRED_URL_SCHEME"] = "https"

# Sub-path prefix support (e.g. APP_PREFIX=/stemsplitter)
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
    app.wsgi_app = _prefix_middleware  # type: ignore[assignment]
PROJECT_ROOT = Path(__file__).resolve().parent.parent
JOB_ROOT = Path(os.getenv("WEB_JOBS_ROOT", str(PROJECT_ROOT / "web_jobs")))
LOGIN_ROOT = Path(os.getenv("WEB_LOGINS_ROOT", str(PROJECT_ROOT / "web_logins")))
JOB_ROOT.mkdir(parents=True, exist_ok=True)
if not LITE_MODE:
    stem_cache.init(JOB_ROOT / "stem_cache.db")
admin_config.init(JOB_ROOT / "admin_config.json")
_gauth_db_path = Path(os.getenv("APP_DB_PATH", str(JOB_ROOT / "gauth.db")))
app_db.init(_gauth_db_path)

# Comma-separated Google emails that are always treated as admin.
# E.g.  ADMIN_EMAILS=me@gmail.com,partner@gmail.com
_ADMIN_EMAILS: set[str] = {
    e.strip().lower()
    for e in os.getenv("ADMIN_EMAILS", "").split(",")
    if e.strip()
}
JOB_META_NAME = "job.json"
ALLOWED_SUFFIXES = {".mp3", ".mpe", ".wav", ".flac", ".m4a", ".aac", ".ogg"}
SHARE_TOKENS_FILE = JOB_ROOT / "share_tokens.json"
_share_lock = threading.Lock()
PROGRESS_RE = re.compile(r"(\d{1,3})%\|")
jobs = {}
jobs_mtime: dict[str, float] = {}   # job_id -> mtime of job.json when last loaded
jobs_lock = threading.Lock()
# Maps job_id -> running subprocess.Popen so cancel can terminate it
job_processes: dict[str, subprocess.Popen] = {}
job_processes_lock = threading.Lock()
JOB_ID_RE = re.compile(r"(?:[0-9a-f]{32}|[0-9]{8}_[0-9]{6}_[0-9a-f]{32})")
STEM_KEY_RE = re.compile(r"[a-z_]{1,24}")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "").strip()
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "").strip()
AUTH_ENABLED = bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)
AUTH_REQUIRED = os.getenv("REQUIRE_GOOGLE_LOGIN", "false").strip().lower() in {"1", "true", "yes", "on"}
# Google doesn't expose "name-only" scope; profile is needed for a reliable display name.
GOOGLE_OAUTH_SCOPE = os.getenv("GOOGLE_OAUTH_SCOPE", "openid email profile").strip() or "openid email profile"
API_CORS_ORIGIN = os.getenv("API_CORS_ORIGIN", "").strip()


def _detect_compute_device() -> str:
    try:
        import torch
        if torch.cuda.is_available():
            return f"GPU ({torch.cuda.get_device_name(0)})"
    except Exception:
        pass
    return "CPU"

COMPUTE_DEVICE = _detect_compute_device()
APP_STARTED_AT = datetime.now()


def _migrate_jobs_to_db() -> None:
    """
    One-time background migration: scan JOB_ROOT and populate app.db with any
    projects not yet indexed. Safe to run on every startup — upsert is idempotent.
    Also stores source_url from job.json so URL-based dedup works for legacy jobs.
    """
    try:
        indexed = 0
        for job_dir in JOB_ROOT.iterdir():
            if not job_dir.is_dir():
                continue
            job_id = job_dir.name
            if not _is_valid_job_id(job_id):
                continue
            # Skip if already indexed and recently updated
            existing = app_db.get_project(job_id)
            if existing and existing.get("updated_at", "") > "2020":
                continue
            job = _get_job(job_id)
            if not job:
                continue
            name = (job.get("project_name") or "").strip()
            if not name:
                sf = (job.get("source_file") or "").strip()
                name = Path(sf).stem if sf else f"Project {job_id[:8]}"
            app_db.upsert_project(
                job_id=job_id,
                name=name,
                source_url=(job.get("source_url") or "").strip(),
                source_file=(job.get("source_file") or "").strip(),
                status=job.get("status", "queued"),
                stem_count=len(job.get("stem_files") or {}),
                folder=(job.get("folder") or "").strip(),
                created_at=job.get("created_at") or "",
                updated_at=job.get("updated_at") or "",
            )
            # Grant access to all existing users for every legacy project
            app_db.grant_access_to_all_users(job_id)
            indexed += 1
        if indexed:
            app.logger.info("db_migration indexed=%d legacy projects", indexed)
    except Exception:
        app.logger.exception("db_migration failed")


def _reset_stale_jobs() -> None:
    """
    On startup, any job that was left in 'running' or 'queued' state from a previous
    server run will never complete — the processing threads are gone. Mark them failed
    so they don't appear stuck in the UI forever.
    """
    try:
        stale_statuses = {"running", "queued"}
        reset = 0
        if JOB_ROOT.exists():
            for job_dir in JOB_ROOT.iterdir():
                if not job_dir.is_dir():
                    continue
                job_id = job_dir.name
                if not _is_valid_job_id(job_id):
                    continue
                meta_path = job_dir / JOB_META_NAME
                if not meta_path.exists():
                    continue
                try:
                    data = json.loads(meta_path.read_text())
                    if data.get("status") in stale_statuses:
                        data["status"] = "failed"
                        data["message"] = "Interrupted — server was restarted while this job was in progress."
                        meta_path.write_text(json.dumps(data))
                        app_db.upsert_project(
                            job_id=job_id,
                            name=data.get("project_name") or f"Project {job_id[:8]}",
                            source_url=(data.get("source_url") or "").strip(),
                            source_file=(data.get("source_file") or "").strip(),
                            status="failed",
                            stem_count=len(data.get("stem_files") or {}),
                            folder=(data.get("folder") or "").strip(),
                            created_at=data.get("created_at") or "",
                            updated_at=data.get("updated_at") or "",
                        )
                        reset += 1
                except Exception:
                    pass
        # Also sweep DB for running/queued records whose directory no longer exists
        all_projects, _ = app_db.list_all_projects(limit=10000)
        for p in all_projects:
            if p.get("status") in stale_statuses:
                job_id = p["job_id"]
                if not _job_dir(job_id).exists():
                    app_db.upsert_project(
                        job_id=job_id,
                        name=p.get("name") or f"Project {job_id[:8]}",
                        source_url=p.get("source_url") or "",
                        source_file=p.get("source_file") or "",
                        status="failed",
                        stem_count=p.get("stem_count") or 0,
                        folder=p.get("folder") or "",
                        created_at=p.get("created_at") or "",
                        updated_at=p.get("updated_at") or "",
                    )
                    reset += 1

        if reset:
            app.logger.info("startup_reset stale_jobs=%d", reset)
    except Exception:
        app.logger.exception("startup reset of stale jobs failed")


# Run migration and stale-job reset in background so startup is not delayed
threading.Thread(target=_migrate_jobs_to_db, daemon=True).start()
threading.Thread(target=_reset_stale_jobs, daemon=True).start()


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


def _resolve_build_timestamp() -> str:
    for key in (
        "APP_DEPLOYED_AT",
        "RELEASE_CREATED_AT",
        "BUILD_TIMESTAMP",
        "SOURCE_DATE_EPOCH",
    ):
        value = os.getenv(key, "").strip()
        if not value:
            continue
        if key == "SOURCE_DATE_EPOCH":
            try:
                return datetime.fromtimestamp(int(value)).isoformat(timespec="seconds")
            except Exception:
                continue
        return value

    tracked_files = [Path(__file__), Path(__file__).parent / "templates" / "index.html"]
    latest_mtime = max(file_path.stat().st_mtime for file_path in tracked_files if file_path.exists())
    return datetime.fromtimestamp(latest_mtime).isoformat(timespec="seconds")


def _format_uptime_seconds(total_seconds: float) -> str:
    total = max(0, int(total_seconds))
    hours, remainder = divmod(total, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes}m {seconds}s"
    if minutes:
        return f"{minutes}m {seconds}s"
    return f"{seconds}s"

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


def _current_user_db() -> Optional[dict]:
    """Return the unified users-table row for the session user (Google or local)."""
    user = session.get("user", {})
    # Local auth: id is 'local:<local_id>'
    if user.get("auth_type") == "local":
        uid = user.get("sub", "")
        if uid:
            return app_db.get_user_by_sub(uid)
        return None
    # Google auth
    sub = user.get("sub")
    if sub:
        return app_db.get_user_by_sub(sub)
    email = user.get("email", "").strip().lower()
    if email:
        return app_db.get_user_by_email(email)
    return None


def _is_admin() -> bool:
    """True if the current session user has admin role."""
    user = session.get("user", {})
    # Fast path: role stored in session
    if user.get("role") == "admin":
        return True
    # Google users: also check ADMIN_EMAILS
    email = user.get("email", "").strip().lower()
    if email and email in _ADMIN_EMAILS:
        return True
    db_user = _current_user_db()
    return bool(db_user and db_user.get("role") == "admin")


def _is_contributor() -> bool:
    """True if the current session user has contributor role (but not admin)."""
    if _is_admin():
        return False
    user = session.get("user", {})
    if user.get("role") == "contributor":
        return True
    db_user = _current_user_db()
    return bool(db_user and db_user.get("role") == "contributor")


def _can_edit_content() -> bool:
    """True if the user may write to canonical job.json (admin or contributor)."""
    return _is_admin() or _is_contributor()


def _current_user_id() -> Optional[str]:
    """Return the stable unified user id for the current session."""
    db_user = _current_user_db()
    return db_user["id"] if db_user else None


def _has_job_access(job_id: str) -> bool:
    """Return True if the current session has read access to this job."""
    if not AUTH_REQUIRED:
        return True
    if _is_admin():
        return True
    user_id = _current_user_id()
    if not user_id:
        return False
    # Check in-memory for in-flight jobs (not yet in DB)
    with jobs_lock:
        job = jobs.get(job_id)
        if job and job.get("created_by") == user_id:
            return True
    # Check DB (direct access or group membership)
    return app_db.has_access(job_id, user_id)


# ─── Password validation ──────────────────────────────────────────────────────

_PW_SPECIAL = r"""!@#$%^&*()_+\-=\[\]{}|;':",./<>?"""

def validate_password(password: str) -> Optional[str]:
    """Return an error message string, or None if the password is valid."""
    if len(password) < 8:
        return "Password must be at least 8 characters."
    if not re.search(r"[A-Z]", password):
        return "Password must contain at least one uppercase letter."
    if not re.search(r"[a-z]", password):
        return "Password must contain at least one lowercase letter."
    if not re.search(r"\d", password):
        return "Password must contain at least one number."
    if not re.search(rf"[{_PW_SPECIAL}]", password):
        return "Password must contain at least one special character (!@#$%^&* etc.)."
    return None


def _auth_response():
    if request.path.startswith("/api/") or request.path.startswith("/start") or request.path.startswith("/status") or request.path.startswith("/download"):
        return jsonify({"ok": False, "error": "Login required."}), 401
    # request.path is the Flask-internal path (prefix stripped, e.g. "/" for "/stemsplitter/").
    # The browser needs the full browser-visible path so the post-login redirect works correctly.
    browser_path = (_APP_PREFIX + request.path) if _APP_PREFIX else request.path
    return redirect(url_for("login", next=browser_path))


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


def admin_required(func):
    """Allow only users with admin role (or in ADMIN_EMAILS)."""
    @wraps(func)
    def wrapped(*args, **kwargs):
        if not AUTH_REQUIRED:
            return func(*args, **kwargs)
        if not _is_logged_in():
            return _auth_response()
        if not _is_admin():
            return jsonify({"ok": False, "error": "Admin access required."}), 403
        return func(*args, **kwargs)
    return wrapped


def full_mode_only(func):
    """Return 503 in LITE_MODE — route requires split/analyse capabilities."""
    @wraps(func)
    def wrapped(*args, **kwargs):
        if LITE_MODE:
            return jsonify({"ok": False, "error": "This server runs in lite mode. Splitting and analysis are not available."}), 503
        return func(*args, **kwargs)
    return wrapped


def _to_job_relative(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(PROJECT_ROOT.resolve()))
    except ValueError:
        return str(path)


def _with_app_prefix(path: str) -> str:
    return f"{_APP_PREFIX}{path}" if _APP_PREFIX else path


def _format_hhmmss(seconds: float) -> str:
    total_seconds = max(0, int(seconds))
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60
    return f"{hours:02d}{minutes:02d}{secs:02d}"


def _describe_job_root_storage() -> dict:
    resolved = JOB_ROOT.resolve()
    text = str(resolved)
    env_value = os.getenv("WEB_JOBS_ROOT", "").strip()
    parts = resolved.parts
    mount_anchors = {
        "/Volumes",
        "/mnt",
        "/media",
        "/net",
    }
    is_mounted_path = any(
        len(parts) >= 2 and f"{parts[0]}{parts[1]}" == anchor
        for anchor in mount_anchors
    )
    if not is_mounted_path and text.startswith("//"):
        is_mounted_path = True

    if is_mounted_path:
        storage_type = "NAS / mounted volume"
    else:
        storage_type = "Local folder"

    if env_value:
        config_source = "WEB_JOBS_ROOT env var"
    else:
        config_source = "Default app folder"

    return {
        "job_root": text,
        "job_root_storage_type": storage_type,
        "job_root_config_source": config_source,
    }


def _find_job_zip_path(job_id: str, job: dict | None = None) -> Path | None:
    if job and job.get("zip_file"):
        candidate = JOB_ROOT / job_id / str(job["zip_file"])
        if candidate.exists():
            return candidate
    candidates = sorted(
        (JOB_ROOT / job_id).glob("*_stems_*.zip"),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    if candidates:
        return candidates[0]
    fallback = JOB_ROOT / job_id / "stems.zip"
    if fallback.exists():
        return fallback
    return None


def _ensure_stems_available(job_id: str, job: dict) -> str:
    stem_files = job.get("stem_files", {})
    if not isinstance(stem_files, dict) or not stem_files:
        return ""

    stem_root = str(job.get("stem_root", "") or "").strip()
    if stem_root:
        all_present = True
        for filename in stem_files.values():
            if not (Path(stem_root) / str(filename)).exists():
                all_present = False
                break
        if all_present:
            return stem_root

    zip_path = _find_job_zip_path(job_id, job)
    if zip_path is None:
        return ""

    restored_root = JOB_ROOT / job_id / "restored_stems"
    restored_root.mkdir(parents=True, exist_ok=True)

    try:
        with zipfile.ZipFile(zip_path) as archive:
            # Build a lookup by exact filename AND by stem suffix
            # ZIP often names files like "songname_vocals.mp3" while stem_files has "vocals.mp3"
            archive_names = {Path(name).name: name for name in archive.namelist()}
            extracted_any = False
            extracted_map: dict[str, str] = {}  # stem_key → extracted filename
            for stem_key, stem_filename in stem_files.items():
                bare_name = Path(stem_filename).name
                # 1. Exact match
                member_name = archive_names.get(bare_name)
                # 2. Fallback: find archive entry whose stem ends with _{stem_key}
                if not member_name:
                    member_name = next(
                        (n for n in archive_names
                         if Path(n).stem.lower().endswith(f"_{stem_key}")
                         or Path(n).stem.lower() == stem_key),
                        None,
                    )
                if not member_name:
                    continue
                # Use the actual archive filename as the output filename
                out_name = Path(member_name).name
                output_path = restored_root / out_name
                if output_path.exists():
                    extracted_any = True
                    extracted_map[stem_key] = out_name
                    continue
                with archive.open(member_name) as source, output_path.open("wb") as target:
                    shutil.copyfileobj(source, target)
                extracted_any = True
                extracted_map[stem_key] = out_name
    except Exception:
        app.logger.exception("failed_to_restore_stems job_id=%s zip=%s", job_id, zip_path)
        return ""

    if not extracted_any:
        return ""

    # Use the actual extracted filenames (may differ from stem_files values)
    restored_stem_files = {
        key: extracted_map.get(key, Path(name).name)
        for key, name in stem_files.items()
    }
    restored_stems = {
        key: Path(job.get("stems", {}).get(key, filename)).name
        for key, filename in restored_stem_files.items()
    }
    _update_job(
        job_id,
        stem_root=str(restored_root.resolve()),
        stem_files=restored_stem_files,
        stems=restored_stems,
        updated_at=datetime.now().isoformat(timespec="seconds"),
    )
    return str(restored_root.resolve())


def _get_stem_path(job: dict, stem_key: str) -> Path | None:
    job_id = job.get("job_id", "")
    if job_id:
        ensured_root = _ensure_stems_available(job_id, job)
        if ensured_root:
            # Re-read job so we get the updated stem_files written by _ensure_stems_available
            updated_job = _get_job(job_id)
            job = updated_job if updated_job else dict(job)
            job["stem_root"] = ensured_root

    stem_root = job.get("stem_root")
    stem_file = job.get("stem_files", {}).get(stem_key)
    if not stem_root or not stem_file:
        return None
    stem_path = Path(stem_root) / stem_file
    if stem_path.exists():
        return stem_path
    # stem_root may be an absolute path from a different machine (e.g. EC2 vs local).
    # Fall back to resolving relative to JOB_ROOT using the job_id.
    if job_id:
        # Reconstruct the relative portion after the job folder
        stem_root_path = Path(stem_root)
        try:
            # Find the job_id segment and take everything after it
            parts = stem_root_path.parts
            idx = next(i for i, p in enumerate(parts) if p == job_id)
            relative_suffix = Path(*parts[idx + 1:]) if idx + 1 < len(parts) else Path()
            fallback = JOB_ROOT / job_id / relative_suffix / stem_file
        except StopIteration:
            fallback = JOB_ROOT / job_id / stem_file
        if fallback.exists():
            return fallback
    return None


def _load_share_tokens() -> dict:
    try:
        with SHARE_TOKENS_FILE.open() as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_share_tokens(tokens: dict):
    SHARE_TOKENS_FILE.write_text(json.dumps(tokens, indent=2, ensure_ascii=False))


def _get_share_by_token(token: str) -> dict | None:
    return _load_share_tokens().get(token)


def _create_share_token(folder: str, created_by: str) -> str:
    with _share_lock:
        tokens = _load_share_tokens()
        # Re-use existing token for the same folder
        for t, data in tokens.items():
            if data.get("folder") == folder:
                return t
        token = secrets.token_hex(16)
        tokens[token] = {
            "folder": folder,
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "created_by": created_by,
        }
        _save_share_tokens(tokens)
        return token


def _revoke_share_token(token: str):
    with _share_lock:
        tokens = _load_share_tokens()
        tokens.pop(token, None)
        _save_share_tokens(tokens)


def _ensure_pitch_variant(stem_path: Path, job_id: str, semitones: float) -> Path:
    pitch_root = JOB_ROOT / job_id / "pitch_cache"
    pitch_root.mkdir(parents=True, exist_ok=True)
    sign = "p" if semitones >= 0 else "m"
    # Encode as integer hundredths to avoid dots in filename (e.g. +1.6460 → p00165)
    semitones_hundredths = int(round(abs(semitones) * 100))
    variant_name = f"{stem_path.stem}_pitch_{sign}{semitones_hundredths:05d}{stem_path.suffix.lower()}"
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
    stem_files = job.get("stem_files", {})
    if not isinstance(stem_files, dict):
        return {}
    resolved: dict[str, Path] = {}
    for key in stem_files.keys():
        if not STEM_KEY_RE.fullmatch(str(key)):
            continue
        path = _get_stem_path(job, str(key))
        if path and path.exists():
            resolved[str(key)] = path
    return resolved


@app.get("/")
@login_required
def index():
    ui_version = _resolve_ui_version()
    return render_template("index.html", ui_version=ui_version, compute_device=COMPUTE_DEVICE, current_user=session.get("user"), share_token=None, share_folder=None, lite_mode=LITE_MODE, app_prefix=_APP_PREFIX, is_admin=_is_admin(), is_contributor=_is_contributor())


@app.get("/login")
def login():
    if not AUTH_REQUIRED:
        return redirect(url_for("index"))
    if _is_logged_in():
        return redirect(url_for("index"))
    error = request.args.get("error", "")
    tab = request.args.get("tab", "login")
    return render_template("login.html", auth_enabled=AUTH_ENABLED, error=error, tab=tab)


@app.post("/auth/local/login")
def auth_local_login():
    username = (request.form.get("username") or "").strip().lower()
    password = request.form.get("password") or ""
    _raw_next = (request.form.get("next") or "").strip()
    # If next is a bare Flask-internal path (e.g. "/") without the app prefix,
    # prepend the prefix so the browser lands at the right URL after login.
    if _raw_next and _APP_PREFIX and not _raw_next.startswith(_APP_PREFIX) and not _raw_next.startswith("http"):
        _raw_next = _APP_PREFIX + ("" if _raw_next.startswith("/") else "/") + _raw_next.lstrip("/")
    next_url = _raw_next or url_for("index")
    if not username or not password:
        return redirect(url_for("login", error="Username and password are required.", next=next_url))
    lu = app_db.get_local_user(username)
    if not lu or not lu.get("is_active"):
        return redirect(url_for("login", error="Invalid username or password.", next=next_url))
    if not check_password_hash(lu["password_hash"], password):
        app.logger.warning("local_login_failed username=%s ip=%s", username, request.remote_addr)
        return redirect(url_for("login", error="Invalid username or password.", next=next_url))
    # Upsert into unified users table so project_access works
    unified_id = app_db.local_user_to_unified_id(lu["id"])
    app_db.upsert_user(
        sub=unified_id,
        email=f"{username}@local",
        name=lu.get("name") or username,
        picture="",
        force_role=lu.get("role"),
    )
    app_db.touch_local_user(lu["id"])
    session["user"] = {
        "sub": unified_id,
        "auth_type": "local",
        "local_id": lu["id"],
        "name": lu.get("name") or username,
        "username": username,
        "email": f"{username}@local",
        "picture": "",
        "role": lu.get("role", "user"),
    }
    app.logger.info("local_login_success username=%s role=%s ip=%s", username, lu.get("role"), request.remote_addr)
    return redirect(next_url)


@app.post("/auth/local/register")
def auth_local_register():
    name     = (request.form.get("name") or "").strip()
    username = (request.form.get("username") or "").strip().lower()
    phone    = (request.form.get("phone") or "").strip()
    password = request.form.get("password") or ""
    confirm  = request.form.get("confirm_password") or ""
    next_url = url_for("index")

    def _fail(msg):
        return redirect(url_for("login", error=msg, tab="register"))

    if not name or not username or not password:
        return _fail("Name, username, and password are required.")
    if not re.match(r"^[a-z0-9_]{3,30}$", username):
        return _fail("Username must be 3–30 characters: letters, numbers, underscores only.")
    if app_db.local_username_exists(username):
        return _fail("That username is already taken.")
    if password != confirm:
        return _fail("Passwords do not match.")
    pw_error = validate_password(password)
    if pw_error:
        return _fail(pw_error)

    lu = app_db.create_local_user(
        username=username,
        name=name,
        phone=phone,
        password_hash=generate_password_hash(password),
    )
    # Upsert into unified users table
    unified_id = app_db.local_user_to_unified_id(lu["id"])
    app_db.upsert_user(
        sub=unified_id,
        email=f"{username}@local",
        name=name,
        picture="",
        force_role="user",
    )
    session["user"] = {
        "sub": unified_id,
        "auth_type": "local",
        "local_id": lu["id"],
        "name": name,
        "username": username,
        "email": f"{username}@local",
        "picture": "",
        "role": "user",
    }
    app.logger.info("local_register_success username=%s ip=%s", username, request.remote_addr)
    return redirect(next_url)


@app.post("/api/v1/auth/change-password")
@login_required
def api_change_password():
    user = session.get("user", {})
    if user.get("auth_type") != "local":
        return jsonify({"ok": False, "error": "Password change is only available for local accounts."}), 400
    local_id = user.get("local_id")
    if not local_id:
        return jsonify({"ok": False, "error": "Session error — please log in again."}), 401
    data = request.get_json(silent=True) or {}
    current_pw  = data.get("current_password", "")
    new_pw      = data.get("new_password", "")
    confirm_pw  = data.get("confirm_password", "")
    lu = app_db.get_local_user_by_id(local_id)
    if not lu:
        return jsonify({"ok": False, "error": "User not found."}), 404
    if not check_password_hash(lu["password_hash"], current_pw):
        return jsonify({"ok": False, "error": "Current password is incorrect."}), 400
    if new_pw != confirm_pw:
        return jsonify({"ok": False, "error": "New passwords do not match."}), 400
    pw_error = validate_password(new_pw)
    if pw_error:
        return jsonify({"ok": False, "error": pw_error}), 400
    app_db.update_local_user_password(local_id, generate_password_hash(new_pw))
    app.logger.info("change_password_success username=%s ip=%s", lu.get("username"), request.remote_addr)
    return jsonify({"ok": True, "message": "Password changed successfully."})


@app.get("/auth/google")
def auth_google():
    if not AUTH_REQUIRED or not AUTH_ENABLED:
        return redirect(url_for("login"))
    app.logger.info("google_login_start ip=%s next=%s", request.remote_addr, request.args.get("next", ""))
    _write_login_event("google_login_start", next=request.args.get("next", ""))
    session["next_url"] = request.args.get("next") or url_for("index")
    _scheme = "http" if request.host.startswith(("localhost", "127.0.0.1")) else "https"
    redirect_uri = url_for("auth_google_callback", _external=True, _scheme=_scheme)
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
        picture = (userinfo.get("picture") or "").strip()
        sub = (userinfo.get("sub") or "").strip()
        if not name and email:
            name = email.split("@", 1)[0]

        # Determine role: ADMIN_EMAILS list takes precedence over DB value
        force_role = "admin" if email.lower() in _ADMIN_EMAILS else None
        db_user = app_db.upsert_user(sub, email, name or "User", picture, force_role=force_role)

        session["user"] = {
            "sub": sub,
            "name": db_user.get("name") or name or "User",
            "email": email,
            "picture": picture,
            "role": db_user.get("role", "user"),
        }
        app.logger.info(
            "google_login_success email=%s name=%s role=%s ip=%s",
            email or "-",
            (name or "User"),
            db_user.get("role", "user"),
            request.remote_addr,
        )
        _write_login_event("google_login_success", email=email, name=(name or "User"),
                           role=db_user.get("role", "user"))
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
    user = session.get("user", {})
    user_id = _current_user_id() if _is_logged_in() else None
    effective_settings = app_db.get_effective_settings(user_id) if user_id else {}
    return jsonify(
        {
            "ok": True,
            "auth_required": AUTH_REQUIRED,
            "auth_enabled": AUTH_ENABLED,
            "logged_in": _is_logged_in(),
            "user": user,
            "is_admin": _is_admin() if _is_logged_in() else False,
            "is_contributor": _is_contributor() if _is_logged_in() else False,
            "settings": effective_settings,
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


def _sync_job_to_db(job_id: str, job: dict) -> None:
    """Keep the project index in app.db in sync with job.json."""
    try:
        name = (job.get("project_name") or "").strip()
        if not name:
            sf = (job.get("source_file") or "").strip()
            name = Path(sf).stem if sf else f"Project {job_id[:8]}"
        app_db.upsert_project(
            job_id=job_id,
            name=name,
            source_url=(job.get("source_url") or "").strip(),
            source_file=(job.get("source_file") or "").strip(),
            status=job.get("status", "queued"),
            stem_count=len(job.get("stem_files") or {}),
            folder=(job.get("folder") or "").strip(),
            created_by=job.get("created_by"),
            updated_at=datetime.now().isoformat(timespec="seconds"),
        )
    except Exception:
        app.logger.exception("_sync_job_to_db failed job_id=%s", job_id)


def _update_job(job_id: str, **kwargs):
    job_snapshot = None
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].update(kwargs)
            job_snapshot = dict(jobs[job_id])
    if job_snapshot:
        _persist_job_snapshot(job_id, job_snapshot)
        # Sync index on status changes and metadata saves
        if "status" in kwargs or "project_name" in kwargs or "folder" in kwargs or "mixer_state" in kwargs:
            _sync_job_to_db(job_id, job_snapshot)


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
            "folder": job.get("folder", ""),
            "mixer_state": job.get("mixer_state", {}),
            "created_at": job.get("created_at", ""),
            "updated_at": datetime.now().isoformat(timespec="seconds"),
            "bpm": job.get("bpm"),
            "bpm_segments": job.get("bpm_segments", []),
            "bpm_analyse_status": job.get("bpm_analyse_status"),
            "bpm_analyse_stage": job.get("bpm_analyse_stage"),
            "bpm_analyse_progress": job.get("bpm_analyse_progress"),
            "key": job.get("key"),
            "key_confidence": job.get("key_confidence", 0.0),
            "thaat": job.get("thaat"),
            "thaat_alt": job.get("thaat_alt"),
            "note_timeline": job.get("note_timeline", []),
            "lyrics": job.get("lyrics", []),
        }
        meta_path = _job_meta_path(job_id)
        temp_path = meta_path.with_suffix(".json.tmp")
        with temp_path.open("w", encoding="utf-8") as handle:
            json.dump(snapshot, handle, ensure_ascii=True, indent=2)
        temp_path.replace(meta_path)
        # Record the mtime we just wrote so _get_job doesn't self-evict the cache
        try:
            written_mtime = meta_path.stat().st_mtime
            with jobs_lock:
                jobs_mtime[job_id] = written_mtime
        except OSError:
            pass
    except Exception:
        app.logger.exception("failed_to_persist_job_snapshot job_id=%s", job_id)


def _infer_stems_from_zip(zip_path: Path) -> tuple[dict[str, str], dict[str, str]]:
    stems: dict[str, str] = {}
    stem_files: dict[str, str] = {}
    try:
        with zipfile.ZipFile(zip_path) as archive:
            for name in archive.namelist():
                member = Path(name)
                suffix = member.suffix.lower()
                if suffix not in {".mp3", ".wav"}:
                    continue
                key = member.stem.lower()
                if key.endswith("_other"):
                    key = "other"
                elif "_" in key:
                    key = key.rsplit("_", 1)[-1]
                if key not in {"vocals", "bass", "drums", "other", "others", "no_vocals"}:
                    continue
                normalized = "others" if key == "other" else key
                stems[normalized] = member.name
                stem_files[normalized] = member.name
    except Exception:
        app.logger.exception("failed_to_infer_stems_from_zip path=%s", zip_path)
    return stems, stem_files


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
    if not stem_files and zip_file:
        zip_stems, zip_stem_files = _infer_stems_from_zip(job_dir / zip_file)
        if zip_stem_files:
            stems = zip_stems
            stem_files = zip_stem_files

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
        "status": "completed" if (stem_files or zip_file or source_file) else "queued",
        "progress": 100 if (stem_files or zip_file or source_file) else 0,
        "message": "Project loaded from history.",
        "stems": stems,
        "stem_files": stem_files,
        "stem_root": stem_root,
        "zip_file": zip_file,
        "source_file": source_file,
        "output_format": "mp3",
        "separation_mode": "full",
        "job_type": "split" if (stem_files or zip_file) else "download_only",
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
    normalized["folder"] = normalized.get("folder", "")
    normalized["mixer_state"] = normalized.get("mixer_state", {})
    normalized["created_at"] = normalized.get("created_at", "")
    normalized["updated_at"] = normalized.get("updated_at", "")
    normalized["bpm"] = normalized.get("bpm")
    normalized["bpm_segments"] = normalized.get("bpm_segments", [])
    normalized["bpm_analyse_status"] = normalized.get("bpm_analyse_status")
    normalized["bpm_analyse_stage"] = normalized.get("bpm_analyse_stage")
    normalized["bpm_analyse_progress"] = normalized.get("bpm_analyse_progress")
    normalized["key"] = normalized.get("key")
    normalized["key_confidence"] = normalized.get("key_confidence", 0.0)
    normalized["thaat"] = normalized.get("thaat")
    normalized["thaat_alt"] = normalized.get("thaat_alt")
    normalized["note_timeline"] = normalized.get("note_timeline", [])
    normalized["lyrics"] = normalized.get("lyrics", [])

    if normalized["stem_files"]:
        normalized["stem_urls"] = {
            key: _with_app_prefix(f"/api/v1/jobs/{job_id}/stems/{key}/stream")
            for key in normalized["stem_files"]
        }
        normalized["stem_download_urls"] = {
            key: _with_app_prefix(f"/api/v1/jobs/{job_id}/stems/{key}/download")
            for key in normalized["stem_files"]
        }
    else:
        normalized["stem_urls"] = normalized.get("stem_urls", {})
        normalized["stem_download_urls"] = normalized.get("stem_download_urls", {})

    normalized["download_url"] = ""
    if normalized["zip_file"] and (_job_dir(job_id) / normalized["zip_file"]).exists():
        normalized["download_url"] = _with_app_prefix(f"/api/v1/jobs/{job_id}/download")

    normalized["source_download_url"] = ""
    if normalized["source_file"] and (_job_dir(job_id) / normalized["source_file"]).exists():
        normalized["source_download_url"] = _with_app_prefix(f"/api/v1/jobs/{job_id}/source")
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

    # Language labels for dual-language lyrics
    langs_payload = payload.get("lyrics_langs", {})
    if not isinstance(langs_payload, dict):
        langs_payload = {}
    lyrics_langs = {
        "primary": str(langs_payload.get("primary", "English")).strip()[:40] or "English",
        "alt": str(langs_payload.get("alt", "")).strip()[:40],
    }

    return {
        "tempo_pct": tempo_pct,
        "pitch_semitones": pitch_semitones,
        "loop_start": round(loop_start, 3) if loop_start is not None else None,
        "loop_end": round(loop_end, 3) if loop_end is not None else None,
        "loop_enabled": bool(payload.get("loop_enabled", False)),
        "tracks": normalized_tracks,
        "lyrics_langs": lyrics_langs,
    }


_LYRIC_TYPES = {"lead", "chorus", "music"}

def _normalize_lyrics(payload: list) -> list:
    if not isinstance(payload, list):
        return []
    result = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text", "")).strip()[:500]
        text_alt = str(item.get("text_alt", "")).strip()[:500]
        # Keep the line if it has a timestamp (placeholder) or any text
        raw_time = item.get("time")
        try:
            time_val = float(raw_time) if raw_time is not None else None
            if time_val is not None and (not math.isfinite(time_val) or time_val < 0):
                time_val = None
            if time_val is not None:
                time_val = round(time_val, 3)
        except (TypeError, ValueError):
            time_val = None
        if not text and not text_alt and time_val is None:
            continue
        lyric_type = str(item.get("type", "lead")).strip().lower()
        if lyric_type not in _LYRIC_TYPES:
            lyric_type = "lead"
        result.append({
            "id": str(item.get("id") or uuid.uuid4().hex),
            "text": text,
            "text_alt": text_alt,
            "time": time_val,
            "type": lyric_type,
        })
    return result


def _normalize_project_title(value: str) -> str:
    title = " ".join(str(value or "").strip().split())
    return title[:120]


def _get_job(job_id: str) -> dict | None:
    meta_path = _job_meta_path(job_id)

    # Check if job.json on disk is newer than our cached copy (written by another
    # machine sharing the same NAS). If so, evict the cache so we reload fresh.
    if meta_path.exists():
        try:
            disk_mtime = meta_path.stat().st_mtime
            with jobs_lock:
                cached_mtime = jobs_mtime.get(job_id)
            if cached_mtime is not None and disk_mtime > cached_mtime + 0.5:
                with jobs_lock:
                    jobs.pop(job_id, None)
                    jobs_mtime.pop(job_id, None)
        except OSError:
            pass

    with jobs_lock:
        in_memory = jobs.get(job_id)
    if in_memory:
        return _normalize_job(job_id, in_memory)

    if meta_path.exists():
        try:
            disk_mtime = meta_path.stat().st_mtime
            with meta_path.open("r", encoding="utf-8") as handle:
                loaded = json.load(handle)
            normalized = _normalize_job(job_id, loaded)
            with jobs_lock:
                jobs[job_id] = dict(normalized)
                jobs_mtime[job_id] = disk_mtime
            return normalized
        except Exception:
            app.logger.exception("failed_to_load_job_snapshot job_id=%s", job_id)

    inferred = _infer_job_from_disk(job_id)
    if inferred:
        normalized = _normalize_job(job_id, inferred)
        with jobs_lock:
            jobs[job_id] = dict(normalized)
            jobs_mtime[job_id] = meta_path.stat().st_mtime if meta_path.exists() else 0.0
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

        _write_job_log(log_path, f"Compute device: {COMPUTE_DEVICE}")
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
        with job_processes_lock:
            job_processes[job_id] = process

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

        with job_processes_lock:
            job_processes.pop(job_id, None)

        return_code = process.wait()
        # -15 = SIGTERM (cancelled), treat gracefully
        if return_code == -15 or (_get_job(job_id) or {}).get("status") == "cancelled":
            _write_job_log(log_path, "Job was cancelled.")
            return
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
            job_type="split",
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

        # BPM + key detection — run in background so mixer loads immediately
        _update_job(job_id, bpm_analyse_status="running", bpm_analyse_stage="queued", bpm_analyse_progress=5)
        threading.Thread(target=_run_analyse_job, args=(job_id,), daemon=True).start()
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

    # Write to cache if the job completed successfully
    video_id = stem_cache.extract_video_id(source_url)
    if video_id:
        completed_job = _get_job(job_id) or {}
        if completed_job.get("status") == "completed":
            model = _quality_profile(options.get("quality_level", 50))["model"]
            separation_mode = options.get("separation_mode", "full")
            output_format = options.get("output_format", "mp3")
            cache_key = stem_cache.make_cache_key(video_id, model, separation_mode, output_format)
            stem_cache.insert(cache_key, video_id, model, separation_mode, output_format, job_id)
            app.logger.info("cache_insert job_id=%s video_id=%s", job_id, video_id)


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


@app.post("/api/v1/jobs/bulk")
@login_required
@full_mode_only
def bulk_split():
    data = request.get_json(silent=True) or {}
    urls = data.get("urls", [])
    separation_mode = data.get("separation_mode", "full")
    output_format = data.get("output_format", "mp3")
    if not isinstance(urls, list) or not urls:
        return jsonify({"ok": False, "error": "Provide a list of URLs."}), 400
    if separation_mode not in {"full", "vocals"}:
        return jsonify({"ok": False, "error": "Invalid separation mode."}), 400
    if output_format not in {"mp3", "wav"}:
        return jsonify({"ok": False, "error": "Invalid output format."}), 400
    urls = [u.strip() for u in urls if isinstance(u, str) and u.strip()]
    if not urls:
        return jsonify({"ok": False, "error": "No valid URLs provided."}), 400

    job_ids = []
    queued_jobs: list[tuple[str, str, Path, Path, dict]] = []
    for url in urls:
        if not _is_http_url(url):
            job_ids.append({"url": url, "ok": False, "error": "Invalid URL"})
            continue
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        job_id = f"{timestamp}_{uuid.uuid4().hex}"
        job_dir = JOB_ROOT / job_id
        JOB_ROOT.mkdir(parents=True, exist_ok=True)
        job_dir.mkdir(parents=True, exist_ok=True)
        options = {
            "separation_mode": separation_mode,
            "output_format": output_format,
            "quality_level": 50,
        }
        _update_job(job_id, status="queued", progress=0, message="Queued. Waiting for earlier URLs to finish.", job_type="split",
                    separation_mode=separation_mode, output_format=output_format)
        output_path = job_dir / "output"
        queued_jobs.append((job_id, url, job_dir, output_path, options))
        job_ids.append({"url": url, "ok": True, "job_id": job_id})

    def _run_bulk_queue(items: list[tuple[str, str, Path, Path, dict]]):
        total = len(items)
        for index, (job_id, url, job_dir, output_path, options) in enumerate(items, start=1):
            current = _get_job(job_id) or {}
            if current.get("status") == "cancelled":
                continue
            _update_job(
                job_id,
                status="queued",
                progress=1,
                message=f"Starting queued job {index} of {total}...",
            )
            _run_url_demucs_job(job_id, url, job_dir, output_path, options)

    if queued_jobs:
        threading.Thread(target=_run_bulk_queue, args=(queued_jobs,), daemon=True).start()

    return jsonify({"ok": True, "jobs": job_ids})


@app.get("/api/v1/cookie/check")
@login_required
@full_mode_only
def cookie_check():
    """Quick test of whether the configured YouTube cookies are still valid."""
    downloader = YtDlpVideoDownloader(quiet=True)
    cookie_file, cookie_source, cookie_warning = downloader._resolve_cookie_file()

    if not cookie_file:
        return jsonify({
            "status": "none",
            "message": "No cookies configured — some videos may be blocked.",
            "cookie_source": None,
            "cookie_age_hours": None,
        })

    # Report how old the cookie file is
    try:
        age_hours = round((time.time() - os.path.getmtime(cookie_file)) / 3600, 1)
    except Exception:
        age_hours = None

    # Quick test: metadata-only fetch of a known public video using web_embedded + cookies.
    # Try two videos in sequence; if the first is unavailable (geo/removed) that is NOT a
    # cookie failure — move on to the second.  Only 403 / "Sign in" / bot errors mean bad cookies.
    _COOKIE_TEST_URLS = [
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",   # Rick Astley — very stable
        "https://www.youtube.com/watch?v=9bZkp7q19f0",   # Gangnam Style — fallback
    ]
    ydl_opts: dict = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "cookiefile": cookie_file,
        "extractor_args": {"youtube": {"player_client": ["web_embedded"]}},
        "js_runtimes": {"node": {}},
    }

    def _is_unavailable_error(err_str: str) -> bool:
        """True when the video itself is inaccessible but cookies are fine."""
        low = err_str.lower()
        return (
            "unavailable" in low
            or "this video is not available" in low
            or "error code: 152" in low
            or "has been removed" in low
            or "private video" in low
            or "not supported in this application" in low   # embed-restricted video
            or "watch video on youtube" in low              # embed restriction message
        )

    def _is_auth_error(err_str: str) -> bool:
        """True when YouTube rejected the cookies / requires login."""
        low = err_str.lower()
        return "403" in err_str or "sign in" in low or "bot" in low or "login" in low

    import yt_dlp as _yt_dlp
    status = "invalid"
    message = "Cookie check failed: unknown error."
    for _test_url in _COOKIE_TEST_URLS:
        try:
            with _yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.extract_info(_test_url, download=False)
            # Success — cookies are working
            status = "valid"
            message = "Cookies are valid — ready to download."
            if age_hours is not None and age_hours > 72:
                status = "expiring"
                message = f"Cookies are working but are {int(age_hours // 24)}d old — consider refreshing soon."
            break
        except Exception as exc:
            err = str(exc)
            if _is_unavailable_error(err):
                # Video is geo-blocked or removed — not a cookie problem; try next URL
                continue
            if _is_auth_error(err):
                status = "invalid"
                message = "Cookies are expired or rejected by YouTube. Please upload fresh cookies."
                break
            # Any other error on this URL — try the next one before giving up
            message = f"Cookie check failed: {err[:200]}"
            continue
    else:
        # All test URLs were unavailable; assume cookies are fine (can't prove otherwise)
        if status == "invalid" and message.startswith("Cookie check failed"):
            status = "valid"
            message = "Cookie probe inconclusive (test videos unavailable) — cookies assumed valid."

    return jsonify({
        "status": status,
        "message": message,
        "cookie_source": cookie_source,
        "cookie_age_hours": age_hours,
    })


@app.post("/api/v1/playlist/info")
@login_required
@full_mode_only
def playlist_info():
    """Extract track list from a playlist URL without downloading any audio."""
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    if not url or not _is_http_url(url):
        return jsonify({"ok": False, "error": "Invalid URL."}), 400

    # Resolve cookies via the downloader helper
    downloader = YtDlpVideoDownloader(quiet=True)
    cookie_file, _, _ = downloader._resolve_cookie_file()

    ydl_opts: dict = {
        "extract_flat": True,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": False,
        "js_runtimes": {"node": {}},
    }
    if cookie_file:
        ydl_opts["cookiefile"] = cookie_file

    try:
        import yt_dlp as _yt_dlp
        with _yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:
        return jsonify({"ok": False, "error": f"Could not read playlist: {str(exc)[:300]}"}), 400

    if not info:
        return jsonify({"ok": False, "error": "No info returned for that URL."}), 400

    entries = [e for e in (info.get("entries") or []) if e]
    if not entries:
        return jsonify({"ok": False, "error": "That URL is not a playlist or the playlist is empty."}), 400

    tracks = []
    for i, entry in enumerate(entries):
        video_id = entry.get("id") or ""
        title = (entry.get("title") or entry.get("id") or f"Track {i + 1}").strip()
        duration = entry.get("duration")
        # Flat playlist entries have the video ID in 'url'; prefer webpage_url if present
        track_url = entry.get("webpage_url") or ""
        if not track_url and video_id:
            track_url = f"https://www.youtube.com/watch?v={video_id}"
        if not track_url:
            track_url = entry.get("url") or ""
        if not track_url:
            continue
        tracks.append({
            "index": i + 1,
            "title": title,
            "url": track_url,
            "duration": int(duration) if duration else None,
        })

    if not tracks:
        return jsonify({"ok": False, "error": "No valid tracks found in playlist."}), 400

    playlist_title = (info.get("title") or "Playlist").strip()
    return jsonify({"ok": True, "title": playlist_title, "count": len(tracks), "tracks": tracks})


@app.post("/api/v1/jobs")
@app.post("/start")
@login_required
@full_mode_only
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

    # Cache check: only for URL-based split jobs
    if has_source_url and url_action == "split":
        video_id = stem_cache.extract_video_id(source_url)
        if video_id:
            model = _quality_profile(quality_level)["model"]
            cache_key = stem_cache.make_cache_key(video_id, model, separation_mode, output_format)
            cached_job_id = stem_cache.lookup(cache_key)
            if cached_job_id:
                # Verify the job files still exist on disk
                cached_job_dir = JOB_ROOT / cached_job_id
                cached_meta = cached_job_dir / JOB_META_NAME
                if cached_meta.exists():
                    app.logger.info("cache_hit job_id=%s video_id=%s", cached_job_id, video_id)
                    return jsonify({"ok": True, "job_id": cached_job_id, "cached": True})
                # Files gone — remove stale entry and continue to create a new job
                app.logger.info("cache_stale job_id=%s video_id=%s", cached_job_id, video_id)
                stem_cache.invalidate(cache_key)

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
            "bpm": None,
            "bpm_segments": [],
            "key": None,
            "key_confidence": 0.0,
            "thaat": None,
            "thaat_alt": None,
            "created_by": _current_user_id(),
        }
        initial_snapshot = dict(jobs[job_id])
    _persist_job_snapshot(job_id, initial_snapshot)
    # Ensure the project row exists in DB before granting access (FK requirement)
    creator_id = _current_user_id()
    app_db.upsert_project(
        job_id=job_id,
        name=initial_snapshot.get("project_name", ""),
        source_url=source_url if has_source_url else "",
        source_file=original_name,
        status="queued",
        stem_count=0,
        folder=initial_snapshot.get("folder", ""),
        created_by=creator_id,
        created_at=initial_snapshot.get("created_at", ""),
        updated_at=initial_snapshot.get("updated_at", ""),
    )
    if AUTH_REQUIRED and creator_id:
        app_db.grant_access(job_id, creator_id, granted_by=creator_id)

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
    if not _has_job_access(job_id):
        abort(403)
    normalized = _normalize_job(job_id, job)

    # Regular users (not admin/contributor) get their personal overlay merged on top
    if AUTH_REQUIRED and not _can_edit_content():
        user_id = _current_user_id()
        if user_id:
            overlay = app_db.get_overlay(job_id, user_id)
            if overlay:
                normalized = app_db.merge_overlay(normalized, overlay)

    return jsonify(
        {
            "job_id": normalized.get("job_id", ""),
            "status": normalized.get("status", "queued"),
            "progress": int(normalized.get("progress", 0)),
            "message": normalized.get("message", ""),
            "stems": normalized.get("stems", {}),
            "stem_urls": normalized.get("stem_urls", {}),
            "stem_download_urls": normalized.get("stem_download_urls", {}),
            "download_url": normalized.get("download_url", ""),
            "source_download_url": normalized.get("source_download_url", ""),
            "job_type": normalized.get("job_type", "split"),
            "project_name": normalized.get("project_name", ""),
            "mixer_state": normalized.get("mixer_state", {}),
            "bpm": normalized.get("bpm"),
            "bpm_segments": normalized.get("bpm_segments", []),
            "key": normalized.get("key"),
            "key_confidence": normalized.get("key_confidence", 0.0),
            "thaat": normalized.get("thaat"),
            "thaat_alt": normalized.get("thaat_alt"),
            "note_timeline": normalized.get("note_timeline", []),
            "bpm_analyse_status": normalized.get("bpm_analyse_status"),
            "bpm_analyse_stage": normalized.get("bpm_analyse_stage"),
            "bpm_analyse_progress": normalized.get("bpm_analyse_progress"),
            "lyrics": normalized.get("lyrics", []),
            "is_admin_view": _is_admin() or not AUTH_REQUIRED,
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
    lyrics = _normalize_lyrics(payload.get("lyrics", job.get("lyrics", [])))

    if AUTH_REQUIRED and not _can_edit_content():
        # Regular users: write to user overlay, leave job.json untouched
        user_id = _current_user_id()
        if user_id:
            app_db.save_overlay(job_id, user_id, {
                "mixer_state": mixer_state,
                "lyrics": lyrics,
            })
        return jsonify({"ok": True, "mixer_state": mixer_state, "lyrics": lyrics,
                        "saved_as": "overlay"})

    # Admin (or auth not required): write to canonical job.json
    _update_job(
        job_id,
        mixer_state=mixer_state,
        lyrics=lyrics,
        updated_at=datetime.now().isoformat(timespec="seconds"),
    )
    # Keep the project index in sync
    app_db.upsert_project(
        job_id,
        name=job.get("project_name") or "",
        source_url=job.get("source_url") or "",
        source_file=job.get("source_file") or "",
        status=job.get("status", "completed"),
        stem_count=len(job.get("stem_files") or {}),
        folder=job.get("folder") or "",
        updated_at=datetime.now().isoformat(timespec="seconds"),
    )
    return jsonify({"ok": True, "mixer_state": mixer_state, "lyrics": lyrics,
                    "saved_as": "canonical"})


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


@app.post("/api/v1/jobs/<job_id>/auto-markers")
@login_required
def auto_detect_markers(job_id: str):
    """Analyse stems and return suggested markers per stem."""
    if not _is_valid_job_id(job_id):
        abort(404)
    if not _has_job_access(job_id):
        abort(403)
    job = _get_job(job_id)
    if not job:
        abort(404)
    if job.get("status") != "completed":
        return jsonify({"ok": False, "error": "Job not complete yet."}), 400

    stem_files = job.get("stem_files") or {}
    if not stem_files:
        return jsonify({"ok": False, "error": "No stem files available."}), 400

    # Re-fetch job after potential restore so stem_root is always valid
    stem_root = _ensure_stems_available(job_id, job)
    if not stem_root:
        return jsonify({"ok": False, "error": "Stem files not found. The job may need to be re-processed."}), 400

    # Re-read stem_files in case they were updated by _ensure_stems_available
    job = _get_job(job_id) or job
    stem_files = job.get("stem_files") or stem_files

    # Read optional tuning params from request body
    body = request.get_json(silent=True) or {}
    params = {
        "silence_top_db":           float(body.get("silence_top_db", 40)),
        "min_vocal_duration":       float(body.get("min_vocal_duration", 2.0)),
        "min_silence_before_start": float(body.get("min_silence_before_start", 0.75)),
    }

    # Copy only the stems librosa needs (vocals + others) to local /tmp so
    # analysis doesn't run over a slow NAS/SMB mount.
    _MARKER_STEMS = {"vocals", "no_vocals", "others", "other"}
    local_tmp = Path(tempfile.mkdtemp(prefix=f"markers_{job_id}_"))
    local_stem_files = {}
    try:
        for key, filename in stem_files.items():
            if key not in _MARKER_STEMS:
                continue
            src = Path(stem_root) / filename
            if not src.exists():
                continue
            dst = local_tmp / filename
            shutil.copy2(str(src), str(dst))
            local_stem_files[key] = filename

        if not local_stem_files:
            # Fallback: run directly from NAS if copy failed
            local_tmp_root = stem_root
            local_stem_files = stem_files
        else:
            local_tmp_root = str(local_tmp)

        try:
            suggested = _marker_detector.detect_markers_for_job(local_tmp_root, local_stem_files, params=params)
        except Exception as exc:
            app.logger.exception("auto_detect_markers failed job_id=%s", job_id)
            return jsonify({"ok": False, "error": str(exc)}), 500
    finally:
        shutil.rmtree(str(local_tmp), ignore_errors=True)

    return jsonify({"ok": True, "markers": suggested})


@app.patch("/api/v1/jobs/<job_id>/folder")
@login_required
def set_job_folder(job_id: str):
    """Assign or clear the logical folder for a project."""
    if not _is_valid_job_id(job_id):
        abort(404)
    if not _get_job(job_id):
        abort(404)
    payload = request.get_json(silent=True) or {}
    folder = str(payload.get("folder", "")).strip()[:100]
    _update_job(job_id, folder=folder)
    return jsonify({"ok": True, "job_id": job_id, "folder": folder})


@app.delete("/api/v1/jobs/<job_id>")
@login_required
@admin_required
def delete_job(job_id: str):
    if not _is_valid_job_id(job_id):
        abort(404)

    # Require either a job directory on disk OR a DB record — not necessarily both
    job_dir = _job_dir(job_id)
    db_record = app_db.get_project(job_id)
    if not job_dir.exists() and not db_record:
        abort(404)

    with jobs_lock:
        jobs.pop(job_id, None)

    if job_dir.exists():
        shutil.rmtree(job_dir, ignore_errors=True)
    app_db.delete_project(job_id)
    return jsonify({"ok": True, "job_id": job_id})


@app.post("/api/v1/jobs/<job_id>/cancel")
@login_required
@full_mode_only
def cancel_job(job_id: str):
    if not _is_valid_job_id(job_id):
        abort(404)

    job = _get_job(job_id)
    if not job:
        abort(404)

    status = job.get("status", "")
    if status not in {"queued", "running"}:
        return jsonify({"ok": False, "error": f"Job is already {status}."}), 409

    # Mark cancelled first so the worker thread exits cleanly
    _update_job(job_id, status="cancelled", progress=100, message="Cancelled by user.")

    # Terminate the demucs subprocess if it's running
    with job_processes_lock:
        proc = job_processes.pop(job_id, None)
    if proc and proc.poll() is None:
        proc.terminate()

    app.logger.info("job_cancelled job_id=%s", job_id)
    return jsonify({"ok": True, "job_id": job_id})


def _run_analyse_job(job_id: str):
    """Background worker: run BPM + key detection on existing stems."""
    job = _get_job(job_id)
    if not job:
        return

    stem_root_str = _ensure_stems_available(job_id, job) or job.get("stem_root", "")
    if not stem_root_str:
        app.logger.warning("analyse_job: no stem_root for job_id=%s", job_id)
        _update_job(job_id, bpm_analyse_status="failed", bpm_analyse_stage="error", bpm_analyse_progress=100)
        return

    stem_root = Path(stem_root_str)
    extension = ".mp3" if job.get("output_format", "mp3") == "mp3" else ".wav"

    drums_path  = stem_root / f"drums{extension}"
    vocals_path = stem_root / f"vocals{extension}"
    others_path = stem_root / f"other{extension}"
    if not others_path.exists():
        others_path = stem_root / f"others{extension}"

    # Source file fallback
    source_file = job.get("source_file", "")
    source_path = (JOB_ROOT / job_id / source_file) if source_file else None
    if source_path and not source_path.exists():
        candidates = sorted((JOB_ROOT / job_id).glob("source_*.*"),
                            key=lambda p: p.stat().st_mtime, reverse=True)
        source_path = candidates[0] if candidates else None

    try:
        _update_job(job_id, bpm_analyse_status="running", bpm_analyse_stage="bpm", bpm_analyse_progress=15)
        bpm_result = bpm_detector.detect(drums_path, fallback_path=source_path)
        _update_job(job_id, bpm_analyse_status="running", bpm_analyse_stage="key", bpm_analyse_progress=55)
        key_result = key_detector.detect(
            vocals_path=vocals_path,
            others_path=others_path if others_path.exists() else None,
            source_path=source_path,
        )
        note_timeline = []
        if key_result.get("tonic") and vocals_path.exists():
            _update_job(job_id, bpm_analyse_status="running", bpm_analyse_stage="notes", bpm_analyse_progress=80)
            note_timeline = key_detector.detect_note_timeline(
                vocals_path=vocals_path,
                tonic_note=key_result["tonic"],
                tonic_hz=key_result.get("tonic_hz"),
            )
        _update_job(
            job_id,
            bpm=bpm_result.get("bpm"),
            bpm_segments=bpm_result.get("segments", []),
            key=key_result.get("label"),
            key_confidence=key_result.get("confidence", 0.0),
            thaat=key_result.get("thaat"),
            thaat_alt=key_result.get("thaat_alt"),
            note_timeline=note_timeline,
            bpm_analyse_status="done",
            bpm_analyse_stage="done",
            bpm_analyse_progress=100,
            updated_at=datetime.now().isoformat(timespec="seconds"),
        )
        app.logger.info("analyse_job done job_id=%s bpm=%s key=%s",
                        job_id, bpm_result.get("bpm"), key_result.get("label"))
    except Exception as exc:
        app.logger.exception("analyse_job failed job_id=%s: %s", job_id, exc)
        _update_job(job_id, bpm_analyse_status="failed", bpm_analyse_stage="error", bpm_analyse_progress=100)


@app.post("/api/v1/jobs/<job_id>/analyse")
@login_required
def analyse_job(job_id: str):
    """(Re-)run BPM and key detection on an already-completed job."""
    if not _is_valid_job_id(job_id):
        abort(404)
    job = _get_job(job_id)
    if not job:
        abort(404)
    if job.get("status") != "completed":
        return jsonify({"ok": False, "error": "Job is not completed yet."}), 409
    if job.get("bpm_analyse_status") == "running":
        return jsonify({"ok": True, "job_id": job_id, "status": "already_running"})

    _update_job(job_id, bpm_analyse_status="running", bpm_analyse_stage="queued", bpm_analyse_progress=5)
    threading.Thread(target=_run_analyse_job, args=(job_id,), daemon=True).start()
    return jsonify({"ok": True, "job_id": job_id, "status": "started"})


@app.get("/api/v1/projects")
@login_required
def list_projects():
    query  = request.args.get("q", "").strip()
    limit  = min(int(request.args.get("limit", 50)), 200)
    offset = max(int(request.args.get("offset", 0)), 0)

    if _is_admin() or not AUTH_REQUIRED:
        projects, total = app_db.list_all_projects(query=query, limit=limit, offset=offset)
    else:
        user_id = _current_user_id()
        if not user_id:
            return jsonify({"ok": True, "projects": [], "total": 0, "limit": limit, "offset": offset})
        projects, total = app_db.list_projects_for_user(user_id, query=query, limit=limit, offset=offset)

    # Enrich with live progress for in-flight jobs and playlist memberships
    result = []
    for p in projects:
        job_id = p["job_id"]
        live_progress = None
        with jobs_lock:
            if job_id in jobs:
                live_progress = jobs[job_id].get("progress")
        playlists = app_db.list_project_playlists(job_id)
        result.append({
            "job_id":     job_id,
            "name":       p["name"],
            "updated_at": p["updated_at"],
            "stem_count": p["stem_count"],
            "folder":     p["folder"],
            "status":     p["status"],
            "progress":   live_progress if live_progress is not None else (100 if p["status"] == "completed" else 0),
            "source_url": p["source_url"],
            "playlists":  [{"id": pl["id"], "name": pl["name"], "is_shared": bool(pl["is_shared"])} for pl in playlists],
        })

    return jsonify({"ok": True, "projects": result, "total": total,
                    "limit": limit, "offset": offset})


@app.get("/api/v1/projects/search-url")
@login_required
def search_project_by_url():
    """Check if a YouTube URL has already been split. Returns job_id if found."""
    url = request.args.get("url", "").strip()
    if not url:
        return jsonify({"ok": False, "error": "url parameter required"}), 400
    project = app_db.find_project_by_url(url)
    if not project:
        # Also try matching by video_id extracted from URL
        if not LITE_MODE:
            video_id = stem_cache.extract_video_id(url)
            if video_id:
                # Search source_url containing the video_id
                projects, _ = app_db.list_all_projects(query=video_id, limit=1)
                project = projects[0] if projects else None
    if project:
        return jsonify({"ok": True, "found": True, "job_id": project["job_id"],
                        "name": project["name"]})
    return jsonify({"ok": True, "found": False})


@app.get("/api/v1/jobs/<job_id>/download")
@app.get("/download/<job_id>")
@login_required
def download_zip(job_id: str):
    if not _is_valid_job_id(job_id):
        abort(404)
    if not _has_job_access(job_id):
        abort(403)

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


@app.get("/api/v1/jobs/<job_id>/export-project")
@login_required
def export_project(job_id: str):
    """Export a project as a self-contained ZIP containing stems + project.json."""
    if not _is_valid_job_id(job_id):
        abort(404)
    job = _get_job(job_id)
    if not job or job.get("status") != "completed":
        abort(404)

    stem_root_str = job.get("stem_root", "")
    stem_files = job.get("stem_files", {})
    if not stem_root_str or not stem_files:
        abort(404)
    stem_root = Path(stem_root_str)

    project_json = {
        "export_version": 1,
        "project_name": job.get("project_name", ""),
        "output_format": job.get("output_format", "mp3"),
        "separation_mode": job.get("separation_mode", "full"),
        "bpm": job.get("bpm"),
        "bpm_segments": job.get("bpm_segments", []),
        "key": job.get("key"),
        "key_confidence": job.get("key_confidence", 0.0),
        "thaat": job.get("thaat"),
        "thaat_alt": job.get("thaat_alt"),
        "mixer_state": job.get("mixer_state", {}),
        "stems": list(stem_files.keys()),
    }

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_STORED) as zf:
        zf.writestr("project.json", json.dumps(project_json, ensure_ascii=False, indent=2))
        for stem_key, stem_filename in stem_files.items():
            stem_path = stem_root / stem_filename
            if stem_path.exists():
                zf.write(stem_path, arcname=stem_filename)
    buf.seek(0)

    safe_name = re.sub(r"[^\w\s\-]", "", job.get("project_name", "project")).strip() or "project"
    download_name = f"{safe_name}_project.zip"
    return send_file(buf, as_attachment=True, download_name=download_name, mimetype="application/zip")


@app.post("/api/v1/projects/import")
@login_required
def import_project():
    """Import a previously exported project ZIP and recreate the project."""
    uploaded = request.files.get("project_zip")
    if not uploaded or not uploaded.filename:
        return jsonify({"ok": False, "error": "No file uploaded."}), 400
    if not uploaded.filename.lower().endswith(".zip"):
        return jsonify({"ok": False, "error": "File must be a .zip export."}), 400

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    job_id = f"{timestamp}_{uuid.uuid4().hex}"
    job_dir = JOB_ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    try:
        zip_bytes = uploaded.read()
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            names = zf.namelist()
            if "project.json" not in names:
                return jsonify({"ok": False, "error": "Invalid export: missing project.json."}), 400

            project_data = json.loads(zf.read("project.json"))
            export_version = project_data.get("export_version", 1)
            if export_version != 1:
                return jsonify({"ok": False, "error": f"Unsupported export version: {export_version}."}), 400

            output_format = project_data.get("output_format", "mp3")
            stem_dir = job_dir / "output" / "htdemucs" / "input"
            stem_dir.mkdir(parents=True, exist_ok=True)

            stem_keys = project_data.get("stems", [])
            ext = f".{output_format}"
            stem_files = {}
            for stem_key in stem_keys:
                filename = f"{stem_key}{ext}" if stem_key != "others" else f"other{ext}"
                if filename in names:
                    stem_dir_file = stem_dir / filename
                    stem_dir_file.write_bytes(zf.read(filename))
                    stem_files[stem_key] = filename

            if not stem_files:
                return jsonify({"ok": False, "error": "No stem audio files found in export."}), 400

        now_iso = datetime.now().isoformat(timespec="seconds")
        project_name = project_data.get("project_name", "") or f"Imported project {timestamp}"
        mixer_state = project_data.get("mixer_state", {})
        valid_keys = set(stem_files.keys())
        mixer_state = _normalize_mixer_state(mixer_state, valid_keys)

        job = {
            "job_id": job_id,
            "status": "completed",
            "progress": 100,
            "message": f"Imported project: {project_name}",
            "stems": {k: v for k, v in stem_files.items()},
            "stem_files": stem_files,
            "stem_root": str(stem_dir.resolve()),
            "zip_file": "",
            "source_file": "",
            "output_format": output_format,
            "separation_mode": project_data.get("separation_mode", "full"),
            "job_type": "split",
            "project_name": project_name,
            "mixer_state": mixer_state,
            "created_at": now_iso,
            "updated_at": now_iso,
            "bpm": project_data.get("bpm"),
            "bpm_segments": project_data.get("bpm_segments", []),
            "key": project_data.get("key"),
            "key_confidence": project_data.get("key_confidence", 0.0),
            "thaat": project_data.get("thaat"),
            "thaat_alt": project_data.get("thaat_alt"),
            "bpm_analyse_status": "done" if project_data.get("bpm") else None,
        }
        with jobs_lock:
            jobs[job_id] = job
        _persist_job_snapshot(job_id, job)

        stem_urls = {k: url_for("stream_stem", job_id=job_id, stem_key=k) for k in stem_files}
        stem_download_urls = {k: url_for("download_stem", job_id=job_id, stem_key=k) for k in stem_files}
        return jsonify({
            "ok": True,
            "job_id": job_id,
            "project_name": project_name,
            "stem_urls": stem_urls,
            "stem_download_urls": stem_download_urls,
        })

    except zipfile.BadZipFile:
        shutil.rmtree(job_dir, ignore_errors=True)
        return jsonify({"ok": False, "error": "Uploaded file is not a valid ZIP."}), 400
    except Exception as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        app.logger.exception("import_project failed: %s", exc)
        return jsonify({"ok": False, "error": "Import failed. File may be corrupt."}), 500


@app.get("/api/v1/jobs/<job_id>/source")
@app.get("/download-source/<job_id>")
@login_required
def download_source(job_id: str):
    if not _is_valid_job_id(job_id):
        abort(404)
    if not _has_job_access(job_id):
        abort(403)

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
    if not _has_job_access(job_id):
        abort(403)
    job = _get_job(job_id)
    if not job:
        abort(404)
    stem_path = _get_stem_path(job, stem_key)
    if not stem_path:
        abort(404)

    pitch_value = request.args.get("pitch")
    if pitch_value is None:
        return send_file(stem_path)
    if LITE_MODE:
        return send_file(stem_path)  # pitch shift not available without ffmpeg
    try:
        semitones = round(float(pitch_value), 4)
    except ValueError:
        abort(400)
    # ±24 to accommodate user pitch (±12) plus tempo compensation (up to ±12 more)
    if semitones < -24 or semitones > 24:
        abort(400)
    if abs(semitones) < 0.005:
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
    if not _has_job_access(job_id):
        abort(403)
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
    stem_path = _get_stem_path(job, stem_key)
    if not stem_path or not stem_path.exists():
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


# ── Admin utilities ───────────────────────────────────────────────────────────

@app.post("/api/v1/admin/resync-db")
@admin_required
def admin_resync_db():
    """Re-run the JOB_ROOT → DB migration on demand (idempotent)."""
    def _run():
        _migrate_jobs_to_db()
    threading.Thread(target=_run, daemon=True).start()
    return jsonify({"ok": True, "message": "Resync started in background — check server logs."})


# ── User management ───────────────────────────────────────────────────────────

@app.get("/api/v1/users")
@admin_required
def list_users():
    limit  = min(int(request.args.get("limit", 100)), 500)
    offset = max(int(request.args.get("offset", 0)), 0)
    # Google auth users only — skip local: entries (already shown from local_users)
    google_users = [u for u in app_db.list_users(limit=limit, offset=offset)
                    if not str(u.get("id", "")).startswith("local:")]
    for u in google_users:
        u["auth_type"] = "google"
    # Local users
    local_users_raw = app_db.list_local_users(limit=500, offset=0)
    local_users = []
    for u in local_users_raw:
        local_users.append({
            "id": app_db.local_user_to_unified_id(u["id"]),
            "email": u.get("username", ""),
            "name": u.get("name", ""),
            "picture": "",
            "role": u.get("role", "user"),
            "auth_type": "local",
            "is_active": u.get("is_active", 1),
            "last_seen": u.get("last_seen", ""),
            "created_at": u.get("created_at", ""),
        })
    all_users = google_users + local_users
    all_users.sort(key=lambda u: u.get("last_seen") or "", reverse=True)
    return jsonify({"ok": True, "users": all_users})


@app.patch("/api/v1/users/<path:user_id>/role")
@admin_required
def set_user_role(user_id: str):
    payload = request.get_json(silent=True) or {}
    role = str(payload.get("role", "")).strip()
    if role not in ("admin", "contributor", "user"):
        return jsonify({"ok": False, "error": "role must be 'admin', 'contributor', or 'user'"}), 400
    if user_id.startswith("local:"):
        local_id = int(user_id.split(":", 1)[1])
        ok = app_db.set_local_user_role(local_id, role)
    else:
        ok = app_db.set_user_role(user_id, role)
    if not ok:
        return jsonify({"ok": False, "error": "User not found"}), 404
    return jsonify({"ok": True, "user_id": user_id, "role": role})


@app.patch("/api/v1/users/<path:user_id>/active")
@admin_required
def set_user_active(user_id: str):
    payload = request.get_json(silent=True) or {}
    is_active = bool(payload.get("is_active", True))
    if not user_id.startswith("local:"):
        return jsonify({"ok": False, "error": "Active/inactive only supported for local accounts."}), 400
    local_id = int(user_id.split(":", 1)[1])
    ok = app_db.set_local_user_active(local_id, is_active)
    if not ok:
        return jsonify({"ok": False, "error": "User not found"}), 404
    return jsonify({"ok": True, "user_id": user_id, "is_active": is_active})


@app.delete("/api/v1/users/<path:user_id>")
@admin_required
def delete_user_route(user_id: str):
    ok = app_db.delete_user(user_id)
    if not ok:
        return jsonify({"ok": False, "error": "User not found"}), 404
    return jsonify({"ok": True, "user_id": user_id})


@app.get("/api/v1/users/<path:user_id>/projects")
@admin_required
def list_user_projects(user_id: str):
    """List projects directly granted to a specific user (admin view)."""
    projects = app_db.list_direct_projects_for_user(user_id)
    return jsonify({"ok": True, "projects": projects})


@app.post("/api/v1/users/<path:user_id>/projects")
@admin_required
def grant_user_project(user_id: str):
    payload = request.get_json(silent=True) or {}
    job_id = str(payload.get("job_id", "")).strip()
    if not job_id or not _is_valid_job_id(job_id):
        return jsonify({"ok": False, "error": "valid job_id required"}), 400
    # Ensure project exists in DB (may be on disk but not yet indexed)
    if not app_db.get_project(job_id):
        job = _get_job(job_id)
        if not job:
            return jsonify({"ok": False, "error": "Project not found"}), 404
        name = (job.get("project_name") or "").strip()
        if not name:
            sf = (job.get("source_file") or "").strip()
            name = Path(sf).stem if sf else f"Project {job_id[:8]}"
        app_db.upsert_project(
            job_id=job_id,
            name=name,
            source_url=(job.get("source_url") or "").strip(),
            source_file=(job.get("source_file") or "").strip(),
            status=job.get("status", "completed"),
            stem_count=len(job.get("stem_files") or {}),
            folder=(job.get("folder") or "").strip(),
            created_at=job.get("created_at") or "",
            updated_at=job.get("updated_at") or "",
        )
    # Ensure user exists in unified users table (may not have logged in yet)
    if not app_db.get_user_by_sub(user_id):
        return jsonify({"ok": False, "error": "User not found in users table — they must log in at least once before projects can be assigned"}), 400
    app_db.grant_access(job_id, user_id, granted_by=_current_user_id())
    return jsonify({"ok": True})


@app.delete("/api/v1/users/<path:user_id>/projects/<job_id>")
@admin_required
def revoke_user_project(user_id: str, job_id: str):
    if not _is_valid_job_id(job_id):
        abort(404)
    app_db.revoke_access(job_id, user_id)
    return jsonify({"ok": True})


# ── Group management ──────────────────────────────────────────────────────────

@app.get("/api/v1/groups")
@admin_required
def list_groups():
    groups = app_db.list_groups()
    return jsonify({"ok": True, "groups": groups})


@app.post("/api/v1/groups")
@admin_required
def create_group():
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()
    if not name:
        return jsonify({"ok": False, "error": "name is required"}), 400
    description = str(payload.get("description", "")).strip()
    try:
        g = app_db.create_group(name, description, created_by=_current_user_id())
        return jsonify({"ok": True, "group": g})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.patch("/api/v1/groups/<int:group_id>")
@admin_required
def update_group(group_id: int):
    payload = request.get_json(silent=True) or {}
    ok = app_db.update_group(
        group_id,
        name=payload.get("name"),
        description=payload.get("description"),
    )
    return jsonify({"ok": ok})


@app.delete("/api/v1/groups/<int:group_id>")
@admin_required
def delete_group(group_id: int):
    ok = app_db.delete_group(group_id)
    if not ok:
        return jsonify({"ok": False, "error": "Group not found"}), 404
    return jsonify({"ok": True})


@app.get("/api/v1/groups/<int:group_id>/members")
@admin_required
def list_group_members(group_id: int):
    members = app_db.list_group_members(group_id)
    return jsonify({"ok": True, "members": members})


@app.post("/api/v1/groups/<int:group_id>/members")
@admin_required
def add_group_member(group_id: int):
    payload = request.get_json(silent=True) or {}
    user_id = str(payload.get("user_id", "")).strip()
    if not user_id:
        return jsonify({"ok": False, "error": "user_id required"}), 400
    app_db.add_group_member(group_id, user_id)
    return jsonify({"ok": True})


@app.delete("/api/v1/groups/<int:group_id>/members/<path:user_id>")
@admin_required
def remove_group_member(group_id: int, user_id: str):
    app_db.remove_group_member(group_id, user_id)
    return jsonify({"ok": True})


@app.get("/api/v1/groups/<int:group_id>/projects")
@admin_required
def list_group_projects(group_id: int):
    projects = app_db.list_group_projects(group_id)
    return jsonify({"ok": True, "projects": projects})


@app.post("/api/v1/groups/<int:group_id>/projects")
@admin_required
def assign_project_to_group(group_id: int):
    payload = request.get_json(silent=True) or {}
    job_id = str(payload.get("job_id", "")).strip()
    if not job_id or not _is_valid_job_id(job_id):
        return jsonify({"ok": False, "error": "valid job_id required"}), 400
    app_db.grant_group_project_access(job_id, group_id, granted_by=_current_user_id())
    return jsonify({"ok": True})


@app.delete("/api/v1/groups/<int:group_id>/projects/<job_id>")
@admin_required
def unassign_project_from_group(group_id: int, job_id: str):
    if not _is_valid_job_id(job_id):
        abort(404)
    app_db.revoke_group_project_access(job_id, group_id)
    return jsonify({"ok": True})


# ── Project access management ─────────────────────────────────────────────────

@app.get("/api/v1/jobs/<job_id>/access")
@admin_required
def list_project_access(job_id: str):
    if not _is_valid_job_id(job_id):
        abort(404)
    access = app_db.list_project_access(job_id)
    return jsonify({"ok": True, "job_id": job_id, "access": access})


@app.post("/api/v1/jobs/<job_id>/access")
@admin_required
def grant_project_access(job_id: str):
    if not _is_valid_job_id(job_id):
        abort(404)
    payload = request.get_json(silent=True) or {}
    user_id = str(payload.get("user_id", "")).strip()
    if not user_id:
        return jsonify({"ok": False, "error": "user_id required"}), 400
    app_db.grant_access(job_id, user_id, granted_by=_current_user_id())
    return jsonify({"ok": True, "job_id": job_id, "user_id": user_id})


@app.post("/api/v1/jobs/<job_id>/access/grant-all")
@admin_required
def grant_project_access_to_all(job_id: str):
    """Grant this project to every registered user."""
    if not _is_valid_job_id(job_id):
        abort(404)
    app_db.grant_access_to_all_users(job_id, granted_by=_current_user_id())
    return jsonify({"ok": True, "job_id": job_id})


@app.delete("/api/v1/jobs/<job_id>/access/<user_id>")
@admin_required
def revoke_project_access(job_id: str, user_id: str):
    if not _is_valid_job_id(job_id):
        abort(404)
    app_db.revoke_access(job_id, user_id)
    return jsonify({"ok": True, "job_id": job_id, "user_id": user_id})


@app.get("/api/v1/jobs/<job_id>/overlay")
@login_required
def get_user_overlay(job_id: str):
    """Return the current user's overlay for a project."""
    if not _is_valid_job_id(job_id):
        abort(404)
    user_id = _current_user_id()
    if not user_id:
        return jsonify({"ok": True, "overlay": {}})
    overlay = app_db.get_overlay(job_id, user_id) or {}
    return jsonify({"ok": True, "overlay": overlay})


@app.patch("/api/v1/jobs/<job_id>/overlay")
@login_required
def patch_user_overlay(job_id: str):
    """Merge partial overlay fields into the current user's overlay."""
    if not _is_valid_job_id(job_id):
        abort(404)
    user_id = _current_user_id()
    if not user_id:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    payload = request.get_json(silent=True) or {}
    existing = app_db.get_overlay(job_id, user_id) or {}
    # Deep-merge mixer_state sub-fields if provided
    if "mixer_state" in payload:
        ms = dict(existing.get("mixer_state") or {})
        ms.update(payload["mixer_state"])
        existing["mixer_state"] = ms
    # Merge any other top-level overlay keys (lyrics, etc.)
    for k, v in payload.items():
        if k != "mixer_state":
            existing[k] = v
    app_db.save_overlay(job_id, user_id, existing)
    return jsonify({"ok": True})


@app.delete("/api/v1/jobs/<job_id>/overlay")
@login_required
def reset_user_overlay(job_id: str):
    """Reset the current user's overlay (revert to canonical admin version)."""
    if not _is_valid_job_id(job_id):
        abort(404)
    user_id = _current_user_id()
    if user_id:
        app_db.save_overlay(job_id, user_id, {})
    return jsonify({"ok": True, "job_id": job_id})


# ── Admin ─────────────────────────────────────────────────────────────────────

@app.get("/admin")
@login_required
def admin_page():
    if AUTH_REQUIRED and not _is_admin():
        return redirect(url_for("index"))
    return render_template("admin.html", current_user=session.get("user"), app_prefix=_APP_PREFIX)


@app.get("/api/v1/admin/config")
@login_required
def admin_get_config():
    return jsonify(admin_config.get_all())


@app.post("/api/v1/admin/config")
@login_required
def admin_update_config():
    updates = request.get_json(force=True, silent=True) or {}
    new_cfg = admin_config.update(updates)
    return jsonify(new_cfg)


@app.post("/api/v1/admin/config/reset")
@login_required
def admin_reset_config():
    cfg = admin_config.reset_to_defaults()
    return jsonify(cfg)


@app.get("/api/v1/admin/stats")
@login_required
def admin_stats():
    """Return system stats: project count, storage, cache size, failed jobs."""
    total = 0
    completed = 0
    failed = 0
    queued = 0
    running = 0
    cancelled = 0
    disk_bytes = 0
    failed_last_24h = 0
    split_durations: list[float] = []
    now = datetime.now()
    duration_re = re.compile(r"\bin ([0-9]+(?:\.[0-9]+)?) seconds\b")

    if JOB_ROOT.exists():
        for job_dir in JOB_ROOT.iterdir():
            if not job_dir.is_dir():
                continue
            meta = job_dir / JOB_META_NAME
            if not meta.exists():
                continue
            total += 1
            try:
                data = json.loads(meta.read_text())
                status = data.get("status", "")
                if status == "completed":
                    completed += 1
                elif status == "failed":
                    failed += 1
                elif status == "queued":
                    queued += 1
                elif status == "running":
                    running += 1
                elif status == "cancelled":
                    cancelled += 1

                if status == "failed":
                    updated_text = str(data.get("updated_at") or "").strip()
                    try:
                        updated_at = datetime.fromisoformat(updated_text) if updated_text else datetime.fromtimestamp(meta.stat().st_mtime)
                    except Exception:
                        updated_at = datetime.fromtimestamp(meta.stat().st_mtime)
                    if (now - updated_at).total_seconds() <= 86400:
                        failed_last_24h += 1

                if status == "completed" and data.get("job_type") == "split":
                    message = str(data.get("message") or "")
                    match = duration_re.search(message)
                    if match:
                        try:
                            split_durations.append(float(match.group(1)))
                        except ValueError:
                            pass
            except Exception:
                pass
            # Sum directory size
            for f in job_dir.rglob("*"):
                if f.is_file():
                    try:
                        disk_bytes += f.stat().st_size
                    except OSError:
                        pass

    # Cache entry count
    cache_entries = 0
    try:
        import sqlite3
        db_path = JOB_ROOT / "stem_cache.db"
        if db_path.exists():
            con = sqlite3.connect(str(db_path))
            row = con.execute("SELECT COUNT(*) FROM stem_cache").fetchone()
            cache_entries = row[0] if row else 0
            con.close()
    except Exception:
        pass

    storage_info = _describe_job_root_storage()
    ffmpeg_path = which("ffmpeg")
    ffmpeg_available = bool(ffmpeg_path)
    pitch_support = ffmpeg_available and not LITE_MODE
    ui_version = _resolve_ui_version()
    build_timestamp = _resolve_build_timestamp()
    job_root_writable = JOB_ROOT.exists() and os.access(JOB_ROOT, os.W_OK)
    server_started_at = APP_STARTED_AT.isoformat(timespec="seconds")
    uptime_seconds = max(0.0, (now - APP_STARTED_AT).total_seconds())
    free_disk_bytes = 0
    free_disk_gb = None
    try:
        free_disk_bytes = disk_usage(JOB_ROOT).free
        free_disk_gb = round(free_disk_bytes / (1024 ** 3), 2)
    except Exception:
        free_disk_bytes = 0
    average_split_seconds = round(sum(split_durations) / len(split_durations), 1) if split_durations else None

    return jsonify({
        "total_projects": total,
        "completed_projects": completed,
        "failed_projects": failed,
        "queued_projects": queued,
        "running_projects": running,
        "cancelled_projects": cancelled,
        "disk_bytes": disk_bytes,
        "disk_mb": round(disk_bytes / 1_048_576, 1),
        "cache_entries": cache_entries,
        "failed_last_24h": failed_last_24h,
        "average_split_seconds": average_split_seconds,
        "app_mode": "Lite Mode" if LITE_MODE else "Full Mode",
        "lite_mode": LITE_MODE,
        "ffmpeg_available": ffmpeg_available,
        "ffmpeg_path": ffmpeg_path or "",
        "compute_device": COMPUTE_DEVICE,
        "pitch_support": pitch_support,
        "ui_version": ui_version,
        "build_timestamp": build_timestamp,
        "job_root_writable": job_root_writable,
        "web_jobs_root": str(JOB_ROOT),
        "server_pid": os.getpid(),
        "server_started_at": server_started_at,
        "server_uptime_seconds": round(uptime_seconds, 1),
        "server_uptime": _format_uptime_seconds(uptime_seconds),
        "free_disk_bytes": free_disk_bytes,
        "free_disk_gb": free_disk_gb,
        **storage_info,
    })


@app.post("/api/v1/admin/cache/clear")
@login_required
def admin_clear_cache():
    try:
        import sqlite3
        db_path = JOB_ROOT / "stem_cache.db"
        if db_path.exists():
            con = sqlite3.connect(str(db_path))
            con.execute("DELETE FROM stem_cache")
            con.commit()
            con.close()
        return jsonify({"ok": True, "message": "Cache cleared."})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.post("/api/v1/admin/jobs/clear-failed")
@login_required
def admin_clear_failed_jobs():
    deleted = 0
    errors = []

    # Pass 1: scan filesystem — delete directories of jobs marked failed on disk
    if JOB_ROOT.exists():
        for job_dir in list(JOB_ROOT.iterdir()):
            if not job_dir.is_dir():
                continue
            meta = job_dir / JOB_META_NAME
            if not meta.exists():
                continue
            try:
                data = json.loads(meta.read_text())
                if data.get("status") == "failed":
                    shutil.rmtree(job_dir, ignore_errors=True)
                    with jobs_lock:
                        jobs.pop(job_dir.name, None)
                    app_db.delete_project(job_dir.name)
                    deleted += 1
            except Exception as exc:
                errors.append(str(exc))

    # Pass 2: sweep DB for orphaned failed records (directory already gone)
    try:
        all_projects, _ = app_db.list_all_projects(limit=10000)
        for p in all_projects:
            if p.get("status") == "failed":
                job_id = p["job_id"]
                # directory is already gone (or never existed); just purge the DB row
                if not _job_dir(job_id).exists():
                    with jobs_lock:
                        jobs.pop(job_id, None)
                    app_db.delete_project(job_id)
                    deleted += 1
    except Exception as exc:
        errors.append(f"DB sweep error: {exc}")

    return jsonify({"ok": True, "deleted": deleted, "errors": errors})


@app.get("/api/v1/admin/jobs")
@login_required
def admin_list_jobs():
    jobs_list = []
    if JOB_ROOT.exists():
        for job_dir in sorted(JOB_ROOT.iterdir(), key=lambda d: d.stat().st_mtime, reverse=True):
            if not job_dir.is_dir():
                continue
            meta = job_dir / JOB_META_NAME
            if not meta.exists():
                continue
            try:
                data = json.loads(meta.read_text())
                jobs_list.append({
                    "job_id": job_dir.name,
                    "status": data.get("status", "unknown"),
                    "project_name": data.get("project_name", ""),
                    "message": data.get("message", ""),
                    "created_at": data.get("created_at", ""),
                    "updated_at": data.get("updated_at", ""),
                })
            except Exception:
                pass
    return jsonify(jobs_list)


@app.get("/api/v1/admin/jobs/<job_id>/log")
@login_required
def admin_job_log(job_id: str):
    if not _is_valid_job_id(job_id):
        abort(404)
    log_path = _job_dir(job_id) / "job.log"
    if not log_path.exists():
        return jsonify({"log": "(no log file found)"})
    try:
        content = log_path.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        return jsonify({"log": f"Error reading log: {exc}"})
    return jsonify({"log": content})


# ── Shareable folder routes ────────────────────────────────────────────────

@app.post("/api/v1/folders/share")
@login_required
def create_folder_share():
    payload = request.get_json(silent=True) or {}
    folder = str(payload.get("folder", "")).strip()[:100]
    if not folder:
        return jsonify({"ok": False, "error": "folder is required"}), 400
    created_by = (session.get("user") or {}).get("email", "anonymous")
    token = _create_share_token(folder, created_by)
    share_url = url_for("shared_folder_view", token=token, _external=True)
    return jsonify({"ok": True, "token": token, "share_url": share_url})


@app.delete("/api/v1/share/<token>")
@login_required
def revoke_folder_share(token: str):
    _revoke_share_token(token)
    return jsonify({"ok": True})


@app.get("/s/<token>")
def shared_folder_view(token: str):
    share = _get_share_by_token(token)
    if not share:
        abort(404)
    ui_version = _resolve_ui_version()
    return render_template(
        "index.html",
        ui_version=ui_version,
        compute_device=COMPUTE_DEVICE,
        current_user=None,
        share_token=token,
        share_folder=share["folder"],
        lite_mode=LITE_MODE,
        app_prefix=_APP_PREFIX,
    )


@app.get("/api/v1/share/<token>")
def shared_folder_projects(token: str):
    share = _get_share_by_token(token)
    if not share:
        return jsonify({"ok": False, "error": "invalid or expired link"}), 404
    folder = share["folder"]
    projects = []
    for job_dir in sorted(JOB_ROOT.iterdir(), key=lambda d: d.stat().st_mtime, reverse=True):
        if not job_dir.is_dir():
            continue
        job_id = job_dir.name
        if not _is_valid_job_id(job_id):
            continue
        job = _get_job(job_id)
        if not job:
            continue
        if (job.get("folder") or "").strip() != folder:
            continue
        stem_files = job.get("stem_files", {})
        if not stem_files:
            continue
        project_name = (job.get("project_name") or "").strip()
        if not project_name:
            source_name = (job.get("source_file") or "").strip()
            project_name = Path(source_name).stem if source_name else f"Project {job_id[:8]}"
        updated_at = job.get("updated_at") or datetime.fromtimestamp(job_dir.stat().st_mtime).isoformat(timespec="seconds")
        projects.append({
            "job_id": job_id,
            "name": project_name,
            "updated_at": updated_at,
            "stem_count": len(stem_files),
            "folder": folder,
            # Public share: rewrite stem URLs to the token-scoped public endpoint
            "stem_urls": {
                k: url_for("shared_stem_stream", token=token, job_id=job_id, stem_key=k)
                for k in stem_files
            },
        })
    projects.sort(key=lambda p: p.get("updated_at", ""), reverse=True)
    return jsonify({"ok": True, "folder": folder, "projects": projects})


@app.get("/api/v1/share/<token>/jobs/<job_id>/stems/<stem_key>/stream")
def shared_stem_stream(token: str, job_id: str, stem_key: str):
    share = _get_share_by_token(token)
    if not share:
        abort(404)
    if not _is_valid_job_id(job_id) or not STEM_KEY_RE.fullmatch(stem_key):
        abort(404)
    job = _get_job(job_id)
    if not job:
        abort(404)
    # Verify the job belongs to the shared folder
    if (job.get("folder") or "").strip() != share["folder"]:
        abort(403)
    stem_path = _get_stem_path(job, stem_key)
    if not stem_path:
        abort(404)
    return send_file(stem_path)


# ── /api/v1/share/<token>/jobs/<job_id> — public job metadata ─────────────

@app.get("/api/v1/share/<token>/jobs/<job_id>")
def shared_job_detail(token: str, job_id: str):
    share = _get_share_by_token(token)
    if not share:
        abort(404)
    if not _is_valid_job_id(job_id):
        abort(404)
    job = _get_job(job_id)
    if not job:
        abort(404)
    if (job.get("folder") or "").strip() != share["folder"]:
        abort(403)
    safe = _normalize_job(job_id, job)
    # Rewrite stem URLs to token-scoped public endpoints
    stem_files = job.get("stem_files", {})
    safe["stem_urls"] = {
        k: url_for("shared_stem_stream", token=token, job_id=job_id, stem_key=k)
        for k in stem_files
    }
    safe["stem_download_urls"] = {}  # no download in read-only share
    return jsonify({"ok": True, "job": safe})


# ── Transliteration ──────────────────────────────────────────────────────────

try:
    from indic_transliteration import sanscript
    from indic_transliteration.sanscript import transliterate as _sanscript_transliterate
    _TRANSLIT_AVAILABLE = True
except ImportError:
    _TRANSLIT_AVAILABLE = False

@app.post("/api/v1/transliterate")
def transliterate_text():
    """Transliterate Gujarati script to Roman (ITRANS) phonetics."""
    if not _TRANSLIT_AVAILABLE:
        return jsonify({"ok": False, "error": "indic-transliteration not installed"}), 503
    payload = request.get_json(silent=True) or {}
    text = str(payload.get("text", "")).strip()
    if not text:
        return jsonify({"ok": True, "result": ""})
    try:
        result = _sanscript_transliterate(text, sanscript.GUJARATI, sanscript.ITRANS)
        # Simplify ITRANS to plain lowercase phonetic English (A→a, I→i, U→u, etc.)
        result = (result
            .replace("AA", "aa").replace("Aa", "aa").replace("A", "a")
            .replace("II", "ii").replace("Ii", "ii").replace("I", "i")
            .replace("UU", "uu").replace("Uu", "uu").replace("U", "u")
            .lower())
        return jsonify({"ok": True, "result": result})
    except Exception as exc:
        logging.warning("Transliteration error: %s", exc)
        return jsonify({"ok": False, "error": str(exc)}), 500


# ─── Playlists ────────────────────────────────────────────────────────────────

@app.get("/api/v1/playlists")
@login_required
def list_playlists():
    user_id = _current_user_id()
    if _is_admin() or not AUTH_REQUIRED:
        playlists = app_db.list_all_playlists()
    else:
        playlists = app_db.list_playlists_for_user(user_id)
    # Normalise is_shared to bool for JS
    for pl in playlists:
        pl["is_shared"] = bool(pl.get("is_shared"))
    return jsonify({"ok": True, "playlists": playlists})


@app.post("/api/v1/playlists")
@login_required
def create_playlist():
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()[:100]
    if not name:
        return jsonify({"ok": False, "error": "name is required"}), 400
    is_shared = bool(payload.get("is_shared", False))
    user_id = _current_user_id()
    # Only admins can create shared playlists
    if is_shared and not _is_admin():
        is_shared = False
    pl = app_db.create_playlist(name=name, owner_id=user_id, is_shared=is_shared, created_by=user_id)
    return jsonify({"ok": True, "playlist": pl}), 201


@app.get("/api/v1/playlists/<int:playlist_id>")
@login_required
def get_playlist(playlist_id: int):
    pl = app_db.get_playlist(playlist_id)
    if not pl:
        abort(404)
    user_id = _current_user_id()
    if not _is_admin() and not pl.get("is_shared") and pl.get("owner_id") != user_id:
        abort(403)
    projects = app_db.list_playlist_projects(playlist_id)
    return jsonify({"ok": True, "playlist": pl, "projects": projects})


@app.put("/api/v1/playlists/<int:playlist_id>")
@login_required
def update_playlist(playlist_id: int):
    pl = app_db.get_playlist(playlist_id)
    if not pl:
        abort(404)
    user_id = _current_user_id()
    if not _is_admin() and pl.get("owner_id") != user_id:
        abort(403)
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", pl["name"])).strip()[:100]
    is_shared = payload.get("is_shared", pl.get("is_shared"))
    # Only admins can make a playlist shared
    if not _is_admin():
        is_shared = pl.get("is_shared")
    app_db.update_playlist(playlist_id, name=name, is_shared=bool(is_shared))
    return jsonify({"ok": True, "playlist": app_db.get_playlist(playlist_id)})


@app.delete("/api/v1/playlists/<int:playlist_id>")
@login_required
def delete_playlist(playlist_id: int):
    pl = app_db.get_playlist(playlist_id)
    if not pl:
        abort(404)
    user_id = _current_user_id()
    if not _is_admin() and pl.get("owner_id") != user_id:
        abort(403)
    app_db.delete_playlist(playlist_id)
    return jsonify({"ok": True, "playlist_id": playlist_id})


@app.post("/api/v1/playlists/<int:playlist_id>/projects/<job_id>")
@login_required
def add_project_to_playlist(playlist_id: int, job_id: str):
    if not _is_valid_job_id(job_id):
        abort(404)
    pl = app_db.get_playlist(playlist_id)
    if not pl:
        abort(404)
    user_id = _current_user_id()
    if not _is_admin() and pl.get("owner_id") != user_id:
        abort(403)
    if not app_db.get_project(job_id):
        abort(404)
    app_db.add_project_to_playlist(playlist_id, job_id, added_by=user_id)
    return jsonify({"ok": True, "playlist_id": playlist_id, "job_id": job_id})


@app.delete("/api/v1/playlists/<int:playlist_id>/projects/<job_id>")
@login_required
def remove_project_from_playlist(playlist_id: int, job_id: str):
    if not _is_valid_job_id(job_id):
        abort(404)
    pl = app_db.get_playlist(playlist_id)
    if not pl:
        abort(404)
    user_id = _current_user_id()
    if not _is_admin() and pl.get("owner_id") != user_id:
        abort(403)
    app_db.remove_project_from_playlist(playlist_id, job_id)
    return jsonify({"ok": True, "playlist_id": playlist_id, "job_id": job_id})


@app.get("/api/v1/jobs/<job_id>/playlists")
@login_required
def get_project_playlists(job_id: str):
    if not _is_valid_job_id(job_id):
        abort(404)
    playlists = app_db.list_project_playlists(job_id)
    return jsonify({"ok": True, "playlists": playlists})


# ── Playlist sharing ──────────────────────────────────────────────────────────

@app.get("/api/v1/playlists/<int:playlist_id>/access")
@login_required
@admin_required
def get_playlist_access(playlist_id: int):
    pl = app_db.get_playlist(playlist_id)
    if not pl:
        abort(404)
    users  = app_db.list_playlist_user_access(playlist_id)
    groups = app_db.list_playlist_group_access(playlist_id)
    all_groups = app_db.list_groups()
    return jsonify({
        "ok": True,
        "playlist": pl,
        "users":  users,
        "groups": groups,
        "all_groups": all_groups,
    })


@app.post("/api/v1/playlists/<int:playlist_id>/access/users")
@login_required
@admin_required
def grant_playlist_user_access(playlist_id: int):
    pl = app_db.get_playlist(playlist_id)
    if not pl:
        abort(404)
    payload = request.get_json(silent=True) or {}
    user_id = str(payload.get("user_id", "")).strip()
    if not user_id:
        return jsonify({"ok": False, "error": "user_id required"}), 400
    app_db.grant_playlist_access(playlist_id, user_id, granted_by=_current_user_id())
    return jsonify({"ok": True})


@app.delete("/api/v1/playlists/<int:playlist_id>/access/users/<path:user_id>")
@login_required
@admin_required
def revoke_playlist_user_access(playlist_id: int, user_id: str):
    app_db.revoke_playlist_access(playlist_id, user_id)
    return jsonify({"ok": True})


@app.post("/api/v1/playlists/<int:playlist_id>/access/groups")
@login_required
@admin_required
def grant_playlist_group_access(playlist_id: int):
    pl = app_db.get_playlist(playlist_id)
    if not pl:
        abort(404)
    payload = request.get_json(silent=True) or {}
    group_id = payload.get("group_id")
    if group_id is None:
        return jsonify({"ok": False, "error": "group_id required"}), 400
    app_db.grant_playlist_group_access(playlist_id, int(group_id), granted_by=_current_user_id())
    return jsonify({"ok": True})


@app.delete("/api/v1/playlists/<int:playlist_id>/access/groups/<int:group_id>")
@login_required
@admin_required
def revoke_playlist_group_access(playlist_id: int, group_id: int):
    app_db.revoke_playlist_group_access(playlist_id, group_id)
    return jsonify({"ok": True})


@app.patch("/api/v1/playlists/<int:playlist_id>/sharing")
@login_required
@admin_required
def set_playlist_sharing(playlist_id: int):
    """Set is_shared (all-users flag) on a playlist."""
    pl = app_db.get_playlist(playlist_id)
    if not pl:
        abort(404)
    payload = request.get_json(silent=True) or {}
    is_shared = bool(payload.get("is_shared", pl.get("is_shared")))
    app_db.update_playlist(playlist_id, is_shared=is_shared)
    return jsonify({"ok": True, "playlist": app_db.get_playlist(playlist_id)})


# ─── User settings ────────────────────────────────────────────────────────────

@app.get("/api/v1/me/settings")
@login_required
def get_my_settings():
    user_id = _current_user_id()
    effective = app_db.get_effective_settings(user_id)
    user_overrides = app_db.get_user_settings(user_id)
    global_settings = {s["key"]: s for s in app_db.list_app_settings()}
    return jsonify({
        "ok": True,
        "effective": effective,
        "overrides": user_overrides,
        "global": {k: v["value"] for k, v in global_settings.items()},
        "can_override": {k: v["can_be_overridden"] for k, v in global_settings.items()},
    })


@app.put("/api/v1/me/settings")
@login_required
def update_my_settings():
    user_id = _current_user_id()
    payload = request.get_json(silent=True) or {}
    global_settings = {s["key"]: s for s in app_db.list_app_settings()}
    saved = {}
    rejected = {}
    for key, value in payload.items():
        gs = global_settings.get(key)
        if gs is None:
            rejected[key] = "unknown setting"
            continue
        if not gs["can_be_overridden"]:
            rejected[key] = "not overrideable"
            continue
        app_db.set_user_setting(user_id, key, value)
        saved[key] = value
    effective = app_db.get_effective_settings(user_id)
    return jsonify({"ok": True, "saved": saved, "rejected": rejected, "effective": effective})


@app.delete("/api/v1/me/settings/<key>")
@login_required
def reset_my_setting(key: str):
    user_id = _current_user_id()
    app_db.delete_user_setting(user_id, key)
    effective = app_db.get_effective_settings(user_id)
    return jsonify({"ok": True, "key": key, "effective": effective})


# ─── User favorites ──────────────────────────────────────────────────────────

@app.get("/api/v1/me/favorites")
@login_required
def get_my_favorites():
    user_id = _current_user_id()
    return jsonify({"ok": True, "favorites": app_db.list_favorites(user_id)})


@app.post("/api/v1/me/favorites/<job_id>")
@login_required
def add_favorite(job_id: str):
    user_id = _current_user_id()
    if not app_db.get_project(job_id):
        return jsonify({"ok": False, "error": "Project not found"}), 404
    app_db.add_favorite(user_id, job_id)
    return jsonify({"ok": True})


@app.delete("/api/v1/me/favorites/<job_id>")
@login_required
def remove_favorite(job_id: str):
    user_id = _current_user_id()
    app_db.remove_favorite(user_id, job_id)
    return jsonify({"ok": True})


# ─── Admin: global settings ───────────────────────────────────────────────────

@app.get("/api/v1/admin/settings")
@login_required
@admin_required
def admin_get_settings():
    settings = app_db.list_app_settings()
    return jsonify({"ok": True, "settings": settings})


@app.put("/api/v1/admin/settings")
@login_required
@admin_required
def admin_update_settings():
    payload = request.get_json(silent=True) or {}
    user_id = _current_user_id()
    updated = []
    for key, entry in payload.items():
        if not isinstance(entry, dict):
            # Allow plain value shorthand: {"key": value}
            entry = {"value": entry}
        app_db.set_app_setting(
            key=key,
            value=entry.get("value"),
            can_be_overridden=entry.get("can_be_overridden"),
            updated_by=user_id,
        )
        updated.append(key)
    return jsonify({"ok": True, "updated": updated, "settings": app_db.list_app_settings()})


# ─── Admin: playlists viewer + export/import ──────────────────────────────────

@app.get("/api/v1/admin/playlists")
@login_required
@admin_required
def admin_list_playlists():
    playlists = app_db.list_all_playlists()
    return jsonify({"ok": True, "playlists": playlists})


@app.get("/api/v1/admin/playlists/export")
@login_required
@admin_required
def admin_export_playlists():
    data = app_db.export_playlists()
    return jsonify({"ok": True, "export": data})


@app.post("/api/v1/admin/playlists/import")
@login_required
@admin_required
def admin_import_playlists():
    payload = request.get_json(silent=True) or {}
    export_data = payload.get("export") or payload  # accept wrapped or raw
    if not isinstance(export_data, dict) or "playlists" not in export_data:
        return jsonify({"ok": False, "error": "Invalid import format. Expected {playlists: [...]}"}), 400
    user_id = _current_user_id()
    stats = app_db.import_playlists(export_data, imported_by=user_id)
    return jsonify({"ok": True, **stats})


# ─── Admin: project access overview ──────────────────────────────────────────

@app.get("/api/v1/admin/projects/access-summary")
@login_required
@admin_required
def admin_project_access_summary():
    data = app_db.get_all_projects_access_summary()
    return jsonify({"ok": True, "projects": data})


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5001"))
    app.run(host="0.0.0.0", port=port, debug=False)
