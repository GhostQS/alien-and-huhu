// ─── CHARACTERS ──────────────────────────────────────────────────────────────
// Alien and HuHu, rebuilt in 3D from primitives. Both keep the proportions that
// made the 2D sprites read as cute: an oversized head-to-body ratio, huge eyes
// set wide and low, and stubby limbs.
//
// Everything is procedural — no model files. Parts are stored on the rig by name
// so the animation code can pose them without traversing the graph every frame.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { clamp, clamp01, damp, TAU } from '../core/util.js';
import { radialBlob } from '../render/textures.js';

// ─── palette (carried over from the 2D game, plus cyber trim) ───────────────
export const SKIN_PRESETS = {
  default: {
    id: 'default', name: 'Nova', cost: 0, swatch: '#c084fc',
    blurb: 'Standard issue.',
    body: 0xc084fc, belly: 0xf9a8d4, limb: 0xa855f7, foot: 0x7c3aed,
    cheek: 0xfb7185, trim: 0x16f2ff, antenna: 0x818cf8,
  },
  chrome: {
    id: 'chrome', name: 'Chrome Void', cost: 800, swatch: '#c9d6e8',
    blurb: 'Polished to a mirror.',
    body: 0xc9d6e8, belly: 0xeef4ff, limb: 0x9fb0c6, foot: 0x6d7c92,
    cheek: 0x8fa8c4, trim: 0xffffff, antenna: 0xdfe9f7,
    metalness: 0.95, roughness: 0.12,
  },
  ember: {
    id: 'ember', name: 'Ember Drive', cost: 1400, swatch: '#ff7a3d',
    blurb: 'Runs hot.',
    body: 0xff7a3d, belly: 0xffd0a3, limb: 0xe0562a, foot: 0x8f2f14,
    cheek: 0xffb27a, trim: 0xffcc33, antenna: 0xff9a5c,
  },
  ghostwave: {
    id: 'ghostwave', name: 'Ghostwave', cost: 2600, swatch: '#7df9ff',
    blurb: 'Barely there.',
    body: 0x7df9ff, belly: 0xd6ffff, limb: 0x4fd8e8, foot: 0x2a97a8,
    cheek: 0xa8fbff, trim: 0xffffff, antenna: 0xbdfdff,
    opacity: 0.62, emissiveBoost: 1.5,
  },
  voidcore: {
    id: 'voidcore', name: 'Void Core', cost: 4200, swatch: '#2b0b57',
    blurb: 'Light goes in. Nothing comes out.',
    body: 0x2b0b57, belly: 0x4c1d95, limb: 0x1e0740, foot: 0x120428,
    cheek: 0x7c3aed, trim: 0xff2ea6, antenna: 0xb57bff,
    metalness: 0.7, roughness: 0.25, emissiveBoost: 1.4,
  },
};

export const SKIN_LIST = Object.values(SKIN_PRESETS);

// ─── shared geometry (built once, shared by every instance) ─────────────────
const GEO = {};
function geo() {
  if (GEO.built) return GEO;
  GEO.sphere = new THREE.SphereGeometry(1, 22, 16);
  GEO.sphereLo = new THREE.SphereGeometry(1, 14, 10);
  GEO.capsule = new THREE.CapsuleGeometry(1, 1, 6, 12);
  GEO.cone = new THREE.ConeGeometry(1, 1, 12);
  GEO.cyl = new THREE.CylinderGeometry(1, 1, 1, 10);
  GEO.box = new RoundedBoxGeometry(1, 1, 1, 3, 0.22);
  GEO.torus = new THREE.TorusGeometry(1, 0.09, 8, 28);
  GEO.plane = new THREE.PlaneGeometry(1, 1);
  // 4-point star, matching the antenna tip from the 2D game.
  {
    const s = new THREE.Shape();
    const R = 1, r = 0.34;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU - Math.PI / 2;
      const d = i % 2 === 0 ? R : r;
      const x = Math.cos(a) * d, y = Math.sin(a) * d;
      i === 0 ? s.moveTo(x, y) : s.lineTo(x, y);
    }
    s.closePath();
    GEO.star = new THREE.ExtrudeGeometry(s, { depth: 0.22, bevelEnabled: true, bevelSize: 0.08, bevelThickness: 0.06, bevelSegments: 2 });
    GEO.star.center();
  }
  // Heart for HuHu's tummy.
  {
    const h = new THREE.Shape();
    h.moveTo(0, -0.75);
    h.bezierCurveTo(-0.1, -0.4, -1, -0.3, -1, 0.1);
    h.bezierCurveTo(-1, 0.75, 0, 0.6, 0, 0.2);
    h.bezierCurveTo(0, 0.6, 1, 0.75, 1, 0.1);
    h.bezierCurveTo(1, -0.3, 0.1, -0.4, 0, -0.75);
    GEO.heart = new THREE.ExtrudeGeometry(h, { depth: 0.16, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.05, bevelSegments: 2 });
    GEO.heart.center();
  }
  GEO.built = true;
  return GEO;
}

