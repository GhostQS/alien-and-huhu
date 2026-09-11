// ─── OBSTACLES ───────────────────────────────────────────────────────────────
// Every obstacle is a pooled THREE.Group with an axis-aligned hitbox.
//
// Two rules govern the design of this file:
//   1. Each obstacle demands exactly one verb — JUMP, SLIDE or DODGE. Anything
//      ambiguous is unfair at speed, because the player reads the silhouette in
//      well under a second.
//   2. Hitboxes are inset from the visual bounds. The original 2D game did this
//      too; forgiveness is what separates "I misjudged that" from "that was rigged".

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { LANE_X } from './world.js';
import { Pool, lerp, TAU } from '../core/util.js';
import { techPanel, holoSheet, radialBlob } from '../render/textures.js';

export const VERB = { JUMP: 'jump', SLIDE: 'slide', DODGE: 'dodge' };

// Player capsule reference — obstacle heights are tuned against these.
export const PLAYER = {
  height: 1.30,
  slideHeight: 0.58,
  radius: 0.34,
  jumpApex: 1.70,          // peak of a single jump, feet-relative
};

// ─── shared geometry & materials ────────────────────────────────────────────
let G = null;
function shared() {
  if (G) return G;
  G = {
    box: new RoundedBoxGeometry(1, 1, 1, 2, 0.06),
    plate: new RoundedBoxGeometry(1, 1, 1, 3, 0.14),
    cyl: new THREE.CylinderGeometry(1, 1, 1, 12),
    cone: new THREE.ConeGeometry(1, 1, 6),
    sphere: new THREE.SphereGeometry(1, 16, 12),
    octa: new THREE.OctahedronGeometry(1, 0),
    torus: new THREE.TorusGeometry(1, 0.08, 8, 24),
    plane: new THREE.PlaneGeometry(1, 1),
  };
  return G;
}

// Obstacles must read as threats at 60+ units through fog, against a dark road.
// That means they cannot rely on scene lighting: the body carries its own
// emissive panel map, and every silhouette edge gets an unlit neon strip.
function bodyMaterial(accent = '#ff3b5c') {
  const panel = techPanel({ base: '#232a45', line: accent, lit: accent, density: 3, glow: 0.85, seed: 12 });
  return new THREE.MeshStandardMaterial({
    map: panel,
    emissiveMap: panel,
    color: 0xffffff,
    roughness: 0.42,
    metalness: 0.55,
    emissive: new THREE.Color(accent),
    emissiveIntensity: 0.75,
    fog: true,
  });
}

/** Bright unlit shell that traces an obstacle's outline. */
function edgeMaterial(color) {
  return new THREE.MeshBasicMaterial({ color, toneMapped: false, fog: true });
}

