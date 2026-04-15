"""
Admin-controllable application configuration.

Settings are persisted to a JSON file so they survive restarts.
Call init() once at startup with the desired config file path.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

_lock = threading.Lock()
_path: Path | None = None

# All supported keys and their defaults
_DEFAULTS: dict = {
    # Feature toggles
    "enable_bpm_detection": True,
    "enable_key_detection": True,
    "enable_note_timeline": True,
    "auto_analyse_on_open": True,

    # BPM detection
    "bpm_change_threshold": 7.0,       # BPM difference to count as a tempo change
    "bpm_min_segment_beats": 12,        # minimum beats a segment must span

    # Key / thaat detection
    "note_energy_threshold": 0.12,      # min HPCP energy to label a frame
    "note_min_duration": 0.15,          # min note segment duration (seconds)
    "thaat_penalty": 0.9,               # penalty for energy at non-thaat notes
}

_config: dict = dict(_DEFAULTS)


def init(config_path: Path) -> None:
    global _path, _config
    _path = config_path
    if config_path.exists():
        try:
            with open(config_path) as f:
                saved = json.load(f)
            _config = {**_DEFAULTS, **{k: v for k, v in saved.items() if k in _DEFAULTS}}
        except Exception:
            _config = dict(_DEFAULTS)
    else:
        _config = dict(_DEFAULTS)


def get(key: str, default=None):
    return _config.get(key, default)


def get_all() -> dict:
    with _lock:
        return dict(_config)


def update(updates: dict) -> dict:
    """Update one or more config keys and persist to disk. Returns the new config."""
    with _lock:
        for k, v in updates.items():
            if k not in _DEFAULTS:
                continue
            # Coerce to the same type as the default
            try:
                default_val = _DEFAULTS[k]
                if isinstance(default_val, bool):
                    _config[k] = bool(v)
                elif isinstance(default_val, int):
                    _config[k] = int(v)
                elif isinstance(default_val, float):
                    _config[k] = float(v)
                else:
                    _config[k] = v
            except (TypeError, ValueError):
                pass
        if _path:
            try:
                _path.write_text(json.dumps(_config, indent=2))
            except Exception:
                pass
        return dict(_config)


def reset_to_defaults() -> dict:
    """Reset all settings to their default values."""
    with _lock:
        _config.clear()
        _config.update(_DEFAULTS)
        if _path:
            try:
                _path.write_text(json.dumps(_config, indent=2))
            except Exception:
                pass
        return dict(_config)
