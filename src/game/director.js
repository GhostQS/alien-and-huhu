// ─── DIRECTOR ────────────────────────────────────────────────────────────────
// Decides what appears in front of the player.
//
// The track is built from hand-authored CHUNKS rather than random obstacles.
// Randomness alone produces stretches that are either trivial or impossible;
// chunks let each moment be a deliberate little puzzle while the ORDER stays
// unpredictable.
//
// Two selection rules keep it from turning into mush:
//   1. A chunk may share at most one verb with the chunk before it, so the
//      player is constantly switching between jump / slide / dodge instead of
//      spamming one input.
//   2. Every fourth chunk is a breather (shards only). Unbroken pressure reads
//      as noise; the gaps are what make the hard parts feel hard.

import { VERB, OBSTACLE_TYPES } from './obstacles.js';
import { POWERUP } from './pickups.js';
import { makeRng, clamp, clamp01, lerp } from '../core/util.js';

// A chunk's entries are in LOCAL z, where 0 is the chunk start and positive
// numbers are further ahead. `length` is how much track it consumes.
const C = (id, length, minDistance, verbs, entries, weight = 1) =>
  ({ id, length, minDistance, verbs, entries, weight });

const O = (z, type, lane, opts) => ({ kind: 'obstacle', z, type, lane, opts });
const S = (z, lane, y) => ({ kind: 'shard', z, lane, y });
const CORE = (z, lane) => ({ kind: 'core', z, lane });
const PWR = (z, lane, which) => ({ kind: 'power', z, lane, which });

/** A line of shards along one lane — the standard reward trail. */
function trail(z0, lane, count, spacing = 2.2, y = 0.85) {
  return Array.from({ length: count }, (_, i) => S(z0 + i * spacing, lane, y));
}

/** An arc of shards over a jump — rewards the player for jumping well. */
function arc(z0, lane, count = 5, spacing = 2.0, peak = 1.25) {
  return Array.from({ length: count }, (_, i) => {
    const t = count === 1 ? 0.5 : i / (count - 1);
    return S(z0 + i * spacing, lane, 0.85 + Math.sin(t * Math.PI) * peak);
  });
}

