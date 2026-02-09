from __future__ import annotations

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

    def download(self, url: str, output_dir: Path) -> list[DownloadedMedia]:
        output_dir.mkdir(parents=True, exist_ok=True)
        before_files = {path.resolve() for path in output_dir.rglob("*") if path.is_file()}

        info = None
        attempt_errors: list[str] = []
        for options in self._attempt_options(output_dir, url):
            try:
                with yt_dlp.YoutubeDL(options) as ydl:
                    info = ydl.extract_info(url, download=True)
                break
            except Exception as exc:
                attempt_errors.append(str(exc).strip() or exc.__class__.__name__)
                continue

        after_files = {path.resolve() for path in output_dir.rglob("*") if path.is_file()}
        new_files = sorted(self._filter_output_files(after_files - before_files))
        if not new_files:
            details = ""
            if attempt_errors:
                details = f" Last yt-dlp error: {attempt_errors[-1]}"
            raise VideoDownloadError(f"yt-dlp completed, but no downloadable output files were found.{details}")

        entries = self._extract_entries(info)
        results: list[DownloadedMedia] = []
        for index, file_path in enumerate(new_files):
            title = file_path.stem
            source_url = url
            if index < len(entries):
                title = entries[index].get("title") or title
                source_url = entries[index].get("webpage_url") or source_url
            results.append(DownloadedMedia(source_url=source_url, file_path=file_path, title=title))
        return results

    def _build_options(self, output_dir: Path) -> dict:
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

    def _filter_output_files(self, files: set[Path]) -> list[Path]:
        ignored_suffixes = {".part", ".ytdl", ".tmp"}
        valid_files = [path for path in files if path.suffix.lower() not in ignored_suffixes]
        if self.audio_only:
            target_suffix = f".{self.audio_format}"
            valid_files = [path for path in valid_files if path.suffix.lower() == target_suffix]
        return valid_files

    def _attempt_options(self, output_dir: Path, url: str) -> list[dict]:
        options = [self._build_options(output_dir)]
        if self._is_youtube_url(url):
            fallback = dict(options[0])
            fallback["extractor_args"] = {
                "youtube": {
                    # Prefer mobile/TV clients to avoid intermittent web client SABR/403 failures.
                    "player_client": ["android", "ios", "tv_embedded"],
                }
            }
            options.append(fallback)
        return options

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
