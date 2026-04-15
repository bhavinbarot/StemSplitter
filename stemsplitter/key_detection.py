"""
Musical key + thaat detection optimised for Indian devotional music.

Ensemble strategy — three independent signals, majority-weighted vote:

  Signal 1 · TonicIndianArtMusic (vocals + source)
    Purpose-built for Indian music. Detects tonic (Sa) via pitch salience
    histogram. Highest weight because it's domain-specific.
    Scale type (major/minor) is determined separately via HPCP analysis
    relative to the detected tonic — NOT from a generic key profile.

  Signal 2 · KeyExtractor (vocals, others, source)
    Western key detector. Less accurate on Indian music but provides
    useful cross-validation signal.

  Voting
    Every signal casts a (tonic, scale) vote weighted by its confidence.
    Enharmonic equivalents are normalised (Eb→D#, Ab→G#, etc.) so they
    land in the same bucket. Winner = highest total weight.

  Thaat detection
    After the winning tonic is known, the mean HPCP is rotated so Sa sits
    at index 0. Pearson correlation is then computed against each of the
    10 Hindustani thaat profiles. Top two matches are returned.

Returns:
    {
        "tonic":      "D#",
        "scale":      "minor",
        "label":      "D# minor",
        "confidence": 0.74,
        "thaat":      "Kafi",
        "thaat_alt":  "Asavari",          # second-closest thaat
        "thaat_scores": {"Kafi": 0.89, …} # all 10 scores for debugging
        "votes":      […]
    }
    or {"tonic": None, …} on failure.
"""

from __future__ import annotations

import logging
import math
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

_MIN_RMS = 0.002
_SR = 44100

# Chromatic note names — sharps only (normalised form)
_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Flatten every flat/enharmonic name → sharp equivalent
_TO_SHARP = {
    "Db": "C#", "D#": "D#",
    "Eb": "D#", "E#": "F",
    "Fb": "E",
    "Gb": "F#", "G#": "G#",
    "Ab": "G#", "A#": "A#",
    "Bb": "A#", "B#": "C",
    "Cb": "B",
}

# ── 10 Hindustani thaats ──────────────────────────────────────────────────────
# Each value is a 12-element binary template (1 = note present in thaat).
# Index 0 = Sa (tonic), index 1 = komal Re, index 2 = Re, etc.
# Semitone intervals from Sa: 0=Sa, 1=komal Re, 2=Re, 3=komal Ga, 4=Ga,
#   5=Ma, 6=tivra Ma, 7=Pa, 8=komal Dha, 9=Dha, 10=komal Ni, 11=Ni
_THAATS: dict[str, np.ndarray] = {
    #               Sa  kRe Re  kGa Ga  Ma  tMa Pa  kDh Dh  kNi Ni
    "Bilawal":  np.array([1,  0,  1,  0,  1,  1,  0,  1,  0,  1,  0,  1], float),  # Major
    "Khamaj":   np.array([1,  0,  1,  0,  1,  1,  0,  1,  0,  1,  1,  0], float),  # Mixolydian
    "Kafi":     np.array([1,  0,  1,  1,  0,  1,  0,  1,  0,  1,  1,  0], float),  # Dorian
    "Asavari":  np.array([1,  0,  1,  1,  0,  1,  0,  1,  1,  0,  1,  0], float),  # Natural minor
    "Bhairavi": np.array([1,  1,  0,  1,  0,  1,  0,  1,  1,  0,  1,  0], float),  # Phrygian
    "Bhairav":  np.array([1,  1,  0,  0,  1,  1,  0,  1,  1,  0,  0,  1], float),  # Double harmonic
    "Kalyan":   np.array([1,  0,  1,  0,  1,  0,  1,  1,  0,  1,  0,  1], float),  # Lydian
    "Marwa":    np.array([1,  1,  0,  0,  1,  0,  1,  1,  0,  1,  0,  1], float),
    "Poorvi":   np.array([1,  1,  0,  0,  1,  0,  1,  1,  1,  0,  0,  1], float),
    "Todi":     np.array([1,  1,  0,  1,  0,  0,  1,  1,  1,  0,  0,  1], float),
}


