// ─── GAME ────────────────────────────────────────────────────────────────────
// Top-level state machine and the one place every subsystem is wired together.
//
//   BOOT -> TITLE -> PLAYING -> (PAUSED) -> OVER -> TITLE
//
// The run loop is deliberately ordered: input, then simulation, then collision,
// then presentation. Anything that reads game state to drive visuals (camera,
// post-processing, HUD) happens strictly after the simulation has settled, so a
// frame never shows a half-updated world.

import * as THREE from 'three';
import { Renderer } from '../core/renderer.js';
import { Input, Action, attachTouch } from '../core/input.js';
import { Audio } from '../core/audio.js';
import { Save } from '../core/save.js';
import { Particles, CameraRig } from '../core/fx.js';
import { clamp01, lerp, damp, remap } from '../core/util.js';
import { UI } from '../ui/screens.js';
import { World, LANE_X, BIOMES } from './world.js';
import { Alien, HuHu, SKIN_LIST, SKIN_PRESETS } from './characters.js';
import { Obstacles } from './obstacles.js';
import { Shards, Collectibles, POWERUP, POWERUP_META } from './pickups.js';
import { Director } from './director.js';
import { Player, TUNE } from './player.js';

export const MODE = { BOOT: 'boot', TITLE: 'title', MENU: 'menu', PLAYING: 'playing', PAUSED: 'paused', OVER: 'over' };

const SPEED = {
  START: 18,
  MAX: 46,
  TAU: 2600,               // v = START + (MAX-START) * (1 - e^(-dist/TAU))
};

// Overdrive: the release valve. Earned by playing well, spent when the player
// chooses — never automatic, because the choice is most of the fun.
const OD = {
  MAX: 100,
  PER_CHAIN: 0.55,
  PER_GRAZE: 8,
  PER_CELL: 50,
};

// HuHu's own economy. Separate from Overdrive on purpose: if they shared a
// meter, six seconds of invulnerability would always beat one screen-clear and
// the Pulse would never be pressed.
const PULSE = {
  CHARGES: 2,
  RECHARGE_DISTANCE: 700,
  COOLDOWN: 5.0,
  WINDOW: 14.0,            // units forward, all three lanes
  DOWN_TIME: 12.0,         // seconds HuHu is out after absorbing a hit
};

// Chain thresholds -> multiplier. The colour is mirrored onto the Alien's
// antenna and HuHu's trail so the player's state is legible on the character.
const COMBO_TIERS = [
  { at: 0, mult: 1, color: 0x818cf8, css: '#818cf8' },
  { at: 12, mult: 2, color: 0x16f2ff, css: '#16f2ff' },
  { at: 30, mult: 3, color: 0x34d399, css: '#34d399' },
  { at: 60, mult: 4, color: 0xa3e635, css: '#a3e635' },
  { at: 105, mult: 6, color: 0xfde047, css: '#fde047' },
  { at: 170, mult: 8, color: 0xfb923c, css: '#fb923c' },
  { at: 260, mult: 12, color: 0xff2d95, css: '#ff2d95' },
  { at: 380, mult: 20, color: 0xffffff, css: '#ffffff' },
];
const CHAIN_GRACE = 3.2;   // seconds of silence before the chain starts to decay
const GOLD_EVERY = 10;     // every Nth mote in an unbroken chain is worth triple
const GRAZE_MARGIN = 0.55; // clearance beyond contact that still counts as a graze

