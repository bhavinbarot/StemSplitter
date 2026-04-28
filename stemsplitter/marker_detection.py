"""
Auto-marker detection for stems.

Strategy (two-pass):
  Pass 1 — Amplitude surge detection:
    Compute short-frame RMS energy. Find frames where energy surges
    significantly vs. the preceding quiet window. Only keep surges where
    the elevated energy is *sustained* for min_vocal_duration seconds —
    this eliminates drum hits, plucks, and reverb tails.

  Pass 2 — Silence-split detection (librosa):
    Traditional silence re-entry detection as a complementary source.

  Both candidate lists are merged and deduplicated (within 1.5 s).

  Music stem — vocal-silence cross-reference:
    Marks every point where qualified vocals go silent for >= 2 s.
"""

from __future__ import annotations

import logging
import uuid
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

# ── Defaults (overridable per-request via params dict) ────────────────────────

# dB below peak to consider "silence" in a stem (Pass 2)
# Lower = more gaps detected · Higher = stricter (fewer gaps)
_SILENCE_TOP_DB = 40

# Minimum gap before a vocal entry to place a marker (seconds)
_MIN_SILENCE_BEFORE_START = 0.75

# Minimum sustained duration for a vocal segment to be a real phrase (seconds)
_MIN_VOCAL_DURATION = 2.0

# Minimum vocal silence gap to place a Music marker (seconds)
_MIN_VOCAL_SILENCE_FOR_MUSIC = 2.0

# ── RMS surge detection config ────────────────────────────────────────────────

# RMS frame length and hop (seconds)
_FRAME_SEC = 0.05
_HOP_SEC   = 0.025

# How many seconds to look back to compute the "quiet baseline"
_BASELINE_WINDOW_SEC = 1.5

# Surge multiplier: current RMS must be this many times the baseline to count
_SURGE_RATIO = 4.0

# Minimum absolute RMS to even consider as a vocal frame (avoids near-silence)
_MIN_RMS_FLOOR = 0.005


def _make_marker(label: str, time: float) -> dict:
    return {"id": uuid.uuid4().hex, "label": label, "time": round(time, 3)}


def _load_audio(path: Path):
    """Return (y, sr) or (None, None) on failure."""
    try:
        import librosa  # type: ignore
        y, sr = librosa.load(str(path), mono=True, duration=600)
        return y, sr
    except Exception as exc:
        logger.debug("marker_detection: failed to load %s: %s", path, exc)
        return None, None


def _compute_rms_frames(y: np.ndarray, sr: int, frame_sec: float, hop_sec: float):
    """Return (rms_array, times_array) where times are centre of each frame."""
    frame_len = max(1, int(frame_sec * sr))
    hop_len   = max(1, int(hop_sec  * sr))
    # Pad so all samples are covered
    pad = frame_len // 2
    y_pad = np.pad(y, (pad, pad), mode="reflect")
    n_frames = 1 + (len(y_pad) - frame_len) // hop_len
    rms = np.array([
        np.sqrt(np.mean(y_pad[i * hop_len: i * hop_len + frame_len] ** 2))
        for i in range(n_frames)
    ], dtype=np.float32)
    times = np.arange(n_frames) * hop_sec
    return rms, times


