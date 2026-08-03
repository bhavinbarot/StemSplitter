"""
Drum pattern analysis: beat tracking, time-signature detection,
2-measure segmentation, feature extraction, and agglomerative clustering.

Results are stored as {job_dir}/drum_analysis.json.
"""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

_MIN_SEGMENTS = 4           # fewer than this → report "too_short"
_ANALYSIS_FILENAME = "drum_analysis.json"
_write_lock = threading.Lock()

_PATTERN_COLORS = [
    "#3B82F6",  # blue
    "#10B981",  # emerald
    "#F59E0B",  # amber
    "#EF4444",  # red
    "#8B5CF6",  # violet
    "#EC4899",  # pink
    "#06B6D4",  # cyan
    "#84CC16",  # lime
]


# ── Persistence ───────────────────────────────────────────────────────────────

def _analysis_path(job_dir: Path) -> Path:
    return job_dir / _ANALYSIS_FILENAME


def load(job_dir: Path) -> dict | None:
    p = _analysis_path(job_dir)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _save(job_dir: Path, data: dict) -> None:
    with _write_lock:
        _analysis_path(job_dir).write_text(
            json.dumps(data, allow_nan=False), encoding="utf-8"
        )


def _progress(job_dir: Path, pct: int, step: str) -> None:
    _save(job_dir, {"status": "running", "progress": pct, "step": step})


# ── Main analysis pipeline ────────────────────────────────────────────────────

def analyze(drum_stem_path: Path, job_dir: Path) -> dict:
    """
    Full pipeline: beat tracking → time-signature detection → 2-measure
    segmentation → feature extraction.  Writes drum_analysis.json.
    Safe to call in a background thread.
    """
    _progress(job_dir, 0, "Loading audio…")

    try:
        import librosa
    except ImportError:
        logger.error("librosa not installed — drum analysis unavailable")
        result: dict = {"status": "failed", "error": "librosa not installed"}
        _save(job_dir, result)
        return result

    try:
        y, sr = librosa.load(str(drum_stem_path), mono=True)
    except Exception as exc:
        logger.error("drum_analysis: failed to load %s: %s", drum_stem_path, exc)
        result = {"status": "failed", "error": str(exc)}
        _save(job_dir, result)
        return result

    _progress(job_dir, 15, "Tracking beats…")

    # Beat tracking
    try:
        tempo_arr, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units="frames")
        bpm = float(np.atleast_1d(tempo_arr)[0])
        beat_times: list[float] = librosa.frames_to_time(beat_frames, sr=sr).tolist()
    except Exception as exc:
        logger.error("drum_analysis: beat tracking failed: %s", exc)
        result = {"status": "failed", "error": f"beat tracking: {exc}"}
        _save(job_dir, result)
        return result

    _progress(job_dir, 40, "Detecting time signature…")

    # Time signature detection (madmom; falls back to 4 on failure)
    time_sig = _detect_time_signature(drum_stem_path, beat_times)

    _progress(job_dir, 72, "Extracting features…")

    # Measure grid: every time_sig beats = one measure start
    measure_starts = [beat_times[i] for i in range(0, len(beat_times), time_sig)]

    # 2-measure windows
    audio_duration = float(len(y) / sr)
    segments: list[dict] = []
    i = 0
    while i + 1 < len(measure_starts):
        start = measure_starts[i]
        end_idx = i + 2
        end = measure_starts[end_idx] if end_idx < len(measure_starts) else audio_duration
        segments.append({"start": round(start, 4), "end": round(end, 4)})
        i += 2

    if len(segments) < _MIN_SEGMENTS:
        result = {
            "status": "too_short",
            "bpm": round(bpm, 1),
            "time_signature": time_sig,
            "beat_timestamps": [round(t, 4) for t in beat_times],
            "measure_timestamps": [round(t, 4) for t in measure_starts],
            "segments": [],
            "features": [],
            "pattern_names": {},
        }
        _save(job_dir, result)
        return result

    features = _extract_features(y, sr, segments)

    _progress(job_dir, 92, "Identifying patterns…")

    result = {
        "status": "complete",
        "bpm": round(bpm, 1),
        "time_signature": time_sig,
        "beat_timestamps": [round(t, 4) for t in beat_times],
        "measure_timestamps": [round(t, 4) for t in measure_starts],
        "segments": segments,
        "features": features,
        "pattern_names": {},
    }
    _save(job_dir, result)
    logger.info(
        "drum_analysis: complete job=%s bpm=%.1f time_sig=%d segs=%d",
        job_dir.name, bpm, time_sig, len(segments),
    )
    return result


# ── Time signature detection ──────────────────────────────────────────────────

_MADMOM_TIMEOUT = 90  # seconds; fall back to 4/4 if madmom hangs longer than this


def _detect_time_signature(drum_stem_path: Path, beat_times: list[float]) -> int:
    """
    Use madmom's RNN downbeat tracker to find the number of beats per bar.
    Falls back to 4 if madmom is unavailable, times out, or the audio is too short.
    """
    if len(beat_times) < 6:
        return 4

    result: list[int] = [4]

    def _run() -> None:
        try:
            import madmom
            proc = madmom.features.downbeats.RNNDownBeatProcessor()
            act = proc(str(drum_stem_path))
            tracker = madmom.features.downbeats.DBNDownBeatTrackingProcessor(
                beats_per_bar=[2, 3, 4, 6, 7, 8], fps=100
            )
            downbeats = tracker(act)
            if downbeats is not None and len(downbeats):
                beat_positions = np.array(downbeats)[:, 1].astype(int)
                max_beat = int(np.max(beat_positions))
                result[0] = max(2, max_beat)
        except Exception as exc:
            logger.warning(
                "drum_analysis: madmom time-sig detection failed (%s), defaulting to 4/4", exc
            )

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout=_MADMOM_TIMEOUT)
    if t.is_alive():
        logger.warning(
            "drum_analysis: madmom timed out after %ds, defaulting to 4/4", _MADMOM_TIMEOUT
        )
    return result[0]


