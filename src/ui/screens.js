// ─── UI CONTROLLER ───────────────────────────────────────────────────────────
// Owns every DOM screen and the HUD. The game calls into this; it never reads
// game state directly, which keeps the render loop free of layout thrash.

import { Save } from '../core/save.js';
import { Audio } from '../core/audio.js';
import { clamp01, commas, distanceLabel } from '../core/util.js';

const $ = id => document.getElementById(id);
const $$ = sel => Array.from(document.querySelectorAll(sel));

const SCREENS = {
  loading: 'scrLoading',
  title: 'scrTitle',
  menu: 'scrMenu',
  settings: 'scrSettings',
  skins: 'scrSkins',
  howto: 'scrHowto',
  credits: 'scrCredits',
  pause: 'scrPause',
  over: 'scrOver',
  none: null,
};

const HOWTO = [
  ['Move', 'A / D  ·  ← →  ·  swipe sideways', 'Change lane. Skim a hazard for a GRAZE bonus.'],
  ['Jump', 'W  ·  ↑  ·  SPACE  ·  swipe up / tap', 'Hold for height. Tap again mid-air and HuHu headbutts you higher.'],
  ['Slide', 'S  ·  ↓  ·  swipe down', 'Duck under gates. Press it in the air to slam down fast.'],
  ['Ability', 'SHIFT  ·  E  ·  two-finger tap', 'Overdrive when the meter is full, otherwise HuHu&rsquo;s Pulse.'],
  ['Overdrive', 'Fills as you chain and graze', 'Six seconds invulnerable, faster, smashing everything you touch.'],
  ['Pulse', 'HuHu clears the road ahead', 'Two charges, one back every 700&thinsp;m.'],
  ['Chain', 'Keep collecting without a hit', 'Tiers run ×1 up to ×20. Every tenth shard is gold.'],
  ['Damage', 'HuHu takes the first hit', 'He is out for 12&thinsp;s — no double jump, no Pulse. Then your shields go.'],
  ['Pause', 'ESC  ·  P', 'Anytime during a run.'],
];

export class UI {
  constructor() {
    // Touch devices have no SHIFT key; naming a key they cannot press is worse
    // than naming nothing.
    const touch = matchMedia('(hover: none) and (pointer: coarse)').matches;
    const el = $('odReady');
    if (el) el.textContent = touch ? 'READY · 2 FINGERS' : 'READY · SHIFT';

    this.current = 'loading';
    this.selection = 0;
    this.onAction = () => {};
    this.floaterPool = [];
    this._bannerTimer = null;
    this._lastScore = -1;
    this._lastDist = -1;
    this._lastShards = -1;
    this._shieldPips = 0;
    this._powerEls = new Map();

    this._bindButtons();
    this._bindSettings();
    this._buildHowto();
    this._bindKeys();
  }

  // ─── screen switching ──────────────────────────────────────────────────
  show(name) {
    if (!(name in SCREENS)) return;
    for (const [k, id] of Object.entries(SCREENS)) {
      if (!id) continue;
      $(id).classList.toggle('on', k === name);
    }
    this.current = name;
    this.selection = 0;
    this._syncSelection();

    if (name === 'title') {
      const t = $('titleText');
      t.classList.remove('fire');
      void t.offsetWidth;                       // restart the CSS animation
      t.classList.add('fire');
      const d = Save.data;
      $('titleBest').textContent = d.hiScore > 0
        ? `Best  ${commas(d.hiScore)}   ·   ${distanceLabel(d.bestDistance)}   ·   ${d.runs} run${d.runs === 1 ? '' : 's'}`
        : 'No runs logged';
    }
    if (name === 'menu') this._refreshMenuStats();
    if (name === 'settings') this._syncSettings();
    if (name === 'skins') this._buildSkins();
  }

  setHudVisible(v) { $('hud').classList.toggle('on', v); }

