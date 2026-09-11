// ─── AUDIO ───────────────────────────────────────────────────────────────────
// Everything is synthesised at runtime — no audio files anywhere.
//
// Signal path:
//   sources -> [musicBus | sfxBus] -> masterGain -> compressor -> destination
//
// The music engine schedules one bar at a time, a little ahead of the playhead,
// which is the only reliable way to stay tight in a browser: setTimeout jitter
// is absorbed because note times are computed against AudioContext.currentTime.

import { Save } from './save.js';
import { clamp, clamp01 } from './util.js';

let ac = null;
let masterGain, musicBus, sfxBus, compressor, noiseBuf, shortNoiseBuf;
let started = false;
let muted = false;

// ─── setup ───────────────────────────────────────────────────────────────────
function makeNoise(seconds) {
  const len = Math.max(1, Math.ceil(ac.sampleRate * seconds));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function init() {
  if (ac) return true;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return false;
  ac = new Ctx();

  compressor = ac.createDynamicsCompressor();
  compressor.threshold.value = -14;
  compressor.knee.value = 22;
  compressor.ratio.value = 7;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.22;
  compressor.connect(ac.destination);

  masterGain = ac.createGain();
  masterGain.gain.value = Save.settings.master;
  masterGain.connect(compressor);

  musicBus = ac.createGain();
  musicBus.gain.value = Save.settings.music;
  musicBus.connect(masterGain);

  sfxBus = ac.createGain();
  sfxBus.gain.value = Save.settings.sfx;
  sfxBus.connect(masterGain);

  noiseBuf = makeNoise(2.0);
  shortNoiseBuf = makeNoise(0.25);
  Music._bind(ac, musicBus, noiseBuf);
  return true;
}

// ─── synth primitives ────────────────────────────────────────────────────────
function env(gain, t, peak, attack, decay, sustain = 0, hold = 0) {
  gain.gain.cancelScheduledValues(t);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(peak, t + attack);
  if (hold > 0) gain.gain.setValueAtTime(peak, t + attack + hold);
  const end = t + attack + hold + decay;
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, sustain || 0.0001), end);
  return end;
}

/** A single oscillator voice with a pitch sweep. */
function tone(bus, { type = 'sine', f0, f1 = f0, t, dur, peak = 0.3, attack = 0.005, detune = 0, curve = 'exp', pan = 0 }) {
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.detune.value = detune;
  osc.frequency.setValueAtTime(Math.max(1, f0), t);
  if (f1 !== f0) {
    if (curve === 'exp') osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    else osc.frequency.linearRampToValueAtTime(Math.max(1, f1), t + dur);
  }
  env(g, t, peak, attack, Math.max(0.01, dur - attack));
  let node = g;
  if (pan !== 0 && ac.createStereoPanner) {
    const p = ac.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    g.connect(p);
    node = p;
  }
  osc.connect(g);
  node.connect(bus);
  osc.start(t);
  osc.stop(t + dur + 0.05);
  return osc;
}

/** Filtered noise burst — hats, impacts, whooshes, sparks. */
function noise(bus, { t, dur, peak = 0.3, type = 'bandpass', f0 = 4000, f1 = f0, q = 1.2, attack = 0.002, buffer }) {
  const src = ac.createBufferSource();
  src.buffer = buffer ?? shortNoiseBuf;
  const filt = ac.createBiquadFilter();
  filt.type = type;
  filt.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) filt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  filt.Q.value = q;
  const g = ac.createGain();
  env(g, t, peak, attack, Math.max(0.01, dur - attack));
  src.connect(filt); filt.connect(g); g.connect(bus);
  src.start(t);
  src.stop(t + dur + 0.05);
  return src;
}