export const CHUNKS = [
  // ── breathers ───────────────────────────────────────────────────────────
  C('breathe_line', 34, 0, [], [...trail(6, 1, 9)], 1),
  C('breathe_weave', 38, 0, [], [...trail(5, 0, 4), ...trail(15, 1, 4), ...trail(25, 2, 4)], 1),

  // ── single verb, teaching ───────────────────────────────────────────────
  C('jump_one', 30, 0, [VERB.JUMP], [
    O(14, 'barrier', 1), ...arc(11, 1, 5),
  ], 1.2),
  C('jump_two', 42, 60, [VERB.JUMP], [
    O(12, 'barrier', 0), O(28, 'barrier', 2), ...arc(9, 0, 4), ...arc(25, 2, 4),
  ], 1.1),
  C('slide_one', 32, 120, [VERB.SLIDE], [
    O(15, 'gate', 1), ...trail(11, 1, 7, 1.8, 0.55),
  ], 1.2),
  C('dodge_one', 30, 60, [VERB.DODGE], [
    O(14, 'pylon', 1), ...trail(6, 0, 3), ...trail(20, 0, 4),
  ], 1.1),
  C('dodge_wall', 40, 200, [VERB.DODGE], [
    O(14, 'pylon', 0), O(14, 'pylon', 1), ...trail(20, 2, 6),
  ], 1.0),

  // ── two verbs ───────────────────────────────────────────────────────────
  C('jump_slide', 52, 220, [VERB.JUMP, VERB.SLIDE], [
    O(13, 'barrier', 1), O(32, 'gate', 1), ...arc(10, 1, 4), ...trail(28, 1, 5, 1.8, 0.55),
  ], 1.1),
  C('slide_dodge', 54, 260, [VERB.SLIDE, VERB.DODGE], [
    O(14, 'gate', 1), O(34, 'pylon', 1), ...trail(10, 1, 6, 1.8, 0.55), ...trail(30, 0, 4),
  ], 1.0),
  C('jump_dodge', 50, 240, [VERB.JUMP, VERB.DODGE], [
    O(13, 'barrier', 0), O(30, 'pylon', 2), ...arc(10, 0, 4), ...trail(26, 1, 5),
  ], 1.0),
  C('lane_gauntlet', 62, 320, [VERB.DODGE], [
    O(12, 'pylon', 0), O(26, 'pylon', 1), O(40, 'pylon', 2),
    ...trail(8, 1, 3), ...trail(22, 2, 3), ...trail(36, 0, 3),
  ], 0.9),

  // ── air traffic ─────────────────────────────────────────────────────────
  C('drone_pair', 56, 320, [VERB.DODGE], [
    O(14, 'drone', 0, { y: 1.05, laneDrift: 1, driftPhase: 0 }),
    O(34, 'drone', 2, { y: 1.05, laneDrift: 1, driftPhase: 1.6 }),
    ...trail(8, 1, 4), ...trail(26, 1, 4),
  ], 0.9),
  C('drone_gate', 58, 400, [VERB.DODGE, VERB.SLIDE], [
    O(14, 'drone', 1, { y: 1.05 }), O(36, 'gate', 1),
    ...trail(24, 0, 5), ...trail(32, 1, 5, 1.8, 0.55),
  ], 0.85),

  // ── heavier ─────────────────────────────────────────────────────────────
  C('lowblock_hop', 46, 480, [VERB.JUMP], [
    O(16, 'lowblock', 1, { wide: true }), ...arc(12, 1, 6, 2.0, 1.35),
  ], 0.9),
  C('fan_alley', 60, 700, [VERB.DODGE], [
    O(16, 'fan', 0), O(34, 'fan', 2), ...trail(12, 2, 5), ...trail(30, 0, 5),
  ], 0.8),
  C('triple_threat', 72, 900, [VERB.JUMP, VERB.SLIDE, VERB.DODGE], [
    O(12, 'barrier', 1), O(30, 'gate', 1), O(48, 'pylon', 0),
    ...arc(9, 1, 4), ...trail(26, 1, 4, 1.8, 0.55), ...trail(46, 2, 5),
  ], 0.75),
  C('slalom', 68, 1100, [VERB.DODGE, VERB.JUMP], [
    O(12, 'pylon', 0), O(24, 'barrier', 1), O(36, 'pylon', 2), O(50, 'barrier', 1),
    ...trail(18, 1, 3), ...arc(33, 1, 3), ...trail(44, 0, 3),
  ], 0.7),
  C('the_squeeze', 76, 1500, [VERB.SLIDE, VERB.DODGE], [
    O(14, 'gate', 0), O(14, 'gate', 1), O(38, 'pylon', 1), O(38, 'pylon', 2),
    ...trail(10, 2, 5, 1.8, 0.55), ...trail(36, 0, 5),
  ], 0.6),
];

// Reward chunks are appended on top of a normal chunk, not instead of one.
const CORE_INTERVAL = [520, 900];      // metres between shield cores
const POWER_INTERVAL = [700, 1300];    // metres between power-ups

// Chunks are authored in metres against this cruising speed. At 46 u/s the same
// layout would arrive twice as fast, which is how a fair pattern turns into an
// unreadable one — so every chunk is stretched in proportion to current speed
// and the authored RHYTHM IN TIME is preserved at every speed.
const REFERENCE_SPEED = 24;
const MAX_STRETCH = 1.8;

// Reaction budget between patterns, in seconds. Shrinks with distance, but never
// below the point where a human can actually see and answer the next hazard.
const REACTION_EARLY = 0.82;
const REACTION_LATE = 0.40;

export class Director {
  constructor(obstacles, shards, collectibles, seed = 1) {
    this.obstacles = obstacles;
    this.shards = shards;
    this.collectibles = collectibles;
    this.rng = makeRng(seed);
    this.reset(seed);
  }

  reset(seed = (Math.random() * 1e9) | 0) {
    this.rng.reseed(seed);
    this.speed = REFERENCE_SPEED;
    this.cursor = -60;          // world z at which the next chunk starts
    this.distance = 0;
    this.lastVerbs = [];
    this.sinceBreather = 0;
    this.chunkCount = 0;
    this.nextCore = this.rng.range(...CORE_INTERVAL);
    this.nextPower = this.rng.range(400, 700);
    this.recent = [];
  }

