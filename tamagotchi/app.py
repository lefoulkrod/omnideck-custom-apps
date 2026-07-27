"""
Tamagotchi Custom App Backend
Handles pet state persistence and game logic actions.
"""
import json
import os
import time
import random

from custom_apps import action

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
STATE_FILE = os.path.join(DATA_DIR, "pet.json")

# --- Pet lifecycle constants ---
STAT_DECAY_INTERVAL = 60       # seconds between stat decay ticks
HUNGER_DECAY = 3
HAPPINESS_DECAY = 2
ENERGY_DECAY = 1
HEALTH_DECAY_WHEN_STARVING = 5
HEALTH_REGEN_WHEN_HEALTHY = 2

EGG_AUTO_HATCH_SECONDS = 30    # auto-hatch after this many seconds
EGG_TAP_WARMUP = 3            # taps needed to hatch (accumulated)

# --- Pet species ---
# Each species has evolution stages with emoji + name.
# The pet starts as an egg, hatches into a baby, then grows through stages.
PET_SPECIES = [
    {
        "species": "Cat",
        "stages": [
            {"name": "Kitten",  "min_age": 0,  "emoji": "🐱"},
            {"name": "Cat",     "min_age": 6,  "emoji": "😺"},
            {"name": "Tomcat",  "min_age": 24, "emoji": "😸"},
            {"name": "Elder",   "min_age": 72, "emoji": "🙀"},
        ],
    },
    {
        "species": "Dog",
        "stages": [
            {"name": "Puppy",   "min_age": 0,  "emoji": "🐶"},
            {"name": "Dog",     "min_age": 6,  "emoji": "🐕"},
            {"name": "Good Boy","min_age": 24, "emoji": "🦮"},
            {"name": "Elder",   "min_age": 72, "emoji": "🐩"},
        ],
    },
    {
        "species": "Bunny",
        "stages": [
            {"name": "Bunny",   "min_age": 0,  "emoji": "🐰"},
            {"name": "Rabbit",  "min_age": 6,  "emoji": "🐇"},
            {"name": "Hare",    "min_age": 24, "emoji": "🐇"},
            {"name": "Elder",   "min_age": 72, "emoji": "🐰"},
        ],
    },
    {
        "species": "Dragon",
        "stages": [
            {"name": "Hatchling","min_age": 0, "emoji": "🐲"},
            {"name": "Drake",   "min_age": 6,  "emoji": "🐉"},
            {"name": "Dragon",  "min_age": 24, "emoji": "🐉"},
            {"name": "Ancient",  "min_age": 72, "emoji": "🐲"},
        ],
    },
    {
        "species": "Penguin",
        "stages": [
            {"name": "Chick",   "min_age": 0,  "emoji": "🐤"},
            {"name": "Penguin", "min_age": 6,  "emoji": "🐧"},
            {"name": "Emperor", "min_age": 24, "emoji": "🐧"},
            {"name": "Elder",   "min_age": 72, "emoji": "🐤"},
        ],
    },
    {
        "species": "Hamster",
        "stages": [
            {"name": "Niblet",  "min_age": 0,  "emoji": "🐹"},
            {"name": "Hamster", "min_age": 6,  "emoji": "🐹"},
            {"name": "Chonk",   "min_age": 24, "emoji": "🐭"},
            {"name": "Elder",   "min_age": 72, "emoji": "🐹"},
        ],
    },
    {
        "species": "Frog",
        "stages": [
            {"name": "Tadpole", "min_age": 0,  "emoji": "🐸"},
            {"name": "Froglet", "min_age": 6,  "emoji": "🐸"},
            {"name": "Frog",    "min_age": 24, "emoji": "🐸"},
            {"name": "Elder",   "min_age": 72, "emoji": "🐸"},
        ],
    },
    {
        "species": "Fox",
        "stages": [
            {"name": "Kit",     "min_age": 0,  "emoji": "🦊"},
            {"name": "Fox",     "min_age": 6,  "emoji": "🦊"},
            {"name": "Vixen",   "min_age": 24, "emoji": "🦊"},
            {"name": "Elder",   "min_age": 72, "emoji": "🦊"},
        ],
    },
    {
        "species": "Bear",
        "stages": [
            {"name": "Cub",     "min_age": 0,  "emoji": "🐻"},
            {"name": "Bear",    "min_age": 6,  "emoji": "🐻"},
            {"name": "Grizzly", "min_age": 24, "emoji": "🐻"},
            {"name": "Elder",   "min_age": 72, "emoji": "🐻"},
        ],
    },
    {
        "species": "Duck",
        "stages": [
            {"name": "Duckling","min_age": 0,  "emoji": "🦆"},
            {"name": "Duck",    "min_age": 6,  "emoji": "🦆"},
            {"name": "Mallard", "min_age": 24, "emoji": "🦆"},
            {"name": "Elder",   "min_age": 72, "emoji": "🦆"},
        ],
    },
    {
        "species": "Unicorn",
        "rare": True,
        "stages": [
            {"name": "Foal",    "min_age": 0,  "emoji": "🦄"},
            {"name": "Unicorn", "min_age": 6,  "emoji": "🦄"},
            {"name": "Majestic","min_age": 24, "emoji": "🦄"},
            {"name": "Legend",  "min_age": 72, "emoji": "🦄"},
        ],
    },
]

