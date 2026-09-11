// ─── INPUT ───────────────────────────────────────────────────────────────────
// Keyboard, touch and gamepad collapse into one small set of named actions.
//
// Two things here matter for game feel:
//   • Buffering — a jump pressed just before landing still fires. Without it,
//     fast players feel the game "ate" their input.
//   • Edge tracking — `pressed()` is true for exactly one frame, so menus and
//     one-shot abilities never double-fire.

import { Save } from './save.js';

export const Action = {
  LEFT: 'left',
  RIGHT: 'right',
  JUMP: 'jump',
  SLIDE: 'slide',
  DASH: 'dash',
  PAUSE: 'pause',
  MUTE: 'mute',
  CONFIRM: 'confirm',
  BACK: 'back',
};

const KEY_MAP = {
  ArrowLeft: Action.LEFT, KeyA: Action.LEFT,
  ArrowRight: Action.RIGHT, KeyD: Action.RIGHT,
  ArrowUp: Action.JUMP, KeyW: Action.JUMP, Space: Action.JUMP,
  ArrowDown: Action.SLIDE, KeyS: Action.SLIDE,
  ShiftLeft: Action.DASH, ShiftRight: Action.DASH, KeyE: Action.DASH,
  Escape: Action.PAUSE, KeyP: Action.PAUSE,
  KeyM: Action.MUTE,
  Enter: Action.CONFIRM, NumpadEnter: Action.CONFIRM,
  Backspace: Action.BACK,
};

// Standard gamepad mapping: A=0 B=1 X=2 Y=3, LB=4 RB=5, Start=9, dpad=12..15
const PAD_BUTTON_MAP = {
  0: Action.JUMP, 3: Action.JUMP,
  1: Action.SLIDE, 2: Action.SLIDE,
  4: Action.DASH, 5: Action.DASH, 6: Action.DASH, 7: Action.DASH,
  9: Action.PAUSE, 8: Action.BACK,
  12: Action.JUMP, 13: Action.SLIDE, 14: Action.LEFT, 15: Action.RIGHT,
};

const BUFFER_SECONDS = 0.14;   // how long a press stays "fresh" enough to consume
const SWIPE_MIN_PX = 26;       // shorter than this is a tap, not a swipe
const SWIPE_MAX_MS = 500;
const HOLD_SLIDE_MS = 0;       // slide is edge-triggered; hold handled separately

const held = new Set();        // actions currently down
const bufferedAt = new Map();  // action -> timestamp of most recent press
const consumed = new Set();    // buffered presses already spent this run
const pressedThisFrame = new Set();
const releasedThisFrame = new Set();

let now = 0;                   // seconds, advanced by update()
let padIndex = null;
const padPrev = [];
let anyInputSeen = false;

// ─── low-level press/release ─────────────────────────────────────────────────
function press(action) {
  if (!action) return;
  anyInputSeen = true;
  if (!held.has(action)) {
    held.add(action);
    pressedThisFrame.add(action);
    bufferedAt.set(action, now);
    consumed.delete(action);
  }
}

function release(action) {
  if (!action) return;
  if (held.delete(action)) releasedThisFrame.add(action);
}

// ─── keyboard ────────────────────────────────────────────────────────────────
addEventListener('keydown', e => {
  const a = KEY_MAP[e.code];
  if (!a) return;
  // Stop Space/arrows scrolling the page behind the canvas.
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  if (e.repeat) return;
  press(a);
}, { passive: false });

addEventListener('keyup', e => release(KEY_MAP[e.code]));

// Losing focus must not leave a key stuck down.
addEventListener('blur', () => { held.forEach(a => releasedThisFrame.add(a)); held.clear(); });

// ─── touch ───────────────────────────────────────────────────────────────────
// One finger: swipe left/right to change lane, up to jump, down to slide,
// tap to jump. Two fingers or a long press triggers dash.
const touches = new Map();
let touchTarget = null;

function onTouchStart(e) {
  for (const t of e.changedTouches) {
    touches.set(t.identifier, { x0: t.clientX, y0: t.clientY, t0: performance.now(), fired: false });
  }
  if (touches.size >= 2) press(Action.DASH);
  anyInputSeen = true;
}