# ── Feature extraction ────────────────────────────────────────────────────────

def _extract_features(y: np.ndarray, sr: int, segments: list[dict]) -> list[list[float]]:
    """
    Returns one feature vector per segment.
    Each vector: onset-strength envelope (64 bins) + MFCC means (13 coeff).
    """
    import librosa

    ONSET_BINS = 64
    N_MFCC = 13
    zero_vec = [0.0] * (ONSET_BINS + N_MFCC)
    features: list[list[float]] = []

    for seg in segments:
        start_sample = int(seg["start"] * sr)
        end_sample = int(seg["end"] * sr)
        chunk = y[start_sample:end_sample]

        if len(chunk) < int(sr * 0.1):
            features.append(zero_vec)
            continue

        # Onset strength envelope — resampled to fixed-length vector
        hop = max(64, len(chunk) // (ONSET_BINS * 2))
        onset_env = librosa.onset.onset_strength(y=chunk, sr=sr, hop_length=hop)
        onset_resampled = np.interp(
            np.linspace(0, max(len(onset_env) - 1, 0), ONSET_BINS),
            np.arange(len(onset_env)),
            onset_env,
        )
        rng = onset_resampled.max() - onset_resampled.min()
        if rng > 1e-6:
            onset_resampled = (onset_resampled - onset_resampled.min()) / rng

        # MFCC mean (z-score normalised across coefficients)
        mfcc = librosa.feature.mfcc(y=chunk, sr=sr, n_mfcc=N_MFCC)
        mfcc_mean = np.mean(mfcc, axis=1)
        mfcc_std = np.std(mfcc_mean)
        if mfcc_std > 1e-6:
            mfcc_mean = (mfcc_mean - np.mean(mfcc_mean)) / mfcc_std

        vec = np.concatenate([onset_resampled, mfcc_mean])
        features.append([round(float(v), 6) for v in vec])

    return features


# ── Clustering (stateless, no audio I/O) ─────────────────────────────────────

def cluster(job_dir: Path, threshold: float) -> dict:
    """
    Re-cluster the pre-computed features with a new distance threshold.
    No audio loading — reads drum_analysis.json only.

    threshold: cosine distance cutoff (0.01 = many fine patterns, 0.99 = few coarse patterns).
    """
    data = load(job_dir)
    if not data or data.get("status") != "complete":
        status = (data or {}).get("status", "missing")
        return {"ok": False, "error": f"Analysis not ready (status: {status})"}

    features_raw = data.get("features", [])
    segments = data.get("segments", [])
    pattern_names = data.get("pattern_names", {})

    if len(features_raw) < 2:
        return {"ok": False, "error": "Not enough segments to cluster"}

    try:
        from sklearn.cluster import AgglomerativeClustering
        from sklearn.preprocessing import normalize
    except ImportError:
        return {"ok": False, "error": "scikit-learn not installed"}

    X = normalize(np.array(features_raw, dtype=np.float32), norm="l2")
    t = float(np.clip(threshold, 0.01, 1.99))

    model = AgglomerativeClustering(
        metric="cosine",
        linkage="average",
        distance_threshold=t,
        n_clusters=None,
    )
    raw_labels: list[int] = model.fit_predict(X).tolist()

    # Map numeric labels → letter labels ordered by first occurrence
    seen: dict[int, str] = {}
    letter_labels: list[str] = []
    for lbl in raw_labels:
        if lbl not in seen:
            idx = len(seen)
            seen[lbl] = chr(ord("A") + idx) if idx < 26 else f"P{idx + 1}"
        letter_labels.append(seen[lbl])

    # Build per-pattern occurrence lists
    pattern_map: dict[str, dict] = {}
    for i, (seg, letter) in enumerate(zip(segments, letter_labels)):
        if letter not in pattern_map:
            color_idx = ord(letter[0]) - ord("A") if len(letter) == 1 else 0
            pattern_map[letter] = {
                "id": letter,
                "name": pattern_names.get(letter, letter),
                "color": _PATTERN_COLORS[color_idx % len(_PATTERN_COLORS)],
                "occurrences": [],
            }
        pattern_map[letter]["occurrences"].append({
            "segment_idx": i,
            "start": seg["start"],
            "end": seg["end"],
        })

    return {
        "ok": True,
        "threshold": threshold,
        "patterns": list(pattern_map.values()),
        "segments": [
            {"start": seg["start"], "end": seg["end"], "pattern_id": letter}
            for seg, letter in zip(segments, letter_labels)
        ],
    }


# ── Pattern name persistence ──────────────────────────────────────────────────

def save_pattern_names(job_dir: Path, names: dict) -> None:
    """Merge new user-given pattern names into drum_analysis.json."""
    data = load(job_dir)
    if not data:
        return
    existing = data.get("pattern_names", {})
    existing.update({str(k): str(v) for k, v in names.items()})
    data["pattern_names"] = existing
    _save(job_dir, data)
