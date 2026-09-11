// ─── WORLD ───────────────────────────────────────────────────────────────────
// The track, the city around it, and the sky.
//
// Nothing actually moves the player forward in world space: the player sits at
// z ≈ 0 and the world scrolls toward them. That keeps float precision constant
// over an unbounded run and makes recycling trivial — anything past the camera
// gets teleported back to the horizon.
//
// The city is drawn with two InstancedMeshes (one per side), so a hundred
// buildings cost two draw calls.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { makeRng, lerp, damp, mixHex } from '../core/util.js';
import { gridTexture, starField, gradientTexture, techPanel, stripGlow } from '../render/textures.js';

export const LANE_X = [-2.5, 0, 2.5];
export const TRACK_HALF_WIDTH = 4.0;
export const HORIZON_Z = -190;      // where new geometry appears
export const DESPAWN_Z = 14;        // behind the camera

// ─── biomes ──────────────────────────────────────────────────────────────────
// `at` is the distance in metres where the biome takes over. Kept deliberately
// close together at the start: a player who never sees a second biome never
// learns the game has any.
export const BIOMES = [
  {
    id: 'grid', name: 'NEON GRID', sub: 'Sector 7 · Outer Data Rim', at: 0,
    acc: 0x16f2ff, acc2: 0xff2ea6, accCss: '#16f2ff', acc2Css: '#ff2ea6',
    fog: 0x0a0620, fogDensity: 0.0072,
    skyTop: '#04030c', skyBot: '#2a0a4e',
    ground: '#07051a', groundLine: '#16f2ff',
    building: 0x120a2e, buildingLit: 0x16f2ff,
    ambient: 0x39325e, key: 0x16f2ff, rim: 0xff2ea6,
  },
  {
    id: 'bloom', name: 'BIOLUME', sub: 'Sector 4 · Grown Architecture', at: 900,
    acc: 0x3dffab, acc2: 0xb57bff, accCss: '#3dffab', acc2Css: '#b57bff',
    fog: 0x03170f, fogDensity: 0.0085,
    skyTop: '#010e08', skyBot: '#0b4a33',
    ground: '#03130d', groundLine: '#3dffab',
    building: 0x07301f, buildingLit: 0x3dffab,
    ambient: 0x27443c, key: 0x3dffab, rim: 0xb57bff,
  },
  {
    id: 'foundry', name: 'MAGMA FOUNDRY', sub: 'Sector 1 · Thermal Core', at: 2100,
    // Deliberately shifted off the hazard palette: the obstacle set already owns
    // #ff3b5c and #ffcc33, and an environment wearing the danger colours makes
    // threats stop reading as threats.
    acc: 0xff8a1f, acc2: 0xc026d3, accCss: '#ff8a1f', acc2Css: '#c026d3',
    fog: 0x1a0503, fogDensity: 0.0095,
    skyTop: '#120301', skyBot: '#5c1408',
    ground: '#1c0604', groundLine: '#ff7a3d',
    building: 0x2a0a06, buildingLit: 0xff7a3d,
    ambient: 0x4a2a20, key: 0xffcc33, rim: 0xff3b5c,
  },
  {
    id: 'void', name: 'VOID RIFT', sub: 'Sector 0 · No Signal', at: 3800,
    acc: 0xb57bff, acc2: 0x16f2ff, accCss: '#b57bff', acc2Css: '#16f2ff',
    fog: 0x050010, fogDensity: 0.0062,
    skyTop: '#000000', skyBot: '#1b0740',
    ground: '#06021a', groundLine: '#b57bff',
    building: 0x0d0424, buildingLit: 0xb57bff,
    ambient: 0x2e2450, key: 0xb57bff, rim: 0x16f2ff,
  },
];

export function biomeAt(distance) {
  let b = BIOMES[0];
  for (const x of BIOMES) if (distance >= x.at) b = x;
  return b;
}

