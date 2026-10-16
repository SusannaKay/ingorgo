# Ingorgo! 🚌

A "bus jam" puzzle game for mobile browsers. **[Play it here](https://ingorgo.vercel.app)**.

Tap a bus and it leaves the parking lot following its arrow. Passengers wait in line and only get on the bus of their color. Buses that nobody can board wait in the stalls, and if the stalls fill up before the person at the front of the line finds a ride, you lose.

*Ingorgo* is Italian for traffic jam. I like this kind of game, but the free ones on the app stores are more ads than game: thirty seconds of puzzle, thirty seconds of video. So I made my own to play & chill, with no ads, ever. The part I cared about most was the levels: they should keep getting harder without ever becoming impossible.

<!-- screenshot / gif of a level -->

---

## Features

- **Endless levels**, generated on the fly and always solvable
- **Same level everywhere**: the level number is the random seed, so level 342 is identical on every phone, with nothing to download or save
- **Six themed worlds** (city, snow, beach, night, desert, autumn) that change every 10 levels
- **Mechanics that show up as you go**: parking lots with weird shapes, rotated 45°, garages that release hidden buses one at a time
- **Helpers**: undo, hint (the solver shows you the right move, or tells you the level can't be won anymore from there), crane (lifts any bus, once per level), +1 stall, restart
- Runs in the browser and can be added to the home screen

---

## How the levels are generated

This is the part I find most interesting. Every level goes through three steps:

1. **Reverse placement.** Buses are placed one at a time, and each new bus must have a clear way out with respect to the ones already placed (it's allowed to block them, though). This guarantees that leaving in reverse placement order always works: no circular deadlocks.
2. **A queue built from a solution.** The game picks an exit order that respects the blocks and simulates it, generating passengers so that at most a given number of stalls is ever occupied. The level is solvable by construction.
3. **Picking by perceived difficulty.** For each level the generator builds up to 28 candidates and has a simulated "reasonable but distracted" player play each one dozens of times. It keeps the candidate whose win rate is closest to the target for that level.

The difficulty curve rises quickly at first, with a sawtooth pattern on blocks of 10 levels: climb, a breather level, then a boss on the tenth. Past level 100 it goes into overdrive: more colors, more buses, and eventually only 3 stalls.

`npm run check-levels` generates a range of levels and verifies each one with the solver.

---

## Tech

- **TypeScript + Vite**, no framework
- **Three.js** for the 3D view, loaded from a CDN through an import map, so the game itself is about 25 kB gzipped
- Game logic (`src/game/`) is completely separate from rendering (`src/render/`): the engine is instant and pure, and the renderer turns each event into an animation timeline

```text
src/game/
  types.ts        cells, buses, exit paths
  engine.ts       game rules: tap, boarding, win/lose, crane, extra stall
  generator.ts    level generator and difficulty curve
  solver.ts       DFS solver, used for hints and level checks
  rng.ts          seeded random generator
src/render/
  view3d.ts       Three.js scene
  timeline.ts     turns game events into animations
  themes.ts       the six worlds
src/main.ts       UI, input, overlays
scripts/check-levels.ts
```

---

## Run it locally

```bash
npm install
npm run dev               # dev server, reachable from your phone on the same Wi-Fi
npm run build             # production build in dist/
npm run check-levels -- 200   # generate and verify levels 1 to 200
```

URL parameters:

- `?level=42` opens a specific level (tapping the level number at the top does the same)
- `?debug=1` shows the level stats: difficulty, estimated win rate, longest blocking chain

Every push to `main` is deployed to Vercel automatically.

---

## Ideas for later

- More mechanics: locked buses, hidden "?" colors, an ambulance with limited moves
- Sounds
- Offline play with a service worker
