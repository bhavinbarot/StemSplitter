import os
import re
import ssl
import certifi
import subprocess
import yt_dlp

#How to run:
#source venv/bin/activate
#python demucs/Youtube.py 

# ✅ Fix SSL verification issue on macOS (LibreSSL workaround)
ssl._create_default_https_context = lambda: ssl.create_default_context(cafile=certifi.where())

# 🎧 Ask user for YouTube URL
url = input("Enter YouTube video, Shorts, or playlist URL: ").strip()

# 🎯 Detect type: playlist or single video
is_playlist = "playlist?list=" in url or "youtube.com/playlist" in url

# 📁 Base folder for all downloads
BASE_DIR = "SourceAudio"
os.makedirs(BASE_DIR, exist_ok=True)

# ⚙️ Common yt-dlp options
common_opts = {
    'format': 'bestaudio/best',
    'ignoreerrors': True,
    'geo_bypass': True,
    'quiet': False,
    'postprocessors': [{
        'key': 'FFmpegExtractAudio',
        'preferredcodec': 'mp3',
        'preferredquality': '192',
    }],
}


# 🎵 Download all audio files (handles playlists and single videos)
def download_audio(url):
    print(f"\n🎵 Downloading from: {url}")

    with yt_dlp.YoutubeDL({**common_opts, 'noplaylist': not is_playlist}) as ydl:
        info = ydl.extract_info(url, download=False)

        # Playlist: download all, no Demucs
        if 'entries' in info:
            print("\n📜 Playlist detected — downloading all MP3s (Demucs skipped)\n")
            for entry in info['entries']:
                if entry:
                    download_single(entry, run_demucs=False)
        else:
            # Single video
            download_single(info, run_demucs=True)


def download_single(video_info, run_demucs=True):
    try:
        title = video_info.get('title', 'unknown_title')
        safe_title = re.sub(r'[\\/:"*?<>|]+', "_", title.strip())
        video_folder = os.path.join(BASE_DIR, safe_title)
        os.makedirs(video_folder, exist_ok=True)

        # Use %(ext)s so yt-dlp can change it to .mp3 after post-processing
        output_path = os.path.join(video_folder, f"{safe_title}.%(ext)s")

        # yt-dlp options for "bestaudio → MP3 (best quality)"
        audio_opts = {
            "format": "bestaudio/best",       # like -f "bestaudio"
            "outtmpl": output_path,
            "noplaylist": True,
            "prefer_ffmpeg": True,
            "postprocessors": [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",      # --audio-format mp3
                "preferredquality": "0",      # --audio-quality 0 (best)
            }],
        }

        # Merge with your common_opts (common wins or is overridden depending on order)
        ydl_opts = {**common_opts, **audio_opts}

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            # Use the original URL to let yt-dlp handle everything
            ydl.download([video_info['webpage_url']])

        # After post-processing, the final file will be .mp3
        mp3_file = os.path.join(video_folder, f"{safe_title}.mp3")
        if not os.path.exists(mp3_file):
            print(f"⚠️ MP3 not found for {safe_title}")
            return

        print(f"✅ MP3 saved: {mp3_file}")

        if run_demucs:
            run_demucs_process(mp3_file, video_folder)

    except Exception as e:
        print(f"❌ Error processing video '{video_info.get('title', 'unknown')}': {e}")



# 🎚️ Run Demucs and save stems in the same folder
def run_demucs_process(mp3_file, output_folder):
    print(f"\n🎛️ Running Demucs on: {mp3_file}")
    command = [
        "python3",
        "-m", "demucs",
        # "-n", "htdemucs_6s",
        "--two-stems=vocals",
        "--mp3",
        "--mp3-bitrate", "320",
        "-o", output_folder,
        mp3_file
    ]
    try:
        subprocess.run(command, check=True)
        move_stems(output_folder)
        print(f"✅ Demucs completed: {mp3_file}")
    except subprocess.CalledProcessError as e:
        print(f"❌ Demucs failed for {mp3_file}: {e}")


# 📦 Move stems up one level (Demucs usually creates e.g. “htdemucs/songname/”)
def move_stems(folder):
    for root, dirs, files in os.walk(folder):
        for file in files:
            if file.endswith(".mp3") and "htdemucs" in root:
                src = os.path.join(root, file)
                dest = os.path.join(folder, file)
                os.rename(src, dest)
        # Remove extra subfolder if empty
        for d in dirs:
            subpath = os.path.join(root, d)
            if "htdemucs" in d and os.path.isdir(subpath):
                try:
                    os.rmdir(subpath)
                except OSError:
                    pass


# 🚀 Start the process
download_audio(url)

print("\n🎉 All tasks finished successfully!")