  // ─── loading ───────────────────────────────────────────────────────────
  setLoading(pct, msg) {
    $('loadFill').style.width = `${Math.round(clamp01(pct) * 100)}%`;
    if (msg) $('loadMsg').textContent = msg;
  }

  // ─── buttons & keyboard nav ────────────────────────────────────────────
  _bindButtons() {
    $$('#ui [data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        Audio.play('uiSelect');
        this.onAction(btn.dataset.act, btn);
      });
      btn.addEventListener('mouseenter', () => {
        const list = this._buttons();
        const i = list.indexOf(btn);
        if (i >= 0 && i !== this.selection) {
          this.selection = i;
          this._syncSelection();
          Audio.play('uiMove');
        }
      });
    });
    $('btnPause').addEventListener('click', () => this.onAction('pause'));
  }

  _buttons() {
    const id = SCREENS[this.current];
    if (!id) return [];
    return Array.from($(id).querySelectorAll('.btn:not([disabled])'));
  }

  _syncSelection() {
    const list = this._buttons();
    list.forEach((b, i) => b.classList.toggle('sel', i === this.selection));
  }

  move(dir) {
    const list = this._buttons();
    if (!list.length) return;
    this.selection = (this.selection + dir + list.length) % list.length;
    this._syncSelection();
    Audio.play('uiMove');
  }

  activate() {
    const list = this._buttons();
    const btn = list[this.selection];
    if (!btn) return false;
    Audio.play('uiSelect');
    this.onAction(btn.dataset.act, btn);
    return true;
  }

  _bindKeys() {
    // Menu navigation is handled here rather than in Input so that gameplay
    // bindings and menu bindings never fight over the same keys.
    addEventListener('keydown', e => {
      if (this.current === 'none' || this.current === 'loading') return;
      const k = e.key;
      if (k === 'ArrowUp' || k === 'w' || k === 'W') { e.preventDefault(); this.move(-1); }
      else if (k === 'ArrowDown' || k === 's' || k === 'S') { e.preventDefault(); this.move(1); }
      else if (k === 'Enter') { e.preventDefault(); this.activate(); }
    });
  }

  // ─── settings ──────────────────────────────────────────────────────────
  _bindSettings() {
    const sliders = [
      ['setMaster', 'valMaster', 'master', v => Audio.setVolume('master', v)],
      ['setMusic', 'valMusic', 'music', v => Audio.setVolume('music', v)],
      ['setSfx', 'valSfx', 'sfx', v => { Audio.setVolume('sfx', v); Audio.play('uiMove'); }],
      ['setShake', 'valShake', 'shake', v => Save.setSetting('shake', v)],
    ];
    for (const [id, valId, key, apply] of sliders) {
      const el = $(id);
      el.addEventListener('input', () => {
        const v = Number(el.value) / 100;
        $(valId).textContent = `${el.value}%`;
        el.style.setProperty('--pct', `${el.value}%`);
        apply(v);
        this.onSettingChange?.(key, v);
      });
    }

    this._bindSeg('setQuality', 'q', v => { Save.setSetting('quality', v); this.onSettingChange?.('quality', v); });
    this._bindSeg('setBlur', 'v', v => { Save.setSetting('motionBlur', v === '1'); this.onSettingChange?.('motionBlur', v === '1'); });
    this._bindSeg('setFps', 'v', v => {
      Save.setSetting('showFps', v === '1');
      $('fps').classList.toggle('on', v === '1');
    });
    this._bindSeg('setInvert', 'v', v => Save.setSetting('invertSwipe', v === '1'));
  }

  _bindSeg(id, attr, apply) {
    const root = $(id);
    root.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      Array.from(root.children).forEach(c => c.classList.toggle('on', c === btn));
      Audio.play('uiSelect');
      apply(btn.dataset[attr]);
    });
  }

  _syncSettings() {
    const s = Save.settings;
    const set = (id, valId, v) => {
      const el = $(id);
      el.value = Math.round(v * 100);
      $(valId).textContent = `${Math.round(v * 100)}%`;
      el.style.setProperty('--pct', `${Math.round(v * 100)}%`);
    };
    set('setMaster', 'valMaster', s.master);
    set('setMusic', 'valMusic', s.music);
    set('setSfx', 'valSfx', s.sfx);
    set('setShake', 'valShake', s.shake);

    const mark = (rootId, attr, value) => {
      Array.from($(rootId).children).forEach(c => c.classList.toggle('on', c.dataset[attr] === String(value)));
    };
    mark('setQuality', 'q', s.quality);
    mark('setBlur', 'v', s.motionBlur ? '1' : '0');
    mark('setFps', 'v', s.showFps ? '1' : '0');
    mark('setInvert', 'v', s.invertSwipe ? '1' : '0');
    $('fps').classList.toggle('on', s.showFps);
  }

  // ─── how to play ───────────────────────────────────────────────────────
  _buildHowto() {
    $('howtoRows').innerHTML = HOWTO.map(([label, keys, note]) => `
      <div class="row">
        <span class="label">${label}</span>
        <div class="ctl" style="justify-content:flex-start;flex-direction:column;align-items:flex-start;gap:3px">
          <span class="val" style="color:var(--acc);min-width:0;text-align:left">${keys}</span>
          <span class="tiny" style="letter-spacing:.04em">${note}</span>
        </div>
      </div>`).join('');
  }

  // ─── chassis / skins ───────────────────────────────────────────────────
  setSkins(list) { this._skins = list; }

  _buildSkins() {
    const skins = this._skins ?? [];
    const d = Save.data;
    $('skinBalance').textContent = `Balance  ${commas(d.shards)} shards`;
    $('skinRows').innerHTML = skins.map(s => {
      const owned = Save.isUnlocked(s.id);
      const active = d.skin === s.id;
      const state = active ? 'Equipped' : owned ? 'Equip' : `${commas(s.cost)} ◈`;
      return `
        <div class="row" data-skin="${s.id}" style="cursor:pointer">
          <span class="label" style="color:${owned ? 'var(--ink)' : 'var(--ink-faint)'}">${s.name}</span>
          <div class="ctl">
            <span class="tiny" style="letter-spacing:.04em;flex:1;text-align:left">${s.blurb}</span>
            <span style="display:inline-block;width:16px;height:16px;background:${s.swatch};box-shadow:0 0 10px ${s.swatch}"></span>
            <span class="val" style="color:${active ? 'var(--good)' : owned ? 'var(--acc)' : 'var(--warn)'}">${state}</span>
          </div>
        </div>`;
    }).join('');

    $$('#skinRows [data-skin]').forEach(row => {
      row.addEventListener('click', () => this.onAction('skin', row));
    });
  }

  // ─── HUD ───────────────────────────────────────────────────────────────
  updateHud(s) {
    if (s.score !== this._lastScore) {
      $('hudScore').textContent = commas(s.score);
      this._lastScore = s.score;
    }
    if (s.distance !== this._lastDist) {
      $('hudDist').textContent = distanceLabel(s.distance);
      this._lastDist = s.distance;
    }
    if (s.shards !== this._lastShards) {
      $('hudShards').textContent = commas(s.shards);
      this._lastShards = s.shards;
    }

    // Combo
    const c = $('combo');
    if (s.comboTier > 0) {
      c.classList.add('on');
      $('comboMult').textContent = `×${s.multiplier}`;
      const pct = `${Math.round(clamp01(s.comboTimeLeft) * 100)}%`;
      const fill = $('comboFill');
      fill.style.height = pct;
      fill.style.setProperty('--w', pct);
    } else {
      c.classList.remove('on');
    }

    // Shields
    if (s.shieldMax !== this._shieldPips) {
      this._shieldPips = s.shieldMax;
      $('shields').innerHTML = Array.from({ length: s.shieldMax }, () => '<i class="pip"></i>').join('');
    }
    const pips = $('shields').children;
    for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('spent', i >= s.shields);

    // Pulse charges
    if (s.pulseMax !== this._pulseDots) {
      this._pulseDots = s.pulseMax;
      $('pulses').innerHTML = Array.from({ length: s.pulseMax }, () => '<i class="pulse-dot"></i>').join('');
    }
    const dots = $('pulses').children;
    for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('spent', i >= s.pulses);

    // Overdrive meter
    const bar = $('odBar');
    $('odFill').style.width = `${Math.round(clamp01(s.overdrive) * 100)}%`;
    const ready = s.overdrive >= 1 && !s.overdriveActive;
    bar.classList.toggle('ready', ready);
    bar.classList.toggle('active', !!s.overdriveActive);
    $('odWrap').classList.toggle('ready', ready);

    // HuHu-down warning
    const down = $('huhuDown');
    const isDown = s.huhuDown > 0;
    if (isDown !== this._huhuDownOn) {
      this._huhuDownOn = isDown;
      down.classList.toggle('on', isDown);
    }
    if (isDown) $('huhuDownT').textContent = s.huhuDown.toFixed(1);
  }

  /** Power-up timers: `list` is [{ id, label, color, progress }]. */
  updatePowers(list) {
    const root = $('powers');
    const seen = new Set();
    for (const p of list) {
      seen.add(p.id);
      let el = this._powerEls.get(p.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'power';
        el.innerHTML = `<span class="nm"></span><span class="bar"><i></i></span>`;
        root.appendChild(el);
        this._powerEls.set(p.id, el);
      }
      el.style.color = p.color;
      el.querySelector('.nm').textContent = p.label;
      el.querySelector('.bar i').style.width = `${Math.round(clamp01(p.progress) * 100)}%`;
    }
    for (const [id, el] of this._powerEls) {
      if (!seen.has(id)) { el.remove(); this._powerEls.delete(id); }
    }
  }

  banner(big, small = '') {
    $('bannerBig').textContent = big;
    $('bannerSmall').textContent = small;
    const b = $('banner');
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
  }

  popScore() {
    const el = $('hudScore');
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }

  /** Floating "+120" at a screen position (0..1 normalised). */
  floater(text, nx, ny, color = 'var(--warn)') {
    const el = this.floaterPool.pop() ?? document.createElement('div');
    el.className = 'floater';
    el.textContent = text;
    el.style.color = color;
    el.style.left = `${clamp01(nx) * 100}%`;
    el.style.top = `${clamp01(ny) * 100}%`;
    $('floaters').appendChild(el);
    setTimeout(() => {
      el.remove();
      if (this.floaterPool.length < 24) this.floaterPool.push(el);
    }, 1000);
  }

  setFps(v) { $('fps').textContent = `${Math.round(v)} fps`; }

  /** Recolour the whole interface to match the current biome. */
  setAccent(acc, acc2) {
    document.documentElement.style.setProperty('--acc', acc);
    document.documentElement.style.setProperty('--acc2', acc2);
  }

  // ─── game over ─────────────────────────────────────────────────────────
  showGameOver(r) {
    $('ovScore').textContent = commas(r.score);
    $('ovDist').textContent = distanceLabel(r.distance);
    $('ovShards').textContent = commas(r.shards);
    $('ovCombo').textContent = `×${r.bestMultiplier}`;
    $('ovSpeed').textContent = `${Math.round(r.topSpeed)} u/s`;
    $('ovBest').textContent = commas(Save.data.hiScore);
    $('overTitle').textContent = r.beat.score ? 'New record' : 'Signal lost';
    $('overRecord').innerHTML = r.beat.score
      ? '<span class="record">◈ Personal best</span>'
      : r.beat.distance ? '<span class="record">◈ Furthest run</span>' : '';
    this.show('over');
  }

  _refreshMenuStats() {
    const d = Save.data;
    $('menuStats').textContent =
      `Best ${commas(d.hiScore)}  ·  Furthest ${distanceLabel(d.bestDistance)}  ·  ` +
      `Shards ${commas(d.shards)}  ·  Runs ${d.runs}`;
  }
}
