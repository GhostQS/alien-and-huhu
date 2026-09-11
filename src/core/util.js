// ─── MATH & UTILITY ──────────────────────────────────────────────────────────
// Frame-rate-independent helpers. Nothing here allocates in a hot path.

export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const remap = (v, a, b, c, d) => lerp(c, d, clamp01(invLerp(a, b, v)));
export const sign = v => (v > 0 ? 1 : v < 0 ? -1 : 0);

/**
 * Frame-rate-independent exponential smoothing.
 * `smoothing` is the fraction of the gap REMAINING after one second.
 * damp(x, target, 0.01, dt) closes 99% of the distance each second, at any fps.
 */
export const damp = (current, target, smoothing, dt) =>
  lerp(current, target, 1 - Math.pow(smoothing, dt));

/** Angular damp that always takes the short way round. */
export function dampAngle(current, target, smoothing, dt) {
  let d = (target - current) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return current + d * (1 - Math.pow(smoothing, dt));
}

// ─── EASING ──────────────────────────────────────────────────────────────────
export const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
export const easeInCubic = t => t * t * t;
export const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutQuint = t => 1 - Math.pow(1 - t, 5);
export const easeOutExpo = t => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
export const easeOutBack = (t, s = 1.70158) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
export const easeOutElastic = t => {
  if (t === 0 || t === 1) return t;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
};
/** Smooth 0→1→0 pulse. */
export const pulse = t => Math.sin(clamp01(t) * Math.PI);

// ─── SEEDED RNG ──────────────────────────────────────────────────────────────
// mulberry32 — small, fast, good enough for level generation, and seedable so a
// run can be replayed or shared.
export function makeRng(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + next() * (hi - lo),
    int: (lo, hi) => Math.floor(lo + next() * (hi - lo + 1)),
    bool: (p = 0.5) => next() < p,
    pick: arr => arr[Math.floor(next() * arr.length)],
    /** Weighted pick. `weights[i]` corresponds to `arr[i]`; need not sum to 1. */
    weighted(arr, weights) {
      let total = 0;
      for (let i = 0; i < weights.length; i++) total += weights[i];
      let r = next() * total;
      for (let i = 0; i < arr.length; i++) {
        r -= weights[i];
        if (r <= 0) return arr[i];
      }
      return arr[arr.length - 1];
    },
    sign: () => (next() < 0.5 ? -1 : 1),
    reseed(s) { a = s >>> 0; },
  };
}

/** Shared RNG for cosmetic effects — never affects gameplay, so it need not be seeded. */
export const fxRng = makeRng((Math.random() * 0xffffffff) >>> 0);

// ─── OBJECT POOL ─────────────────────────────────────────────────────────────
// Endless runners live or die by GC pressure. Everything recycled goes here.
export class Pool {
  constructor(factory, reset, initial = 0) {
    this.factory = factory;
    this.reset = reset;
    this.free = [];
    this.live = [];
    for (let i = 0; i < initial; i++) this.free.push(factory());
  }
  acquire(...args) {
    const obj = this.free.pop() ?? this.factory();
    this.reset(obj, ...args);
    this.live.push(obj);
    return obj;
  }
  /** Release by index — O(1) via swap-remove. Iterate backwards when using this. */
  releaseAt(i) {
    const obj = this.live[i];
    this.live[i] = this.live[this.live.length - 1];
    this.live.pop();
    this.free.push(obj);
    return obj;
  }
  release(obj) {
    const i = this.live.indexOf(obj);
    if (i >= 0) this.releaseAt(i);
  }
  releaseAll() {
    while (this.live.length) this.free.push(this.live.pop());
  }
  get count() { return this.live.length; }
}

// ─── FORMATTING ──────────────────────────────────────────────────────────────
export const commas = n => Math.floor(n).toLocaleString('en-US');

/** 1234 -> "1.2k", 1234567 -> "1.2M" — for compact HUD readouts. */
export function abbrev(n) {
  const v = Math.floor(n);
  if (v < 1000) return String(v);
  if (v < 1e6) return (v / 1000).toFixed(v < 1e4 ? 1 : 0) + 'k';
  return (v / 1e6).toFixed(1) + 'M';
}

/** Metres -> "1 204 m" / "1.20 km". */
export function distanceLabel(m) {
  return m < 1000 ? `${Math.floor(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

// ─── COLOR ───────────────────────────────────────────────────────────────────
/** Blend two 0xRRGGBB ints in gamma space. Cheap and good enough for UI/fog. */
export function mixHex(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return ((Math.round(lerp(ar, br, t)) << 16) |
          (Math.round(lerp(ag, bg, t)) << 8) |
           Math.round(lerp(ab, bb, t)));
}

export const hexToCss = h => '#' + h.toString(16).padStart(6, '0');

// ─── TIMING ──────────────────────────────────────────────────────────────────
/** A countdown that reports the moment it fires. Avoids `if (t > 0) t -= dt` noise. */
export class Timer {
  constructor() { this.remaining = 0; this.duration = 0; }
  start(seconds) { this.remaining = seconds; this.duration = seconds; return this; }
  stop() { this.remaining = 0; this.duration = 0; }
  /** @returns true exactly once, on the tick the timer reaches zero. */
  tick(dt) {
    if (this.remaining <= 0) return false;
    this.remaining -= dt;
    if (this.remaining <= 0) { this.remaining = 0; return true; }
    return false;
  }
  get active() { return this.remaining > 0; }
  /** 1 at start, 0 at end. */
  get progress() { return this.duration > 0 ? clamp01(this.remaining / this.duration) : 0; }
  get elapsed() { return this.duration - this.remaining; }
}