export class Game {
  constructor(canvas) {
    this.renderer = new Renderer(canvas);
    this.scene = this.renderer.scene;
    this.camera = this.renderer.camera;

    this.ui = new UI();
    this.ui.setSkins(SKIN_LIST);
    this.ui.onAction = (a, el) => this._onUiAction(a, el);
    this.ui.onSettingChange = (k, v) => this._onSetting(k, v);

    this.world = new World(this.scene, 20260801);
    this.particles = new Particles(this.scene, this.renderer.tier.particles);
    this.obstacles = new Obstacles(this.scene);
    this.shards = new Shards(this.scene);
    this.collectibles = new Collectibles(this.scene);
    this.director = new Director(this.obstacles, this.shards, this.collectibles);

    this.player = new Player();
    this.alien = new Alien(Save.data.skin);
    this.scene.add(this.alien.root);
    this.huhu = new HuHu();
    this.scene.add(this.huhu.root);

    this.rig = new CameraRig(this.camera);
    this.rig.shake.scale = Save.settings.shake;

    // Chase-camera rig. Tuned so roughly three obstacle "beats" are on screen at
    // once: enough to plan a line, not so much that the player feels detached.
    this.camTune = { height: 3.15, back: 6.4, follow: 0.30, lookY: 0.85, lookZ: -17, lookFollow: 0.5 };

    // Dev-only: halts world scroll while animation and camera keep running, so
    // a scene can be posed and inspected. Never set during normal play.
    this.freeze = false;

    this.mode = MODE.BOOT;
    this.elapsed = 0;
    this._camPos = new THREE.Vector3();
    this._camLook = new THREE.Vector3();
    this._proj = new THREE.Vector3();

    this.renderer.onQualityChange = (tier, dir) => {
      if (dir === 'down') this.ui.banner('QUALITY REDUCED', tier.toUpperCase());
    };
    this.renderer.onResize = (w, h, portrait, fov) => this._layoutCamera(portrait, fov);
    this._layoutCamera(this.renderer.height > this.renderer.width, this.renderer.baseFov ?? 48);

    attachTouch(canvas);
    this._bindGlobalKeys();
    this._resetRun();
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────
  start() {
    this.ui.setLoading(1, 'Ready');
    this.mode = MODE.TITLE;
    this.ui.show('title');
    this.ui.setHudVisible(false);
    this._attractCamera(true);
    Audio.setVolume('master', Save.settings.master);
  }

  _resetRun() {
    this.speed = SPEED.START;
    this.distance = 0;
    this.score = 0;
    this.runShards = 0;
    this.chain = 0;
    this.chainTimer = 0;
    this.bestMultiplier = 1;
    this.topSpeed = SPEED.START;
    this.nearMisses = 0;
    this.milestone = 0;
    this.powers = new Map();      // id -> secondsRemaining
    this.overdrive = 0;           // 0..OD.MAX
    this.overdriveActive = 0;     // seconds remaining
    this.pulseCharges = PULSE.CHARGES;
    this.pulseCooldown = 0;
    this.nextPulseRecharge = PULSE.RECHARGE_DISTANCE;
    this.huhuDown = 0;            // seconds until HuHu is back
    this.motesInChain = 0;
    this.recordBeaten = false;
    this.dilation = 0;            // seconds of graze slow-motion left
    this._runRecorded = false;
    this.deathTimer = 0;
    this.flash = 0;
    this.glitch = 0;
    this.desat = 0;
    this.countdown = 0;

    this.player.reset();
    this.obstacles.clear();
    this.shards.clear();
    this.collectibles.clear();
    this.director.reset();
    this.world.reset();
    this.particles.clear();

    this.alien.root.position.set(LANE_X[1], 0, 0);
    this.huhu.root.position.set(LANE_X[1] - 2.5, 3.05, 0.4);
    // revive(), not `dead = false`: the knockout also swaps in X-eyes and leaves
    // the body rotated, and neither undoes itself.
    this.huhu.revive();

    // Overdrive triples bloom while it runs. Dying or restarting mid-Overdrive
    // used to leave the whole game blown out for the rest of the session.
    if (this.renderer.bloom) this.renderer.bloom.strength = 0.62;

    this._applyBiome(BIOMES[0]);
  }

  beginRun() {
    Audio.unlock();
    if (!this.player.alive && this.ui.current !== 'over') this.endRun();
    this._resetRun();
    this.mode = MODE.PLAYING;
    this.ui.show('none');
    this.ui.setHudVisible(true);
    Input.clearBuffer();
    this.countdown = 2.2;
    Audio.startMusic();
    Audio.music.setIntensity(0.25);
    this.rig.snap(new THREE.Vector3(0, 2.05, 4.6), new THREE.Vector3(0, 1.05, -12));
  }

  endRun() {
    if (this._runRecorded) return;
    this._runRecorded = true;
    this.mode = MODE.OVER;
    Audio.music.setIntensity(0.05);
    Audio.music.setDuck(0.35);
    const beat = Save.recordRun({
      score: this.score,
      distance: this.distance,
      shards: this.runShards,
      combo: this.bestMultiplier,
      biome: this.world.biome.id,
    });
    this.ui.setHudVisible(false);
    this.ui.showGameOver({
      score: Math.floor(this.score),
      distance: this.distance,
      shards: this.runShards,
      bestMultiplier: this.bestMultiplier,
      topSpeed: this.topSpeed,
      beat,
    });
  }

  pause() {
    if (this.mode !== MODE.PLAYING) return;
    this.mode = MODE.PAUSED;
    this.ui.show('pause');
    Audio.music.setDuck(0.3);
  }

  resume() {
    if (this.mode !== MODE.PAUSED) return;
    this.mode = MODE.PLAYING;
    this.ui.show('none');
    Input.clearBuffer();
    Audio.music.setDuck(1);
  }

  quitToMenu() {
    // A run abandoned during the death cinematic must still be banked, or the
    // player loses the shards they actually earned.
    if (!this.player.alive && this.ui.current !== 'over') this.endRun();
    this.mode = MODE.MENU;
    this.ui.setHudVisible(false);
    this.ui.show('menu');
    Audio.music.setDuck(1);
    Audio.music.setIntensity(0.12);
    this._resetRun();
    this._attractCamera(true);
  }

  // ─── input plumbing ────────────────────────────────────────────────────
  _bindGlobalKeys() {
    addEventListener('keydown', e => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === 'escape' || k === 'p') {
        e.preventDefault();
        // Order matters: a sub-screen is checked BEFORE the paused state, or
        // ESC inside Settings-from-Pause resumes the run behind the panel.
        if (['settings', 'skins', 'howto', 'credits'].includes(this.ui.current)) this._back();
        else if (this.mode === MODE.PLAYING) this.pause();
        else if (this.mode === MODE.PAUSED) this.resume();
        else if (this.mode === MODE.OVER) this.quitToMenu();
        return;
      }
      if (k === 'm') { const m = Audio.toggleMute(); this.ui.banner(m ? 'MUTED' : 'SOUND ON'); return; }
      if (this.mode === MODE.TITLE && (k === ' ' || k === 'enter')) { e.preventDefault(); this._enterMenu(); return; }
      if (this.mode === MODE.OVER && k === ' ') { e.preventDefault(); this.beginRun(); return; }
      if (this.mode === MODE.PAUSED && k === 'r') { this.beginRun(); return; }
      if (this.mode === MODE.MENU) {
        if (k === 'c') this.ui.show('skins');
        else if (k === 's') this.ui.show('settings');
        else if (k === 'h') this.ui.show('howto');
      }
    }, { passive: false });