function onTouchMove(e) {
  if (e.cancelable) e.preventDefault();
  const invert = Save.settings.invertSwipe ? -1 : 1;
  for (const t of e.changedTouches) {
    const s = touches.get(t.identifier);
    if (!s || s.fired) continue;
    const dx = t.clientX - s.x0;
    const dy = t.clientY - s.y0;
    if (Math.abs(dx) < SWIPE_MIN_PX && Math.abs(dy) < SWIPE_MIN_PX) continue;
    s.fired = true;
    if (Math.abs(dx) > Math.abs(dy)) {
      press(dx > 0 ? Action.RIGHT : Action.LEFT);
    } else if (dy * invert < 0) {
      press(Action.JUMP);
    } else {
      press(Action.SLIDE);
      s.slideHeld = true;
    }
  }
}

function onTouchEnd(e) {
  for (const t of e.changedTouches) {
    const s = touches.get(t.identifier);
    touches.delete(t.identifier);
    if (!s) continue;
    const dt = performance.now() - s.t0;
    if (!s.fired && dt < SWIPE_MAX_MS) press(Action.JUMP); // tap = jump
    if (s.slideHeld) release(Action.SLIDE);
  }
  // Swipe actions are momentary; clear them so they don't latch.
  release(Action.LEFT); release(Action.RIGHT); release(Action.JUMP); release(Action.DASH);
}

export function attachTouch(el) {
  touchTarget = el;
  el.addEventListener('touchstart', onTouchStart, { passive: true });
  el.addEventListener('touchmove', onTouchMove, { passive: false });
  el.addEventListener('touchend', onTouchEnd, { passive: true });
  el.addEventListener('touchcancel', onTouchEnd, { passive: true });
}

// ─── gamepad ─────────────────────────────────────────────────────────────────
addEventListener('gamepadconnected', e => { padIndex = e.gamepad.index; });
addEventListener('gamepaddisconnected', e => { if (padIndex === e.gamepad.index) padIndex = null; });

function pollGamepad() {
  if (padIndex === null || !navigator.getGamepads) return;
  const pad = navigator.getGamepads()[padIndex];
  if (!pad) return;

  for (let i = 0; i < pad.buttons.length; i++) {
    const down = pad.buttons[i].pressed;
    if (down !== padPrev[i]) {
      const a = PAD_BUTTON_MAP[i];
      if (a) (down ? press : release)(a);
      padPrev[i] = down;
    }
  }
  // Left stick as a digital d-pad, with a deadzone.
  const ax = pad.axes[0] ?? 0, ay = pad.axes[1] ?? 0;
  const DZ = 0.55;
  const stick = { left: ax < -DZ, right: ax > DZ, jump: ay < -DZ, slide: ay > DZ };
  for (const [k, a] of [['left', Action.LEFT], ['right', Action.RIGHT], ['jump', Action.JUMP], ['slide', Action.SLIDE]]) {
    const key = 'axis_' + k;
    if (stick[k] !== padPrev[key]) {
      (stick[k] ? press : release)(a);
      padPrev[key] = stick[k];
    }
  }
}

// ─── public API ──────────────────────────────────────────────────────────────
export const Input = {
  /** Call once per frame, before game logic. `dt` in seconds. */
  update(dt) {
    now += dt;
    pressedThisFrame.clear();
    releasedThisFrame.clear();
    pollGamepad();
  },

  /** Down right now. */
  isDown: action => held.has(action),

  /** True for exactly one frame, on the press edge. Use for menus. */
  pressed: action => pressedThisFrame.has(action),

  released: action => releasedThisFrame.has(action),

  /**
   * Buffered consume: true if the action was pressed within BUFFER_SECONDS and
   * has not been consumed yet. This is what gameplay should call — it forgives
   * a player who hits jump a few frames early.
   */
  consume(action) {
    const t = bufferedAt.get(action);
    if (t === undefined || consumed.has(action)) return false;
    if (now - t > BUFFER_SECONDS) return false;
    consumed.add(action);
    return true;
  },

  /** Discard any pending buffered input — call on state transitions. */
  clearBuffer() {
    bufferedAt.clear();
    consumed.clear();
    pressedThisFrame.clear();
  },

  clearAll() {
    held.clear();
    this.clearBuffer();
  },

  /** Any input at all since load — used to unlock audio and skip the attract loop. */
  get hasInteracted() { return anyInputSeen; },

  get gamepadConnected() { return padIndex !== null; },

  /** Synthesise a press — lets on-screen buttons reuse the same path. */
  virtualPress: press,
  virtualRelease: release,
};