def _normalise_note(name: str) -> str:
    return _TO_SHARP.get(name, name)


def _hz_to_note(freq_hz: float) -> str | None:
    if freq_hz <= 0:
        return None
    semitones = round(12 * math.log2(freq_hz / 440.0))
    return _NOTE_NAMES[(semitones + 9) % 12]


def _rms(audio: np.ndarray) -> float:
    return float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))


def _load(path: Path) -> np.ndarray | None:
    try:
        import essentia.standard as es
        audio = es.MonoLoader(filename=str(path), sampleRate=_SR)()
        return audio
    except Exception as exc:
        logger.warning("key_detection: cannot load %s — %s", path.name, exc)
        return None


def _active_audio(path: Path | None) -> np.ndarray | None:
    if not path or not path.exists():
        return None
    audio = _load(path)
    if audio is None or _rms(audio) < _MIN_RMS:
        return None
    return audio


# ── HPCP helper ──────────────────────────────────────────────────────────────

def _mean_hpcp(audio: np.ndarray) -> np.ndarray | None:
    """
    Compute mean 12-bin HPCP over the full audio (C=index 0).
    Returns None on failure.
    """
    try:
        import essentia.standard as es
        windowing   = es.Windowing(type="blackmanharris62")
        spectrum_fn = es.Spectrum()
        spec_peaks  = es.SpectralPeaks(orderBy="magnitude", maxPeaks=60,
                                       minFrequency=40, maxFrequency=5000)
        hpcp_fn     = es.HPCP(size=12, referenceFrequency=440,
                               minFrequency=40, maxFrequency=5000)
        frames      = es.FrameGenerator(audio, frameSize=4096, hopSize=1024,
                                        startFromZero=True)
        hpcp_frames = []
        for frame in frames:
            spec = spectrum_fn(windowing(frame))
            freqs, mags = spec_peaks(spec)
            if len(freqs):
                hpcp_frames.append(hpcp_fn(freqs, mags))

        if not hpcp_frames:
            return None
        return np.mean(hpcp_frames, axis=0)
    except Exception as exc:
        logger.warning("key_detection: HPCP failed — %s", exc)
        return None


# ── Scale determination relative to a known tonic ────────────────────────────

def _scale_from_hpcp(hpcp: np.ndarray, tonic_note: str) -> tuple[str, float]:
    """Decide major vs minor using energy at scale-defining intervals."""
    try:
        t = _NOTE_NAMES.index(tonic_note)
    except ValueError:
        return "major", 0.5

    def e(s: int) -> float:
        return float(hpcp[(t + s) % 12])

    major_score = e(4) * 2.0 + e(9) * 1.0 + e(11) * 0.5   # M3, M6, M7
    minor_score = e(3) * 2.0 + e(8) * 1.0 + e(10) * 0.5   # m3, m6, m7
    total = major_score + minor_score
    if total < 1e-6:
        return "major", 0.5
    if minor_score >= major_score:
        return "minor", round(minor_score / total, 3)
    return "major", round(major_score / total, 3)


# ── Thaat detection ───────────────────────────────────────────────────────────

# Penalty applied to energy at notes that are NOT in a thaat.
# Higher value = harsher punishment for "wrong" notes → more discriminative.
_THAAT_PENALTY = 0.9

# Precompute discriminative weights per semitone.
# Notes that appear in fewer thaats are rarer → more discriminative → higher weight.
# Sa (index 0) and Pa (index 7) appear in all 10 thaats → lowest weight.
def _compute_disc_weights() -> np.ndarray:
    counts = np.zeros(12)
    for t in _THAATS.values():
        counts += t
    # Inverse-frequency weight; clip to avoid extreme values
    w = 10.0 / (counts + 1.0)
    return np.clip(w / w.mean(), 0.5, 2.5)