  /** Chunks that are unlocked and don't repeat the previous verb set. */
  _eligible(distance) {
    const unlocked = CHUNKS.filter(c => distance >= c.minDistance);
    const forcedBreather = this.sinceBreather >= 3;

    let pool = unlocked.filter(c => {
      const isBreather = c.verbs.length === 0;
      if (forcedBreather) return isBreather;
      // Early on only a handful of chunks are unlocked and two of them are
      // breathers, so allowing one every other chunk left the opening minute
      // mostly empty. Two real patterns must pass before another rest.
      if (isBreather) return this.sinceBreather >= 2;
      // Rule 1: share at most one verb with the previous chunk.
      const shared = c.verbs.filter(v => this.lastVerbs.includes(v)).length;
      return shared <= 1;
    });

    // Avoid immediate repeats of the same chunk id.
    pool = pool.filter(c => !this.recent.includes(c.id));
    if (!pool.length) pool = unlocked.filter(c => c.verbs.length > 0);
    if (!pool.length) pool = unlocked;
    return pool;
  }

  /** Difficulty-weighted pick: later chunks get relatively more likely. */
  _pick(distance) {
    const pool = this._eligible(distance);
    const diff = clamp01(distance / 2600);
    const weights = pool.map(c => {
      const hardness = clamp01(c.minDistance / 1500);
      // Early on, favour simple chunks; later, favour the ones with teeth.
      return c.weight * lerp(1.2 - hardness, 0.45 + hardness * 1.5, diff);
    });
    return this.rng.weighted(pool, weights);
  }

  /**
   * Fill the track ahead of the player.
   * @param distance  metres travelled, drives unlocks and difficulty
   * @param horizon   world z at which things should be spawned (negative)
   */
  update(distance, horizon = -180, speed = REFERENCE_SPEED) {
    this.distance = distance;
    this.speed = speed;

    // `cursor` walks away from the camera as chunks are emitted.
    let guard = 0;
    while (this.cursor > horizon && guard++ < 12) {
      const chunk = this._pick(distance);
      const stretch = this._stretch();
      this._emit(chunk, this.cursor, stretch);
      this.cursor -= chunk.length * stretch + this._gap(distance);

      this.lastVerbs = chunk.verbs;
      this.sinceBreather = chunk.verbs.length === 0 ? 0 : this.sinceBreather + 1;
      this.chunkCount++;
      this.recent.push(chunk.id);
      if (this.recent.length > 3) this.recent.shift();
    }
  }

  /** How much to stretch a chunk so its timing matches how it was authored. */
  _stretch() {
    return clamp(this.speed / REFERENCE_SPEED, 1, MAX_STRETCH);
  }

  /**
   * Breathing room between patterns, expressed in TIME and converted to metres.
   * A fixed metre gap silently halves the player's reaction window as speed
   * rises; a fixed time gap does not.
   */
  _gap(distance) {
    const t = clamp01(distance / 5000);
    const reaction = lerp(REACTION_EARLY, REACTION_LATE, t);
    return Math.max(12, reaction * this.speed) + this.rng.range(-1.5, 3);
  }

  _emit(chunk, baseZ, stretch = 1) {
    this._stretchUsed = stretch;
    for (const e of chunk.entries) {
      const z = baseZ - e.z * stretch;
      switch (e.kind) {
        case 'obstacle': {
          if (!OBSTACLE_TYPES[e.type]) break;
          this.obstacles.spawn(e.type, e.lane, z, e.opts ?? {});
          break;
        }
        case 'shard':
          this.shards.spawn(e.lane, z, e.y ?? 0.85);
          break;
        case 'core':
          this.collectibles.spawn('shield', e.lane, z, 1.1);
          break;
        case 'power':
          this.collectibles.spawn(e.which, e.lane, z, 1.1);
          break;
      }
    }

    // Rewards are placed on the chunk's safest lane so they never demand a
    // suicidal detour.
    if (this.distance >= this.nextCore) {
      this.nextCore = this.distance + this.rng.range(...CORE_INTERVAL);
      this.collectibles.spawn('shield', this._safeLane(chunk), baseZ - chunk.length * stretch * 0.5, 1.1);
    }
    if (this.distance >= this.nextPower) {
      this.nextPower = this.distance + this.rng.range(...POWER_INTERVAL);
      const which = this.rng.pick([POWERUP.MAGNET, POWERUP.OVERDRIVE, POWERUP.DOUBLE]);
      this.collectibles.spawn(which, this._safeLane(chunk), baseZ - chunk.length * stretch * 0.35, 1.1);
    }
  }

  _safeLane(chunk) {
    const used = new Set(chunk.entries.filter(e => e.kind === 'obstacle').map(e => e.lane));
    for (const l of [1, 0, 2]) if (!used.has(l)) return l;
    return 1;
  }

  /** World scroll shifts everything, so the cursor must move with it. */
  advance(dz) { this.cursor += dz; }
}