/** FM voice — metallic, "sci-fi" timbres that pure oscillators can't reach. */
function fm(bus, { t, dur, carrier, ratio = 2.0, index = 400, peak = 0.25, type = 'sine', attack = 0.004 }) {
  const car = ac.createOscillator();
  const mod = ac.createOscillator();
  const modGain = ac.createGain();
  const g = ac.createGain();
  car.type = type; mod.type = 'sine';
  car.frequency.value = carrier;
  mod.frequency.value = carrier * ratio;
  modGain.gain.setValueAtTime(index, t);
  modGain.gain.exponentialRampToValueAtTime(1, t + dur);
  mod.connect(modGain); modGain.connect(car.frequency);
  env(g, t, peak, attack, Math.max(0.01, dur - attack));
  car.connect(g); g.connect(bus);
  car.start(t); mod.start(t);
  car.stop(t + dur + 0.05); mod.stop(t + dur + 0.05);
}

// ─── SFX library ─────────────────────────────────────────────────────────────
// Each entry is a function of (bus, t, opts) so pitch can vary per call — a
// combo chain that rises in pitch reads as "getting better" without any text.
const SFX = {
  jump: (b, t) => {
    tone(b, { type: 'triangle', f0: 260, f1: 620, t, dur: 0.16, peak: 0.26, attack: 0.004 });
    noise(b, { t, dur: 0.10, peak: 0.10, f0: 1200, f1: 4200, q: 0.8 });
  },
  doubleJump: (b, t) => {
    tone(b, { type: 'triangle', f0: 520, f1: 980, t, dur: 0.16, peak: 0.22 });
    tone(b, { type: 'sine', f0: 780, f1: 1460, t: t + 0.02, dur: 0.14, peak: 0.12 });
    noise(b, { t, dur: 0.14, peak: 0.09, f0: 2600, f1: 7000, q: 0.7 });
  },
  land: (b, t) => {
    tone(b, { type: 'sine', f0: 150, f1: 48, t, dur: 0.14, peak: 0.32 });
    noise(b, { t, dur: 0.09, peak: 0.14, type: 'lowpass', f0: 1400, f1: 260, q: 0.6 });
  },
  lane: (b, t) => {
    noise(b, { t, dur: 0.13, peak: 0.11, f0: 900, f1: 2600, q: 1.6 });
    tone(b, { type: 'sine', f0: 420, f1: 300, t, dur: 0.09, peak: 0.07 });
  },
  slide: (b, t) => {
    noise(b, { t, dur: 0.34, peak: 0.16, type: 'bandpass', f0: 2400, f1: 500, q: 2.4, buffer: noiseBuf });
  },
  dash: (b, t) => {
    tone(b, { type: 'sawtooth', f0: 180, f1: 900, t, dur: 0.26, peak: 0.22 });
    noise(b, { t, dur: 0.30, peak: 0.20, type: 'bandpass', f0: 600, f1: 6000, q: 0.9, buffer: noiseBuf });
    fm(b, { t: t + 0.02, dur: 0.22, carrier: 320, ratio: 3.5, index: 900, peak: 0.10 });
  },
  shard: (b, t, { pitch = 0 } = {}) => {
    // Rises through a pentatonic ladder as the combo climbs — pure dopamine.
    const semis = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
    const s = semis[clamp(pitch, 0, semis.length - 1)];
    const f = 880 * Math.pow(2, s / 12);
    tone(b, { type: 'triangle', f0: f, f1: f, t, dur: 0.13, peak: 0.15, attack: 0.002 });
    tone(b, { type: 'sine', f0: f * 2, f1: f * 2, t, dur: 0.09, peak: 0.07 });
  },
  core: (b, t) => {
    [0, 4, 7, 12].forEach((s, i) =>
      tone(b, { type: 'triangle', f0: 523.25 * Math.pow(2, s / 12), t: t + i * 0.045, dur: 0.30, peak: 0.13 }));
    fm(b, { t, dur: 0.5, carrier: 523, ratio: 1.5, index: 300, peak: 0.08 });
  },
  powerup: (b, t) => {
    for (let i = 0; i < 5; i++) {
      tone(b, { type: 'square', f0: 330 * Math.pow(2, i / 6), t: t + i * 0.05, dur: 0.14, peak: 0.10 });
    }
    fm(b, { t, dur: 0.6, carrier: 220, ratio: 2.01, index: 600, peak: 0.10 });
  },
  shield: (b, t) => {
    fm(b, { t, dur: 0.5, carrier: 180, ratio: 1.41, index: 700, peak: 0.18 });
    tone(b, { type: 'sine', f0: 900, f1: 300, t, dur: 0.4, peak: 0.10 });
  },
  shieldBreak: (b, t) => {
    noise(b, { t, dur: 0.45, peak: 0.30, type: 'highpass', f0: 800, f1: 4000, q: 0.5, buffer: noiseBuf });
    tone(b, { type: 'sawtooth', f0: 700, f1: 90, t, dur: 0.4, peak: 0.22 });
  },
  nearMiss: (b, t) => {
    noise(b, { t, dur: 0.22, peak: 0.13, type: 'bandpass', f0: 5000, f1: 900, q: 3.0, buffer: noiseBuf });
  },
  hit: (b, t) => {
    tone(b, { type: 'sawtooth', f0: 420, f1: 60, t, dur: 0.5, peak: 0.34 });
    noise(b, { t, dur: 0.35, peak: 0.26, type: 'lowpass', f0: 2200, f1: 180, q: 0.8, buffer: noiseBuf });
    fm(b, { t, dur: 0.45, carrier: 90, ratio: 1.77, index: 1200, peak: 0.18 });
  },
  die: (b, t) => {
    tone(b, { type: 'sawtooth', f0: 380, f1: 44, t, dur: 1.1, peak: 0.30 });
    tone(b, { type: 'square', f0: 190, f1: 30, t: t + 0.06, dur: 1.0, peak: 0.16 });
    noise(b, { t, dur: 0.9, peak: 0.20, type: 'lowpass', f0: 3000, f1: 110, q: 0.7, buffer: noiseBuf });
  },
  milestone: (b, t) => {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      tone(b, { type: 'triangle', f0: f, t: t + i * 0.07, dur: 0.26, peak: 0.15 }));
  },
  biome: (b, t) => {
    [261.6, 329.6, 392.0, 523.3, 659.3].forEach((f, i) =>
      tone(b, { type: 'sine', f0: f, t: t + i * 0.09, dur: 0.7, peak: 0.13 }));
    fm(b, { t, dur: 1.4, carrier: 130.8, ratio: 2.0, index: 500, peak: 0.10 });
  },
  uiMove: (b, t) => tone(b, { type: 'square', f0: 660, f1: 880, t, dur: 0.05, peak: 0.07 }),
  uiSelect: (b, t) => {
    tone(b, { type: 'square', f0: 880, f1: 1320, t, dur: 0.09, peak: 0.10 });
    tone(b, { type: 'sine', f0: 1760, t: t + 0.03, dur: 0.09, peak: 0.05 });
  },
  uiBack: (b, t) => tone(b, { type: 'square', f0: 620, f1: 380, t, dur: 0.09, peak: 0.08 }),
  uiDenied: (b, t) => {
    tone(b, { type: 'square', f0: 200, f1: 160, t, dur: 0.14, peak: 0.12 });
    tone(b, { type: 'square', f0: 150, f1: 120, t: t + 0.1, dur: 0.16, peak: 0.10 });
  },
  countdown: (b, t, { last = false } = {}) =>
    tone(b, { type: 'square', f0: last ? 880 : 440, t, dur: last ? 0.4 : 0.16, peak: 0.16 }),
};

