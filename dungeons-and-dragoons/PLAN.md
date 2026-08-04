# Dungeons & Dragoons — Build Plan

A Contra-style run-and-gun side scroller with a D&D fantasy skin, as an Omnideck Custom App.

## Concept
You are a **Dragoon** — a spell-slinging mercenary raiding a dungeon. Run, jump,
shoot in 8 directions, collect spell upgrades, kill monsters, beat the floor boss.

- **Movement**: run L/R, jump, duck, aim up/diagonal/down-while-jumping (Contra rules)
- **Weapons (spells)**: Arcane Bolt (default), Fire Spread (shotgun), Lightning Beam
  (piercing rapid), Frost Shard (slow, heavy dmg + freezes)
- **Enemies**: Goblin (runner), Skeleton Archer (stationary shooter), Bat (sine flyer),
  Slime (hopper), Imp (dive bomber), Boss: Wyrmling (multi-phase dragon)
- **Stages**: 3 stages (Crypt, Lava Forge, Dragon's Roost) each ending in a boss
- **Lives / HP**: 3 lives, 3 hearts each, checkpoints at mid-stage
- **Score**: kills + pickups + time bonus; persisted high scores via Python action

## Tech
- Native HTML/CSS/JS, ES modules, single `<canvas>` (960x540 internal, integer-scaled)
- Fixed timestep 60Hz simulation, decoupled render
- Procedurally generated pixel-art sprites (no binary assets) drawn to offscreen canvases
- WebAudio synthesized SFX + music (no audio files)
- `app.py` actions: `load_scores`, `save_score`, `load_progress`, `save_progress`

## File layout
```
dungeons-and-dragoons/
  omnideck.json
  app.py
  PLAN.md
  data/                 # scores.json, progress.json
  web/
    index.html
    css/style.css
    js/
      main.js           # boot, scene manager, menus
      engine.js         # loop, input, camera, collision helpers, particles
      sprites.js        # procedural sprite atlas  (SUB-AGENT A)
      audio.js          # WebAudio sfx + music     (SUB-AGENT B)
      entities.js       # player, enemies, projectiles, pickups
      boss.js           # boss state machines
      levels.js         # tilemap level data + generator
      hud.js            # HUD, menus, overlays
  tests/
    run_tests.mjs       # node unit tests for pure logic
```

## Work breakdown
| # | Item | Owner | Status |
|---|------|-------|--------|
| 1 | Scaffold + manifest + plan | me | done |
| 2 | engine.js (loop/input/camera/collision/particles) | me | done |
| 3 | sprites.js procedural art | sub-agent A | done |
| 4 | audio.js chiptune engine | sub-agent B | done |
| 5 | levels.js tilemaps + 3 stages | me | done |
| 6 | entities.js player + enemies + weapons | me | done |
| 7 | boss.js 3 bosses | me | done |
| 8 | hud.js + menus | me | done |
| 9 | main.js scene wiring | me | done |
| 10 | app.py score/progress persistence | me | done |
| 11 | Unit tests (physics, collision, weapons, level parse) | me | done |
| 12 | Integration: load in browser, play through | me | done |
| 13 | Polish pass + send files | me | done |

## Interfaces (contract for sub-agents)

### sprites.js
```js
export const Sprites = {
  ready: Promise<void>,
  init(): Promise<void>,
  get(name: string, frame: number = 0): HTMLCanvasElement,
  frameCount(name: string): number,
  names(): string[],
}
```
Required sprite names + frame counts documented in the sub-agent brief.

### audio.js
```js
export const Audio = {
  init(): void,            // must be called from a user gesture
  play(name: string, opts?: {vol?:number, rate?:number}): void,
  music(track: 'menu'|'stage1'|'stage2'|'stage3'|'boss'|null): void,
  setMuted(b: boolean): void,
  isMuted(): boolean,
}
```

## Test strategy
- **Unit** (node, `tests/run_tests.mjs`): AABB collision, tile collision resolution,
  gravity/jump arcs, weapon fire patterns, damage/invuln timing, level parsing,
  score computation. Pure-logic modules must not touch `window` at import time.
- **Integration**: serve app, open in browser, verify boot → menu → stage 1 loads,
  player moves/shoots/takes damage, boss spawns, score saves via Python action.
- **Manual**: play through stage 1 in-browser via scripted input injection.