// ─── material helpers ────────────────────────────────────────────────────────
function matte(color, skin = {}, extra = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: skin.roughness ?? 0.55,
    metalness: skin.metalness ?? 0.1,
    transparent: skin.opacity !== undefined,
    opacity: skin.opacity ?? 1,
    ...extra,
  });
}

function glow(color, intensity = 1.4) {
  return new THREE.MeshStandardMaterial({
    color: 0x000000,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.4,
    metalness: 0,
    toneMapped: true,
  });
}

/** Pure unlit — for eyes and highlights that must never go dark. */
function flat(color, opts = {}) {
  return new THREE.MeshBasicMaterial({ color, toneMapped: false, ...opts });
}

function mesh(g, m, { pos = [0, 0, 0], scale = [1, 1, 1], rot = [0, 0, 0] } = {}) {
  const o = new THREE.Mesh(g, m);
  o.position.set(...pos);
  o.scale.set(...(typeof scale === 'number' ? [scale, scale, scale] : scale));
  o.rotation.set(...rot);
  return o;
}

// ─── ALIEN ───────────────────────────────────────────────────────────────────
export class Alien {
  constructor(skinId = 'default') {
    const g = geo();
    const skin = SKIN_PRESETS[skinId] ?? SKIN_PRESETS.default;
    this.skin = skin;
    this.root = new THREE.Group();
    this.parts = {};
    this.materials = [];

    const eb = skin.emissiveBoost ?? 1;

    // Pivot the whole character at the feet so ground contact is trivial.
    const body = new THREE.Group();
    body.position.y = 0;
    this.root.add(body);
    this.parts.body = body;

    // Torso — one chunky rounded box, exactly like the 2D silhouette.
    const torsoMat = matte(skin.body, skin, { emissive: skin.body, emissiveIntensity: 0.14 * eb });
    const torso = mesh(g.box, torsoMat, { pos: [0, 0.62, 0], scale: [0.62, 0.66, 0.52] });
    body.add(torso);
    this.parts.torso = torso;
    this.materials.push(torsoMat);

    // Belly patch.
    const bellyMat = matte(skin.belly, skin, { emissive: skin.belly, emissiveIntensity: 0.2 * eb });
    body.add(mesh(g.sphere, bellyMat, { pos: [0, 0.55, 0.2], scale: [0.22, 0.26, 0.14] }));
    this.materials.push(bellyMat);

    // Cyber chest plate — a thin emissive strip that catches the bloom.
    const trimMat = glow(skin.trim, 1.1 * eb);
    body.add(mesh(g.box, trimMat, { pos: [0, 0.42, 0.245], scale: [0.30, 0.045, 0.03] }));
    body.add(mesh(g.box, trimMat, { pos: [0, 0.86, 0.24], scale: [0.20, 0.035, 0.03] }));
    // Shoulder edge lights
    body.add(mesh(g.box, trimMat, { pos: [-0.3, 0.82, 0], scale: [0.035, 0.16, 0.035] }));
    body.add(mesh(g.box, trimMat, { pos: [0.3, 0.82, 0], scale: [0.035, 0.16, 0.035] }));
    this.trimMat = trimMat;
    this.materials.push(trimMat);

    // Eyes — the single most important read. Big, wide, low on the face.
    // Just under pure white on purpose: at 1.0 the sclera clears the bloom
    // threshold and the glow swallows the pupils, which is the whole expression.
    const eyeWhite = flat(0xdce8f5);
    const pupil = flat(0x140a2e);
    const spark = flat(0xffffff);
    this.parts.eyes = new THREE.Group();
    this.parts.eyes.position.set(0, 0.86, 0.0);
    body.add(this.parts.eyes);
    for (const sx of [-1, 1]) {
      const eye = new THREE.Group();
      eye.position.set(sx * 0.19, 0, 0.30);
      const white = mesh(g.sphere, eyeWhite, { scale: [0.155, 0.185, 0.13] });
      eye.add(white);
      const p = mesh(g.sphere, pupil, { pos: [0, 0, 0.08], scale: [0.076, 0.092, 0.07] });
      eye.add(p);
      eye.add(mesh(g.sphere, spark, { pos: [sx * 0.035 + 0.03, 0.055, 0.135], scale: 0.036 }));
      eye.add(mesh(g.sphere, spark, { pos: [-0.045, -0.03, 0.13], scale: 0.019 }));
      this.parts.eyes.add(eye);
      (this.parts.eyeGroups ??= []).push({ group: eye, white, pupil: p });
    }

    // Cheeks — additive blobs, same soft blush as the sprite.
    const cheekTex = radialBlob({ color: '#ffffff', power: 1.7 });
    const cheekMat = new THREE.MeshBasicMaterial({
      map: cheekTex, color: skin.cheek, transparent: true,
      opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    for (const sx of [-1, 1]) {
      body.add(mesh(g.plane, cheekMat, { pos: [sx * 0.3, 0.72, 0.26], scale: 0.24, rot: [0, sx * 0.5, 0] }));
    }

    // Mouth — a small torus arc gives the sprite's smile in 3D.
    const mouthMat = flat(0x6b21a8);
    const mouth = mesh(g.torus, mouthMat, { pos: [0, 0.66, 0.30], scale: [0.10, 0.075, 1], rot: [0, 0, Math.PI] });
    mouth.geometry = new THREE.TorusGeometry(1, 0.11, 6, 16, Math.PI);
    body.add(mouth);
    this.parts.mouth = mouth;

    // Antenna — stalk plus the 4-point star. The star's colour is driven by the
    // combo tier at runtime, so the player's state is readable on the character.
    const stalk = new THREE.Group();
    stalk.position.set(-0.04, 1.02, 0);
    body.add(stalk);
    const stalkMat = matte(skin.antenna, skin, { emissive: skin.antenna, emissiveIntensity: 0.5 * eb });
    stalk.add(mesh(g.cyl, stalkMat, { pos: [-0.05, 0.16, 0], scale: [0.022, 0.34, 0.022], rot: [0, 0, 0.32] }));
    const starMat = glow(skin.antenna, 2.6 * eb);
    const star = mesh(g.star, starMat, { pos: [-0.12, 0.35, 0], scale: 0.10 });
    stalk.add(star);
    this.parts.antenna = stalk;
    this.parts.star = star;
    this.starMat = starMat;
    this.materials.push(stalkMat, starMat);

    // Arms.
    const limbMat = matte(skin.limb, skin, { emissive: skin.limb, emissiveIntensity: 0.12 * eb });
    this.parts.arms = [];
    for (const sx of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx * 0.34, 0.82, 0);
      body.add(pivot);
      const arm = mesh(g.capsule, limbMat, { pos: [0, -0.16, 0], scale: [0.075, 0.14, 0.075] });
      pivot.add(arm);
      this.parts.arms.push(pivot);
    }
    this.materials.push(limbMat);

    // Legs + feet.
    const footMat = matte(skin.foot, skin, { emissive: skin.trim, emissiveIntensity: 0.25 * eb });
    this.parts.legs = [];
    for (const sx of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx * 0.17, 0.34, 0);
      body.add(pivot);
      const leg = mesh(g.capsule, limbMat, { pos: [0, -0.11, 0], scale: [0.072, 0.09, 0.072] });
      pivot.add(leg);
      const foot = mesh(g.box, footMat, { pos: [0, -0.26, 0.04], scale: [0.13, 0.07, 0.19] });
      pivot.add(foot);
      this.parts.legs.push(pivot);
    }
    this.materials.push(footMat);

    // Contact shadow — a cheap dark blob that sells "standing on the ground"
    // without paying for a real shadow map.
    const shadowMat = new THREE.MeshBasicMaterial({
      map: radialBlob({ color: '#000000', power: 2.6 }),
      transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false,
    });
    this.parts.shadow = mesh(g.plane, shadowMat, { pos: [0, 0.02, 0], scale: 1.1, rot: [-Math.PI / 2, 0, 0] });
    this.root.add(this.parts.shadow);
    this.shadowMat = shadowMat;

    // Animation state.
    this.phase = 0;
    this.blink = 0;
    this.blinkTimer = 2 + Math.random() * 3;
    this.lean = 0;
    this.squash = 1;
    this.pose = 'run';
    this._eyeScale = 1;
  }