// ─── track ───────────────────────────────────────────────────────────────────
// The floor is a single long plane with a scrolling grid texture. Scrolling the
// UV offset instead of moving geometry means the road is infinitely long for the
// cost of one quad.
class Track {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);

    const grid = gridTexture({ bg: '#07051a', line: '#16f2ff', divisions: 4, thickness: 3, glow: 0.9 });
    const gridE = gridTexture({ bg: '#000000', line: '#ffffff', divisions: 4, thickness: 3, glow: 1 });
    this.gridTex = grid;
    this.gridEmis = gridE;
    grid.repeat.set(3, 46);
    gridE.repeat.set(3, 46);

    this.floorMat = new THREE.MeshStandardMaterial({
      map: grid,
      emissiveMap: gridE,
      emissive: 0x16f2ff,
      emissiveIntensity: 0.7,
      roughness: 0.34,
      metalness: 0.55,
      color: 0xffffff,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_HALF_WIDTH * 2, 240), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = -100;
    this.group.add(floor);
    this.floor = floor;

    // Outer aprons — darker ground either side so the track edge reads.
    // Fully rough and non-metallic: any specular lobe here lands as a blown-out
    // magenta blob under the rim light, right in the player's peripheral vision.
    const apronMat = new THREE.MeshStandardMaterial({
      map: gridTexture({ bg: '#040310', line: '#1b2545', divisions: 6, thickness: 2, glow: 0.2 }),
      roughness: 1.0, metalness: 0.0, color: 0x9aa4c8,
    });
    apronMat.map.repeat.set(8, 46);
    this.apronMat = apronMat;
    for (const sx of [-1, 1]) {
      const apron = new THREE.Mesh(new THREE.PlaneGeometry(26, 240), apronMat);
      apron.rotation.x = -Math.PI / 2;
      apron.position.set(sx * (TRACK_HALF_WIDTH + 13), -0.06, -100);
      this.group.add(apron);
    }

    // Lane divider strips — thin emissive lines exactly between lanes, so the
    // player can always see where a lane change lands.
    this.laneMat = new THREE.MeshBasicMaterial({
      color: 0x16f2ff, transparent: true, opacity: 0.32,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    for (const x of [-1.25, 1.25]) {
      const s = new THREE.Mesh(new THREE.PlaneGeometry(0.045, 240), this.laneMat);
      s.rotation.x = -Math.PI / 2;
      s.position.set(x, 0.012, -100);
      this.group.add(s);
    }

    // Guard rails — the strongest speed cue in the whole scene, because their
    // emissive strips streak past at the edge of vision.
    this.railMat = new THREE.MeshBasicMaterial({
      map: stripGlow({ color: '#16f2ff', softness: 0.5 }),
      color: 0x16f2ff, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    this.railMat.map.repeat.set(1, 60);
    this.railBodyMat = new THREE.MeshStandardMaterial({
      map: techPanel({ base: '#0a0f24', line: '#16f2ff', lit: '#16f2ff', density: 6, glow: 0.4 }),
      roughness: 0.5, metalness: 0.7, color: 0xffffff,
    });
    this.railBodyMat.map.repeat.set(40, 1);

    for (const sx of [-1, 1]) {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.5, 240), this.railBodyMat);
      body.position.set(sx * (TRACK_HALF_WIDTH + 0.17), 0.25, -100);
      this.group.add(body);
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 240), this.railMat);
      strip.rotation.y = -sx * Math.PI / 2;
      strip.position.set(sx * (TRACK_HALF_WIDTH - 0.01), 0.4, -100);
      this.group.add(strip);
    }

    this.scroll = 0;
  }

  update(dt, speed) {
    // One texture repeat spans 240/46 ≈ 5.2 world units; convert speed to UV.
    this.scroll += (speed * dt) / (240 / 46);
    this.gridTex.offset.y = -this.scroll;
    this.gridEmis.offset.y = -this.scroll;
    this.apronMat.map.offset.y = -this.scroll * 0.85;
    this.railBodyMat.map.offset.x = this.scroll * 1.4;
    this.railMat.map.offset.y = -this.scroll * 2.2;
  }

  applyBiome(b) {
    this.floorMat.emissive.setHex(b.acc);
    this.laneMat.color.setHex(b.acc);
    this.railMat.color.setHex(b.acc);
    this.floorMat.color.setHex(0xffffff);
  }
}

// ─── city ────────────────────────────────────────────────────────────────────
// Two instanced towers meshes (body + lit windows) recycled along z.
const CITY_COUNT = 78;

