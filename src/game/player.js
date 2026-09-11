// ─── PLAYER ──────────────────────────────────────────────────────────────────
// Three-lane movement with a jump/slide/dash verb set.
//
// The feel of the whole game lives in this file. The things doing the heavy
// lifting are the ones a player never notices:
//   • Coyote time — jump still works for a beat after walking off a ledge or
//     being knocked airborne.
//   • Input buffering (in Input.consume) — a jump pressed just before landing
//     fires on touchdown instead of being dropped.
//   • Lane-change easing on a curve, not a lerp, so the move has a snap at the
//     start and settles without overshoot.
//   • A slide that cannot be cancelled instantly, so it reads as a commitment.

import * as THREE from 'three';
import { Input, Action } from '../core/input.js';
import { Audio } from '../core/audio.js';
import { LANE_X } from './world.js';
import { PLAYER } from './obstacles.js';
import { clamp, clamp01, damp, lerp, easeOutCubic } from '../core/util.js';

export const STATE = {
  RUN: 'run', JUMP: 'jump', FALL: 'fall', SLIDE: 'slide',
  DASH: 'dash', HIT: 'hit', DEAD: 'dead',
};

export const TUNE = {
  GRAVITY: 26.0,
  JUMP_V: 9.4,            // apex 1.70u at t=0.362s, airtime 0.723s
  DOUBLE_JUMP_V: 8.0,     // SET, not added, so the second hop is always predictable
  FAST_FALL: 1.55,        // gravity multiplier when falling — a snappier arc
  FASTFALL_MUL: 3.2,      // air-pressed slide slams you down
  SHORT_HOP: 0.55,        // velocity kept when jump is released early
  JUMP_CUT_WINDOW: 0.14,
  COYOTE: 0.110,
  LANE_TIME: 0.155,
  SLIDE_TIME: 0.62,
  SLIDE_MIN: 0.18,        // minimum commit before a jump-cancel is accepted
  SLIDE_SPEED_MULT: 1.12, // offensively useful, not purely defensive
  OVERDRIVE_TIME: 6.0,
  OVERDRIVE_SPEED_MULT: 1.45,
  HIT_STUN: 0.45,
  INVULN_AFTER_HIT: 1.10,
};

export class Player {
  constructor() {
    this.position = new THREE.Vector3(0, 0, 0);
    this.reset();
  }

  reset() {
    this.lane = 1;
    this.targetLane = 1;
    this.laneT = 1;             // continuous lane position, for easing
    this.laneFrom = 1;
    this.laneProgress = 1;
    this.position.set(LANE_X[1], 0, 0);

    this.vy = 0;
    this.grounded = true;
    this.jumpsUsed = 0;
    this.coyote = 0;
    this.state = STATE.RUN;

    this.slideTimer = 0;
    this.overdriveTimer = 0;
    this.hitTimer = 0;
    this.invuln = 0;

    this.shields = 1;
    this.shieldMax = 2;

    this.lean = 0;
    this.canDoubleJump = true;
    this.fastFalling = false;
    this.jumpCutArmed = false;
    this.jumpHeldSeen = false;
    this.jumpAge = 0;
    this.alive = true;
    this.speedMult = 1;
    this.justLanded = false;
    this.justJumped = 0;
  }

  get height() { return this.state === STATE.SLIDE ? PLAYER.slideHeight : PLAYER.height; }
  get halfHeight() { return this.height / 2; }
  /** Centre of the collision box, feet-relative. */
  get centerY() { return this.position.y + this.halfHeight; }
  get halfWidth() { return PLAYER.radius; }
  get invulnerable() { return this.invuln > 0 || this.overdriving; }

  // ─── verbs ───────────────────────────────────────────────────────────────
  moveLane(dir) {
    if (!this.alive || this.state === STATE.HIT) return false;
    const next = clamp(this.targetLane + dir, 0, 2);
    if (next === this.targetLane) return false;
    this.laneFrom = this.laneT;
    this.targetLane = next;
    this.laneProgress = 0;
    Audio.play('lane');
    return true;
  }