  setSkin(skinId) {
    // Rebuilding is cheap and far less error-prone than patching every material.
    const parent = this.root.parent;
    const pos = this.root.position.clone();
    const rot = this.root.rotation.clone();
    this.dispose();
    const next = new Alien(skinId);
    next.root.position.copy(pos);
    next.root.rotation.copy(rot);
    parent?.add(next.root);
    parent?.remove(this.root);
    return next;
  }

  /** Drive the antenna star (and chest trim) from the combo tier colour. */
  setAccent(colorHex) {
    this.starMat.emissive.setHex(colorHex);
    this.trimMat.emissive.setHex(colorHex);
  }

  setStarIntensity(v) { this.starMat.emissiveIntensity = v; }

  /**
   * @param s.state   'run' | 'jump' | 'fall' | 'slide' | 'dash' | 'hit' | 'dead' | 'idle'
   * @param s.speed   normalised 0..1, drives stride frequency
   * @param s.grounded
   */
  update(dt, s) {
    const { state = 'run', speed = 0.5, groundY = 0 } = s;
    const p = this.parts;
    const stride = 7.5 + speed * 9;
    if (state === 'run' || state === 'idle') this.phase += dt * stride;
    const ph = this.phase;

    // Blink — the cheapest possible "alive" signal.
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) { this.blinkTimer = 2.2 + Math.random() * 3.4; this.blink = 1; }
    if (this.blink > 0) this.blink = Math.max(0, this.blink - dt * 7);
    const lidClose = Math.sin(clamp01(this.blink) * Math.PI);
    this._eyeScale = damp(this._eyeScale, 1 - lidClose * 0.92, 0.0001, dt);
    for (const e of p.eyeGroups) e.group.scale.y = Math.max(0.06, this._eyeScale);

