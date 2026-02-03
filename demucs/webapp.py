import os
import re
import subprocess
import sys
import threading
import time
import uuid
import zipfile
import math
from functools import wraps
from datetime import datetime
from pathlib import Path

from authlib.integrations.flask_client import OAuth
from flask import Flask, abort, jsonify, redirect, render_template, request, send_file, session, url_for


app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "change-this-dev-secret")
PROJECT_ROOT = Path(__file__).resolve().parent.parent
JOB_ROOT = Path(os.getenv("WEB_JOBS_ROOT", str(PROJECT_ROOT / "web_jobs")))
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

oauth = OAuth(app)
if AUTH_ENABLED:
    oauth.register(
        name="google",
        client_id=GOOGLE_CLIENT_ID,
        client_secret=GOOGLE_CLIENT_SECRET,
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
    )


def _is_valid_job_id(job_id: str) -> bool:
    return bool(JOB_ID_RE.fullmatch(job_id))


def _is_logged_in() -> bool:
    return bool(session.get("user"))


def _auth_response():
    if request.path.startswith("/start") or request.path.startswith("/status") or request.path.startswith("/download"):
        return jsonify({"ok": False, "error": "Please login with Google first."}), 401
    return redirect(url_for("login", next=request.path))


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


@app.get("/")
@login_required
def index():
    tracked_files = [Path(__file__), Path(__file__).parent / "templates" / "index.html"]
    latest_mtime = max(file_path.stat().st_mtime for file_path in tracked_files if file_path.exists())
    ui_version = datetime.fromtimestamp(latest_mtime).strftime("v%Y.%m.%d-%H%M%S")
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
    session["next_url"] = request.args.get("next") or url_for("index")
    redirect_uri = url_for("auth_google_callback", _external=True)
    return oauth.google.authorize_redirect(redirect_uri, prompt="select_account")


@app.get("/auth/google/callback")
def auth_google_callback():
    if not AUTH_REQUIRED or not AUTH_ENABLED:
        return redirect(url_for("login"))
    token = oauth.google.authorize_access_token()
    userinfo = token.get("userinfo")
    if not userinfo:
        userinfo = oauth.google.userinfo()
    session["user"] = {
        "name": userinfo.get("name", "User"),
        "email": userinfo.get("email", ""),
        "picture": userinfo.get("picture", ""),
    }
    next_url = session.pop("next_url", url_for("index"))
    return redirect(next_url)


@app.get("/logout")
def logout():
    if not AUTH_REQUIRED:
        return redirect(url_for("index"))
    session.pop("user", None)
    return redirect(url_for("login"))


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
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].update(kwargs)


def _job_progress(job_id: str) -> int:
    with jobs_lock:
        if job_id in jobs:
            return int(jobs[job_id].get("progress", 0))
    return 0


def _write_job_log(log_path: Path, line: str):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(f"[{timestamp}] {line}\n")


def _quality_profile(quality_level: int) -> dict:
    if quality_level <= 33:
        return {"model": "mdx_q", "shifts": 1, "overlap": 0.10, "segment": 6, "mp3_preset": 7}
    if quality_level <= 66:
        return {"model": "htdemucs", "shifts": 1, "overlap": 0.25, "segment": 7, "mp3_preset": 4}
    return {"model": "htdemucs_ft", "shifts": 2, "overlap": 0.35, "segment": 7, "mp3_preset": 2}


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
        _update_job(
            job_id,
            status="completed",
            progress=100,
            message=f"Split completed for {original_name} in {round(time.monotonic() - started_at, 1)} seconds.",
            stems=stems,
            stem_root=str(stem_root.resolve()),
            stem_files=stem_files,
            stem_urls={key: f"/stem/{job_id}/{key}" for key in stem_files},
            stem_download_urls={key: f"/download-stem/{job_id}/{key}" for key in stem_files},
            zip_file=zip_filename,
            log_file=_to_job_relative(log_path),
            download_url=f"/download/{job_id}",
        )
    except Exception as exc:
        _write_job_log(log_path, f"Unexpected error: {exc}")
        _update_job(job_id, status="failed", message="Unexpected server error.", progress=100)


@app.post("/start")
@login_required
def start_split():
    uploaded_file = request.files.get("audio_file")
    if not uploaded_file or not uploaded_file.filename:
        return jsonify({"ok": False, "error": "Please upload an audio file first."}), 400

    suffix = Path(uploaded_file.filename).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        return jsonify({"ok": False, "error": "Unsupported file type."}), 400
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

    input_path = job_dir / f"input{suffix}"
    uploaded_file.save(input_path)
    with jobs_lock:
        jobs[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "progress": 1,
            "message": "File uploaded. Waiting to start...",
            "stems": {},
            "stem_files": {},
            "stem_urls": {},
            "stem_download_urls": {},
            "stem_root": "",
            "zip_file": "",
            "log_file": "",
            "download_url": "",
            "output_format": output_format,
            "separation_mode": separation_mode,
        }

    worker = threading.Thread(
        target=_run_demucs_job,
        args=(
            job_id,
            input_path,
            output_path,
            Path(uploaded_file.filename).name,
            {
                "separation_mode": separation_mode,
                "output_format": output_format,
                "quality_level": quality_level,
            },
        ),
        daemon=True,
    )
    worker.start()
    return jsonify({"ok": True, "job_id": job_id})


@app.get("/status/<job_id>")
@login_required
def job_status(job_id: str):
    if not _is_valid_job_id(job_id):
        abort(404)
    with jobs_lock:
        job = jobs.get(job_id)
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
        }
    )


@app.get("/download/<job_id>")
@login_required
def download_zip(job_id: str):
    if not _is_valid_job_id(job_id):
        abort(404)

    zip_path = None
    with jobs_lock:
        job = jobs.get(job_id)
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


@app.get("/stem/<job_id>/<stem_key>")
@login_required
def stream_stem(job_id: str, stem_key: str):
    if not _is_valid_job_id(job_id) or not STEM_KEY_RE.fullmatch(stem_key):
        abort(404)
    with jobs_lock:
        job = jobs.get(job_id)
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


@app.get("/download-stem/<job_id>/<stem_key>")
@login_required
def download_stem(job_id: str, stem_key: str):
    if not _is_valid_job_id(job_id) or not STEM_KEY_RE.fullmatch(stem_key):
        abort(404)
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        abort(404)
    stem_path = _get_stem_path(job, stem_key)
    if not stem_path:
        abort(404)
    download_name = job.get("stems", {}).get(stem_key, stem_path.name)
    return send_file(stem_path, as_attachment=True, download_name=download_name)


@app.get("/download-loop/<job_id>/<stem_key>")
@login_required
def download_stem_loop(job_id: str, stem_key: str):
    if not _is_valid_job_id(job_id) or not STEM_KEY_RE.fullmatch(stem_key):
        abort(404)
    with jobs_lock:
        job = jobs.get(job_id)
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
    app.run(host="0.0.0.0", port=5000, debug=False)
