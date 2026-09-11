// ─── PROCEDURAL TEXTURES ─────────────────────────────────────────────────────
// Every texture in the game is drawn here at boot with Canvas2D. No image files.
//
// All generators are cached by their full argument list, because the same panel
// or grid gets requested by many meshes and a CanvasTexture upload is not free.

import * as THREE from 'three';

const cache = new Map();
const key = (name, args) => name + ':' + JSON.stringify(args);

function memo(name, args, build) {
  const k = key(name, args);
  let t = cache.get(k);
  if (!t) { t = build(); cache.set(k, t); }
  return t;
}

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')];
}

function finish(c, { repeat = 1, srgb = true, aniso = 4 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

// ─── value noise ─────────────────────────────────────────────────────────────
function valueNoise(ctx, size, cells, alpha, seed = 1) {
  const rnd = (x, y) => {
    const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const step = size / cells;
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  const smooth = t => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = x / step, gy = y / step;
      const x0 = Math.floor(gx), y0 = Math.floor(gy);
      const fx = smooth(gx - x0), fy = smooth(gy - y0);
      const a = rnd(x0 % cells, y0 % cells);
      const b = rnd((x0 + 1) % cells, y0 % cells);
      const c = rnd(x0 % cells, (y0 + 1) % cells);
      const e = rnd((x0 + 1) % cells, (y0 + 1) % cells);
      const v = (a + (b - a) * fx) * (1 - fy) + (c + (e - c) * fx) * fy;
      const i = (y * size + x) * 4;
      const add = (v - 0.5) * 255 * alpha;
      d[i] += add; d[i + 1] += add; d[i + 2] += add;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ─── generators ──────────────────────────────────────────────────────────────

/**
 * Tech panel: dark plate, panel seams, a scatter of lit micro-detail.
 * The workhorse for buildings, obstacle bodies and track walls.
 */
export function techPanel({ base = '#0a0f24', line = '#16f2ff', lit = '#16f2ff',
                            density = 5, glow = 0.5, size = 512, seed = 3 } = {}) {
  return memo('techPanel', [base, line, lit, density, glow, size, seed], () => {
    const [c, g] = canvas(size);
    g.fillStyle = base;
    g.fillRect(0, 0, size, size);

    // Large plates
    const cell = size / density;
    g.strokeStyle = line;
    g.globalAlpha = 0.22;
    g.lineWidth = Math.max(1, size / 340);
    for (let i = 0; i <= density; i++) {
      const p = Math.round(i * cell) + 0.5;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, size); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(size, p); g.stroke();
    }

    // Sub-panel greebles — asymmetric so tiling reads as detail, not pattern.
    let s = seed * 977;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    g.globalAlpha = 0.14;
    for (let i = 0; i < density * density * 2; i++) {
      const x = Math.floor(rnd() * density) * cell;
      const y = Math.floor(rnd() * density) * cell;
      const w = cell * (0.2 + rnd() * 0.55);
      const h = cell * (0.12 + rnd() * 0.3);
      g.fillStyle = rnd() > 0.5 ? '#ffffff' : '#000000';
      g.fillRect(x + cell * 0.12, y + cell * 0.12, w, h);
    }

    // Lit strips
    g.globalAlpha = glow;
    g.fillStyle = lit;
    g.shadowColor = lit;
    g.shadowBlur = size / 26;
    for (let i = 0; i < density; i++) {
      if (rnd() > 0.55) continue;
      const x = Math.floor(rnd() * density) * cell;
      const y = Math.floor(rnd() * density) * cell;
      if (rnd() > 0.5) g.fillRect(x + cell * 0.14, y + cell * 0.44, cell * 0.72, Math.max(2, size / 200));
      else g.fillRect(x + cell * 0.44, y + cell * 0.14, Math.max(2, size / 200), cell * 0.72);
    }
    g.shadowBlur = 0;
    g.globalAlpha = 1;
    valueNoise(g, size, 32, 0.10, seed);
    return finish(c, { repeat: 1 });
  });
}

/** Emissive strip: a single bright bar with falloff. Used for edge lighting. */
export function stripGlow({ color = '#16f2ff', size = 128, softness = 0.42 } = {}) {
  return memo('stripGlow', [color, size, softness], () => {
    const [c, g] = canvas(size);
    g.fillStyle = '#000';
    g.fillRect(0, 0, size, size);
    const grad = g.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, '#000');
    grad.addColorStop(0.5 - softness / 2, color);
    grad.addColorStop(0.5, '#ffffff');
    grad.addColorStop(0.5 + softness / 2, color);
    grad.addColorStop(1, '#000');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return finish(c);
  });
}

/** Holographic scanline sheet — for signage, shields and force fields. */
export function holoSheet({ color = '#16f2ff', size = 256, lines = 48, glyphs = true } = {}) {
  return memo('holoSheet', [color, size, lines, glyphs], () => {
    const [c, g] = canvas(size);
    g.fillStyle = '#000';
    g.fillRect(0, 0, size, size);
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.globalAlpha = 0.5;
    const step = size / lines;
    for (let i = 0; i < lines; i++) {
      const y = i * step + 0.5;
      g.globalAlpha = 0.18 + (i % 4 === 0 ? 0.4 : 0.1);
      g.beginPath(); g.moveTo(0, y); g.lineTo(size, y); g.stroke();
    }
    if (glyphs) {
      // Fake data glyphs — unreadable on purpose, reads as "alien telemetry".
      g.globalAlpha = 0.55;
      g.fillStyle = color;
      let s = 11;
      const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
      for (let i = 0; i < 90; i++) {
        const x = rnd() * size, y = rnd() * size;
        const w = 3 + rnd() * 16, h = step * 0.5;
        g.fillRect(x, y, w, h);
      }
    }
    g.globalAlpha = 1;
    return finish(c);
  });
}

/** Ground grid — the signature cyber floor. Bright lines, dark cells. */
export function gridTexture({ bg = '#05030f', line = '#16f2ff', size = 512,
                              divisions = 8, thickness = 2, glow = 0.75, fade = false } = {}) {
  return memo('grid', [bg, line, size, divisions, thickness, glow, fade], () => {
    const [c, g] = canvas(size);
    g.fillStyle = bg;
    g.fillRect(0, 0, size, size);
    const step = size / divisions;
    g.strokeStyle = line;
    g.shadowColor = line;
    g.shadowBlur = thickness * 4 * glow;
    g.lineWidth = thickness;
    for (let i = 0; i <= divisions; i++) {
      const p = Math.round(i * step) + 0.5;
      g.globalAlpha = i % divisions === 0 ? 1 : 0.55;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, size); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(size, p); g.stroke();
    }
    g.shadowBlur = 0;
    g.globalAlpha = 1;
    return finish(c);
  });
}

/** Star field for the sky dome — clustered, with a few bright anchors. */
export function starField({ size = 1024, count = 900, color = '#dfeaff', seed = 5 } = {}) {
  return memo('stars', [size, count, color, seed], () => {
    const [c, g] = canvas(size);
    g.fillStyle = '#000';
    g.fillRect(0, 0, size, size);
    let s = seed * 7919;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < count; i++) {
      const x = rnd() * size, y = rnd() * size;
      const r = Math.pow(rnd(), 3.2) * 2.4 + 0.25;
      const a = 0.25 + rnd() * 0.75;
      g.globalAlpha = a;
      g.fillStyle = color;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      if (r > 1.9) {                        // bloom anchors
        g.globalAlpha = a * 0.35;
        g.beginPath(); g.arc(x, y, r * 3.5, 0, Math.PI * 2); g.fill();
      }
    }
    g.globalAlpha = 1;
    return finish(c, { repeat: 1 });
  });
}