    const target = { bodyY: 0, pitch: 0, squashY: 1, squashXZ: 1, armSwing: 0, legSwing: 0, headTilt: 0 };

    switch (state) {
      case 'run':
      case 'idle': {
        target.bodyY = Math.abs(Math.sin(ph)) * 0.055 * (0.5 + speed);
        target.legSwing = Math.sin(ph) * (0.55 + speed * 0.45);
        target.armSwing = -Math.sin(ph) * (0.42 + speed * 0.4);
        target.pitch = 0.06 + speed * 0.16;
        break;
      }
      case 'jump':
        target.bodyY = 0.04;
        target.pitch = -0.16;
        target.squashY = 1.14; target.squashXZ = 0.9;
        target.legSwing = 0.72;      // tuck
        target.armSwing = -1.15;     // arms up
        break;
      case 'fall':
        target.pitch = 0.14;
        target.squashY = 1.05; target.squashXZ = 0.96;
        target.legSwing = -0.42;
        target.armSwing = -0.75;
        break;
      case 'slide':
        target.bodyY = -0.30;
        target.pitch = 1.02;
        target.squashY = 0.72; target.squashXZ = 1.2;
        target.legSwing = -0.9;
        target.armSwing = 0.85;
        break;
      case 'dash':
        target.pitch = 0.44;
        target.squashY = 0.94; target.squashXZ = 1.06;
        target.legSwing = Math.sin(ph * 1.6) * 0.9;
        target.armSwing = -1.3;
        break;
      case 'hit':
        target.pitch = -0.3;
        target.squashY = 0.86; target.squashXZ = 1.15;
        target.armSwing = -1.4;
        break;
      case 'dead':
        target.pitch = 1.5;
        target.bodyY = -0.12;
        target.legSwing = -0.6;
        target.armSwing = -1.5;
        break;
    }