_DISC_WEIGHTS: np.ndarray = _compute_disc_weights()


def _thaat_score(hpcp_rotated: np.ndarray, template: np.ndarray) -> float:
    """
    Penalty-weighted discriminative score for one thaat.

    Algorithm:
      1. Weight each HPCP bin by how discriminative that note is across thaats.
      2. Sum weighted energy at notes IN the thaat  (reward).
      3. Subtract penalty * weighted energy at notes NOT in the thaat (penalty).

    Score range is roughly (-1, +1) for a unit-sum HPCP.
    """
    weighted = hpcp_rotated * _DISC_WEIGHTS
    present = template.astype(bool)
    score_in  = float(np.sum(weighted[present]))
    score_out = float(np.sum(weighted[~present]))
    return score_in - _THAAT_PENALTY * score_out


def detect_thaat(hpcp: np.ndarray, tonic_note: str) -> dict:
    """
    Given a 12-bin HPCP (C=index 0) and a known tonic, score against all 10
    Hindustani thaat templates using penalty-weighted discriminative scoring.

    The HPCP is rotated so the tonic sits at index 0 before scoring,
    making the comparison tonic-independent.

    Returns:
        {
            "thaat":        "Bhairav",   # best match
            "thaat_alt":    "Marwa",     # second-best
            "thaat_scores": {name: normalised_score, …}  # 0–1, sorted descending
        }
    """
    try:
        tonic_idx = _NOTE_NAMES.index(tonic_note)
    except ValueError:
        return {"thaat": None, "thaat_alt": None, "thaat_scores": {}}

    # Rotate HPCP so Sa is at index 0
    rotated = np.roll(hpcp, -tonic_idx)

    # Normalise HPCP to sum=1 so scores are comparable across recordings
    hpcp_sum = float(rotated.sum())
    if hpcp_sum > 1e-9:
        rotated = rotated / hpcp_sum

    raw: dict[str, float] = {
        name: _thaat_score(rotated, template)
        for name, template in _THAATS.items()
    }

    # Min-max normalise raw scores to [0, 1] for interpretable confidence
    lo, hi = min(raw.values()), max(raw.values())
    rng = hi - lo
    if rng > 1e-9:
        norm_scores = {n: round((s - lo) / rng, 4) for n, s in raw.items()}
    else:
        norm_scores = {n: round(1.0 / len(raw), 4) for n in raw}

    ranked = sorted(norm_scores.items(), key=lambda x: -x[1])
    best   = ranked[0][0] if ranked else None
    second = ranked[1][0] if len(ranked) > 1 else None

    logger.info("key_detection: thaat scores (tonic=%s) → %s",
                tonic_note,
                ", ".join(f"{n}={s:.3f}" for n, s in ranked[:5]))

    return {
        "thaat":        best,
        "thaat_alt":    second,
        "thaat_scores": dict(ranked),
    }


# ── Signal 1: TonicIndianArtMusic ─────────────────────────────────────────────

def _votes_from_tonic_indian(audio: np.ndarray, source_name: str,
                              weight: float = 1.5) -> list[dict]:
    try:
        import essentia.standard as es
        tonic_freq = float(es.TonicIndianArtMusic()(audio))
        tonic_note = _hz_to_note(tonic_freq)
        if not tonic_note:
            return []
        hpcp = _mean_hpcp(audio)
        if hpcp is None:
            return []
        scale, scale_conf = _scale_from_hpcp(hpcp, tonic_note)
        vote_weight = weight * scale_conf
        logger.info("key_detection: TonicIndian(%s) → %s %s (freq=%.1f Hz, conf=%.3f)",
                    source_name, tonic_note, scale, tonic_freq, scale_conf)
        return [{"tonic": tonic_note, "scale": scale,
                 "weight": vote_weight, "hpcp": hpcp,
                 "tonic_hz": tonic_freq,
                 "source": f"TonicIndian({source_name})"}]
    except Exception as exc:
        logger.warning("key_detection: TonicIndianArtMusic failed on %s — %s", source_name, exc)
        return []


