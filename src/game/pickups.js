// ─── PICKUPS ─────────────────────────────────────────────────────────────────
// Shards are the score/currency spine; cores and power-ups are the spice.
//
// Shards use a single InstancedMesh: a run can have a hundred on screen and
// they must cost close to nothing. Cores and power-ups are rarer, so they get
// real Groups with proper geometry.

import * as THREE from 'three';
import { LANE_X } from './world.js';
import { Pool, TAU } from '../core/util.js';
import { hexShield, radialBlob } from '../render/textures.js';

export const POWERUP = {
  MAGNET: 'magnet',
  OVERDRIVE: 'overdrive',
  DOUBLE: 'double',
};

export const POWERUP_META = {
  [POWERUP.MAGNET]: { label: 'Magnet', color: '#16f2ff', hex: 0x16f2ff, duration: 8 },
  [POWERUP.OVERDRIVE]: { label: 'Overdrive', color: '#ffcc33', hex: 0xffcc33, duration: 5 },
  [POWERUP.DOUBLE]: { label: 'Double', color: '#ff2ea6', hex: 0xff2ea6, duration: 10 },
};

const MAX_SHARDS = 220;
const MAGNET_RADIUS = 6.5;
const PICKUP_RADIUS = 0.72;

// ─── shards ──────────────────────────────────────────────────────────────────
export class Shards {
  constructor(scene) {
    const geo = new THREE.OctahedronGeometry(0.19, 0);
    this.material = new THREE.MeshStandardMaterial({
      color: 0x0d2b33,
      emissive: 0x16f2ff,
      emissiveIntensity: 2.1,
      roughness: 0.15,
      metalness: 0.9,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, MAX_SHARDS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);

    // A soft additive halo behind each shard so they pop against the dark road.
    this.haloMat = new THREE.MeshBasicMaterial({
      map: radialBlob({ color: '#ffffff', power: 2.0 }),
      color: 0x16f2ff, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    this.halos = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.85, 0.85), this.haloMat, MAX_SHARDS);
    this.halos.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.halos.frustumCulled = false;
    this.halos.count = 0;
    scene.add(this.halos);

    this.items = [];        // { x, y, z, phase, taken, flyT }
    this._d = new THREE.Object3D();
    this._free = [];
    for (let i = MAX_SHARDS - 1; i >= 0; i--) this._free.push(i);
    this.slots = new Array(MAX_SHARDS).fill(null);
    for (let i = 0; i < MAX_SHARDS; i++) this._hide(i);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.halos.instanceMatrix.needsUpdate = true;
  }

  spawn(lane, z, y = 0.85, xOverride = null) {
    const i = this._free.pop();
    if (i === undefined) return null;
    const item = {
      slot: i,
      x: xOverride ?? LANE_X[lane],
      y, z,
      lane,
      phase: Math.random() * TAU,
      taken: false,
      flyT: 0,
    };
    this.slots[i] = item;
    this.items.push(item);
    return item;
  }

  /**
   * @param magnet  world position to attract toward, or null
   * @returns array of collected items this frame
   */
  update(dt, speed, playerPos, magnetActive, onCollect) {
    const d = this._d;
    let maxSlot = -1;

    for (let k = this.items.length - 1; k >= 0; k--) {
      const it = this.items[k];
      it.z += speed * dt;
      it.phase += dt * 3.2;

      if (!it.taken) {
        const dx = playerPos.x - it.x;
        const dy = playerPos.y + 0.7 - it.y;
        const dz = playerPos.z - it.z;
        const dist2 = dx * dx + dy * dy + dz * dz;

        if (magnetActive && dist2 < MAGNET_RADIUS * MAGNET_RADIUS) {
          const dist = Math.sqrt(dist2) || 1;
          const pull = 14 * dt * (1 + (MAGNET_RADIUS - dist) / MAGNET_RADIUS);
          it.x += (dx / dist) * pull;
          it.y += (dy / dist) * pull;
          it.z += (dz / dist) * pull;
        }

        if (dist2 < PICKUP_RADIUS * PICKUP_RADIUS) {
          it.taken = true;
          onCollect?.(it);
        }
      } else {
        // Brief shrink-and-vanish rather than popping out of existence.
        it.flyT += dt * 4;
        if (it.flyT >= 1) { this._despawnAt(k); continue; }
      }

      if (it.z > 14) { this._despawnAt(k); continue; }

      const s = it.taken ? (1 - it.flyT) * 1.6 : 1;
      d.position.set(it.x, it.y + Math.sin(it.phase) * 0.09, it.z);
      d.rotation.set(it.phase * 0.6, it.phase, 0);
      d.scale.setScalar(s);
      d.updateMatrix();
      this.mesh.setMatrixAt(it.slot, d.matrix);

      // Pushed behind the shard: co-located, the opaque octahedron wins the
      // depth test and punches a hole through the centre of its own halo.
      d.position.z -= 0.14;
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(s * (1 + Math.sin(it.phase * 2) * 0.08));
      d.updateMatrix();
      this.halos.setMatrixAt(it.slot, d.matrix);
      if (it.slot > maxSlot) maxSlot = it.slot;
    }

    this.mesh.count = MAX_SHARDS;
    this.halos.count = MAX_SHARDS;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.halos.instanceMatrix.needsUpdate = true;
  }

  _despawnAt(k) {
    const it = this.items[k];
    this._hide(it.slot);
    this.slots[it.slot] = null;
    this._free.push(it.slot);
    this.items.splice(k, 1);
  }

  /** Collapse one recycled slot. Done on release, not swept every frame. */
  _hide(slot) {
    const d = this._d;
    d.position.set(0, -999, 0);
    d.rotation.set(0, 0, 0);
    d.scale.setScalar(0);
    d.updateMatrix();
    this.mesh.setMatrixAt(slot, d.matrix);
    this.halos.setMatrixAt(slot, d.matrix);
  }

  setBiome(b) {
    this.material.emissive.setHex(b.acc);
    this.haloMat.color.setHex(b.acc);
  }

  clear() {
    for (const it of this.items) { this._hide(it.slot); this.slots[it.slot] = null; this._free.push(it.slot); }
    this.items.length = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.halos.instanceMatrix.needsUpdate = true;
  }
}

// ─── cores & power-ups ───────────────────────────────────────────────────────
function buildShieldCore() {
  const root = new THREE.Group();
  const inner = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.26, 0),
    new THREE.MeshStandardMaterial({ color: 0x0a2430, emissive: 0x16f2ff, emissiveIntensity: 2.4, roughness: 0.2, metalness: 0.8 }),
  );
  root.add(inner);
  const shellMat = new THREE.MeshBasicMaterial({
    map: hexShield({ color: '#16f2ff', cells: 5 }),
    color: 0x16f2ff, transparent: true, opacity: 0.42,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
  });
  const shell = new THREE.Mesh(new THREE.SphereGeometry(0.46, 16, 12), shellMat);
  root.add(shell);
  root.userData.inner = inner;
  root.userData.shell = shell;
  return root;
}