def _surge_candidates(
    rms: np.ndarray,
    times: np.ndarray,
    hop_sec: float,
    baseline_window_sec: float,
    surge_ratio: float,
    min_rms_floor: float,
    min_vocal_duration: float,
    min_silence_before_start: float,
) -> list[float]:
    """
    Return list of times (seconds) where a significant amplitude surge begins
    AND is sustained for at least min_vocal_duration seconds.
    """
    baseline_frames = max(1, int(baseline_window_sec / hop_sec))
    sustain_frames  = max(1, int(min_vocal_duration  / hop_sec))
    gap_frames      = max(1, int(min_silence_before_start / hop_sec))

    candidates: list[float] = []
    in_surge = False
    surge_start_idx = 0

    for i in range(len(rms)):
        # Baseline: mean RMS of the preceding window
        base_start = max(0, i - baseline_frames)
        baseline = float(np.mean(rms[base_start:i])) if i > 0 else 0.0

        is_loud = (rms[i] >= min_rms_floor) and (
            baseline < min_rms_floor or rms[i] >= surge_ratio * baseline
        )

        if is_loud and not in_surge:
            in_surge = True
            surge_start_idx = i
        elif not is_loud and in_surge:
            in_surge = False
            duration_frames = i - surge_start_idx
            # Only keep if sustained long enough
            if duration_frames >= sustain_frames:
                # Only mark if there was a quiet-enough period before it
                pre_end   = surge_start_idx
                pre_start = max(0, surge_start_idx - gap_frames)
                pre_rms   = float(np.mean(rms[pre_start:pre_end])) if pre_end > pre_start else 0.0
                surge_rms = float(np.mean(rms[surge_start_idx:i]))
                if pre_rms < min_rms_floor or surge_rms >= surge_ratio * pre_rms:
                    t = float(times[surge_start_idx])
                    if t >= min_silence_before_start:
                        candidates.append(t)

    # Handle surge that runs to end of file
    if in_surge:
        duration_frames = len(rms) - surge_start_idx
        if duration_frames >= sustain_frames:
            pre_end   = surge_start_idx
            pre_start = max(0, surge_start_idx - gap_frames)
            pre_rms   = float(np.mean(rms[pre_start:pre_end])) if pre_end > pre_start else 0.0
            surge_rms = float(np.mean(rms[surge_start_idx:]))
            if pre_rms < min_rms_floor or surge_rms >= surge_ratio * pre_rms:
                t = float(times[surge_start_idx])
                if t >= min_silence_before_start:
                    candidates.append(t)

    return candidates


def _silence_split_candidates(
    y: np.ndarray,
    sr: int,
    silence_top_db: float,
    min_vocal_duration: float,
    min_silence_before_start: float,
) -> list[float]:
    """Pass 2: traditional librosa silence-split approach."""
    try:
        import librosa  # type: ignore
    except ImportError:
        return []

    intervals = librosa.effects.split(y, top_db=silence_top_db)
    candidates: list[float] = []
    prev_end_sec = 0.0

    for start_sample, end_sample in intervals:
        start_sec = float(start_sample) / sr
        end_sec   = float(end_sample)   / sr
        duration  = end_sec - start_sec
        silence_before = start_sec - prev_end_sec
        prev_end_sec = end_sec

        if duration < min_vocal_duration:
            continue
        if silence_before >= min_silence_before_start:
            candidates.append(start_sec)

    return candidates


def _merge_candidates(
    lists: list[list[float]],
    dedup_window: float = 1.5,
) -> list[float]:
    """Merge multiple candidate lists, dedup within dedup_window seconds."""
    all_times = sorted({t for lst in lists for t in lst})
    merged: list[float] = []
    for t in all_times:
        if not merged or t - merged[-1] >= dedup_window:
            merged.append(t)
    return merged


def _detect_vocal_markers(
    vocal_path: Path,
    silence_top_db: float,
    min_vocal_duration: float,
    min_silence_before_start: float,
) -> list[dict]:
    """Two-pass vocal marker detection."""
    try:
        import librosa  # type: ignore  # noqa: F401
    except ImportError:
        return []

    if not vocal_path.exists():
        return []

    y, sr = _load_audio(vocal_path)
    if y is None:
        return []

    # Pass 1 — amplitude surge detection
    rms, times = _compute_rms_frames(y, sr, _FRAME_SEC, _HOP_SEC)
    surge_times = _surge_candidates(
        rms, times,
        hop_sec=_HOP_SEC,
        baseline_window_sec=_BASELINE_WINDOW_SEC,
        surge_ratio=_SURGE_RATIO,
        min_rms_floor=_MIN_RMS_FLOOR,
        min_vocal_duration=min_vocal_duration,
        min_silence_before_start=min_silence_before_start,
    )

    # Pass 2 — silence split
    split_times = _silence_split_candidates(
        y, sr, silence_top_db, min_vocal_duration, min_silence_before_start
    )

    # Merge and deduplicate
    all_times = _merge_candidates([surge_times, split_times], dedup_window=1.5)

    if not all_times:
        return []

    # Build markers
    markers: list[dict] = []
    section_num = 1
    for i, t in enumerate(all_times):
        if i == 0:
            markers.append(_make_marker("Vocals In", t))
        else:
            markers.append(_make_marker(f"Vocal {section_num}", t))
            section_num += 1

    return markers


