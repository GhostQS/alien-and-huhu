# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Alien & HuHu: Neon Run** — a 3D sci-fi/cyber three-lane endless runner built on three.js.
The original 2D canvas game is preserved verbatim at `classic.html`.

Hard constraint that shapes every design decision: **there are no asset files**. Every mesh,
texture, sound and musical note is generated procedurally at runtime. No `.gltf`, `.png`, `.mp3`,
no CDN, no web fonts. three.js is vendored under `vendor/three/` so the game also runs offline.

## Running the game

ES modules need a server (`file://` will not work — the import map and module fetches are
blocked by CORS). Configured in `.claude/launch.json`:

```bash
node tools/devserver.mjs .
```

Then open http://localhost:3721. Any static server works; `npx serve -l 3721 .` is fine too.

No build step, no dependencies, no package manager.

### tools/devserver.mjs

A static server that also accepts `POST /__shot` and writes a JPEG into `.shots/`. It exists
because **automated screenshots cannot capture a WebGL surface** — the page reads pixels back
from the framebuffer itself and posts them. It also mirrors `npx serve`'s extensionless-path
resolution, which the preview tooling relies on.

## Verifying changes

`requestAnimationFrame` is suspended while a tab is hidden, so the frame loop does not advance
under automation. `src/main.js` exposes a dev surface for this:

```js
__step(n, dt)   // advance the simulation n frames manually
__save(name)    // render + read back pixels + POST to /__shot -> .shots/<name>.jpg
__state()       // mode, distance, score, speed, pools, fps, biome
__game          // the Game instance; __game.freeze = true halts world scroll for posed shots
```

`renderer.capture()` re-renders inside the same task before `readPixels`, because
`preserveDrawingBuffer` is off and the buffer is undefined after compositing.

## Architecture

```
index.html            shell: import map, every DOM screen, HUD markup
src/main.js           entry, frame loop, dev surface
src/core/
  renderer.js         WebGL setup, post chain, quality tiers, adaptive perf governor
  util.js             math, easing, seeded RNG (mulberry32), Pool, Timer
  save.js             localStorage profile (defensive; runs in-memory if blocked)
  input.js            keyboard + touch + gamepad -> named actions, with buffering
  audio.js            Web Audio synth voices, SFX library, adaptive music scheduler
  fx.js               particle cloud, trauma shake, camera rig
src/render/
  textures.js         procedural CanvasTexture generators (memoised)
src/game/
  characters.js       Alien + HuHu rigs, skins, procedural animation
  world.js            track, instanced city, sky, biome definitions
  obstacles.js        pooled obstacle types + AABB collision
  pickups.js          instanced shards, collectibles, power-ups
  director.js         authored chunk selection — the level design lives here
  player.js           three-lane movement and state machine
  game.js             top-level state machine, scoring, chain, overdrive, collision
src/ui/
  screens.js          DOM screen + HUD controller
  ui.css              all interface styling
```

### Invariants

These are load-bearing. Breaking one is a bug even if nothing visibly fails:

- **The player never moves in +z.** The player sits at `z = 0` and the world scrolls toward them.
  This keeps float precision constant over an unbounded run and makes recycling trivial.
- **Nothing allocates per frame in the hot path.** Particles, obstacles and collectibles are
  pooled; shards and buildings are `InstancedMesh`. A GC hitch mid-jump is a gameplay bug.
- **Obstacle hitboxes are inset from visual bounds**, never larger — forgiveness is what separates
  "I misjudged that" from "that was rigged". Carried over from the 2D game.
- **Every obstacle demands exactly one verb**: JUMP, SLIDE or DODGE. Ambiguous silhouettes are
  unfair at speed.
- **All chain gains funnel through `Game._addChain`**, which also credits the Overdrive meter.
  Incrementing `game.chain` directly silently breaks Overdrive.
- **Obstacles never take the biome colour.** Environments recolour around a fixed hazard palette,
  so the player never has to re-learn what is dangerous.
- **`dt` is capped at 0.05 s** so a backgrounded tab does not resume with an integration step that
  teleports the player through geometry.
- **The renderer must survive a 0×0 container.** Sizing is driven by `ResizeObserver`, not the
  `resize` event, and falls back to 16:9 until real layout arrives.

### The three-layer failure buffer

The first mistake costs *capability*, the second costs *resource*, the third ends the run:

1. **HuHu absorbs the hit** and is knocked out for 12 s — no double jump (it is his headbutt
   assist), no Pulse. Free, but you feel it.
2. **A shield pip breaks**, with i-frames and every obstacle within 14 u deleted so one mistake
   cannot cascade into three.
3. **Death.**

### Conventions

- Movement is in units/second against real `dt` — never per-frame constants.
- `damp(current, target, smoothing, dt)` is frame-rate independent; `smoothing` is the fraction of
  the gap *remaining after one second*. Plain `lerp(a, b, 0.1)` in an update loop is a bug.
- Tunables live in named constant objects (`TUNE` in player.js, `SPEED`/`OD`/`PULSE` in game.js),
  not scattered as literals.
- Tone mapping is `NeutralToneMapping`, deliberately: ACES rolls saturated cyan and magenta toward
  white, which is exactly where this palette lives.
- The Alien's body must never bloom. Only the antenna tip is allowed above the bloom threshold —
  it carries the combo-tier colour, so the player reads their multiplier in peripheral vision.