// ─── adaptive music ──────────────────────────────────────────────────────────
// Four-bar loop in A-minor at a tempo that drifts up with intensity. Layers gate
// in as intensity rises, so the track thickens as the run gets faster without
// ever needing a hard cut.
const Music = (() => {
  const CHORDS = [
    { root: 55.00, tones: [110.00, 130.81, 164.81, 220.00] }, // Am
    { root: 43.65, tones: [87.31, 110.00, 130.81, 174.61] },  // F
    { root: 65.41, tones: [130.81, 164.81, 196.00, 261.63] }, // C
    { root: 49.00, tones: [98.00, 123.47, 146.83, 196.00] },  // G
  ];
  const ARP = [0, 2, 1, 3, 2, 1, 3, 2, 0, 2, 1, 3, 2, 3, 1, 0];
  const LEAD = [0, null, 3, 2, null, 1, null, 2, 4, null, 3, null, 2, 1, null, null];

  let ctx = null, bus = null, nBuf = null;
  let playing = false, bar = 0, nextBarTime = 0, timer = null;
  let intensity = 0;      // 0..1, drives tempo and layer gating
  let targetIntensity = 0;
  let filter = null, layerGain = null, delay = null, feedback = null;
  let bpm = 118;
  let duck = 1;

  const beat = () => 60 / bpm;
  const barLen = () => beat() * 4;

  function bind(audioCtx, musicBusNode, noiseBuffer) {
    ctx = audioCtx; nBuf = noiseBuffer;
    filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1200;
    filter.Q.value = 0.9;

    delay = ctx.createDelay(1.0);
    delay.delayTime.value = beat() * 0.75;   // dotted-eighth — the synthwave staple
    feedback = ctx.createGain();
    feedback.gain.value = 0.28;
    const wet = ctx.createGain();
    wet.gain.value = 0.22;
    delay.connect(feedback); feedback.connect(delay);
    delay.connect(wet); wet.connect(musicBusNode);

    layerGain = ctx.createGain();
    layerGain.gain.value = 1;
    filter.connect(layerGain);
    layerGain.connect(musicBusNode);
    layerGain.connect(delay);
    bus = filter;
  }

  function kick(t, peak = 0.5) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(190, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.11);
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    o.connect(g); g.connect(bus);
    o.start(t); o.stop(t + 0.26);
  }

  function snare(t, peak = 0.22) {
    const s = ctx.createBufferSource(); s.buffer = nBuf;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1400;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    s.connect(f); f.connect(g); g.connect(bus);
    s.start(t); s.stop(t + 0.18);
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.1);
    og.gain.setValueAtTime(peak * 0.5, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(og); og.connect(bus);
    o.start(t); o.stop(t + 0.14);
  }

  function hat(t, peak) {
    const s = ctx.createBufferSource(); s.buffer = nBuf;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 9500; f.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    s.connect(f); f.connect(g); g.connect(bus);
    s.start(t); s.stop(t + 0.06);
  }

  function voice(type, freq, peak, t, dur, dest = bus, detune = 0) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq; o.detune.value = detune;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.012);
    g.gain.setValueAtTime(peak, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + dur + 0.03);
  }

  function pad(tones, t, dur) {
    // Detuned saw stack, one octave up — the "wide" bed under everything.
    tones.slice(0, 3).forEach(f => {
      [-7, 0, 7].forEach(d => voice('sawtooth', f * 2, 0.016, t, dur, bus, d));
    });
  }

  function scheduleBar(idx, t) {
    const ch = CHORDS[idx % 4];
    const b = beat();
    const I = intensity;

    // Bass — always present, the spine of the loop.
    voice('sawtooth', ch.root, 0.30, t, b * 1.7);
    voice('sawtooth', ch.root, 0.16, t + b * 2, b * 1.5, bus, 6);
    if (I > 0.15) voice('square', ch.root * 0.5, 0.10, t + b * 3, b * 0.8);

    // Pad — always.
    pad(ch.tones, t, barLen());

    // Drums — kick always; snare and hats gate in with intensity.
    kick(t); kick(t + b * 2);
    if (I > 0.30) { kick(t + b * 2.75, 0.34); }
    if (I > 0.18) { snare(t + b); snare(t + b * 3); }
    if (I > 0.10) {
      const n = I > 0.55 ? 16 : 8;
      for (let i = 0; i < n; i++) hat(t + i * (barLen() / n), i % 2 === 0 ? 0.05 : 0.026);
    }

    // Arpeggio — 16ths, the driving element.
    if (I > 0.05) {
      for (let i = 0; i < 16; i++) {
        const f = ch.tones[ARP[i]] * 2;
        voice('square', f, 0.055 + I * 0.02, t + i * (b / 4), b * 0.2);
      }
    }

    // Lead — only at high intensity, so speed genuinely sounds different.
    if (I > 0.45) {
      LEAD.forEach((step, i) => {
        if (step === null) return;
        const f = ch.tones[step % ch.tones.length] * 4;
        voice('sawtooth', f, 0.045, t + i * (b / 4), b * 0.42);
      });
    }
  }

  function loop() {
    if (!playing) return;
    const lookahead = 0.12;
    while (nextBarTime < ctx.currentTime + lookahead + barLen()) {
      scheduleBar(bar++, nextBarTime);
      nextBarTime += barLen();
    }
    timer = setTimeout(loop, 60);
  }

  return {
    _bind: bind,
    start() {
      if (playing || !ctx) return;
      playing = true;
      bar = 0;
      nextBarTime = ctx.currentTime + 0.08;
      loop();
    },
    stop() {
      playing = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    /** 0..1 — drives tempo, filter cutoff and which layers play. */
    setIntensity(v) { targetIntensity = clamp01(v); },
    /** Duck the music under a big SFX moment (death, biome change). */
    setDuck(v) { duck = clamp01(v); },
    update(dt) {
      if (!ctx) return;
      intensity += (targetIntensity - intensity) * Math.min(1, dt * 1.2);
      bpm = 112 + intensity * 34;
      if (delay) delay.delayTime.value = beat() * 0.75;
      if (filter) {
        const target = 700 + intensity * 5200;
        filter.frequency.value += (target - filter.frequency.value) * Math.min(1, dt * 2.5);
      }
      if (layerGain) {
        layerGain.gain.value += (duck - layerGain.gain.value) * Math.min(1, dt * 4);
      }
    },
    get playing() { return playing; },
    get intensity() { return intensity; },
  };
})();