# --- Rarity weights ---
# Common species: weight 10 each. Rare species: weight 1.
# With 10 common + 1 rare (unicorn), unicorn chance = 1/101 ≈ 1%.
SPECIES_WEIGHTS = []
for s in PET_SPECIES:
    weight = 1 if s.get("rare") else 10
    SPECIES_WEIGHTS.append((s, weight))

# --- Helpers ---

def _ensure_data_dir():
    os.makedirs(DATA_DIR, exist_ok=True)

def _load_state():
    _ensure_data_dir()
    if not os.path.exists(STATE_FILE):
        return None
    try:
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return None

def _save_state(state):
    _ensure_data_dir()
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)

def _clamp(val, lo=0, hi=100):
    return max(lo, min(hi, val))

def _age_hours(born_ts):
    return (time.time() - born_ts) / 3600.0

def _get_species(species_name):
    for s in PET_SPECIES:
        if s["species"] == species_name:
            return s
    return PET_SPECIES[0]  # fallback

def _get_stage(state):
    """Get current evolution stage based on species and age."""
    species = _get_species(state.get("species", "Cat"))
    age_h = _age_hours(state["born"])
    stage = species["stages"][0]
    for s in species["stages"]:
        if age_h >= s["min_age"]:
            stage = s
    return stage

