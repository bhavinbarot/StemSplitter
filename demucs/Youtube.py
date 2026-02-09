from __future__ import annotations

import os
import ssl
import subprocess
from pathlib import Path

import certifi

if __package__:
    from .video_downloader import VideoDownloadError, YtDlpVideoDownloader
else:
    from video_downloader import VideoDownloadError, YtDlpVideoDownloader


# How to run:
# source venv/bin/activate
# python demucs/Youtube.py

# Fix SSL verification issue on macOS (LibreSSL workaround).
ssl._create_default_https_context = lambda: ssl.create_default_context(cafile=certifi.where())

BASE_DIR = Path("SourceAudio")


def run_demucs_process(mp3_file: Path) -> None:
    print(f"\nRunning Demucs on: {mp3_file}")
    command = [
        "python3",
        "-m",
        "demucs",
        "--two-stems=vocals",
        "--mp3",
        "--mp3-bitrate",
        "320",
        "-o",
        str(mp3_file.parent),
        str(mp3_file),
    ]
    try:
        subprocess.run(command, check=True)
        move_stems(mp3_file.parent)
        print(f"Demucs completed: {mp3_file}")
    except subprocess.CalledProcessError as exc:
        print(f"Demucs failed for {mp3_file}: {exc}")


def move_stems(folder: Path) -> None:
    for root, _, files in os.walk(folder):
        root_path = Path(root)
        for file in files:
            if file.endswith(".mp3") and "htdemucs" in str(root_path):
                src = root_path / file
                dest = folder / file
                src.replace(dest)

    for maybe_dir in folder.rglob("*"):
        if maybe_dir.is_dir() and "htdemucs" in maybe_dir.name:
            try:
                maybe_dir.rmdir()
            except OSError:
                pass


def main() -> int:
    url = input("Enter YouTube video, Shorts, or playlist URL: ").strip()
    is_playlist = "playlist?list=" in url or "youtube.com/playlist" in url

    BASE_DIR.mkdir(parents=True, exist_ok=True)
    downloader = YtDlpVideoDownloader(
        audio_only=True,
        audio_format="mp3",
        audio_quality="0",
        allow_playlists=is_playlist,
        quiet=False,
    )

    print(f"\nDownloading from: {url}")
    try:
        downloaded = downloader.download(url, BASE_DIR)
    except VideoDownloadError as exc:
        print(f"Download failed: {exc}")
        return 1

    for item in downloaded:
        print(f"MP3 saved: {item.file_path}")

    if is_playlist:
        print("\nPlaylist detected. Downloaded files only (Demucs skipped).")
        print("\nAll tasks finished successfully.")
        return 0

    first = next((item for item in downloaded if item.file_path.suffix.lower() == ".mp3"), None)
    if not first:
        print("No MP3 output found for single video download.")
        return 1

    run_demucs_process(first.file_path)
    print("\nAll tasks finished successfully.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