    const k = 0.0004;   // fraction of the gap left after one second
    p.body.position.y = damp(p.body.position.y, target.bodyY, k, dt);
    p.body.rotation.x = damp(p.body.rotation.x, target.pitch, k, dt);
    p.torso.scale.y = damp(p.torso.scale.y, 0.66 * target.squashY, k, dt);
    p.torso.scale.x = damp(p.torso.scale.x, 0.62 * target.squashXZ, k, dt);
    p.torso.scale.z = damp(p.torso.scale.z, 0.52 * target.squashXZ, k, dt);

    const running = state === 'run' || state === 'idle';
    p.legs[0].rotation.x = damp(p.legs[0].rotation.x, running ? target.legSwing : target.legSwing, k, dt);
    p.legs[1].rotation.x = damp(p.legs[1].rotation.x, running ? -target.legSwing : target.legSwing * 0.8, k, dt);
    p.arms[0].rotation.x = damp(p.arms[0].rotation.x, running ? target.armSwing : target.armSwing, k, dt);
    p.arms[1].rotation.x = damp(p.arms[1].rotation.x, running ? -target.armSwing : target.armSwing, k, dt);
    // Arms splay slightly outward in the air so the pose reads from behind.
    const splay = state === 'jump' || state === 'fall' || state === 'dash' ? 0.42 : 0.12;
    p.arms[0].rotation.z = damp(p.arms[0].rotation.z, splay, k, dt);
    p.arms[1].rotation.z = damp(p.arms[1].rotation.z, -splay, k, dt);

    // Antenna lags behind the body — secondary motion, the classic "alive" cue.
    const wobble = Math.sin(ph * 0.8) * 0.1 + (state === 'dash' ? -0.5 : 0);
    p.antenna.rotation.z = damp(p.antenna.rotation.z, wobble - this.lean * 0.6, 0.002, dt);
    p.antenna.rotation.x = damp(p.antenna.rotation.x, -target.pitch * 0.5 + Math.sin(ph * 0.6) * 0.07, 0.002, dt);

    // Ground shadow tracks height: smaller and fainter the higher you are.
    const h = clamp(this.root.position.y - groundY, 0, 4);
    this.parts.shadow.position.y = groundY - this.root.position.y + 0.02;
    const sc = clamp(1.1 - h * 0.14, 0.35, 1.1);
    this.parts.shadow.scale.set(sc, sc, sc);
    this.shadowMat.opacity = clamp(0.55 - h * 0.1, 0.08, 0.55);
  }

  /** Roll/steer feedback when changing lanes. */
  setLean(v) {
    this.lean = v;
    this.parts.body.rotation.z = -v * 0.34;
    this.parts.body.rotation.y = v * 0.22;
  }

  /**
   * Materials only. Geometry in GEO is module-level and shared by HuHu and by
   * every Alien built after this one, so disposing it here would blank out the
   * replacement character the instant a skin is switched.
   */
  dispose() {
    this.root.traverse(o => {
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose?.());
    });
  }
}