/** Vertical gradient for sky domes / backdrops. */
export function gradientTexture(stops, { size = 256, vertical = true } = {}) {
  return memo('gradient', [stops, size, vertical], () => {
    const [c, g] = canvas(size);
    const grad = vertical
      ? g.createLinearGradient(0, 0, 0, size)
      : g.createLinearGradient(0, 0, size, 0);
    for (const [pos, col] of stops) grad.addColorStop(pos, col);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return finish(c, { repeat: 1 });
  });
}

/** Soft round blob — cheap fake shadow / light pool under characters. */
export function radialBlob({ color = '#000000', size = 128, power = 2.2 } = {}) {
  return memo('blob', [color, size, power], () => {
    const [c, g] = canvas(size);
    const img = g.createImageData(size, size);
    const d = img.data;
    const rgb = [
      parseInt(color.slice(1, 3), 16),
      parseInt(color.slice(3, 5), 16),
      parseInt(color.slice(5, 7), 16),
    ];
    const half = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x - half) / half, dy = (y - half) / half;
        const r = Math.min(1, Math.hypot(dx, dy));
        const a = Math.pow(1 - r, power);
        const i = (y * size + x) * 4;
        d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2];
        d[i + 3] = Math.round(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
    return finish(c, { repeat: 1 });
  });
}

