// ─── PERSISTENCE ─────────────────────────────────────────────────────────────
// One localStorage key holds the whole profile. Reads are defensive: a corrupt
// or half-written blob must never stop the game from booting.

const KEY = 'alienhuhu_neonrun_v1';
const LEGACY_HISCORE_KEY = 'alienhuhu_hi'; // from the original 2D game

const DEFAULTS = {
  hiScore: 0,
  bestDistance: 0,
  totalShards: 0,     // lifetime currency earned
  shards: 0,          // unspent currency
  runs: 0,
  totalDistance: 0,
  bestCombo: 0,
  unlocked: ['default'],
  skin: 'default',
  seenIntro: false,
  biomesSeen: [],
  settings: {
    master: 0.9,
    music: 0.65,
    sfx: 0.85,
    quality: 'auto',   // auto | low | medium | high
    shake: 1.0,        // 0..1 multiplier
    motionBlur: true,
    showFps: false,
    invertSwipe: false,
    highContrast: false,
  },
};

function deepMerge(base, patch) {
  // Deep-CLONE the base first. A shallow spread leaves nested objects (settings,
  // unlocked) aliased to DEFAULTS, so the first settings change mutates the
  // defaults themselves and "Erase data" restores the edited values.
  const out = Array.isArray(base) ? base.map(v => (v && typeof v === 'object' ? deepMerge(v, null) : v))
                                  : { ...base };
  if (!Array.isArray(base)) {
    for (const k of Object.keys(out)) {
      if (out[k] && typeof out[k] === 'object') out[k] = deepMerge(out[k], null);
    }
  }
  if (!patch || typeof patch !== 'object') return out;
  for (const k of Object.keys(patch)) {
    const b = base?.[k], p = patch[k];
    if (b && p && typeof b === 'object' && typeof p === 'object' && !Array.isArray(b)) {
      out[k] = deepMerge(b, p);
    } else if (p !== undefined && p !== null) {
      out[k] = p;
    }
  }
  return out;
}

let available = true;
try {
  localStorage.setItem('__t', '1');
  localStorage.removeItem('__t');
} catch {
  available = false; // private browsing / blocked storage — run in-memory
}

function read() {
  // deepMerge, not a spread: a shallow copy leaves `settings`, `unlocked` and
  // `biomesSeen` aliased to DEFAULTS, so in the storage-blocked path every
  // settings change writes into the defaults and "Erase data" restores the
  // polluted values instead of the originals.
  if (!available) return deepMerge(DEFAULTS, null);
  let parsed = null;
  try { parsed = JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { /* corrupt */ }
  const data = deepMerge(DEFAULTS, parsed ?? {});

  // Carry the original game's high score forward on first launch.
  if (!parsed) {
    const legacy = Number(localStorage.getItem(LEGACY_HISCORE_KEY));
    if (Number.isFinite(legacy) && legacy > 0) data.hiScore = legacy;
  }
  return data;
}

let state = read();
let writeQueued = false;

/** Batches writes to the end of the frame — never blocks a hot path. */
function flush() {
  writeQueued = false;
  if (!available) return;
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* quota — ignore */ }
}

function queueWrite() {
  if (writeQueued) return;
  writeQueued = true;
  queueMicrotask(flush);
}

export const Save = {
  get data() { return state; },
  get settings() { return state.settings; },

  get(key) { return state[key]; },

  set(key, value) {
    state[key] = value;
    queueWrite();
  },

  setSetting(key, value) {
    state.settings[key] = value;
    queueWrite();
  },

  /** Merge a partial run result in, keeping bests. Returns what improved. */
  recordRun({ score = 0, distance = 0, shards = 0, combo = 0, biome = null } = {}) {
    const beat = { score: false, distance: false, combo: false };
    if (score > state.hiScore) { state.hiScore = Math.floor(score); beat.score = true; }
    if (distance > state.bestDistance) { state.bestDistance = Math.floor(distance); beat.distance = true; }
    if (combo > state.bestCombo) { state.bestCombo = combo; beat.combo = true; }
    state.runs += 1;
    state.totalDistance += Math.floor(distance);
    state.shards += Math.floor(shards);
    state.totalShards += Math.floor(shards);
    if (biome && !state.biomesSeen.includes(biome)) state.biomesSeen.push(biome);
    queueWrite();
    return beat;
  },

  spendShards(n) {
    if (state.shards < n) return false;
    state.shards -= n;
    queueWrite();
    return true;
  },

  unlock(id) {
    if (!state.unlocked.includes(id)) {
      state.unlocked.push(id);
      queueWrite();
    }
  },

  isUnlocked(id) { return state.unlocked.includes(id); },

  reset() {
    state = JSON.parse(JSON.stringify(DEFAULTS));
    queueWrite();
  },

  /** Force a synchronous write — used on pagehide, where microtasks may not run. */
  flushNow: flush,
};

addEventListener('pagehide', flush);
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