// ─── HUHU ────────────────────────────────────────────────────────────────────
// The owl now earns its keep: it carries the shield charges and reacts to every
// event, so the player reads their state by glancing at their companion.
export class HuHu {
  constructor() {
    const g = geo();
    this.root = new THREE.Group();
    this.parts = {};

    const bodyMat = matte(0xfbbf24, {}, { emissive: 0xfbbf24, emissiveIntensity: 0.22 });
    const tummyMat = matte(0xfef3c7, {}, { emissive: 0xfef3c7, emissiveIntensity: 0.3 });
    const wingMat = matte(0xd97706, {}, { emissive: 0xd97706, emissiveIntensity: 0.16 });
    const beakMat = matte(0xf97316, {}, { emissive: 0xf97316, emissiveIntensity: 0.4 });

    const body = new THREE.Group();
    this.root.add(body);
    this.parts.body = body;

    body.add(mesh(g.sphere, bodyMat, { pos: [0, 0, 0], scale: [0.20, 0.26, 0.19] }));
    body.add(mesh(g.sphere, tummyMat, { pos: [0, -0.04, 0.10], scale: [0.13, 0.17, 0.10] }));

    // Heart on the tummy — kept from the 2D sprite.
    const heartMat = flat(0xff6b9d, { transparent: true, opacity: 0.9 });
    this.parts.heart = mesh(g.heart, heartMat, { pos: [0, -0.02, 0.185], scale: 0.075 });
    body.add(this.parts.heart);
    this.heartMat = heartMat;

    // Head.
    const head = new THREE.Group();
    head.position.set(0, 0.26, 0);
    body.add(head);
    this.parts.head = head;
    head.add(mesh(g.sphere, bodyMat, { scale: 0.215 }));

    // Ear tufts.
    for (const sx of [-1, 1]) {
      head.add(mesh(g.cone, wingMat, { pos: [sx * 0.11, 0.20, -0.02], scale: [0.055, 0.16, 0.055], rot: [0, 0, -sx * 0.42] }));
    }

    // Eyes — enormous, the owl's whole personality.
    const eyeWhite = flat(0xffffff);
    const pupilMat = flat(0x140a2e);
    this.parts.eyes = [];
    for (const sx of [-1, 1]) {
      const eye = new THREE.Group();
      eye.position.set(sx * 0.093, 0.015, 0.15);
      head.add(eye);
      eye.add(mesh(g.sphere, eyeWhite, { scale: [0.105, 0.105, 0.08] }));
      const p = mesh(g.sphere, pupilMat, { pos: [0, 0, 0.055], scale: [0.052, 0.052, 0.045] });
      eye.add(p);
      eye.add(mesh(g.sphere, eyeWhite, { pos: [0.03, 0.035, 0.09], scale: 0.024 }));

      // Dead-eye crosses, matching the 2D game's knockout.
      const xMat = flat(0x140a2e);
      for (const rot of [0.7, -0.7]) {
        const bar = mesh(g.box, xMat, { pos: [0, 0, 0.075], scale: [0.09, 0.016, 0.016], rot: [0, 0, rot] });
        bar.visible = false;
        eye.add(bar);
        (this.parts.xEyes ??= []).push(bar);
      }
      this.parts.eyes.push({ group: eye, pupil: p });
    }

    // Beak.
    head.add(mesh(g.cone, beakMat, { pos: [0, -0.075, 0.20], scale: [0.05, 0.09, 0.05], rot: [Math.PI / 2 + 0.35, 0, 0] }));

    // Wings.
    this.parts.wings = [];
    for (const sx of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx * 0.18, 0.03, 0);
      body.add(pivot);
      const w = mesh(g.sphere, wingMat, { pos: [sx * 0.11, -0.02, 0], scale: [0.13, 0.19, 0.045], rot: [0, 0, -sx * 0.3] });
      pivot.add(w);
      this.parts.wings.push(pivot);
    }