# ── Signal 2: KeyExtractor ────────────────────────────────────────────────────

def _votes_from_key_extractor(audio: np.ndarray, source_name: str,
                               weight: float = 1.0) -> list[dict]:
    try:
        import essentia.standard as es
        detected_key, detected_scale, strength = es.KeyExtractor()(audio)
        tonic_note  = _normalise_note(detected_key)
        hpcp        = _mean_hpcp(audio)
        vote_weight = weight * float(strength)
        logger.info("key_detection: KeyExtractor(%s) → %s %s (strength=%.3f)",
                    source_name, tonic_note, detected_scale, strength)
        return [{"tonic": tonic_note, "scale": detected_scale,
                 "weight": vote_weight, "hpcp": hpcp,
                 "source": f"KeyExtractor({source_name})"}]
    except Exception as exc:
        logger.warning("key_detection: KeyExtractor failed on %s — %s", source_name, exc)
        return []


# ── Voting + thaat aggregation ────────────────────────────────────────────────

def _aggregate(votes: list[dict]) -> dict:
    """Tally votes by (tonic, scale), run thaat detection on winner's HPCP."""
    tally: dict[tuple, float] = {}
    for v in votes:
        bucket = (_normalise_note(v["tonic"]), v["scale"])
        tally[bucket] = tally.get(bucket, 0.0) + v["weight"]

    if not tally:
        return _empty()

    total_weight = sum(tally.values())
    (best_tonic, best_scale), best_weight = max(tally.items(), key=lambda x: x[1])
    confidence = round(best_weight / total_weight, 3) if total_weight > 0 else 0.0

    logger.info("key_detection: tally=%s → winner=%s %s (conf=%.3f)",
                {f"{t} {s}": round(w, 3) for (t, s), w in
                 sorted(tally.items(), key=lambda x: -x[1])},
                best_tonic, best_scale, confidence)

    # Thaat detection — use the most harmonically reliable HPCP available.
    # Priority: others/instruments stem (cleanest harmonic signal) > vocals > source > any.
    def _hpcps_for(source_tag: str) -> list[np.ndarray]:
        return [v["hpcp"] for v in votes
                if v.get("hpcp") is not None and source_tag in v.get("source", "")]

    thaat_hpcps = (
        _hpcps_for("others") or
        _hpcps_for("vocals") or
        [v["hpcp"] for v in votes
         if v.get("hpcp") is not None and _normalise_note(v["tonic"]) == best_tonic] or
        [v["hpcp"] for v in votes if v.get("hpcp") is not None]
    )

    thaat_info: dict = {"thaat": None, "thaat_alt": None, "thaat_scores": {}}
    if thaat_hpcps:
        combined_hpcp = np.mean(thaat_hpcps, axis=0)
        thaat_info = detect_thaat(combined_hpcp, best_tonic)

    # Pick tonic_hz from the highest-weight TonicIndianArtMusic vote for the winner
    tonic_hz = None
    for v in sorted(votes, key=lambda x: -x["weight"]):
        if (_normalise_note(v["tonic"]) == best_tonic
                and "TonicIndian" in v.get("source", "")
                and v.get("tonic_hz")):
            tonic_hz = v["tonic_hz"]
            break

    label = f"{best_tonic} {best_scale}"
    if thaat_info.get("thaat"):
        label_with_thaat = f"{best_tonic} {best_scale} · {thaat_info['thaat']} thaat"
    else:
        label_with_thaat = label

    return {
        "tonic":        best_tonic,
        "tonic_hz":     tonic_hz,
        "scale":        best_scale,
        "label":        label,
        "label_full":   label_with_thaat,
        "confidence":   confidence,
        "thaat":        thaat_info.get("thaat"),
        "thaat_alt":    thaat_info.get("thaat_alt"),
        "thaat_scores": thaat_info.get("thaat_scores", {}),
        "votes":        [{k: v for k, v in vote.items() if k not in ("hpcp", "tonic_hz")}
                         for vote in votes],
    }