class City {
  constructor(scene, rng) {
    this.rng = rng;
    const geoBody = new RoundedBoxGeometry(1, 1, 1, 2, 0.05);

    this.bodyMat = new THREE.MeshStandardMaterial({
      map: techPanel({ base: '#0d0722', line: '#16f2ff', lit: '#16f2ff', density: 4, glow: 0.55, seed: 7 }),
      emissiveMap: techPanel({ base: '#000000', line: '#20304f', lit: '#ffffff', density: 4, glow: 1, seed: 7 }),
      emissive: 0x16f2ff,
      emissiveIntensity: 0.85,
      roughness: 0.62, metalness: 0.5, color: 0xffffff,
    });

    this.mesh = new THREE.InstancedMesh(geoBody, this.bodyMat, CITY_COUNT);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    // Crown lights — a second instanced pass of thin emissive slabs on top of
    // each tower. Cheap, and it's what makes a skyline read at night.
    this.crownMat = new THREE.MeshBasicMaterial({
      color: 0xff2ea6, toneMapped: false, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.crowns = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.crownMat, CITY_COUNT);
    this.crowns.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.crowns.frustumCulled = false;
    scene.add(this.crowns);

    this.slots = [];
    this._d = new THREE.Object3D();
    for (let i = 0; i < CITY_COUNT; i++) {
      this.slots.push(this._makeSlot(i, HORIZON_Z + (i / CITY_COUNT) * (HORIZON_Z - DESPAWN_Z) * -1));
    }
    this._writeAll();
  }

  _makeSlot(i, z) {
    const r = this.rng;
    const side = i % 2 === 0 ? -1 : 1;
    const depth = r.range(3, 9);
    return {
      side,
      x: side * r.range(TRACK_HALF_WIDTH + 7.5, TRACK_HALF_WIDTH + 30),
      z,
      w: r.range(2.2, 6.4),
      h: r.range(5, 34),
      d: depth,
      rot: r.range(-0.16, 0.16),
      crown: r.bool(0.55),
      crownH: r.range(0.25, 1.4),
    };
  }

  _reroll(slot, z) {
    const r = this.rng;
    slot.z = z;
    slot.x = slot.side * r.range(TRACK_HALF_WIDTH + 3.2, TRACK_HALF_WIDTH + 26);
    slot.w = r.range(2.2, 6.4);
    slot.h = r.range(5, 34);
    slot.d = r.range(3, 9);
    slot.rot = r.range(-0.16, 0.16);
    slot.crown = r.bool(0.55);
    slot.crownH = r.range(0.25, 1.4);
  }

  _write(i) {
    const s = this.slots[i];
    const d = this._d;
    d.position.set(s.x, s.h / 2 - 0.4, s.z);
    d.rotation.set(0, s.rot, 0);
    d.scale.set(s.w, s.h, s.d);
    d.updateMatrix();
    this.mesh.setMatrixAt(i, d.matrix);

    if (s.crown) {
      d.position.set(s.x, s.h - 0.4 + s.crownH / 2, s.z);
      d.scale.set(s.w * 0.36, s.crownH, s.d * 0.36);
    } else {
      d.scale.set(0, 0, 0);   // hide unused crown slots
    }
    d.updateMatrix();
    this.crowns.setMatrixAt(i, d.matrix);
  }

  _writeAll() {
    for (let i = 0; i < CITY_COUNT; i++) this._write(i);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.crowns.instanceMatrix.needsUpdate = true;
  }

  update(dt, speed) {
    const dz = speed * dt;
    let dirty = false;
    for (let i = 0; i < CITY_COUNT; i++) {
      const s = this.slots[i];
      s.z += dz;
      if (s.z > DESPAWN_Z + 20) {
        this._reroll(s, s.z - (DESPAWN_Z + 20 - HORIZON_Z));
        dirty = true;
      }
      this._write(i);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.crowns.instanceMatrix.needsUpdate = true;
  }

  applyBiome(b) {
    this.bodyMat.color.setHex(b.building);
    this.bodyMat.emissive.setHex(b.buildingLit);
    this.crownMat.color.setHex(b.acc2);
  }
}

/** Banded synthwave sun built from a biome's own two accent colours. */
function sunGradient(primary, secondary) {
  return gradientTexture([
    [0.00, primary], [0.46, primary], [0.48, '#00000000'],
    [0.54, secondary], [0.56, '#00000000'],
    [0.64, primary], [0.66, '#00000000'],
    [0.76, secondary], [0.78, '#00000000'],
    [0.90, primary], [1.00, '#00000000'],
  ], { size: 256 });
}

// ─── sky ─────────────────────────────────────────────────────────────────────
class Sky {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);

    // Gradient dome, rendered on the inside, unlit and behind everything.
    this.gradTex = gradientTexture([[0, '#04030c'], [0.55, '#160a38'], [1, '#2a0a4e']], { size: 256 });
    this.domeMat = new THREE.MeshBasicMaterial({
      map: this.gradTex, side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(280, 24, 16), this.domeMat);
    dome.renderOrder = -100;
    this.group.add(dome);

    // Stars on a slightly smaller shell so they sit "inside" the gradient.
    this.starMat = new THREE.MeshBasicMaterial({
      map: starField({ count: 1100 }), side: THREE.BackSide, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false, opacity: 0.85,
    });
    this.starMat.map.repeat.set(3, 2);
    this.stars = new THREE.Mesh(new THREE.SphereGeometry(268, 20, 14), this.starMat);
    this.stars.renderOrder = -99;
    this.group.add(this.stars);

    // A big soft sun/portal disc on the horizon — the synthwave anchor.
    this.sunMat = new THREE.MeshBasicMaterial({
      map: sunGradient('#ff2ea6', '#16f2ff'),
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      toneMapped: false, opacity: 0.85,
    });
    this.sun = new THREE.Mesh(new THREE.CircleGeometry(46, 48), this.sunMat);
    this.sun.position.set(0, 18, -250);
    this.sun.renderOrder = -98;
    this.group.add(this.sun);
  }

  update(dt, speed, cameraPos) {
    this.group.position.set(cameraPos.x * 0.4, 0, cameraPos.z);
    this.stars.rotation.y += dt * 0.004;
    this.starMat.map.offset.x += dt * 0.0016;
  }

  applyBiome(b) {
    // Rebuilding the gradient is a canvas draw — fine on a biome change, which
    // happens a handful of times per run. Both textures are memoised per palette,
    // so revisiting a biome costs nothing.
    this.domeMat.map = gradientTexture([[0, b.skyTop], [0.58, b.skyBot], [1, b.skyBot]], { size: 256 });
    this.domeMat.needsUpdate = true;
    this.sunMat.map = sunGradient(b.acc2Css, b.accCss);
    this.sunMat.color.setHex(0xffffff);
    this.sunMat.needsUpdate = true;
  }
}

// ─── world ───────────────────────────────────────────────────────────────────
export class World {
  constructor(scene, seed = 12345) {
    this.scene = scene;
    this.rng = makeRng(seed);

    this.track = new Track(scene);
    this.city = new City(scene, this.rng);
    this.sky = new Sky(scene);

    scene.fog = new THREE.FogExp2(0x0a0620, 0.0072);

    this.ambient = new THREE.AmbientLight(0x5a4a9a, 1.15);
    scene.add(this.ambient);
    this.key = new THREE.DirectionalLight(0x16f2ff, 1.6);
    this.key.position.set(3, 9, 4);
    scene.add(this.key);
    this.rim = new THREE.DirectionalLight(0xff2ea6, 0.7);
    this.rim.position.set(-5, 9, -7);
    scene.add(this.rim);
    // Travels with the player so they are never silhouetted into mush.
    this.playerLight = new THREE.PointLight(0xffffff, 16, 20, 2);
    this.playerLight.position.set(0, 2.4, 1.5);
    scene.add(this.playerLight);

    this.biome = BIOMES[0];
    this.nextBiome = null;
    this.blend = 1;
    this._applyBiome(BIOMES[0], true);
  }

