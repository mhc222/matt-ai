"""Human-like timing utilities used by all BrowserUse action scripts."""
import json
import random
import time
from pathlib import Path

_cfg_cache: dict | None = None


def _cfg() -> dict:
    global _cfg_cache
    if _cfg_cache is None:
        cfg_path = Path(__file__).parent.parent.parent / "config" / "settings.json"
        _cfg_cache = json.loads(cfg_path.read_text())["browser"]
    return _cfg_cache


def jitter(min_s: float | None = None, max_s: float | None = None) -> None:
    cfg = _cfg()
    lo = min_s if min_s is not None else cfg["min_action_delay_s"]
    hi = max_s if max_s is not None else cfg["max_action_delay_s"]
    time.sleep(random.uniform(lo, hi))


def pre_action() -> None:
    """Short pause after page load, before interacting."""
    jitter(1.5, 3.5)


def post_action() -> None:
    """Pause after completing an action."""
    jitter(2.0, 6.0)


def between_items() -> None:
    """Longer pause between processing multiple items in a batch.
    Prevents sending 20 emails in 60 seconds.
    """
    cfg = _cfg()
    jitter(cfg["between_items_min_s"], cfg["between_items_max_s"])


def typing_delay_s() -> float:
    """Per-keystroke delay in seconds (80–150 ms range = ~80–120 WPM)."""
    cfg = _cfg()
    lo = cfg["min_typing_delay_ms"] / 1000
    hi = cfg["max_typing_delay_ms"] / 1000
    return random.uniform(lo, hi)
