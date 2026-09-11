// ─── FX ──────────────────────────────────────────────────────────────────────
// Particles, screen shake, hitstop and camera kick — the "juice" layer.
//
// Particles live in one pre-allocated THREE.Points cloud with additive blending.
// Nothing is allocated per emit: dead slots are reused from a free list, so a
// long run never triggers a GC hitch mid-jump.

import * as THREE from 'three';
import { clamp, fxRng, damp } from './util.js';

const MAX_PARTICLES = 1400;

/** Soft radial sprite, generated once — no image files. */
function makeSprite() {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0.00, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.28)');
  grad.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const PARTICLE_VS = /* glsl */`
  attribute float aSize;
  attribute vec3  aColor;
  attribute float aAlpha;
  varying vec3 vColor;
  varying float vAlpha;
  uniform float uScale;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(0.001, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const PARTICLE_FS = /* glsl */`
  uniform sampler2D uMap;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 t = texture2D(uMap, gl_PointCoord);
    if (t.a < 0.01) discard;
    gl_FragColor = vec4(vColor * t.a, t.a * vAlpha);
  }
`;

export class Particles {
  constructor(scene, budgetScale = 1) {
    this.max = Math.floor(MAX_PARTICLES * budgetScale);
    const n = this.max;

    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.spin = new Float32Array(n);   // size growth rate
    this.active = new Uint8Array(n);
    this.free = [];
    for (let i = n - 1; i >= 0; i--) this.free.push(i);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.setDrawRange(0, n);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6); // never cull

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: makeSprite() },
        uScale: { value: 620 },
      },
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    scene.add(this.points);
    this.geo = geo;
    this._dirty = true;
    // Reused emit payload — see burst().
    this._scratch = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, color: 0xffffff,
                      size: 1, life: 0.6, drag: 2, gravity: 0, grow: 0, alpha: 1 };
  }

  /** Spawn one particle. All params are absolute world-space. */
  emit({ x, y, z, vx = 0, vy = 0, vz = 0, color = 0xffffff, size = 1, life = 0.6,
         drag = 2.0, gravity = 0, grow = 0, alpha = 1 }) {
    const i = this.free.pop();
    if (i === undefined) return -1;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    const c = typeof color === 'number' ? color : color.getHex?.() ?? 0xffffff;
    this.col[i3] = ((c >> 16) & 255) / 255;
    this.col[i3 + 1] = ((c >> 8) & 255) / 255;
    this.col[i3 + 2] = (c & 255) / 255;
    this.size[i] = size;
    this.alpha[i] = alpha;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.drag[i] = drag;
    this.grav[i] = gravity;
    this.spin[i] = grow;
    this.active[i] = 1;
    this._dirty = true;
    return i;
  }

  /**
   * Radial burst. `spread` biases the cone: 1 = sphere, 0 = straight along dir.
   *
   * Fills one reused scratch object rather than spreading `opts` per particle —
   * a death burst is 46 particles, in the one frame that must not stutter.
   */
  burst(n, opts) {
    const { x, y, z, speed = 6, speedVar = 0.5, dir = null, spread = 1 } = opts;
    const e = this._scratch;
    e.color = opts.color ?? 0xffffff;
    e.drag = opts.drag ?? 2.0;
    e.gravity = opts.gravity ?? 0;
    e.grow = opts.grow ?? 0;
    e.alpha = opts.alpha ?? 1;
    const baseSize = opts.size ?? 1;
    const baseLife = opts.life ?? 0.6;

    for (let k = 0; k < n; k++) {
      let dx = fxRng.range(-1, 1), dy = fxRng.range(-1, 1), dz = fxRng.range(-1, 1);
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len; dy /= len; dz /= len;
      if (dir) {
        dx = dir.x + dx * spread;
        dy = dir.y + dy * spread;
        dz = dir.z + dz * spread;
      }
      const s = speed * (1 + fxRng.range(-speedVar, speedVar));
      e.x = x + fxRng.range(-0.08, 0.08);
      e.y = y + fxRng.range(-0.08, 0.08);
      e.z = z + fxRng.range(-0.08, 0.08);
      e.vx = dx * s; e.vy = dy * s; e.vz = dz * s;
      e.size = baseSize * fxRng.range(0.7, 1.35);
      e.life = baseLife * fxRng.range(0.7, 1.3);
      this.emit(e);
    }
  }

  /** Flat expanding ring in the XY plane — impact and pickup pops. */
  ring(n, opts) {
    const { x, y, z, radius = 0.4, speed = 5 } = opts;
    const e = this._scratch;
    e.color = opts.color ?? 0xffffff;
    e.drag = opts.drag ?? 2.0;
    e.gravity = opts.gravity ?? 0;
    e.grow = opts.grow ?? 0;
    e.alpha = opts.alpha ?? 1;
    e.size = opts.size ?? 1;
    e.life = opts.life ?? 0.6;

    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + fxRng.range(-0.1, 0.1);
      e.x = x + Math.cos(a) * radius;
      e.y = y + Math.sin(a) * radius;
      e.z = z;
      e.vx = Math.cos(a) * speed; e.vy = Math.sin(a) * speed; e.vz = fxRng.range(-0.6, 0.6);
      this.emit(e);
    }
  }

  update(dt) {
    const { pos, vel, life, maxLife, alpha, size, drag, grav, spin, active } = this;
    let any = false;
    for (let i = 0; i < this.max; i++) {
      if (!active[i]) continue;
      any = true;
      life[i] -= dt;
      if (life[i] <= 0) {
        active[i] = 0;
        alpha[i] = 0;
        size[i] = 0;
        this.free.push(i);
        continue;
      }
      const i3 = i * 3;
      const d = Math.exp(-drag[i] * dt);
      vel[i3] *= d; vel[i3 + 1] *= d; vel[i3 + 2] *= d;
      vel[i3 + 1] -= grav[i] * dt;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
      const t = life[i] / maxLife[i];
      alpha[i] = t * t;                    // quadratic fade reads cleaner than linear
      size[i] += spin[i] * dt;
    }
    if (any || this._dirty) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.aColor.needsUpdate = true;
      this.geo.attributes.aSize.needsUpdate = true;
      this.geo.attributes.aAlpha.needsUpdate = true;
      this._dirty = any;
    }
  }

  clear() {
    this.active.fill(0);
    this.alpha.fill(0);
    this.size.fill(0);
    this.free.length = 0;
    for (let i = this.max - 1; i >= 0; i--) this.free.push(i);
    this._dirty = true;
  }

  get liveCount() { return this.max - this.free.length; }
}

// ─── camera shake & hitstop ──────────────────────────────────────────────────
// Trauma-based shake (Squirrel Eiserloh's model): callers add trauma, and the
// shake magnitude is trauma², which decays. Small hits stay subtle, big hits
// slam, and overlapping hits never look like a sum of two sine waves.
export class Shake {
  constructor() {
    this.trauma = 0;
    this.t = 0;
    this.offset = new THREE.Vector3();
    this.roll = 0;
    this.scale = 1;         // user setting multiplier
    this.hitstop = 0;
  }

  add(amount) { this.trauma = Math.min(1, this.trauma + amount); }

  /** Freeze time briefly on impact — the single cheapest way to sell a hit. */
  freeze(seconds) { this.hitstop = Math.max(this.hitstop, seconds); }

  update(dt) {
    this.t += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const s = this.trauma * this.trauma * this.scale;
    if (s <= 0.0001) {
      this.offset.set(0, 0, 0);
      this.roll = 0;
      return;
    }
    // Layered sines at incommensurate frequencies — cheaper than noise, reads
    // as random, and is deterministic so it never spikes.
    const f = this.t * 34;
    this.offset.set(
      (Math.sin(f * 1.00) + Math.sin(f * 2.31) * 0.5) * 0.34 * s,
      (Math.sin(f * 1.37) + Math.sin(f * 2.79) * 0.5) * 0.30 * s,
      (Math.sin(f * 0.83)) * 0.16 * s,
    );
    this.roll = Math.sin(f * 0.71) * 0.045 * s;
  }

  /** @returns dt to use for gameplay this frame (0 while frozen). */
  consumeHitstop(dt) {
    if (this.hitstop <= 0) return dt;
    this.hitstop -= dt;
    return 0;
  }
}

// ─── camera rig ──────────────────────────────────────────────────────────────
// Follows the player with lag, kicks on speed changes, and applies shake last so
// shake never fights the follow spring.
export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.target = new THREE.Vector3();
    this.position = new THREE.Vector3(0, 3.2, 7.5);
    this.lookAt = new THREE.Vector3();
    this.lookTarget = new THREE.Vector3();
    this.fovBase = 62;
    this.fovKick = 0;
    this.shake = new Shake();
    this._tmp = new THREE.Vector3();
  }

  /** @param kick 0..1 extra FOV, used for dash and speed milestones. */
  addFovKick(v) { this.fovKick = Math.min(1.6, this.fovKick + v); }

  update(dt, desiredPos, desiredLook, opts = {}) {
    const follow = opts.follow ?? 0.0006;    // fraction of gap left after 1s
    const lookFollow = opts.lookFollow ?? 0.0002;

    this.position.x = damp(this.position.x, desiredPos.x, follow, dt);
    this.position.y = damp(this.position.y, desiredPos.y, follow, dt);
    this.position.z = damp(this.position.z, desiredPos.z, follow * 0.4, dt);

    this.lookAt.x = damp(this.lookAt.x, desiredLook.x, lookFollow, dt);
    this.lookAt.y = damp(this.lookAt.y, desiredLook.y, lookFollow, dt);
    this.lookAt.z = damp(this.lookAt.z, desiredLook.z, lookFollow, dt);

    this.shake.update(dt);
    this.fovKick = damp(this.fovKick, 0, 0.02, dt);

    this.camera.position.copy(this.position).add(this.shake.offset);
    this.camera.lookAt(this.lookAt);
    this.camera.rotateZ(this.shake.roll + (opts.roll ?? 0));

    // Clamped: base (up to 64 in portrait) plus speed plus Overdrive plus a
    // kick reached ~93 degrees, which fish-eyes the track at the exact moment
    // the player most needs to read it.
    const fov = clamp(this.fovBase + this.fovKick * 12 + (opts.speedFov ?? 0), 40, this.fovBase + 16);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  snap(pos, look) {
    this.position.copy(pos);
    this.lookAt.copy(look);
    this.camera.position.copy(pos);
    this.camera.lookAt(look);
  }
}
