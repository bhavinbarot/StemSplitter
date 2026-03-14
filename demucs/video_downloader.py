from __future__ import annotations

import base64
import hashlib
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

import yt_dlp


class VideoDownloadError(RuntimeError):
    """Raised when video download fails or yields no output files."""


@dataclass(frozen=True)
class DownloadedMedia:
    source_url: str
    file_path: Path
    title: str


class VideoDownloader(ABC):
    """Abstraction for downloading media from a link."""

    @abstractmethod
    def download(self, url: str, output_dir: Path) -> list[DownloadedMedia]:
        """Download media from `url` into `output_dir`."""


class YtDlpVideoDownloader(VideoDownloader):
    """
    yt-dlp based downloader implementation.
    Replace this class with another provider in the future while keeping the same interface.
    """

    def __init__(
        self,
        *,
        audio_only: bool = True,
        audio_format: str = "mp3",
        audio_quality: str = "0",
        allow_playlists: bool = False,
        quiet: bool = False,
    ) -> None:
        self.audio_only = audio_only
        self.audio_format = audio_format.lower()
        self.audio_quality = audio_quality
        self.allow_playlists = allow_playlists
        self.quiet = quiet
        self.last_run_info: dict[str, object] = {}

    def download(self, url: str, output_dir: Path) -> list[DownloadedMedia]:
        self.last_run_info = {
            "source_url": url,
            "cookie_source": None,
            "cookie_path": None,
            "cookie_warning": None,
            "attempts": [],
            "status": "running",
            "error": None,
        }
        output_dir.mkdir(parents=True, exist_ok=True)
        before_files = {path.resolve() for path in output_dir.rglob("*") if path.is_file()}

        info = None
        attempt_errors: list[str] = []
        cookie_file, cookie_source, cookie_warning = self._resolve_cookie_file()
        self.last_run_info["cookie_source"] = cookie_source
        self.last_run_info["cookie_path"] = cookie_file
        self.last_run_info["cookie_warning"] = cookie_warning
        attempts = self._attempt_options(output_dir, url, cookie_file)
        for attempt in attempts:
            label = attempt["label"]
            options = attempt["options"]
            try:
                with yt_dlp.YoutubeDL(options) as ydl:
                    info = ydl.extract_info(url, download=True)
                self._append_attempt_result(label, "ok")
                break
            except Exception as exc:
                error_message = str(exc).strip() or exc.__class__.__name__
                attempt_errors.append(error_message)
                self._append_attempt_result(label, "failed", error_message)
                continue

        after_files = {path.resolve() for path in output_dir.rglob("*") if path.is_file()}
        new_files = sorted(self._filter_output_files(after_files - before_files))
        if not new_files:
            details = ""
            if attempt_errors:
                details = f" Last yt-dlp error: {attempt_errors[-1]}"
            message = f"yt-dlp completed, but no downloadable output files were found.{details}"
            self.last_run_info["status"] = "failed"
            self.last_run_info["error"] = message
            raise VideoDownloadError(message)

        entries = self._extract_entries(info)
        results: list[DownloadedMedia] = []
        for index, file_path in enumerate(new_files):
            title = file_path.stem
            source_url = url
            if index < len(entries):
                title = entries[index].get("title") or title
                source_url = entries[index].get("webpage_url") or source_url
            results.append(DownloadedMedia(source_url=source_url, file_path=file_path, title=title))
        self.last_run_info["status"] = "completed"
        self.last_run_info["download_count"] = len(results)
        return results

    def _build_options(self, output_dir: Path, cookie_file: str | None = None) -> dict:
        options: dict = {
            "outtmpl": str(output_dir / "%(title).200B [%(id)s].%(ext)s"),
            "noplaylist": not self.allow_playlists,
            "ignoreerrors": False,
            "geo_bypass": True,
            "quiet": self.quiet,
            "no_warnings": self.quiet,
            "retries": 10,
            "fragment_retries": 10,
        }
        if cookie_file:
            options["cookiefile"] = cookie_file
        if self.audio_only:
            options["format"] = "bestaudio/best"
            options["postprocessors"] = [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": self.audio_format,
                    "preferredquality": self.audio_quality,
                }
            ]
        else:
            options["format"] = "bestvideo*+bestaudio/best"
        return options

    def _resolve_cookie_file(self) -> tuple[str | None, str | None, str | None]:
        cookie_file_env = (os.getenv("YTDLP_COOKIES_FILE") or "").strip()
        if cookie_file_env:
            if Path(cookie_file_env).is_file():
                return cookie_file_env, "file", None
            return None, None, f"YTDLP_COOKIES_FILE path not found: {cookie_file_env}"

        cookie_b64_env = (os.getenv("YTDLP_COOKIES_B64") or "").strip()
        if not cookie_b64_env:
            return None, None, None
        try:
            decoded = base64.b64decode(cookie_b64_env, validate=True)
        except Exception as exc:
            return None, None, f"Invalid YTDLP_COOKIES_B64: {exc}"

        if not decoded.strip():
            return None, None, "YTDLP_COOKIES_B64 decoded to an empty file."

        digest = hashlib.sha256(decoded).hexdigest()[:12]
        cookie_path = Path("/tmp") / f"yt_dlp_cookies_{digest}.txt"
        try:
            cookie_path.write_bytes(decoded)
            os.chmod(cookie_path, 0o600)
        except Exception as exc:
            return None, None, f"Failed to write cookie file to /tmp: {exc}"
        return str(cookie_path), "b64", None

    def _filter_output_files(self, files: set[Path]) -> list[Path]:
        ignored_suffixes = {".part", ".ytdl", ".tmp"}
        valid_files = [path for path in files if path.suffix.lower() not in ignored_suffixes]
        if self.audio_only:
            target_suffix = f".{self.audio_format}"
            valid_files = [path for path in valid_files if path.suffix.lower() == target_suffix]
        return valid_files

    def _attempt_options(self, output_dir: Path, url: str, cookie_file: str | None = None) -> list[dict]:
        options = [{"label": "default", "options": self._build_options(output_dir, cookie_file)}]
        if self._is_youtube_url(url):
            fallback = dict(options[0]["options"])
            fallback["extractor_args"] = {
                "youtube": {
                    # Prefer mobile/TV clients to avoid intermittent web client SABR/403 failures.
                    "player_client": ["android", "ios", "tv_embedded"],
                }
            }
            options.append({"label": "youtube_client_fallback", "options": fallback})
        return options

    def _append_attempt_result(self, label: str, status: str, error: str | None = None) -> None:
        attempts = self.last_run_info.get("attempts")
        if not isinstance(attempts, list):
            attempts = []
            self.last_run_info["attempts"] = attempts
        item: dict[str, object] = {"label": label, "status": status}
        if error:
            item["error"] = error
        attempts.append(item)

    def diagnostics_summary(self) -> str:
        status = self.last_run_info.get("status") or "unknown"
        cookie_source = self.last_run_info.get("cookie_source") or "none"
        cookie_path = self.last_run_info.get("cookie_path")
        cookie_warning = self.last_run_info.get("cookie_warning")
        attempts = self.last_run_info.get("attempts")
        attempt_summary = ""
        if isinstance(attempts, list) and attempts:
            parts: list[str] = []
            for item in attempts:
                if isinstance(item, dict):
                    label = str(item.get("label", "unknown"))
                    result = str(item.get("status", "unknown"))
                    error = item.get("error")
                    if error:
                        parts.append(f"{label}={result} ({error})")
                    else:
                        parts.append(f"{label}={result}")
            attempt_summary = "; attempts=" + ", ".join(parts)
        extra = ""
        if cookie_path:
            extra += f"; cookie_path={cookie_path}"
        if cookie_warning:
            extra += f"; cookie_warning={cookie_warning}"
        error = self.last_run_info.get("error")
        if error:
            extra += f"; error={error}"
        return f"status={status}; cookie_source={cookie_source}{extra}{attempt_summary}"

    @staticmethod
    def _is_youtube_url(url: str) -> bool:
        hostname = (urlparse(url).hostname or "").lower()
        return "youtube.com" in hostname or "youtu.be" in hostname

    @staticmethod
    def _extract_entries(info: dict | None) -> list[dict]:
        if not info:
            return []
        entries = info.get("entries")
        if isinstance(entries, list):
            return [entry for entry in entries if isinstance(entry, dict)]
        return [info] if isinstance(info, dict) else []