/** Hex-cell shield pattern for force fields and barriers. */
export function hexShield({ color = '#16f2ff', size = 256, cells = 7 } = {}) {
  return memo('hex', [color, size, cells], () => {
    const [c, g] = canvas(size);
    g.fillStyle = '#000';
    g.fillRect(0, 0, size, size);
    const r = size / (cells * 1.5);
    const h = Math.sqrt(3) * r;
    g.strokeStyle = color;
    g.lineWidth = Math.max(1.4, size / 190);
    g.shadowColor = color;
    g.shadowBlur = size / 40;
    for (let row = -1; row < cells + 1; row++) {
      for (let col = -1; col < cells + 2; col++) {
        const cx = col * r * 1.5;
        const cy = row * h + (col % 2 ? h / 2 : 0);
        g.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI / 3) * i;
          const px = cx + r * 0.92 * Math.cos(a);
          const py = cy + r * 0.92 * Math.sin(a);
          i === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
        }
        g.closePath();
        g.globalAlpha = 0.4 + ((row * 7 + col * 3) % 5) * 0.1;
        g.stroke();
      }
    }
    g.shadowBlur = 0;
    g.globalAlpha = 1;
    return finish(c);
  });
}

/** Rough noise for surface variation on rock / organic geometry. */
export function noiseTexture({ size = 256, cells = 12, contrast = 0.6, base = '#808080', seed = 9 } = {}) {
  return memo('noise', [size, cells, contrast, base, seed], () => {
    const [c, g] = canvas(size);
    g.fillStyle = base;
    g.fillRect(0, 0, size, size);
    valueNoise(g, size, cells, contrast, seed);
    valueNoise(g, size, cells * 4, contrast * 0.5, seed + 1);
    return finish(c, { srgb: false });
  });
}

/** Text as a texture — used for holographic signage inside the world. */
export function textTexture(text, { color = '#16f2ff', bg = 'transparent', size = 512,
                                    height = 128, font = '700 68px ui-monospace, monospace',
                                    letterSpacing = '0.24em' } = {}) {
  return memo('text', [text, color, bg, size, height, font, letterSpacing], () => {
    const c = document.createElement('canvas');
    c.width = size; c.height = height;
    const g = c.getContext('2d');
    if (bg !== 'transparent') { g.fillStyle = bg; g.fillRect(0, 0, size, height); }
    g.font = font;
    if ('letterSpacing' in g) g.letterSpacing = letterSpacing;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = color;
    g.shadowBlur = 22;
    g.fillStyle = color;
    g.fillText(text, size / 2, height / 2);
    g.fillText(text, size / 2, height / 2);   // twice for a denser glow
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  });
}

export function disposeAll() {
  for (const t of cache.values()) t.dispose?.();
  cache.clear();
}
