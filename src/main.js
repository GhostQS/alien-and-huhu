// ─── ENTRY ───────────────────────────────────────────────────────────────────
// Boot the game, own the frame loop, and expose a small dev surface.

import { Game } from './game/game.js';

const canvas = document.getElementById('gl');

let game;
try {
  game = new Game(canvas);
} catch (err) {
  console.error(err);
  document.getElementById('loadMsg').textContent =
    'This browser could not start WebGL2. Try a recent Chrome, Firefox or Safari.';
  throw err;
}

// A short boot beat so the first frame is never a stutter: shaders compile on
// the first render, and doing that behind the loading screen hides the hitch.
let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  game.start();
}

let last = performance.now();

function loop(now) {
  requestAnimationFrame(loop);
  // Cap dt so a backgrounded tab does not resume with a giant integration step
  // that teleports the player through obstacles.
  const dt = Math.min(0.05, Math.max(0.0001, (now - last) / 1000));
  last = now;
  game.frame(dt);
  if (!booted && game.elapsed > 0.35) boot();
}
requestAnimationFrame(loop);

// Backstop: requestAnimationFrame does not run at all while the page is hidden,
// so a game loaded in a background tab would sit on the loading screen forever
// and only reach the title once the user looked at it. Boot on a real timer too,
// so the title screen is already waiting the instant the page becomes visible.
setTimeout(boot, 600);

// Keep the clock honest when returning from a background tab, and repaint once
// immediately: the drawing buffer is not preserved, so the first visible frame
// after a long hidden stretch would otherwise be whatever was last composited.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  last = performance.now();
  boot();
  game.frame(1 / 60);
});

// ─── dev surface ─────────────────────────────────────────────────────────────
// requestAnimationFrame is suspended while a tab is hidden, so automated checks
// step the simulation themselves and read pixels back explicitly.
window.__game = game;
window.__step = (n = 60, dt = 1 / 60) => { for (let i = 0; i < n; i++) game.frame(dt); return +game.elapsed.toFixed(2); };
window.__save = (name, w = 1280, h = 720, q = 0.85) =>
  fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, dataUrl: game.renderer.capture(w, h, q) }) })
    .then(r => r.json());
window.__state = () => ({
  mode: game.mode,
  screen: game.ui.current,
  distance: +game.distance.toFixed(1),
  score: Math.floor(game.score),
  speed: +game.speed.toFixed(1),
  lane: game.player.lane,
  y: +game.player.position.y.toFixed(2),
  state: game.player.state,
  shields: game.player.shields,
  chain: game.chain,
  mult: game.multiplier,
  obstacles: game.obstacles.live.length,
  shards: game.shards.items.length,
  collectibles: game.collectibles.live.length,
  particles: game.particles.liveCount,
  biome: game.world.biome.id,
  fps: Math.round(game.renderer.fps),
  tier: game.renderer.tierName,
});
