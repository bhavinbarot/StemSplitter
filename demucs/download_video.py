from __future__ import annotations

import argparse
from pathlib import Path

if __package__:
    from .video_downloader import VideoDownloadError, YtDlpVideoDownloader
else:
    from video_downloader import VideoDownloadError, YtDlpVideoDownloader


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download media from a link using yt-dlp.")
    parser.add_argument("--url", required=True, help="Media URL to download (YouTube, etc.)")
    parser.add_argument(
        "--output-dir",
        default="SourceAudio",
        help="Directory where downloaded files will be written (default: SourceAudio)",
    )
    parser.add_argument(
        "--allow-playlists",
        action="store_true",
        help="Allow playlist URLs to download multiple items",
    )
    parser.add_argument(
        "--video",
        action="store_true",
        help="Download video instead of extracting audio-only output",
    )
    parser.add_argument(
        "--audio-format",
        default="mp3",
        help="Target audio format when not using --video (default: mp3)",
    )
    parser.add_argument(
        "--audio-quality",
        default="0",
        help="yt-dlp audio quality for extraction, 0 is best (default: 0)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    downloader = YtDlpVideoDownloader(
        audio_only=not args.video,
        audio_format=args.audio_format,
        audio_quality=args.audio_quality,
        allow_playlists=args.allow_playlists,
        quiet=False,
    )

    try:
        results = downloader.download(args.url, Path(args.output_dir))
    except VideoDownloadError as exc:
        print(f"Download failed: {exc}")
        return 1

    print(f"Downloaded {len(results)} file(s):")
    for item in results:
        print(f"- {item.file_path} (title: {item.title})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