def _apply_decay(state):
    """Apply time-based stat decay based on elapsed ticks since last update."""
    now = time.time()
    last = state.get("last_update", now)
    elapsed = now - last
    ticks = int(elapsed // STAT_DECAY_INTERVAL)

    if ticks > 0:
        for _ in range(ticks):
            state["hunger"] = _clamp(state["hunger"] - HUNGER_DECAY)
            state["happiness"] = _clamp(state["happiness"] - HAPPINESS_DECAY)
            state["energy"] = _clamp(state["energy"] - ENERGY_DECAY)

            # Health logic
            if state["hunger"] <= 0 or state["happiness"] <= 0:
                state["health"] = _clamp(state["health"] - HEALTH_DECAY_WHEN_STARVING)
            elif state["hunger"] > 50 and state["happiness"] > 50 and state["energy"] > 20:
                state["health"] = _clamp(state["health"] + HEALTH_REGEN_WHEN_HEALTHY)

        # Check death
        if state["health"] <= 0:
            state["alive"] = False

        state["last_update"] = now

    return state

def _new_egg(name="Pixel"):
    """Create a new egg — not yet hatched."""
    now = time.time()
    return {
        "name": name,
        "species": None,          # assigned at hatch time
        "born": now,
        "created": now,
        "last_update": now,
        "hatched": False,
        "hatch_time": None,
        "egg_taps": 0,
        "hunger": 80,
        "happiness": 80,
        "energy": 80,
        "health": 100,
        "alive": True,
        "poop": False,
        "poop_count": 0,
        "sick": False,
        "sleeping": False,
        "sleep_start": None,
        "total_feedings": 0,
        "total_plays": 0,
        "total_cleanups": 0,
        "total_meds": 0,
    }

def _enrich(state):
    """Add computed fields for the frontend."""
    if state is None:
        return None

    age_h = _age_hours(state["born"])

    if not state.get("hatched", False):
        # Still an egg
        state["age_hours"] = round(age_h, 2)
        state["stage_name"] = "Egg"
        state["stage_emoji"] = "🥚"
        state["species"] = None
        state["species_name"] = None
        state["age_display"] = _format_age(age_h)
        state["can_hatch"] = (time.time() - state.get("created", time.time())) >= EGG_AUTO_HATCH_SECONDS
        state["taps_needed"] = EGG_TAP_WARMUP
        state["taps_current"] = state.get("egg_taps", 0)
        return state

    # Hatched — compute stage from species
    stage = _get_stage(state)
    state["age_hours"] = round(age_h, 2)
    state["stage_name"] = stage["name"]
    state["stage_emoji"] = stage["emoji"]
    state["species_name"] = state.get("species", "Unknown")
    state["age_display"] = _format_age(age_h)
    state["can_hatch"] = False
    return state

def _format_age(hours):
    if hours < 1:
        return f"{int(hours * 60)}m"
    elif hours < 24:
        h = int(hours)
        m = int((hours - h) * 60)
        return f"{h}h {m}m"
    else:
        d = int(hours // 24)
        h = int(hours % 24)
        return f"{d}d {h}h"

# --- Actions ---

@action
def get_state():
    """Get the current pet state, applying time-based decay first."""
    state = _load_state()
    if state is None:
        return {"exists": False}
    # Only apply decay if hatched
    if state.get("hatched", False):
        state = _apply_decay(state)
    _save_state(state)
    return _enrich(state)

@action
def create_pet(name: str = "Pixel"):
    """Create a new egg. Overwrites any existing pet."""
    state = _new_egg(name)
    _save_state(state)
    return _enrich(state)

@action
def tap_egg():
    """Tap the egg to try to hatch it. Needs EGG_TAP_WARMUP taps, or auto-hatches after EGG_AUTO_HATCH_SECONDS."""
    state = _load_state()
    if state is None:
        return {"error": "No pet exists. Create one first!"}
    if state.get("hatched", False):
        return _enrich(state)

    state["egg_taps"] = state.get("egg_taps", 0) + 1
    now = time.time()
    elapsed = now - state.get("created", now)

    # Auto-hatch after timeout, or manual hatch after enough taps
    if state["egg_taps"] >= EGG_TAP_WARMUP or elapsed >= EGG_AUTO_HATCH_SECONDS:
        return _do_hatch(state)

    _save_state(state)
    return _enrich(state)

def _do_hatch(state):
    """Hatch the egg — assign a random species (weighted by rarity)."""
    species_list = [s for s, _ in SPECIES_WEIGHTS]
    weights = [w for _, w in SPECIES_WEIGHTS]
    species = random.choices(species_list, weights=weights, k=1)[0]
    state["species"] = species["species"]
    state["rare"] = species.get("rare", False)
    state["hatched"] = True
    state["hatch_time"] = time.time()
    state["born"] = time.time()  # reset age from hatch
    state["last_update"] = time.time()
    _save_state(state)
    enriched = _enrich(state)
    enriched["just_hatched"] = True
    return enriched

@action
def feed():
    """Feed the pet. Reduces hunger, boosts happiness slightly."""
    state = _load_state()
    if state is None:
        return {"error": "No pet exists. Create one first!"}
    if not state.get("hatched", False):
        return {"error": "Your egg hasn't hatched yet! Tap it! 🥚"}
    state = _apply_decay(state)
    if not state["alive"]:
        return {"error": f"{state['name']} has passed away... 💀"}
    if state["sleeping"]:
        return {"error": f"{state['name']} is sleeping! Can't feed right now. 😴"}

    state["hunger"] = _clamp(state["hunger"] + 25)
    state["happiness"] = _clamp(state["happiness"] + 5)
    state["energy"] = _clamp(state["energy"] + 3)
    state["total_feedings"] += 1

    # Overfeeding can cause sickness
    if state["hunger"] >= 100 and random.random() < 0.3:
        state["sick"] = True

    _save_state(state)
    return _enrich(state)

@action
def play():
    """Play with the pet. Boosts happiness, costs energy, increases hunger."""
    state = _load_state()
    if state is None:
        return {"error": "No pet exists. Create one first!"}
    if not state.get("hatched", False):
        return {"error": "Your egg hasn't hatched yet! Tap it! 🥚"}
    state = _apply_decay(state)
    if not state["alive"]:
        return {"error": f"{state['name']} has passed away... 💀"}
    if state["sleeping"]:
        return {"error": f"{state['name']} is sleeping! Can't play right now. 😴"}
    if state["energy"] < 10:
        return {"error": f"{state['name']} is too tired to play! Let it rest. 😴"}

    state["happiness"] = _clamp(state["happiness"] + 20)
    state["energy"] = _clamp(state["energy"] - 15)
    state["hunger"] = _clamp(state["hunger"] - 5)
    state["total_plays"] += 1

    _save_state(state)
    return _enrich(state)

@action
def cleanup():
    """Clean up poop. Boosts happiness and health."""
    state = _load_state()
    if state is None:
        return {"error": "No pet exists. Create one first!"}
    if not state.get("hatched", False):
        return {"error": "Your egg hasn't hatched yet! Tap it! 🥚"}
    state = _apply_decay(state)
    if not state["alive"]:
        return {"error": f"{state['name']} has passed away... 💀"}

    if state["poop"]:
        state["poop"] = False
        state["happiness"] = _clamp(state["happiness"] + 10)
        state["health"] = _clamp(state["health"] + 5)
        state["total_cleanups"] += 1
    else:
        return {"error": f"Nothing to clean up! {state['name']} is clean. ✨"}

    _save_state(state)
    return _enrich(state)

@action
def medicine():
    """Give medicine to cure sickness."""
    state = _load_state()
    if state is None:
        return {"error": "No pet exists. Create one first!"}
    if not state.get("hatched", False):
        return {"error": "Your egg hasn't hatched yet! Tap it! 🥚"}
    state = _apply_decay(state)
    if not state["alive"]:
        return {"error": f"{state['name']} has passed away... 💀"}

    if state["sick"]:
        state["sick"] = False
        state["health"] = _clamp(state["health"] + 10)
        state["total_meds"] += 1
    else:
        return {"error": f"{state['name']} isn't sick! No medicine needed. 💊"}

    _save_state(state)
    return _enrich(state)

@action
def toggle_sleep():
    """Toggle sleep state. Sleeping restores energy over time."""
    state = _load_state()
    if state is None:
        return {"error": "No pet exists. Create one first!"}
    if not state.get("hatched", False):
        return {"error": "Your egg hasn't hatched yet! Tap it! 🥚"}
    state = _apply_decay(state)
    if not state["alive"]:
        return {"error": f"{state['name']} has passed away... 💀"}

    if state["sleeping"]:
        # Wake up
        state["sleeping"] = False
        # Restore energy based on sleep duration
        if state["sleep_start"]:
            sleep_dur = time.time() - state["sleep_start"]
            energy_gain = int(sleep_dur / 10)  # 1 energy per 10 seconds of sleep
            state["energy"] = _clamp(state["energy"] + energy_gain)
        state["sleep_start"] = None
    else:
        # Go to sleep
        state["sleeping"] = True
        state["sleep_start"] = time.time()

    _save_state(state)
    return _enrich(state)

@action
def revive():
    """Revive a dead pet with a fresh start (keeps the same name)."""
    state = _load_state()
    if state is None:
        return {"error": "No pet exists. Create one first!"}

    name = state.get("name", "Pixel")
    state = _new_egg(name)
    _save_state(state)
    return _enrich(state)

@action
def reset():
    """Delete the current pet entirely."""
    _ensure_data_dir()
    if os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)
    return {"deleted": True}

@action
def check_poop():
    """Random chance for the pet to poop. Called periodically by frontend."""
    state = _load_state()
    if state is None:
        return {"error": "No pet exists."}
    if not state.get("hatched", False):
        return _enrich(state)
    state = _apply_decay(state)
    if not state["alive"]:
        return _enrich(state)

    if not state["poop"] and not state["sleeping"]:
        if random.random() < 0.15:
            state["poop"] = True
            state["poop_count"] += 1
            # Uncleaned poop makes pet unhappy
            state["happiness"] = _clamp(state["happiness"] - 5)

    _save_state(state)
    return _enrich(state)

@action
def list_species():
    """List all available pet species with rarity info."""
    return [
        {
            "species": s["species"],
            "baby_emoji": s["stages"][0]["emoji"],
            "rare": s.get("rare", False),
        }
        for s in PET_SPECIES
    ]