def _detect_music_markers_from_vocals(
    vocal_path: Path,
    silence_top_db: float,
    min_vocal_duration: float,
    min_silence_before_start: float,
) -> list[dict]:
    """
    Music/Others strategy: mark every point where vocals go SILENT.
    Uses the same two-pass candidate list to determine real vocal intervals,
    then marks the gaps between them.
    """
    if not vocal_path.exists():
        return []

    y, sr = _load_audio(vocal_path)
    if y is None:
        return []

    # Use silence-split to get intervals (more reliable for gap boundaries)
    try:
        import librosa  # type: ignore
    except ImportError:
        return []

    intervals = librosa.effects.split(y, top_db=silence_top_db)
    real_intervals = [
        (s, e) for s, e in intervals
        if (float(e) - float(s)) / sr >= min_vocal_duration
    ]

    if not real_intervals:
        return []

    markers: list[dict] = []
    section_num = 1

    first_vocal_sec = float(real_intervals[0][0]) / sr
    if first_vocal_sec >= min_silence_before_start:
        markers.append(_make_marker("Music Starts", 0.0))
        section_num += 1

    for i in range(len(real_intervals) - 1):
        vocal_end_sec  = float(real_intervals[i][1])     / sr
        next_vocal_sec = float(real_intervals[i + 1][0]) / sr
        silence_dur    = next_vocal_sec - vocal_end_sec

        if silence_dur >= _MIN_VOCAL_SILENCE_FOR_MUSIC:
            marker_time = max(0.0, vocal_end_sec - 1.0)
            markers.append(_make_marker(f"Music {section_num}", marker_time))
            section_num += 1

    markers.sort(key=lambda m: m["time"])
    return markers


def detect_markers_for_job(
    stem_root: str,
    stem_files: dict[str, str],
    params: dict | None = None,
) -> dict[str, list[dict]]:
    """
    Run marker detection for vocals and music (others) stems.

    Args:
        stem_root:  Absolute path to directory containing stem files.
        stem_files: Dict mapping stem_key → filename.
        params:     Optional overrides:
                      silence_top_db, min_vocal_duration, min_silence_before_start

    Returns:
        Dict mapping stem_key → list of marker dicts.
    """
    p = params or {}
    silence_top_db           = float(p.get("silence_top_db",           _SILENCE_TOP_DB))
    min_vocal_duration       = float(p.get("min_vocal_duration",       _MIN_VOCAL_DURATION))
    min_silence_before_start = float(p.get("min_silence_before_start", _MIN_SILENCE_BEFORE_START))

    root = Path(stem_root)
    results: dict[str, list[dict]] = {}

    vocal_key  = next((k for k in ("vocals", "no_vocals") if k in stem_files), None)
    vocal_path = root / stem_files[vocal_key] if vocal_key else None

    for stem_key, filename in stem_files.items():
        audio_path = root / filename
        markers: list[dict] = []

        if stem_key in ("vocals", "no_vocals"):
            markers = _detect_vocal_markers(
                audio_path, silence_top_db, min_vocal_duration, min_silence_before_start
            )

        elif stem_key in ("others", "other"):
            if vocal_path and vocal_path.exists():
                markers = _detect_music_markers_from_vocals(
                    vocal_path, silence_top_db, min_vocal_duration, min_silence_before_start
                )

        if markers:
            results[stem_key] = markers
            logger.info("marker_detection: %s → %d markers", stem_key, len(markers))

    return results