function neonMaterial(color, opacity = 1) {
  return new THREE.MeshBasicMaterial({
    color, toneMapped: false, transparent: opacity < 1, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
}

// ─── builders ────────────────────────────────────────────────────────────────
// Each returns { object, size:[w,h,d], hitOffsetY } and is called once per pool
// slot. Colour is re-tinted per biome at spawn time via `tint()`.

function buildBarrier() {
  const g = shared();
  const root = new THREE.Group();
  const body = new THREE.Mesh(g.plate, bodyMaterial('#ff3b5c'));
  body.scale.set(1.55, 0.72, 0.42);
  body.position.y = 0.36;
  root.add(body);

  // Hazard stripes on the face — instantly reads "go over this".
  const stripe = new THREE.Mesh(g.plane, edgeMaterial(0xff3b5c));
  stripe.scale.set(1.42, 0.15, 1);
  stripe.position.set(0, 0.5, 0.225);
  root.add(stripe);
  const stripe2 = stripe.clone();
  stripe2.position.y = 0.2;
  root.add(stripe2);

  // Top light bar — the edge the player must clear. Kept white so the exact
  // clearance height is unambiguous at any distance.
  const top = new THREE.Mesh(g.box, edgeMaterial(0xffffff));
  top.scale.set(1.66, 0.07, 0.5);
  top.position.y = 0.74;
  root.add(top);

  root.userData.neon = [stripe.material, stripe2.material];
  root.userData.body = body.material;
  return { object: root, size: [1.6, 0.74, 0.46], verb: VERB.JUMP };
}

function buildGate() {
  const g = shared();
  const root = new THREE.Group();
  const mat = bodyMaterial('#16f2ff');

  // Two posts and a heavy lintel — the negative space under it is the message.
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(g.box, mat);
    post.scale.set(0.2, 2.6, 0.3);
    post.position.set(sx * 0.85, 1.3, 0);
    root.add(post);
  }
  const lintel = new THREE.Mesh(g.plate, mat);
  lintel.scale.set(1.95, 0.6, 0.4);
  lintel.position.y = 1.85;
  root.add(lintel);

  // Laser curtain hanging from the lintel down to slide height.
  const curtainMat = new THREE.MeshBasicMaterial({
    map: holoSheet({ color: '#16f2ff', lines: 30 }),
    color: 0x16f2ff, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
  });
  const curtain = new THREE.Mesh(g.plane, curtainMat);
  curtain.scale.set(1.72, 1.18, 1);
  curtain.position.y = 1.21;
  root.add(curtain);
  // Backing plate so the curtain reads as solid rather than a faint haze.
  const fill = new THREE.Mesh(g.plane, new THREE.MeshBasicMaterial({
    color: 0x0d4f63, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false,
  }));
  fill.scale.set(1.7, 1.16, 1);
  fill.position.set(0, 1.21, -0.02);
  root.add(fill);

  // The critical line: everything above this bar is lethal. Solid white so it
  // is the first thing the eye finds.
  const bar = new THREE.Mesh(g.box, edgeMaterial(0xffffff));
  bar.scale.set(1.8, 0.075, 0.38);
  bar.position.y = 0.62;
  root.add(bar);
  for (const sx of [-1, 1]) {
    const edge = new THREE.Mesh(g.box, edgeMaterial(0x16f2ff));
    edge.scale.set(0.07, 2.6, 0.34);
    edge.position.set(sx * 0.85, 1.3, 0.17);
    root.add(edge);
  }

  root.userData.neon = [curtainMat, bar.material];
  root.userData.body = mat;
  root.userData.scroll = curtainMat;
  // Hitbox covers only the blocked band: from slide clearance up to the lintel.
  return { object: root, size: [1.8, 1.9, 0.4], hitOffsetY: 1.55, verb: VERB.SLIDE };
}

function buildPylon() {
  const g = shared();
  const root = new THREE.Group();
  const mat = bodyMaterial('#b57bff');
  const core = new THREE.Mesh(g.plate, mat);
  core.scale.set(1.3, 3.0, 0.62);
  core.position.y = 1.5;
  root.add(core);

  // Large lit face. Thin seams alone vanish at distance; a big flat emissive
  // plate is what actually gets seen at 30+ units.
  const face = new THREE.Mesh(g.plane, new THREE.MeshBasicMaterial({
    map: holoSheet({ color: '#b57bff', lines: 22 }),
    color: 0xb57bff, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  }));
  face.scale.set(1.1, 2.7, 1);
  face.position.set(0, 1.5, 0.32);
  root.add(face);

  // Vertical light seams down the full height — a solid, unmistakable wall.
  for (const sx of [-1, 1]) {
    const seam = new THREE.Mesh(g.box, edgeMaterial(0xb57bff));
    seam.scale.set(0.09, 2.9, 0.7);
    seam.position.set(sx * 0.62, 1.5, 0);
    root.add(seam);
  }
  for (const sy of [0.15, 2.85]) {
    const cap = new THREE.Mesh(g.box, edgeMaterial(0xffffff));
    cap.scale.set(1.34, 0.07, 0.66);
    cap.position.set(0, sy, 0);
    root.add(cap);
  }
  const eye = new THREE.Mesh(g.octa, neonMaterial(0xff2ea6, 1));
  eye.scale.setScalar(0.22);
  eye.position.set(0, 2.2, 0.34);
  root.add(eye);

  root.userData.neon = root.children.filter(c => c.material?.blending === THREE.AdditiveBlending).map(c => c.material);
  root.userData.body = mat;
  root.userData.spin = eye;
  return { object: root, size: [1.35, 3.0, 0.65], verb: VERB.DODGE };
}

function buildDrone() {
  const g = shared();
  const root = new THREE.Group();
  const mat = bodyMaterial('#ffcc33');

  const hull = new THREE.Mesh(g.sphere, mat);
  hull.scale.set(0.52, 0.30, 0.52);
  root.add(hull);
  const ring = new THREE.Mesh(g.torus, edgeMaterial(0xffcc33));
  ring.scale.setScalar(0.62);
  ring.rotation.x = Math.PI / 2;
  root.add(ring);
  const eye = new THREE.Mesh(g.sphere, edgeMaterial(0xff3b5c));
  eye.scale.setScalar(0.17);
  eye.position.z = 0.4;
  root.add(eye);
  // Underside glow gives the drone a footprint on the road, which is what the
  // player actually tracks when deciding which lane is free.
  const belly = new THREE.Mesh(g.sphere, edgeMaterial(0xffcc33));
  belly.scale.set(0.3, 0.06, 0.3);
  belly.position.y = -0.2;
  root.add(belly);

  // Downward search light — telegraphs the lane it is about to occupy.
  const beamMat = new THREE.MeshBasicMaterial({
    map: radialBlob({ color: '#ffffff', power: 1.4 }),
    color: 0xffcc33, transparent: true, opacity: 0.32,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const beam = new THREE.Mesh(g.plane, beamMat);
  beam.rotation.x = -Math.PI / 2;
  beam.scale.setScalar(1.5);
  beam.position.y = -1.0;
  root.add(beam);

  root.userData.neon = [ring.material, eye.material, beamMat];
  root.userData.body = mat;
  root.userData.spin = ring;
  return { object: root, size: [1.05, 0.62, 1.05], verb: VERB.DODGE, hover: true };
}

function buildFan() {
  // A spinning blade assembly that leaves a safe gap — pure DODGE, but the
  // rotation makes it read as dangerous far more than a static block would.
  const g = shared();
  const root = new THREE.Group();
  const mat = bodyMaterial('#3dffab');
  const hub = new THREE.Mesh(g.cyl, mat);
  hub.scale.set(0.22, 0.3, 0.22);
  hub.rotation.x = Math.PI / 2;
  hub.position.y = 1.1;
  root.add(hub);

  const spinner = new THREE.Group();
  spinner.position.y = 1.1;
  root.add(spinner);
  for (let i = 0; i < 3; i++) {
    const blade = new THREE.Mesh(g.box, mat);
    blade.scale.set(1.5, 0.16, 0.12);
    blade.rotation.z = (i / 3) * TAU;
    blade.position.set(Math.cos((i / 3) * TAU) * 0.75, Math.sin((i / 3) * TAU) * 0.75, 0);
    spinner.add(blade);
    const edge = new THREE.Mesh(g.box, edgeMaterial(0x3dffab));
    edge.scale.set(1.54, 0.07, 0.16);
    edge.rotation.z = blade.rotation.z;
    edge.position.copy(blade.position);
    spinner.add(edge);
  }

  root.userData.neon = [];
  root.userData.body = mat;
  root.userData.spin2 = spinner;
  return { object: root, size: [1.7, 1.5, 0.3], hitOffsetY: 1.1, verb: VERB.DODGE };
}

function buildLowBlock() {
  // Wide, waist-high slab spanning two lanes — a JUMP that also forces a
  // decision about where to land.
  const g = shared();
  const root = new THREE.Group();
  const mat = bodyMaterial('#ff7a3d');
  const body = new THREE.Mesh(g.plate, mat);
  body.scale.set(3.6, 0.55, 0.5);
  body.position.y = 0.28;
  root.add(body);
  const top = new THREE.Mesh(g.box, edgeMaterial(0xffffff));
  top.scale.set(3.7, 0.08, 0.58);
  top.position.y = 0.57;
  root.add(top);
  for (const sx of [-1, 0, 1]) {
    const chevron = new THREE.Mesh(g.plane, edgeMaterial(0xff7a3d));
    chevron.scale.set(0.9, 0.13, 1);
    chevron.position.set(sx * 1.15, 0.3, 0.26);
    root.add(chevron);
  }
  root.userData.neon = [top.material];
  root.userData.body = mat;
  return { object: root, size: [3.65, 0.57, 0.54], verb: VERB.JUMP, wide: true };
}

export const OBSTACLE_TYPES = {
  barrier: { build: buildBarrier, weight: 1.0, minDistance: 0 },
  gate: { build: buildGate, weight: 0.9, minDistance: 120 },
  pylon: { build: buildPylon, weight: 0.85, minDistance: 60 },
  drone: { build: buildDrone, weight: 0.7, minDistance: 320 },
  fan: { build: buildFan, weight: 0.5, minDistance: 700 },
  lowblock: { build: buildLowBlock, weight: 0.45, minDistance: 480 },
};

// ─── manager ─────────────────────────────────────────────────────────────────
export class Obstacles {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);

    this.pools = new Map();
    for (const [name, def] of Object.entries(OBSTACLE_TYPES)) {
      this.pools.set(name, new Pool(
        () => {
          const built = def.build();
          built.object.visible = false;
          this.group.add(built.object);
          return built;
        },
        (item, lane, z, opts) => this._reset(item, name, lane, z, opts),
        2,
      ));
    }
    this.live = [];
    this._tint = null;
  }

  _reset(item, typeName, lane, z, opts = {}) {
    const o = item.object;
    item.type = typeName;
    item.lane = lane;
    item.hover = opts.hover ?? false;
    item.dead = false;
    // Must be cleared: these objects are recycled, and a stale `scored` means
    // that pool slot silently stops awarding near-miss bonuses for the rest of
    // the session.
    item.scored = false;
    item.prevZ = z;
    item.hitY = item.hitOffsetY ?? item.size[1] / 2;
    item.laneDrift = opts.laneDrift ?? null;
    item.driftPhase = opts.driftPhase ?? 0;
    item.baseY = opts.y ?? 0;

    o.visible = true;
    o.position.set(opts.wide ? 0 : LANE_X[lane], item.baseY, z);
    o.rotation.set(0, 0, 0);
    o.scale.setScalar(1);
    if (this._tint) this._applyTint(item, this._tint);
    return item;
  }

  // Obstacles deliberately do NOT take the biome colour. Every environment
  // recolours around them, and an obstacle that recolours with it stops reading
  // as a threat — the player has to re-learn "what is dangerous" each biome.
  // The hazard palette is fixed for the whole game.
  _applyTint() {}

  setBiome(biome) { this._tint = biome; }

  spawn(typeName, lane, z, opts = {}) {
    const pool = this.pools.get(typeName);
    if (!pool) return null;
    const def = OBSTACLE_TYPES[typeName];
    const proto = pool.free[pool.free.length - 1];
    const item = pool.acquire(lane, z, { ...opts, wide: proto?.wide });
    item.verb = item.verb ?? def.verb;
    this.live.push(item);
    return item;
  }

  update(dt, speed) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const item = this.live[i];
      const o = item.object;
      // Remember where it was: at 46 u/s with a 50 ms frame an obstacle jumps
      // 2.3 units, far more than its own depth, so a discrete test can miss the
      // player entirely. Collision sweeps this interval instead.
      item.prevZ = o.position.z;
      o.position.z += speed * dt;

      // Per-type idle motion.
      if (o.userData.spin) o.userData.spin.rotation.y += dt * 2.4;
      if (o.userData.spin2) o.userData.spin2.rotation.z += dt * 3.6;
      if (o.userData.scroll) o.userData.scroll.map.offset.y -= dt * 0.9;

      if (item.hover) {
        o.position.y = item.baseY + Math.sin(o.position.z * 0.25) * 0.12;
      }
      // Drones slide between lanes so the safe lane is not static.
      if (item.laneDrift !== null) {
        const t = (Math.sin(o.position.z * 0.06 + item.driftPhase) + 1) / 2;
        o.position.x = lerp(LANE_X[item.lane], LANE_X[item.laneDrift], t);
      }

      if (o.position.z > 16) {
        o.visible = false;
        this.pools.get(item.type).release(item);
        this.live.splice(i, 1);
      }
    }
  }

  /**
   * AABB overlap against the player's capsule-as-box, SWEPT along z.
   *
   * The z axis is swept because the world moves fast enough to step an obstacle
   * clean through the player between two frames; x and y are tested at the
   * current frame only, which errs in the player's favour on a late dodge.
   */
  collides(px, py, halfW, halfH, item) {
    const o = item.object;
    const [w, h, d] = item.size;
    // A little forgiveness on every axis, matching the 2D game's inset hitboxes.
    const INSET = 0.08;
    const hw = w / 2 - INSET;
    const hh = h / 2 - INSET;
    const hd = d / 2 - INSET;
    const oy = o.position.y + item.hitY;
    const PLAYER_HALF_DEPTH = 0.42;

    const z0 = item.prevZ ?? o.position.z;
    const z1 = o.position.z;
    const lo = Math.min(z0, z1) - hd;
    const hi = Math.max(z0, z1) + hd;
    if (hi < -PLAYER_HALF_DEPTH || lo > PLAYER_HALF_DEPTH) return false;

    if (Math.abs(px - o.position.x) > hw + halfW) return false;
    if (Math.abs(py - oy) > hh + halfH) return false;
    return true;
  }

  clear() {
    for (const item of this.live) {
      item.object.visible = false;
      this.pools.get(item.type).release(item);
    }
    this.live.length = 0;
  }
}