    // Any tap on the title screen starts things — mobile has no Enter key.
    addEventListener('pointerdown', () => {
      Audio.unlock();
      if (this.mode === MODE.TITLE) this._enterMenu();
    });
  }

  _enterMenu() {
    Audio.unlock();
    Audio.startMusic();
    Audio.music.setIntensity(0.12);
    this.mode = MODE.MENU;
    this.ui.show('menu');
  }

  _back() {
    if (this.mode === MODE.PAUSED) this.ui.show('pause');
    else this.ui.show('menu');
  }

  _onUiAction(act, el) {
    switch (act) {
      case 'play': this.beginRun(); break;
      case 'retry': this.beginRun(); break;
      case 'resume': this.resume(); break;
      case 'restart': this.beginRun(); break;
      case 'quit': this.quitToMenu(); break;
      case 'pause': this.pause(); break;
      case 'settings': this.ui.show('settings'); break;
      case 'skins': this.ui.show('skins'); break;
      case 'howto': this.ui.show('howto'); break;
      case 'credits': this.ui.show('credits'); break;
      case 'back': this._back(); break;
      case 'wipe':
        Save.reset();
        this.ui.banner('DATA ERASED');
        this.ui.show('menu');
        break;
      case 'skin': this._selectSkin(el?.dataset.skin); break;
    }
  }

  _selectSkin(id) {
    const skin = SKIN_PRESETS[id];
    if (!skin) return;
    if (!Save.isUnlocked(id)) {
      if (!Save.spendShards(skin.cost)) {
        Audio.play('uiDenied');
        this.ui.banner('NOT ENOUGH SHARDS', `NEED ${skin.cost - Save.data.shards} MORE`);
        return;
      }
      Save.unlock(id);
      Audio.play('powerup');
    }
    Save.set('skin', id);
    const parent = this.alien.root.parent;
    this.alien.dispose();
    this.scene.remove(this.alien.root);
    this.alien = new Alien(id);
    this.scene.add(this.alien.root);
    this.ui.show('skins');
    this.ui.banner('CHASSIS EQUIPPED', skin.name.toUpperCase());
  }

  _onSetting(key, value) {
    if (key === 'quality') this.renderer.setQuality(value);
    if (key === 'shake') this.rig.shake.scale = value;
  }

  // ─── per-frame ─────────────────────────────────────────────────────────
  frame(dt) {
    this.elapsed += dt;
    Input.update(dt);
    Audio.update(dt);

    switch (this.mode) {
      case MODE.TITLE:
      case MODE.MENU:
        this._attract(dt);
        break;
      case MODE.PLAYING:
        this._simulate(dt);
        break;
      case MODE.PAUSED:
        break;
      case MODE.OVER:
        this._deathScene(dt);
        break;
    }

    this._present(dt);
  }

  /** Slow orbit over an empty track behind the menus. */
  _attract(dt) {
    const t = this.elapsed * 0.16;
    this.speed = lerp(this.speed ?? 12, 14, 1 - Math.pow(0.2, dt));
    this.world.update(dt, this.speed, this.camera.position, this.alien.root.position);

    this.alien.root.position.set(Math.sin(t * 1.4) * 1.3, 0, 0);
    this.alien.update(dt, { state: 'run', speed: 0.35, groundY: 0 });
    this.alien.setLean(Math.cos(t * 1.4) * 0.35);
    // Sit HuHu low and beside the Alien on the attract screen: at flight height
    // he lands squarely behind the title lockup.
    this.huhu.root.position.set(
      this.alien.root.position.x - 1.55,
      1.35 + Math.sin(this.elapsed * 1.5) * 0.13,
      0.5,
    );
    this.huhu.update(dt, { state: 'fly', speed: 0.35 });

    this._camPos.set(Math.sin(t) * 2.2, 2.4 + Math.sin(t * 0.7) * 0.5, 5.6);
    this._camLook.set(Math.sin(t * 1.4) * 0.8, 1.2, -14);
    this.rig.update(dt, this._camPos, this._camLook, { follow: 0.05, lookFollow: 0.05 });
    this.particles.update(dt);
  }

  _attractCamera(snap) {
    if (snap) this.rig.snap(new THREE.Vector3(0, 2.4, 5.6), new THREE.Vector3(0, 1.2, -14));
  }

  _simulate(dt) {
    const p = this.player;

    // Hitstop freezes the simulation but not the presentation, so an impact
    // reads as a physical jolt rather than a dropped frame.
    let simDt = this.rig.shake.consumeHitstop(dt);
    if (this.dilation > 0) {
      this.dilation -= dt;                 // the dilation clock runs on real time
      simDt *= 0.72;
    }

    if (this.countdown > 0) {
      const before = Math.ceil(this.countdown);
      this.countdown -= dt;
      const after = Math.ceil(this.countdown);
      if (after !== before && after >= 0) {
        Audio.play('countdown', { last: after === 0 });
        this.ui.banner(after > 0 ? String(after) : 'RUN');
      }
      p.update(simDt, { inputEnabled: false });
    } else {
      p.update(simDt, { inputEnabled: true, canDoubleJump: this.huhuDown <= 0 });
    }

    // Speed ramp — asymptotic, so it never stops climbing but never spikes.
    const baseSpeed = SPEED.START + (SPEED.MAX - SPEED.START) * (1 - Math.exp(-this.distance / SPEED.TAU));
    this.speed = this.freeze ? 0 : baseSpeed * p.speedMult;
    this.topSpeed = Math.max(this.topSpeed, this.speed);

    if (this.countdown <= 0) {
      const dz = this.speed * simDt;
      this.distance += dz;
      this.director.advance(dz);
      this.director.update(this.distance, -180, this.speed);

      // Score accrues with speed and multiplier — going fast is worth something.
      this.score += this.speed * simDt * 0.55 * this.multiplier;
    }

    // Chain decay: a grace window of silence, then a drain proportional to the
    // chain itself, so losing a tier takes about the same wall-clock time at
    // every level instead of being brutal at the top.
    if (this.chain > 0) {
      this.chainTimer -= simDt;
      if (this.chainTimer <= 0) {
        this._chainFraction = (this._chainFraction ?? 0) + (3.0 + this.chain * 0.055) * simDt;
        const whole = Math.floor(this._chainFraction);
        if (whole > 0) {
          this._chainFraction -= whole;
          this.chain = Math.max(0, this.chain - whole);
          if (this.chain === 0) this.motesInChain = 0;
        }
      }
    }

    // Overdrive, Pulse and HuHu recovery.
    if (this.overdriveActive > 0) {
      this.overdriveActive -= simDt;
      if (this.overdriveActive <= 0) {
        this.overdriveActive = 0;
        this.ui.banner('OVERDRIVE ENDED');
        if (this.renderer.bloom) this.renderer.bloom.strength = 0.62;
      }
    }
    if (this.pulseCooldown > 0) this.pulseCooldown -= simDt;
    if (this.huhuDown > 0) {
      this.huhuDown -= simDt;
      if (this.huhuDown <= 0) {
        this.huhu.dead = false;
        this.huhu.revive();
        Audio.play('shield');
        this.ui.banner('HUHU IS BACK');
      }
    }
    if (this.distance >= this.nextPulseRecharge) {
      // Advance the marker whether or not a charge is granted. Leaving it in the
      // past while at full charges means the next Pulse the player spends is
      // handed straight back, which quietly removes the cost of the ability.
      this.nextPulseRecharge = this.distance + PULSE.RECHARGE_DISTANCE;
      if (this.pulseCharges < PULSE.CHARGES) {
        this.pulseCharges++;
        Audio.play('shield');
      }
    }

    // One context-sensitive button: Overdrive when the meter is full, otherwise
    // HuHu's Pulse. A single action keeps this playable with one thumb.
    if (this.countdown <= 0 && Input.consume(Action.DASH)) this._useAbility();

    // Power-up timers.
    for (const [id, t] of this.powers) {
      const next = t - simDt;
      if (next <= 0) {
        this.powers.delete(id);
        this.ui.banner(`${POWERUP_META[id].label.toUpperCase()} ENDED`);
      } else {
        this.powers.set(id, next);
      }
    }

    // World & entities.
    this.world.update(simDt, this.speed, this.camera.position, this.alien.root.position);
    this.obstacles.update(simDt, this.speed);
    this.shards.update(simDt, this.speed, p.position, this.powers.has(POWERUP.MAGNET) || this.overdriveActive > 0, it => this._collectShard(it));
    this.collectibles.update(simDt, this.speed, p.position, it => this._collectItem(it));

    this._collide();

    const biome = this.world.setDistance(this.distance);
    if (biome) this._applyBiome(biome, true);

    // Telling the player they beat their best AT the moment it happens is worth
    // far more than a line on the results screen.
    if (!this.recordBeaten && Save.data.hiScore > 0 && this.score > Save.data.hiScore) {
      this.recordBeaten = true;
      this.ui.banner('NEW RECORD', 'AND STILL RUNNING');
      Audio.play('milestone');
      this.rig.addFovKick(0.4);
    }

    // Milestones every 500 metres. Deliberately distance-keyed: score scales
    // with the multiplier, so a score-keyed milestone fires several times a
    // second at a high chain and turns celebration into noise.
    const ms = Math.floor(this.distance / 500);
    if (ms > this.milestone) {
      this.milestone = ms;
      Audio.play('milestone');
      this.ui.popScore();
      this.rig.addFovKick(0.35);
      this.huhu.celebrate();
    }

    Audio.music.setIntensity(clamp01(remap(this.speed, SPEED.START, SPEED.MAX, 0.2, 0.95)));
    this.particles.update(simDt);
    this._runTrail(simDt);
  }

  get tier() {
    let t = COMBO_TIERS[0];
    for (const x of COMBO_TIERS) if (this.chain >= x.at) t = x;
    return t;
  }
  get multiplier() { return this.tier.mult; }

  /** Context-sensitive ability button: Overdrive if charged, else HuHu's Pulse. */
  _useAbility() {
    if (!this.player.alive) return;
    if (this.overdrive >= OD.MAX && this.overdriveActive <= 0) {
      this._startOverdrive();
    } else if (this.pulseCharges > 0 && this.pulseCooldown <= 0 && this.huhuDown <= 0) {
      this._huhuPulse();
    } else {
      Audio.play('uiDenied');
    }
  }

  _startOverdrive() {
    this.overdrive = 0;
    this.overdriveActive = TUNE.OVERDRIVE_TIME;
    this.player.startOverdrive();
    this.rig.shake.freeze(0.12);
    this.rig.shake.add(0.7);
    this.rig.addFovKick(1.1);
    this.glitch = 1;
    this.flash = 0.8;
    if (this.renderer.bloom) this.renderer.bloom.strength = 1.9;
    this.ui.banner('OVERDRIVE');
    Audio.play('powerup');
    Audio.music.setIntensity(1);
  }

  /** HuHu rockets ahead and detonates, clearing the road for PULSE.WINDOW units. */
  _huhuPulse() {
    this.pulseCharges--;
    this.pulseCooldown = PULSE.COOLDOWN;
    this.huhu.pulse();
    Audio.play('dash');
    this.rig.shake.add(0.35);
    this.rig.shake.freeze(0.045);
    this.glitch = 0.6;

    const px = this.player.position.x;
    let cleared = 0;
    for (let i = this.obstacles.live.length - 1; i >= 0; i--) {
      const z = this.obstacles.live[i].object.position.z;
      if (z < 1 && z > -PULSE.WINDOW) { this._shatter(this.obstacles.live[i], i); cleared++; }
    }
    this.particles.ring(26, {
      x: px, y: 1.0, z: -4, radius: 0.4, speed: 16,
      color: 0x16f2ff, size: 1.4, life: 0.6, drag: 2.4, gravity: 0,
    });
    if (cleared) {
      this._addChain(5 * cleared);
      this.ui.banner('PULSE', `${cleared} CLEARED`);
    }
  }

  /** Single funnel for every chain gain, so Overdrive credit can never be missed. */
  _addChain(n) {
    this.chain += n;
    this.chainTimer = CHAIN_GRACE;
    this._chainFraction = 0;
    this.overdrive = Math.min(OD.MAX, this.overdrive + n * OD.PER_CHAIN);
    this.bestMultiplier = Math.max(this.bestMultiplier, this.multiplier);
  }

  _collectShard(it) {
    const doubled = this.powers.has(POWERUP.DOUBLE) ? 2 : 1;
    this.motesInChain++;
    // Every tenth mote in an unbroken chain is gold: worth triple, and it
    // resolves the rising pitch ladder so the ear gets paid too.
    const gold = this.motesInChain % GOLD_EVERY === 0;
    this._addChain(gold ? 3 : 1);

    const value = (gold ? 30 : 10) * this.multiplier * doubled;
    this.score += value;
    this.runShards += (gold ? 3 : 1) * doubled;

    if (gold) Audio.play('core');
    else Audio.play('shard', { pitch: Math.min(10, Math.floor(this.chain / 8)) });
    this.particles.burst(gold ? 14 : 5, {
      x: it.x, y: it.y, z: it.z, speed: gold ? 5.5 : 3.4, speedVar: 0.6,
      color: gold ? 0xfbbf24 : this.tier.color, size: gold ? 1.1 : 0.7,
      life: gold ? 0.6 : 0.42, drag: 5, gravity: 1,
    });

    // Screen-space "+N" at the pickup, so the reward lands where the eye is.
    this._proj.set(it.x, it.y, it.z).project(this.camera);
    if (this._proj.z < 1) {
      this.ui.floater(`+${value}`, (this._proj.x + 1) / 2, (-this._proj.y + 1) / 2,
        gold ? '#fbbf24' : this.tier.css);
    }
  }

  _collectItem(it) {
    if (it.kind === 'shield') {
      if (this.player.addShield(1)) {
        Audio.play('shield');
        this.ui.banner('SHIELD RESTORED');
      } else {
        this.score += 250;
        this.ui.banner('+250', 'SHIELD FULL');
      }
    } else if (it.kind === POWERUP.OVERDRIVE) {
      // A cell fills the meter rather than firing the ability — the player
      // still chooses the moment, which is where the tension lives.
      this.overdrive = Math.min(OD.MAX, this.overdrive + OD.PER_CELL);
      Audio.play('powerup');
      this.ui.banner(this.overdrive >= OD.MAX ? 'OVERDRIVE READY' : 'OVERDRIVE CELL');
      this.rig.addFovKick(0.5);
    } else {
      const meta = POWERUP_META[it.kind];
      this.powers.set(it.kind, meta.duration);
      this._addChain(6);
      Audio.play('powerup');
      this.ui.banner(meta.label.toUpperCase());
      this.rig.addFovKick(0.5);
    }
    this.particles.burst(18, {
      x: it.object.position.x, y: it.object.position.y, z: it.object.position.z,
      speed: 6, speedVar: 0.7, color: POWERUP_META[it.kind]?.hex ?? 0x16f2ff,
      size: 1.1, life: 0.7, drag: 3.2, gravity: 2,
    });
  }

  _collide() {
    const p = this.player;
    if (!p.alive) return;
    const halfW = p.halfWidth;
    const halfH = p.halfHeight;
    const cy = p.centerY;

    for (let i = this.obstacles.live.length - 1; i >= 0; i--) {
      const item = this.obstacles.live[i];
      if (item.dead) continue;

      // Near miss: passed close by without touching. Rewards tight lines.
      const oz = item.object.position.z;
      if (!item.scored && oz > 0.6 && oz < 2.4) {
        item.scored = true;
        // The graze window is derived from the obstacle's own width, not a
        // fixed range: hazards vary from 1.35u (pylon) to 3.65u (lowblock), and
        // a hard-coded band either never fires on the wide ones or fires from a
        // clean lane away on the narrow ones.
        const dx = Math.abs(p.position.x - item.object.position.x);
        const contact = item.size[0] / 2 - 0.08 + p.halfWidth;
        if (dx > contact && dx < contact + GRAZE_MARGIN) {
          this.nearMisses++;
          this.score += 25 * this.multiplier;
          this._addChain(3);
          this.overdrive = Math.min(OD.MAX, this.overdrive + OD.PER_GRAZE);
          this.dilation = 0.09;          // brief slow-mo: the reward for a tight line
          this.flash = 0.22;
          Audio.play('nearMiss');
          this._proj.set(item.object.position.x, item.hitY + 0.4, item.object.position.z).project(this.camera);
          if (this._proj.z < 1) {
            this.ui.floater('GRAZE +3', (this._proj.x + 1) / 2, (-this._proj.y + 1) / 2, '#3dffab');
          }
        }
      }

      if (!this.obstacles.collides(p.position.x, cy, halfW, halfH, item)) continue;

      if (p.overdriving) {
        this._shatter(item, i);
        this._addChain(10);
        continue;
      }
      if (p.invulnerable) continue;

      // Layer 1: HuHu takes the hit for free — and is then gone for twelve
      // seconds, so the cost is capability, not currency. Losing the double
      // jump and the Pulse is felt immediately.
      if (this.huhuDown <= 0) {
        this.huhuDown = PULSE.DOWN_TIME;
        this.huhu.knockOut();
        p.invuln = TUNE.INVULN_AFTER_HIT;
        this.chain = Math.floor(this.chain * 0.75);
        this._shatter(item, i);
        this._clearAhead(10);
        this.flash = 0.9;
        this.glitch = 0.7;
        this.rig.shake.add(0.45);
        this.rig.shake.freeze(0.06);
        Audio.play('shieldBreak');
        this.ui.banner('HUHU IS DOWN', '12s · NO DOUBLE JUMP');
        continue;
      }

      const result = p.takeHit();
      if (result === 'shield') {
        // A shield hit clears the road ahead. Without this, one mistake at high
        // speed cascades into three and the player blames the game, not
        // themselves.
        this._shatter(item, i);
        this._clearAhead(14);
        this.chain = Math.floor(this.chain * 0.5);
        this.motesInChain = 0;
        this.flash = 1;
        this.glitch = 1;
        this.rig.shake.add(0.6);
        this.rig.shake.freeze(0.08);
        this.huhu.celebrate();
        this.ui.banner('SHIELD BROKEN', `${p.shields} LEFT`);
      } else if (result === 'dead') {
        this._die(item);
        return;
      }
    }
  }

  _shatter(item, index) {
    const o = item.object;
    this.particles.burst(22, {
      x: o.position.x, y: o.position.y + item.hitY, z: o.position.z,
      speed: 8, speedVar: 0.8, color: 0xff3b5c, size: 1.2, life: 0.65, drag: 2.6, gravity: 9,
    });
    o.visible = false;
    item.dead = true;
    this.obstacles.pools.get(item.type).release(item);
    this.obstacles.live.splice(index, 1);
    Audio.play('hit');
  }

  _clearAhead(range) {
    for (let i = this.obstacles.live.length - 1; i >= 0; i--) {
      const item = this.obstacles.live[i];
      const z = item.object.position.z;
      if (z < 0 && z > -range) this._shatter(item, i);
    }
  }

  _die(item) {
    this.deathTimer = 0;
    this.flash = 1;
    this.glitch = 1;
    this.rig.shake.add(1);
    this.rig.shake.freeze(0.14);
    this.huhu.dead = true;
    this.particles.burst(46, {
      x: this.player.position.x, y: 0.9, z: 0,
      speed: 10, speedVar: 0.9, color: 0xff3b5c, size: 1.5, life: 1.1, drag: 2.2, gravity: 11,
    });
    this.particles.burst(26, {
      x: this.player.position.x, y: 0.9, z: 0,
      speed: 6, speedVar: 0.8, color: this.world.biome.acc, size: 1.1, life: 0.9, drag: 3, gravity: 6,
    });
    Audio.music.setDuck(0.25);
    this.mode = MODE.OVER;
    this.deathHold = 1.5;
  }

  _deathScene(dt) {
    this.deathHold = (this.deathHold ?? 0) - dt;
    this.speed = damp(this.speed, 0, 0.06, dt);
    this.player.update(dt, { inputEnabled: false });
    this.world.update(dt, this.speed, this.camera.position, this.alien.root.position);
    this.obstacles.update(dt, this.speed);
    this.shards.update(dt, this.speed, this.player.position, false, null);
    this.collectibles.update(dt, this.speed, this.player.position, null);
    this.particles.update(dt);
    this.desat = damp(this.desat, 0.75, 0.08, dt);

    if (this.deathHold <= 0 && this.ui.current !== 'over') this.endRun();
  }

  /** Ground dust and speed streaks behind the player. */
  _runTrail(dt) {
    const p = this.player;
    if (!p.alive) return;
    // Kicked-up dust, deliberately kept small, low and pushed out to the sides.
    // Bigger particles emitted on the centre line sit between the camera and the
    // Alien and bury the character in glow — the one thing the player must be
    // able to see at all times.
    const rate = p.overdriving ? 60 : p.grounded ? 18 : 6;
    this._trailAccum = (this._trailAccum ?? 0) + dt * rate;
    while (this._trailAccum >= 1) {
      this._trailAccum -= 1;
      const side = Math.random() < 0.5 ? -1 : 1;
      this.particles.emit({
        x: p.position.x + side * (0.28 + Math.random() * 0.3),
        y: p.position.y + Math.random() * 0.1,
        z: 0.3 + Math.random() * 0.3,
        vx: side * (0.6 + Math.random() * 1.4),
        vy: 0.35 + Math.random() * 0.6,
        vz: 5 + Math.random() * 5,
        color: p.overdriving ? 0xffcc33 : this.world.biome.acc,
        size: p.overdriving ? 0.62 : 0.34,
        life: 0.38, drag: 1.9, gravity: -0.6,
      });
    }
    if (p.justLanded) {
      this.particles.ring(12, {
        x: p.position.x, y: 0.04, z: 0, radius: 0.25, speed: 3.6,
        color: this.world.biome.acc, size: 0.8, life: 0.4, drag: 5, gravity: 0,
      });
      this.rig.shake.add(0.09);
    }
    if (p.justJumped) {
      this.particles.burst(p.justJumped === 2 ? 14 : 9, {
        x: p.position.x, y: p.position.y + 0.1, z: 0,
        speed: 3.4, speedVar: 0.7, dir: { x: 0, y: -1, z: 0 }, spread: 0.85,
        color: p.justJumped === 2 ? 0xffffff : this.world.biome.acc,
        size: 0.85, life: 0.45, drag: 3.4, gravity: -2,
      });
    }
  }

  _applyBiome(b, announce = false) {
    this.obstacles.setBiome(b);
    this.shards.setBiome(b);
    this.ui.setAccent(b.accCss, b.acc2Css);
    if (announce) {
      this.ui.banner(b.name, b.sub);
      Audio.play('biome');
      this.rig.addFovKick(0.6);
      this.glitch = 0.85;
    }
  }

  /** The rig owns FOV during play; the renderer only supplies the orientation base. */
  _layoutCamera(portrait, fov) {
    this.rig.fovBase = fov ?? 48;
    // Portrait sees less track per degree, so the camera sits further back.
    this.camTune = portrait
      ? { height: 3.4, back: 7.6, follow: 0.26, lookY: 0.9, lookZ: -18, lookFollow: 0.45 }
      : { height: 3.15, back: 6.4, follow: 0.30, lookY: 0.85, lookZ: -17, lookFollow: 0.5 };
  }

  // ─── presentation ──────────────────────────────────────────────────────
  _present(dt) {
    const p = this.player;
    const playing = this.mode === MODE.PLAYING || this.mode === MODE.OVER;

    if (playing) {
      // Character follows the simulated player.
      this.alien.root.position.set(p.position.x, p.position.y, 0);
      this.alien.update(dt, { state: p.animState, speed: clamp01(this.speed / SPEED.MAX), groundY: 0 });
      this.alien.setLean(p.lean);
      this.alien.setAccent(this.tier.color);
      this.alien.setStarIntensity(2.2 + Math.sin(this.elapsed * 6) * 0.5 * (this.chain > 0 ? 1 : 0.2));

      // HuHu flies high and wide on the left. It used to sit at the player's
      // shoulder, where it covered whatever was in the left lane — a companion
      // that hides obstacles is worse than no companion.
      const hx = p.position.x - 2.5 - p.lean * 1.1;
      const hy = 3.05 + p.position.y * 0.3 + Math.sin(this.elapsed * 1.6) * 0.12;
      this.huhu.root.position.x = damp(this.huhu.root.position.x, hx, 0.0009, dt);
      this.huhu.root.position.y = damp(this.huhu.root.position.y, hy, 0.002, dt);
      this.huhu.root.position.z = damp(this.huhu.root.position.z, 0.4, 0.01, dt);
      this.huhu.update(dt, { state: this.huhu.dead ? 'dead' : 'fly', speed: clamp01(this.speed / SPEED.MAX) });
      this.huhu.setShield(p.shields, p.shieldMax);
      this.huhu.setAccent(this.tier.color);

      // Camera: sits behind and above, drifts toward the lane, and pulls back
      // as speed rises so the sense of acceleration never plateaus.
      const speedT = clamp01(remap(this.speed, SPEED.START, SPEED.MAX, 0, 1));
      const c = this.camTune;
      this._camPos.set(
        p.position.x * c.follow,
        c.height + speedT * 0.4 + p.position.y * 0.26,
        c.back + speedT * 1.6,
      );
      this._camLook.set(p.position.x * c.lookFollow, c.lookY + p.position.y * 0.4, c.lookZ);
      this.rig.update(dt, this._camPos, this._camLook, {
        follow: 0.00008,
        lookFollow: 0.00002,
        roll: -p.lean * 0.06,
        speedFov: speedT * 9 + (p.overdriving ? 7 : 0),
      });
    }

    // Post-processing state.
    const u = this.renderer.grades;
    this.flash = damp(this.flash, 0, 0.0001, dt);
    this.glitch = damp(this.glitch, 0, 0.0004, dt);
    if (this.mode !== MODE.OVER) this.desat = damp(this.desat, 0, 0.01, dt);

    const speedT = playing ? clamp01(remap(this.speed, SPEED.START, SPEED.MAX, 0, 1)) : 0;
    const blurOn = Save.settings.motionBlur ? 1 : 0;
    u.uSpeed.value = damp(u.uSpeed.value, speedT * blurOn * (this.player.overdriving ? 1.6 : 0.75), 0.02, dt);
    u.uFlash.value = this.flash * 0.55;
    u.uGlitch.value = this.glitch;
    u.uDesat.value = this.desat;
    u.uAberration.value = 0.0009 + speedT * 0.0016;
    u.uVignette.value = 0.5 + speedT * 0.12;
    u.uFlashColor.value.setHex(this.player.shields > 0 ? 0x16f2ff : 0xff3b5c);

    // HUD.
    if (this.mode === MODE.PLAYING) {
      this.ui.updateHud({
        score: Math.floor(this.score),
        distance: this.distance,
        shards: this.runShards,
        comboTier: this.chain > 0 ? this.multiplier : 0,
        multiplier: this.multiplier,
        comboTimeLeft: clamp01(this.chainTimer / CHAIN_GRACE),
        shields: this.player.shields,
        shieldMax: this.player.shieldMax,
        overdrive: this.overdrive / OD.MAX,
        overdriveActive: this.overdriveActive > 0,
        pulses: this.pulseCharges,
        pulseMax: PULSE.CHARGES,
        huhuDown: this.huhuDown,
      });
      this.ui.updatePowers([...this.powers].map(([id, t]) => ({
        id, label: POWERUP_META[id].label, color: POWERUP_META[id].color,
        progress: t / POWERUP_META[id].duration,
      })));
    }

    if (Save.settings.showFps) this.ui.setFps(this.renderer.fps);
    this.renderer.render(dt, this.elapsed);
  }
}