# ── Public API ────────────────────────────────────────────────────────────────

def detect(
    vocals_path: Path,
    others_path: Path | None = None,
    source_path: Path | None = None,
) -> dict:
    """
    Detect musical key + thaat using an ensemble of signals.

    Args:
        vocals_path:  Vocals stem (tonic most clear in singing)
        others_path:  Instruments stem (harmonic cross-validation)
        source_path:  Full source mix (last-resort fallback)
    """
    try:
        import essentia.standard  # noqa: F401
    except ImportError:
        logger.error("key_detection: essentia is not installed")
        return _empty()

    vocals = _active_audio(vocals_path)
    others = _active_audio(others_path)
    source = _active_audio(source_path)

    votes: list[dict] = []

    # Signal 1 — TonicIndianArtMusic (highest weight, domain-specific)
    if vocals is not None:
        votes += _votes_from_tonic_indian(vocals, "vocals", weight=1.8)
    if source is not None:
        votes += _votes_from_tonic_indian(source, "source", weight=1.4)

    # Signal 2 — KeyExtractor (cross-validation, also provides HPCP for thaat)
    if vocals is not None:
        votes += _votes_from_key_extractor(vocals, "vocals", weight=1.0)
    if others is not None:
        votes += _votes_from_key_extractor(others, "others", weight=1.2)
    if source is not None:
        votes += _votes_from_key_extractor(source, "source", weight=0.9)

    if not votes:
        logger.warning("key_detection: no votes collected — all sources silent or failed")
        return _empty()

    return _aggregate(votes)


def _empty() -> dict:
    return {
        "tonic": None, "tonic_hz": None, "scale": None, "label": None, "label_full": None,
        "confidence": 0.0, "thaat": None, "thaat_alt": None,
        "thaat_scores": {}, "votes": [],
    }


# ── Note timeline detection ────────────────────────────────────────────────────

# Indian swara names, index 0 = Sa (tonic) after rotation
# Notation: lowercase = komal, M' = tivra Ma
_SWARA_NAMES = ["S", "r", "R", "g", "G", "M", "M'", "P", "d", "D", "n", "N"]


def _format_swara(swara_idx: int, octave_offset: int) -> str:
    """Apply dot notation for octave: 'S.' = higher octave, '.N' = lower octave."""
    name = _SWARA_NAMES[swara_idx % 12]
    dots = abs(octave_offset)
    if octave_offset > 0:
        return name + "." * dots      # S.  R.  etc.
    elif octave_offset < 0:
        return "." * dots + name      # .N  .n  etc.
    return name

# Minimum HPCP energy (after normalisation) for a frame to be labelled
_NOTE_FRAME_THRESHOLD = 0.12

# Minimum segment duration (seconds) — shorter runs are merged into neighbours
_MIN_NOTE_DURATION = 0.15