// ─── public API ──────────────────────────────────────────────────────────────
export const Audio = {
  /** Must be called from a user gesture — browsers block audio otherwise. */
  unlock() {
    if (!init()) return false;
    if (ac.state === 'suspended') ac.resume();
    started = true;
    return true;
  },

  play(name, opts) {
    if (!started || muted || !ac) return;
    const fn = SFX[name];
    if (!fn) return;
    fn(sfxBus, ac.currentTime, opts);
  },

  /** Schedule a sound slightly in the future — for deliberate rhythmic stacks. */
  playAt(name, delaySeconds, opts) {
    if (!started || muted || !ac) return;
    const fn = SFX[name];
    if (!fn) return;
    fn(sfxBus, ac.currentTime + delaySeconds, opts);
  },

  music: Music,

  startMusic() { if (started) Music.start(); },
  stopMusic() { Music.stop(); },

  update(dt) { Music.update(dt); },

  setVolume(kind, value) {
    const v = clamp01(value);
    Save.setSetting(kind, v);
    if (!ac) return;
    const node = kind === 'master' ? masterGain : kind === 'music' ? musicBus : sfxBus;
    node.gain.setTargetAtTime(muted && kind === 'master' ? 0 : v, ac.currentTime, 0.02);
  },

  toggleMute() {
    muted = !muted;
    if (masterGain && ac) {
      masterGain.gain.setTargetAtTime(muted ? 0 : Save.settings.master, ac.currentTime, 0.02);
    }
    return muted;
  },

  get muted() { return muted; },
  get ready() { return started; },
  get context() { return ac; },
};

// Pause audio when the tab is hidden so a backgrounded game is silent.
addEventListener('visibilitychange', () => {
  if (!ac) return;
  if (document.visibilityState === 'hidden') ac.suspend?.();
  else if (started) ac.resume?.();
});