  jump() {
    if (!this.alive || this.state === STATE.HIT) return false;
    const canFirst = this.grounded || this.coyote > 0;
    if (canFirst) {
      this.vy = TUNE.JUMP_V;
      this.grounded = false;
      this.coyote = 0;
      this.jumpsUsed = 1;
      this.state = STATE.JUMP;
      this.slideTimer = 0;
      this.justJumped = 1;
      this.jumpCutArmed = true;
      this.jumpAge = 0;
      // Was the button actually held at the moment of the jump? A touch tap
      // presses and releases inside one event, so it is never "down" on any
      // frame — without this the tap would always be treated as an early
      // release and cut to a hop that cannot clear a barrier.
      this.jumpHeldSeen = Input.isDown(Action.JUMP);
      Audio.play('jump');
      return true;
    }
    // The second jump is HuHu's headbutt assist, so it is unavailable whenever
    // he is down. That is the whole point of the first-hit penalty.
    if (this.jumpsUsed < 2 && this.canDoubleJump !== false) {
      this.vy = TUNE.DOUBLE_JUMP_V;
      this.jumpsUsed = 2;
      this.state = STATE.JUMP;
      this.justJumped = 2;
      Audio.play('doubleJump');
      return true;
    }
    return false;
  }

  slide() {
    if (!this.alive || this.state === STATE.HIT) return false;
    if (this.state === STATE.SLIDE) return false;
    this.slideTimer = TUNE.SLIDE_TIME;
    this.state = STATE.SLIDE;
    // Sliding from the air slams you down — a fast way to reach a low gap.
    if (!this.grounded) this.fastFalling = true;
    Audio.play('slide');
    return true;
  }

  /**
   * Overdrive: six seconds of invulnerable, faster running.
   *
   * Deliberately NOT a value of `state`. It has to survive jumping, sliding and
   * being knocked about, and anything stored in `state` is overwritten by the
   * next verb the player presses.
   */
  startOverdrive() {
    if (!this.alive) return false;
    this.overdriveTimer = TUNE.OVERDRIVE_TIME;
    Audio.play('dash');
    return true;
  }

  get overdriving() { return this.overdriveTimer > 0; }

  /** @returns 'shield' | 'dead' | null */
  takeHit() {
    if (this.invulnerable || !this.alive) return null;
    if (this.shields > 0) {
      this.shields--;
      this.invuln = TUNE.INVULN_AFTER_HIT;
      this.hitTimer = TUNE.HIT_STUN * 0.45;
      this.state = STATE.HIT;
      Audio.play('shieldBreak');
      return 'shield';
    }
    this.alive = false;
    this.state = STATE.DEAD;
    this.vy = 9;
    Audio.play('die');
    return 'dead';
  }

  addShield(n = 1) {
    const before = this.shields;
    this.shields = clamp(this.shields + n, 0, this.shieldMax);
    return this.shields > before;
  }