    // Shield halo — a hex ring that brightens with remaining shield charges.
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0x16f2ff, transparent: true, opacity: 0.0,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
    });
    // Upright, not flat: a horizontal ring collapses to a bar from the chase
    // camera, which reads as a glitch rather than a shield.
    this.parts.halo = mesh(new THREE.TorusGeometry(0.36, 0.018, 6, 32), haloMat, { pos: [0, 0.02, -0.04], rot: [0.35, 0, 0] });
    this.root.add(this.parts.halo);
    this.haloMat = haloMat;

    // Thruster glow behind the owl — sells flight.
    const trailMat = new THREE.MeshBasicMaterial({
      map: radialBlob({ color: '#ffffff', power: 2.0 }),
      color: 0x16f2ff, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    this.parts.trail = mesh(g.plane, trailMat, { pos: [0, -0.02, -0.26], scale: 0.4 });
    this.root.add(this.parts.trail);
    this.trailMat = trailMat;

    this.phase = Math.random() * TAU;
    this.dead = false;
    this.blinkTimer = 1.5 + Math.random() * 3;
    this.blink = 0;
    this.flapBoost = 0;
    this.pulseT = 0;
    this.tumble = 0;
  }

  celebrate() { this.flapBoost = 1; }

  /** Knocked out absorbing a hit: X eyes, wings wide, tumbling away. */
  knockOut() {
    this.dead = true;
    this.tumble = 0;
    for (const e of this.parts.eyes) e.pupil.visible = false;
    this.parts.xEyes.forEach(x => { x.visible = true; });
  }

  revive() {
    this.dead = false;
    this.tumble = 0;
    this.parts.body.rotation.set(0, 0, 0);
    this.heartMat.opacity = 0.9;
    for (const e of this.parts.eyes) e.pupil.visible = true;
    this.parts.xEyes.forEach(x => { x.visible = false; });
    this.flapBoost = 1;
  }

  /** Pulse dash: rockets forward, wings swept back, trail blazing. */
  pulse() {
    this.pulseT = 1;
    this.flapBoost = 1.4;
  }

  setShield(count, max) {
    const t = max > 0 ? count / max : 0;
    this.haloMat.opacity = t * 0.85;
    this.parts.halo.scale.setScalar(0.9 + t * 0.25);
  }

  setAccent(colorHex) {
    this.haloMat.color.setHex(colorHex);
    this.trailMat.color.setHex(colorHex);
  }

  update(dt, s = {}) {
    const { state = 'fly', speed = 0.5 } = s;
    this.phase += dt * (9 + speed * 7 + this.flapBoost * 12);
    this.flapBoost = Math.max(0, this.flapBoost - dt * 2);
    const p = this.parts;

    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) { this.blinkTimer = 1.8 + Math.random() * 3.6; this.blink = 1; }
    if (this.blink > 0) this.blink = Math.max(0, this.blink - dt * 8);
    const lid = 1 - Math.sin(clamp01(this.blink) * Math.PI) * 0.9;
    for (const e of p.eyes) e.group.scale.y = Math.max(0.08, lid);

    if (state === 'dead') {
      // Wings flung wide, tumbling — matches the 2D death.
      p.wings[0].rotation.z = damp(p.wings[0].rotation.z, -1.1, 0.002, dt);
      p.wings[1].rotation.z = damp(p.wings[1].rotation.z, 1.1, 0.002, dt);
      this.tumble += dt * 4;
      p.body.rotation.z = this.tumble;
      this.trailMat.opacity = damp(this.trailMat.opacity, 0, 0.002, dt);
      this.heartMat.opacity = damp(this.heartMat.opacity, 0.25, 0.01, dt);
      return;
    }

    if (this.pulseT > 0) this.pulseT = Math.max(0, this.pulseT - dt * 2.6);
    const flap = Math.sin(this.phase) * (0.55 + this.flapBoost * 0.5) - this.pulseT * 0.5;
    p.wings[0].rotation.z = flap;
    p.wings[1].rotation.z = -flap;
    p.wings[0].rotation.x = Math.cos(this.phase) * 0.18;
    p.wings[1].rotation.x = Math.cos(this.phase) * 0.18;

    // Body bob and a slow head turn — owls are all head movement.
    p.body.position.y = Math.sin(this.phase * 0.5) * 0.035;
    p.head.rotation.y = damp(p.head.rotation.y, Math.sin(this.phase * 0.16) * 0.42, 0.004, dt);
    p.head.rotation.z = damp(p.head.rotation.z, Math.sin(this.phase * 0.11) * 0.2, 0.004, dt);

    p.halo.rotation.z += dt * 1.4;
    const pulse = 0.5 + Math.sin(this.phase * 0.9) * 0.12;
    this.trailMat.opacity = 0.35 + pulse * 0.35 + speed * 0.2 + this.pulseT * 0.5;
    this.parts.trail.scale.setScalar(0.34 + speed * 0.22 + Math.sin(this.phase * 2) * 0.03 + this.pulseT * 0.9);
  }

  /**
   * Materials only. Geometry in GEO is module-level and shared by HuHu and by
   * every Alien built after this one, so disposing it here would blank out the
   * replacement character the instant a skin is switched.
   */
  dispose() {
    this.root.traverse(o => {
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose?.());
    });
  }
}