  _applyBiome(b, instant = false) {
    this.track.applyBiome(b);
    this.city.applyBiome(b);
    this.sky.applyBiome(b);
    this.ambient.color.setHex(b.ambient);
    this.key.color.setHex(b.key);
    this.rim.color.setHex(b.rim);
    this.targetFogDensity = b.fogDensity;
    this._fogFrom = (this._fogFrom ?? new THREE.Color()).copy(this.scene.fog.color);
    this._fogTo = (this._fogTo ?? new THREE.Color()).setHex(b.fog);
    this._fogT = instant ? 1 : 0;
    if (instant) {
      this.scene.fog.color.setHex(b.fog);
      this.scene.fog.density = b.fogDensity;
      this._fogFrom.setHex(b.fog);
    }
  }

  /** @returns the biome if it just changed, else null. */
  setDistance(distance) {
    const b = biomeAt(distance);
    if (b.id !== this.biome.id) {
      this.biome = b;
      this._applyBiome(b);
      return b;
    }
    return null;
  }

  update(dt, speed, cameraPos, playerPos) {
    this.track.update(dt, speed);
    this.city.update(dt, speed);
    this.sky.update(dt, speed, cameraPos);

    // Ease fog rather than snapping — a hard cut on biome change looks like a bug.
    // Interpolate in float space: mixHex rounds to integers, so feeding it the
    // current colour each frame quantises small steps back to zero and the fog
    // never actually reaches the new biome.
    const f = this.scene.fog;
    this._fogT = Math.min(1, (this._fogT ?? 1) + dt * 1.1);
    f.color.copy(this._fogFrom).lerp(this._fogTo, this._fogT);
    f.density = damp(f.density, this.targetFogDensity, 0.02, dt);

    if (playerPos) {
      this.playerLight.position.set(playerPos.x, playerPos.y + 1.8, playerPos.z + 1.4);
    }
  }

  reset() {
    this.biome = BIOMES[0];
    this._applyBiome(BIOMES[0], true);
    this.track.scroll = 0;
  }
}
