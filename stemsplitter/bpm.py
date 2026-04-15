"""
BPM detection using librosa.

Primary source: drums stem (cleanest rhythm signal).
Fallback:       full source mix (if drums stem is near-silent).

Returns:
    {
        "bpm": 128.0,          # dominant/global BPM
        "segments": [          # only present when meaningful tempo changes found
            {"start": 0.0,  "end": 45.2,  "bpm": 140.0},
            {"start": 45.2, "end": 183.0, "bpm": 110.0},
        ]
    }
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

# Minimum RMS energy for drums stem to be considered "active"
_MIN_DRUMS_RMS = 0.002

# How many BPM apart two segments must be to be reported as different
_CHANGE_THRESHOLD_BPM = 7.0

# Minimum number of beats a segment must span to be kept
_MIN_SEGMENT_BEATS = 12


def detect(primary_path: Path, fallback_path: Path | None = None) -> dict:
    """
    Detect BPM (and optional tempo segments) from an audio file.

    Args:
        primary_path:  Path to drums stem (preferred).
        fallback_path: Path to full source mix (used if drums are silent).

    Returns:
        {"bpm": float, "segments": list[dict]}
    """
    try:
        import librosa  # imported lazily so the rest of the app starts even if librosa is missing
    except ImportError:
        logger.error("librosa is not installed — BPM detection unavailable")
        return {"bpm": None, "segments": []}

    audio_path = primary_path
    try:
        y, sr = librosa.load(str(primary_path), mono=True)
        rms = float(np.sqrt(np.mean(y ** 2)))
        if rms < _MIN_DRUMS_RMS:
            if fallback_path and fallback_path.exists():
                logger.info("bpm_detect: drums stem is quiet (rms=%.4f), using fallback %s", rms, fallback_path)
                audio_path = fallback_path
                y, sr = librosa.load(str(fallback_path), mono=True)
            else:
                logger.info("bpm_detect: drums stem is quiet (rms=%.4f), no fallback", rms)
    except Exception as exc:
        logger.warning("bpm_detect: failed to load %s (%s)", primary_path, exc)
        if fallback_path and fallback_path.exists():
            try:
                y, sr = librosa.load(str(fallback_path), mono=True)
                audio_path = fallback_path
            except Exception as exc2:
                logger.error("bpm_detect: fallback also failed (%s)", exc2)
                return {"bpm": None, "segments": []}
        else:
            return {"bpm": None, "segments": []}

    try:
        # Beat tracking — returns global tempo + beat frame indices
        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
        global_bpm = round(float(tempo), 1)
        logger.info("bpm_detect: global BPM=%.1f from %s", global_bpm, audio_path.name)

        segments = _detect_segments(y, sr, beat_frames)
        return {"bpm": global_bpm, "segments": segments}

    except Exception as exc:
        logger.error("bpm_detect: analysis failed (%s)", exc)
        return {"bpm": None, "segments": []}


def _detect_segments(y: np.ndarray, sr: int, beat_frames: np.ndarray) -> list[dict]:
    """
    Detect regions with different tempos by analysing inter-beat intervals.

    Strategy:
    1. Convert beat frames → times → inter-beat intervals → local BPMs.
    2. Smooth with a rolling window to reduce jitter.
    3. Find positions where the smoothed BPM jumps by > _CHANGE_THRESHOLD_BPM.
    4. Build segments, merge ones that are too similar.
    5. Return empty list if no meaningful change found.
    """
    try:
        import librosa
    except ImportError:
        return []

    if len(beat_frames) < _MIN_SEGMENT_BEATS * 2:
        return []

    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    intervals = np.diff(beat_times)

    if len(intervals) < _MIN_SEGMENT_BEATS:
        return []

    # Local BPM per inter-beat interval
    local_bpms = 60.0 / np.maximum(intervals, 1e-6)

    # Smooth with a window of ~8 beats
    window = min(8, max(2, len(local_bpms) // 6))
    kernel = np.ones(window) / window
    smoothed = np.convolve(local_bpms, kernel, mode="same")

    # Find change points — positions where BPM shifts significantly
    change_beat_indices = [0]
    half = max(1, window // 2)
    for i in range(half, len(smoothed) - half):
        before = float(np.mean(smoothed[max(0, i - half): i]))
        after  = float(np.mean(smoothed[i: min(len(smoothed), i + half)]))
        if abs(after - before) > _CHANGE_THRESHOLD_BPM:
            # Require at least _MIN_SEGMENT_BEATS gap from last change
            if i - change_beat_indices[-1] >= _MIN_SEGMENT_BEATS:
                change_beat_indices.append(i)

    change_beat_indices.append(len(beat_times) - 1)

    # Need at least one interior change point to have multiple segments
    if len(change_beat_indices) <= 2:
        return []

    # Build raw segments
    raw: list[dict] = []
    for i in range(len(change_beat_indices) - 1):
        s = change_beat_indices[i]
        e = change_beat_indices[i + 1]
        seg_bpms = local_bpms[s: e]
        if len(seg_bpms) == 0:
            continue
        seg_bpm = round(float(np.median(seg_bpms)), 1)
        raw.append({
            "start": round(float(beat_times[s]), 2),
            "end":   round(float(beat_times[e]), 2),
            "bpm":   seg_bpm,
        })

    if not raw:
        return []

    # Merge adjacent segments whose BPMs are within threshold
    merged = [dict(raw[0])]
    for seg in raw[1:]:
        prev = merged[-1]
        if abs(seg["bpm"] - prev["bpm"]) <= _CHANGE_THRESHOLD_BPM:
            prev["end"] = seg["end"]
            prev["bpm"] = round((prev["bpm"] + seg["bpm"]) / 2, 1)
        else:
            merged.append(dict(seg))

    # Final check — only return if we still have 2+ distinct segments
    if len(merged) < 2:
        return []

    logger.info("bpm_detect: found %d tempo segments: %s", len(merged),
                [(s["bpm"], s["start"], s["end"]) for s in merged])
    return merged