function buildPowerOrb(hex) {
  const root = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.24, 1),
    new THREE.MeshStandardMaterial({ color: 0x000000, emissive: hex, emissiveIntensity: 2.6, roughness: 0.3, metalness: 0.5 }),
  );
  root.add(core);
  for (let i = 0; i < 2; i++) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.42, 0.022, 6, 28),
      new THREE.MeshBasicMaterial({ color: hex, toneMapped: false, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    ring.rotation.set(i === 0 ? Math.PI / 2 : 0, i === 0 ? 0 : Math.PI / 2, 0);
    root.add(ring);
    (root.userData.rings ??= []).push(ring);
  }
  root.userData.core = core;
  return root;
}

export class Collectibles {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);

    this.pool = new Pool(
      () => {
        const o = new THREE.Group();
        o.visible = false;
        this.group.add(o);
        return { object: o, kind: null, variants: {} };
      },
      (item, kind, lane, z, y) => {
        // Build the visual for this kind once, then reuse it forever.
        if (!item.variants[kind]) {
          const built = kind === 'shield' ? buildShieldCore() : buildPowerOrb(POWERUP_META[kind].hex);
          item.variants[kind] = built;
        }
        for (const [k, v] of Object.entries(item.variants)) v.visible = k === kind;
        for (const v of Object.values(item.variants)) if (!v.parent) item.object.add(v);
        item.kind = kind;
        item.lane = lane;
        item.phase = Math.random() * TAU;
        item.taken = false;
        item.object.visible = true;
        item.object.position.set(LANE_X[lane], y ?? 1.0, z);
        return item;
      },
      2,
    );
    this.live = [];
  }

  spawn(kind, lane, z, y) {
    const item = this.pool.acquire(kind, lane, z, y);
    this.live.push(item);
    return item;
  }

  update(dt, speed, playerPos, onCollect) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const it = this.live[i];
      const o = it.object;
      o.position.z += speed * dt;
      it.phase += dt * 2.4;
      o.position.y += Math.sin(it.phase) * 0.004;
      o.rotation.y += dt * 1.5;

      const v = it.variants[it.kind];
      if (v?.userData.rings) {
        v.userData.rings[0].rotation.z += dt * 2.2;
        v.userData.rings[1].rotation.x += dt * 1.7;
      }
      if (v?.userData.shell) v.userData.shell.rotation.y -= dt * 0.9;

      const dx = playerPos.x - o.position.x;
      const dy = playerPos.y + 0.7 - o.position.y;
      const dz = playerPos.z - o.position.z;
      if (!it.taken && dx * dx + dy * dy + dz * dz < 1.05 * 1.05) {
        it.taken = true;
        onCollect?.(it);
      }

      if (it.taken || o.position.z > 14) {
        o.visible = false;
        this.pool.release(it);
        this.live.splice(i, 1);
      }
    }
  }

  clear() {
    for (const it of this.live) { it.object.visible = false; this.pool.release(it); }
    this.live.length = 0;
  }
}
