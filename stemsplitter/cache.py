"""
Stem split cache backed by SQLite.

Cache key = SHA256(video_id + model + separation_mode + output_format)
Only URL-based split jobs are cached (not file uploads, not download-only).
"""

import hashlib
import re
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, urlparse

_db_lock = threading.Lock()
_db_path: Path | None = None

# Matches ?v=VIDEO_ID or youtu.be/VIDEO_ID
_YT_LONG_RE = re.compile(r"[?&]v=([A-Za-z0-9_-]{11})")
_YT_SHORT_RE = re.compile(r"youtu\.be/([A-Za-z0-9_-]{11})")


def init(db_path: Path) -> None:
    """Call once at app startup with the path to the SQLite file."""
    global _db_path
    _db_path = db_path
    with _db_lock:
        con = sqlite3.connect(str(db_path))
        con.execute("""
            CREATE TABLE IF NOT EXISTS stem_cache (
                cache_key       TEXT PRIMARY KEY,
                video_id        TEXT NOT NULL,
                model           TEXT NOT NULL,
                separation_mode TEXT NOT NULL,
                output_format   TEXT NOT NULL,
                job_id          TEXT NOT NULL,
                created_at      TEXT NOT NULL
            )
        """)
        con.commit()
        con.close()


def extract_video_id(url: str) -> str | None:
    """Return the YouTube video ID from a URL, or None if not found."""
    m = _YT_LONG_RE.search(url)
    if m:
        return m.group(1)
    m = _YT_SHORT_RE.search(url)
    if m:
        return m.group(1)
    # Handle youtube.com/shorts/VIDEO_ID
    parsed = urlparse(url)
    parts = parsed.path.strip("/").split("/")
    if len(parts) >= 2 and parts[-2] in {"shorts", "embed", "v"}:
        candidate = parts[-1]
        if re.fullmatch(r"[A-Za-z0-9_-]{11}", candidate):
            return candidate
    return None


def make_cache_key(video_id: str, model: str, separation_mode: str, output_format: str) -> str:
    raw = f"{video_id}|{model}|{separation_mode}|{output_format}"
    return hashlib.sha256(raw.encode()).hexdigest()


def lookup(cache_key: str) -> str | None:
    """Return cached job_id, or None if not found."""
    if _db_path is None:
        return None
    with _db_lock:
        con = sqlite3.connect(str(_db_path))
        row = con.execute(
            "SELECT job_id FROM stem_cache WHERE cache_key = ?", (cache_key,)
        ).fetchone()
        con.close()
    return row[0] if row else None


def insert(cache_key: str, video_id: str, model: str, separation_mode: str, output_format: str, job_id: str) -> None:
    """Store a completed job in the cache."""
    if _db_path is None:
        return
    now = datetime.now().isoformat(timespec="seconds")
    with _db_lock:
        con = sqlite3.connect(str(_db_path))
        con.execute(
            """
            INSERT OR REPLACE INTO stem_cache
                (cache_key, video_id, model, separation_mode, output_format, job_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (cache_key, video_id, model, separation_mode, output_format, job_id, now),
        )
        con.commit()
        con.close()


def invalidate(cache_key: str) -> None:
    """Remove a stale entry (e.g. when files have been deleted)."""
    if _db_path is None:
        return
    with _db_lock:
        con = sqlite3.connect(str(_db_path))
        con.execute("DELETE FROM stem_cache WHERE cache_key = ?", (cache_key,))
        con.commit()
        con.close()