  // ─── update ──────────────────────────────────────────────────────────────
  update(dt, opts = {}) {
    const { inputEnabled = true, canDoubleJump = true } = opts;
    this.canDoubleJump = canDoubleJump;
    this.justLanded = false;
    this.justJumped = 0;

    if (this.state === STATE.DEAD) {
      this.vy -= TUNE.GRAVITY * 0.55 * dt;
      this.position.y = Math.max(0, this.position.y + this.vy * dt);
      this.position.x = LANE_X[Math.round(this.laneT)] ?? this.position.x;
      return;
    }

    // Timers.
    if (this.invuln > 0) this.invuln -= dt;
    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0 && this.state === STATE.HIT) this.state = this.grounded ? STATE.RUN : STATE.FALL;
    }
    // Overdrive runs its own clock and never touches `state`, so it cannot
    // clobber an in-progress slide when it expires.
    if (this.overdriveTimer > 0) this.overdriveTimer = Math.max(0, this.overdriveTimer - dt);
    if (this.slideTimer > 0) {
      this.slideTimer -= dt;
      // Release slide early if the player lets go, but never before SLIDE_MIN.
      const held = Input.isDown(Action.SLIDE);
      const elapsed = TUNE.SLIDE_TIME - this.slideTimer;
      if (this.slideTimer <= 0 || (!held && elapsed > TUNE.SLIDE_MIN)) {
        this.slideTimer = 0;
        if (this.state === STATE.SLIDE) this.state = this.grounded ? STATE.RUN : STATE.FALL;
      }
    }

    // Input.
    if (inputEnabled && this.alive && this.state !== STATE.HIT) {
      if (Input.consume(Action.LEFT)) this.moveLane(-1);
      if (Input.consume(Action.RIGHT)) this.moveLane(1);
      if (Input.consume(Action.JUMP)) this.jump();
      if (Input.consume(Action.SLIDE)) this.slide();
    }

    // Variable jump height: releasing inside the cut window trims the rise once.
    // The cut only applies to an input that was genuinely HELD and then let go;
    // a discrete tap (touch, or a gamepad button seen only as an edge) always
    // gets the full arc, because there is no "hold" for the player to shorten.
    if (this.jumpCutArmed) {
      this.jumpAge += dt;
      const down = Input.isDown(Action.JUMP);
      if (down) this.jumpHeldSeen = true;
      if (!down) {
        if (this.jumpHeldSeen && this.vy > 0) this.vy *= TUNE.SHORT_HOP;
        this.jumpCutArmed = false;
      } else if (this.jumpAge > TUNE.JUMP_CUT_WINDOW) {
        this.jumpCutArmed = false;
      }
    }

    // Vertical motion.
    if (!this.grounded) {
      const g = this.fastFalling ? TUNE.GRAVITY * TUNE.FASTFALL_MUL
        : this.vy < 0 ? TUNE.GRAVITY * TUNE.FAST_FALL : TUNE.GRAVITY;
      this.vy -= g * dt;
      this.position.y += this.vy * dt;
      if (this.position.y <= 0) {
        this.position.y = 0;
        this.vy = 0;
        this.grounded = true;
        this.jumpsUsed = 0;
        this.justLanded = true;
        this.fastFalling = false;
        this.jumpCutArmed = false;
        this.jumpHeldSeen = false;
        if (this.state === STATE.JUMP || this.state === STATE.FALL) {
          this.state = this.slideTimer > 0 ? STATE.SLIDE : STATE.RUN;
        }
        Audio.play('land');
      } else if (this.state === STATE.JUMP && this.vy < 0) {
        this.state = STATE.FALL;
      }
      this.coyote = 0;
    } else {
      this.coyote = TUNE.COYOTE;
      if (this.state !== STATE.SLIDE && this.state !== STATE.HIT) {
        this.state = STATE.RUN;
      }
    }

    // Lane easing — eased, not linear, so the start of the move has bite.
    if (this.laneProgress < 1) {
      this.laneProgress = clamp01(this.laneProgress + dt / TUNE.LANE_TIME);
      this.laneT = lerp(this.laneFrom, this.targetLane, easeOutCubic(this.laneProgress));
      if (this.laneProgress >= 1) this.lane = this.targetLane;
    } else {
      this.laneT = this.targetLane;
      this.lane = this.targetLane;
    }
    const prevX = this.position.x;
    this.position.x = this._laneToX(this.laneT);

    // Lean is driven by actual lateral velocity, so it reads honestly.
    const lateralV = (this.position.x - prevX) / Math.max(dt, 1e-4);
    this.lean = damp(this.lean, clamp(lateralV / 18, -1, 1), 0.0008, dt);

    this.speedMult = (this.overdriving ? TUNE.OVERDRIVE_SPEED_MULT : 1)
      * (this.state === STATE.SLIDE ? TUNE.SLIDE_SPEED_MULT : 1);
  }

  _laneToX(t) {
    const i = clamp(Math.floor(t), 0, LANE_X.length - 2);
    const f = clamp01(t - i);
    return lerp(LANE_X[i], LANE_X[i + 1], f);
  }

  /** Visual state string for the character rig. */
  get animState() {
    if (!this.alive) return 'dead';
    switch (this.state) {
      case STATE.SLIDE: return 'slide';
      case STATE.HIT: return 'hit';
      case STATE.JUMP: return 'jump';
      case STATE.FALL: return 'fall';
      default: return this.overdriving ? 'dash' : 'run';
    }
  }
}