def detect_note_timeline(vocals_path: Path, tonic_note: str,
                         tonic_hz: float | None = None,
                         frame_size: int = 4096, hop_size: int = 2048) -> list[dict]:
    """
    Detect the dominant Indian swara at each time frame from the vocals stem.

    When tonic_hz is supplied, uses PitchYinFFT for frame-by-frame pitch
    detection so octave information is preserved and dot notation is applied:
        S.  R.  G.  …   = higher octave
        S   R   G   …   = middle octave
        .N  .n  .D  …   = lower octave

    When tonic_hz is absent, falls back to HPCP (octave-invariant) and
    returns notes in middle-octave notation only.

    Returns a list of non-overlapping segments:
        [{"time": 0.00, "end": 1.20, "note": "S"}, …]
    Consecutive identical notes are merged.
    Segments shorter than _MIN_NOTE_DURATION are dropped.
    """
    try:
        import essentia.standard as es
    except ImportError:
        logger.warning("key_detection: essentia not available — note timeline skipped")
        return []

    audio = _active_audio(vocals_path)
    if audio is None:
        return []

    try:
        tonic_idx = _NOTE_NAMES.index(tonic_note)
    except ValueError:
        logger.warning("key_detection: unknown tonic %r — note timeline skipped", tonic_note)
        return []

    use_pitch = tonic_hz is not None and tonic_hz > 0

    try:
        windowing   = es.Windowing(type="blackmanharris62")
        spectrum_fn = es.Spectrum()
        frames_gen  = es.FrameGenerator(audio, frameSize=frame_size,
                                        hopSize=hop_size, startFromZero=True)
        hop_time   = hop_size / _SR
        frame_time = 0.0
        raw_events: list[tuple[float, str]] = []

        if use_pitch:
            # Pitch-based: PitchYinFFT gives Hz per frame → octave-aware swaras
            pitch_fn = es.PitchYinFFT(frameSize=frame_size, sampleRate=_SR)
            for frame in frames_gen:
                spec = spectrum_fn(windowing(frame))
                pitch_hz_val, pitch_conf = pitch_fn(spec)
                if pitch_hz_val > 0 and pitch_conf >= 0.1:
                    semitones = 12 * math.log2(pitch_hz_val / tonic_hz)
                    total_st  = round(semitones)
                    swara_idx = total_st % 12          # 0–11, Python % always ≥ 0
                    octave    = total_st // 12          # 0 = same, 1 = higher, -1 = lower
                    octave    = max(-2, min(2, octave)) # clamp to ±2 octaves
                    raw_events.append((frame_time, _format_swara(swara_idx, octave)))
                frame_time += hop_time
        else:
            # HPCP-based fallback: no octave info, middle-octave notation
            spec_peaks = es.SpectralPeaks(orderBy="magnitude", maxPeaks=60,
                                          minFrequency=40, maxFrequency=5000)
            hpcp_fn    = es.HPCP(size=12, referenceFrequency=440,
                                  minFrequency=40, maxFrequency=5000)
            for frame in frames_gen:
                spec        = spectrum_fn(windowing(frame))
                freqs, mags = spec_peaks(spec)
                if len(freqs):
                    hpcp     = hpcp_fn(freqs, mags)
                    rotated  = np.roll(hpcp, -tonic_idx)
                    hpcp_sum = float(rotated.sum())
                    if hpcp_sum > 1e-9:
                        rotated_norm = rotated / hpcp_sum
                        if float(rotated_norm.max()) >= _NOTE_FRAME_THRESHOLD:
                            dominant_bin = int(np.argmax(rotated_norm))
                            raw_events.append((frame_time, _SWARA_NAMES[dominant_bin]))
                frame_time += hop_time

        if not raw_events:
            return []

        # Merge consecutive identical notes into segments
        segments: list[dict] = []
        cur_note  = raw_events[0][1]
        cur_start = raw_events[0][0]
        cur_end   = raw_events[0][0]

        for t, note in raw_events[1:]:
            if note == cur_note:
                cur_end = t
            else:
                if cur_end + hop_time - cur_start >= _MIN_NOTE_DURATION:
                    segments.append({
                        "time": round(cur_start, 3),
                        "end":  round(cur_end + hop_time, 3),
                        "note": cur_note,
                    })
                cur_note  = note
                cur_start = t
                cur_end   = t

        if cur_end + hop_time - cur_start >= _MIN_NOTE_DURATION:
            segments.append({
                "time": round(cur_start, 3),
                "end":  round(cur_end + hop_time, 3),
                "note": cur_note,
            })

        logger.info("key_detection: note_timeline (%s) — %d segments from %s",
                    "pitch" if use_pitch else "hpcp", len(segments), vocals_path.name)
        return segments

    except Exception as exc:
        logger.warning("key_detection: detect_note_timeline failed — %s", exc)
        return []
