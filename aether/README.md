# Aether — Generative Particle Ecosystem

A custom Omnideck app where particles of different types interact via
attraction/repulsion rules (Particle Life algorithm), producing emergent
life-like behaviors — and those interactions generate music in real-time
via the Web Audio API.

## What It Does

- **Particle Life Simulation**: Particles interact based on a random
  interaction matrix. Each pair of particle types has an attraction or
  repulsion force, creating emergent patterns: clusters, chains,
  oscillators, predator-prey dynamics, and more.

- **Generative Audio**: When particles interact strongly, they trigger
  musical notes. Each particle type maps to a different synth voice
  (sine, triangle, sawtooth). Notes are selected from a musical scale
  (pentatonic, dorian, lydian, etc.) so the result is always harmonious.
  Includes reverb and delay for atmospheric depth.

- **Save/Load Worlds**: Named presets capture the interaction matrix and
  simulation parameters. Save interesting worlds and reload them later.
  Presets persist on disk via the Python backend.

- **Live Interaction**: Click anywhere on the canvas to add a burst of
  particles. Adjust sliders in real-time to tune the simulation.

## Architecture

```
aether/
├── omnideck.json          App manifest
├── app.py                 Backend: preset management + rule generation
├── data/
│   └── presets.json       Saved world presets (created at runtime)
├── web/
│   ├── index.html         Main page
│   ├── app.css            Neon dark aesthetic
│   └── app.js             Simulation + audio engine + UI + backend calls
└── tests/
    └── test_backend.py    Unit tests for all backend actions
```

### Backend Actions (app.py)

| Action | Description |
|--------|-------------|
| `get_presets` | List all saved world presets |
| `save_preset` | Save/overwrite a named world |
| `load_preset` | Load a preset by name |
| `delete_preset` | Delete a preset by name |
| `generate_rules` | Generate a random interaction matrix (seeded) |
| `get_stats` | Summary statistics about saved presets |

### Frontend (app.js)

- Particle Life algorithm with O(n²) interaction computation
- Canvas 2D rendering with glow effects and motion trails
- Web Audio API: oscillators → filter → envelope → reverb/delay
- 5 musical scales, 7 root notes, 8 particle types
- Real-time interaction matrix visualization
- Click-to-add-particles interaction

## Testing

```bash
cd /home/omnideck/apps/aether
python tests/test_backend.py
```

10 unit tests covering: rule generation, preset CRUD, persistence,
error handling, and action exports.