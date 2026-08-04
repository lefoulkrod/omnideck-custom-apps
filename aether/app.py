"""
Aether — Backend Actions

Manages saved world presets: interaction matrices, particle counts,
and simulation parameters. Each preset is a named "world" that can be
loaded back into the frontend simulation.
"""

import json
import random
import time
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)
PRESETS_FILE = DATA_DIR / "presets.json"


def _load_presets() -> dict:
    """Load all presets from disk."""
    if PRESETS_FILE.exists():
        return json.loads(PRESETS_FILE.read_text())
    return {}


def _save_presets(presets: dict) -> None:
    """Persist presets to disk."""
    PRESETS_FILE.write_text(json.dumps(presets, indent=2))


def get_presets() -> dict:
    """Return all saved world presets, sorted by most recently updated."""
    presets = _load_presets()
    items = sorted(
        presets.values(),
        key=lambda p: p.get("updated_at", 0),
        reverse=True,
    )
    return {"presets": items, "count": len(items)}


def save_preset(
    name: str,
    num_types: int = 4,
    interactions: list = None,
    params: dict = None,
) -> dict:
    """
    Save (or overwrite) a named world preset.

    Args:
        name: Unique name for this world.
        num_types: Number of particle types.
        interactions: Flat list of interaction values (num_types * num_types).
        params: Simulation parameters dict (r_max, force_strength, friction, etc.).
    """
    if not name or not name.strip():
        return {"error": "Name is required"}
    name = name.strip()[:60]

    presets = _load_presets()
    now = time.time()
    is_new = name not in presets

    preset = {
        "name": name,
        "num_types": num_types,
        "interactions": interactions or [],
        "params": params or {},
        "created_at": presets.get(name, {}).get("created_at", now),
        "updated_at": now,
    }
    presets[name] = preset
    _save_presets(presets)

    return {"preset": preset, "created": is_new, "count": len(presets)}


def load_preset(name: str) -> dict:
    """Load a single preset by name."""
    presets = _load_presets()
    if name not in presets:
        return {"error": f"Preset '{name}' not found"}
    return {"preset": presets[name]}


def delete_preset(name: str) -> dict:
    """Delete a preset by name."""
    presets = _load_presets()
    if name not in presets:
        return {"error": f"Preset '{name}' not found"}
    del presets[name]
    _save_presets(presets)
    return {"deleted": name, "count": len(presets)}


def generate_rules(num_types: int = 4, seed: int = None) -> dict:
    """
    Generate a random interaction matrix for the particle simulation.
    Uses a seed for reproducibility if provided.

    Returns a flat list of num_types * num_types values in [-1, 1].
    """
    num_types = max(2, min(8, num_types))
    rng = random.Random(seed)
    interactions = []
    for i in range(num_types):
        for j in range(num_types):
            # Bias toward smaller values for more stable emergent behavior
            val = (rng.random() * 2 - 1) * 0.8
            interactions.append(round(val, 4))
    return {
        "num_types": num_types,
        "interactions": interactions,
        "seed": seed if seed is not None else rng.randint(0, 999999),
    }


def get_stats() -> dict:
    """Return summary statistics about saved presets."""
    presets = _load_presets()
    total = len(presets)
    type_counts = {}
    for p in presets.values():
        nt = p.get("num_types", 0)
        type_counts[nt] = type_counts.get(nt, 0) + 1
    return {
        "total_presets": total,
        "type_distribution": type_counts,
    }


actions = {
    "get_presets": get_presets,
    "save_preset": save_preset,
    "load_preset": load_preset,
    "delete_preset": delete_preset,
    "generate_rules": generate_rules,
    "get_stats": get_stats,
}