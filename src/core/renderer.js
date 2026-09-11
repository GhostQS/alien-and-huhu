// ─── RENDERER ────────────────────────────────────────────────────────────────
// WebGL setup, the post chain, quality tiers and an adaptive perf governor.
//
// Post chain (high):  Render -> Bloom -> Output -> FXAA -> Grade
// Post chain (low):   Render -> Output -> Grade
//
// Grade is one custom pass doing chromatic aberration, scanlines, vignette,
// damage flash and glitch. Folding them together keeps it to a single blit.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { clamp } from './util.js';
import { Save } from './save.js';

// ─── grade shader ────────────────────────────────────────────────────────────
const GradeShader = {
  uniforms: {
    tDiffuse:    { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime:       { value: 0 },
    uAberration: { value: 0.0015 },  // base chromatic split
    uVignette:   { value: 0.55 },
    uScanline:   { value: 0.05 },
    uFlash:      { value: 0.0 },     // white/red damage flash
    uFlashColor: { value: new THREE.Color(1, 0.2, 0.35) },
    uGlitch:     { value: 0.0 },     // 0..1 — block displacement + RGB tear
    uSpeed:      { value: 0.0 },     // 0..1 — radial blur amount
    uDesat:      { value: 0.0 },     // 0..1 — drains colour on death
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2  uResolution;
    uniform float uTime, uAberration, uVignette, uScanline;
    uniform float uFlash, uGlitch, uSpeed, uDesat;
    uniform vec3  uFlashColor;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    void main() {
      vec2 uv = vUv;
      vec2 center = uv - 0.5;
      float r2 = dot(center, center);

      // Horizontal block tear — only when glitching, so it reads as an event.
      if (uGlitch > 0.001) {
        float band = floor(uv.y * 28.0);
        float n = hash(vec2(band, floor(uTime * 22.0)));
        float amt = step(1.0 - uGlitch * 0.55, n) * uGlitch;
        uv.x += (n - 0.5) * 0.10 * amt;
      }

      // Radial speed blur — a handful of taps toward the centre.
      vec3 col;
      if (uSpeed > 0.01) {
        vec3 acc = vec3(0.0);
        float total = 0.0;
        for (int i = 0; i < 6; i++) {
          float t = float(i) / 5.0;
          float scale = 1.0 - t * 0.055 * uSpeed;
          float w = 1.0 - t * 0.55;
          acc += texture2D(tDiffuse, center * scale + 0.5).rgb * w;
          total += w;
        }
        col = acc / total;
      } else {
        col = texture2D(tDiffuse, uv).rgb;
      }

      // Chromatic aberration, stronger toward the edges. Applied as an OFFSET
      // against the already-blurred colour: sampling tDiffuse directly here
      // would discard the radial blur on red and blue and leave a green smear.
      float ab = uAberration * (1.0 + r2 * 3.0) + uGlitch * 0.006;
      if (ab > 0.00001) {
        vec2 dir = normalize(center + 1e-6);
        float baseR = texture2D(tDiffuse, uv).r;
        float baseB = texture2D(tDiffuse, uv).b;
        col.r += texture2D(tDiffuse, uv + dir * ab).r - baseR;
        col.b += texture2D(tDiffuse, uv - dir * ab).b - baseB;
      }

      // Scanlines — subtle, sells the CRT/cyber read without hurting legibility.
      float sl = sin(uv.y * uResolution.y * 1.35) * 0.5 + 0.5;
      col *= 1.0 - uScanline * sl;

      // Vignette.
      col *= 1.0 - uVignette * smoothstep(0.18, 0.75, r2);

      // Desaturate (death).
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(col, vec3(luma), uDesat);

      // Damage flash.
      col = mix(col, uFlashColor, uFlash);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

// ─── quality tiers ───────────────────────────────────────────────────────────
export const QUALITY = {
  low:    { bloom: false, fxaa: false, maxDpr: 1.0,  shadow: false, bloomRes: 0.25, particles: 0.4, drawDistance: 0.7 },
  medium: { bloom: true,  fxaa: false, maxDpr: 1.35, shadow: false, bloomRes: 0.5,  particles: 0.7, drawDistance: 0.85 },
  high:   { bloom: true,  fxaa: true,  maxDpr: 2.0,  shadow: true,  bloomRes: 1.0,  particles: 1.0, drawDistance: 1.0 },
};

function detectTier() {
  const mem = navigator.deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (mobile && (mem <= 3 || cores <= 4)) return 'low';
  if (mobile) return 'medium';
  if (cores <= 4 || mem <= 4) return 'medium';
  return 'high';
}

// ─── renderer ────────────────────────────────────────────────────────────────
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;

    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: false,          // FXAA in post instead — cheaper with a composer
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    // Neutral (Khronos PBR) over ACES: ACES rolls saturated cyans and magentas
    // toward white, which is exactly where this palette lives. Neutral keeps the
    // neon hue intact right up to clipping.
    this.gl.toneMapping = THREE.NeutralToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.gl.shadowMap.enabled = false;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.setClearColor(0x05030f, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 600);

    this.tierName = Save.settings.quality === 'auto' ? detectTier() : Save.settings.quality;
    this.tier = QUALITY[this.tierName] ?? QUALITY.high;

    this.width = 1; this.height = 1; this.dpr = 1;
    this._buildComposer();
    this._observeSize();

    // Adaptive governor state.
    this._frameAccum = 0;
    this._frameCount = 0;
    this._slowStreak = 0;
    this._fastStreak = 0;
    this.fps = 60;
    this.autoQuality = Save.settings.quality === 'auto';
    this._ceilingTier = this.tierName;   // never auto-upgrade past the detected tier

    // Recovering from a lost context keeps a long session alive.
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.contextLost = true; });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this._buildComposer();
      // _resize() early-outs when the dimensions match what it last saw, so the
      // freshly rebuilt 1x1 composer would stay 1x1. Invalidate first.
      this.dpr = -1; this.width = -1; this.height = -1;
      this._resize();
    });
  }

  _buildComposer() {
    const t = this.tier;
    // EffectComposer.dispose() releases its own render targets but NOT the
    // passes', so rebuilding on every quality change leaked a full-screen
    // target plus a material each time.
    if (this.composer) {
      for (const pass of this.composer.passes) {
        pass.dispose?.();
        pass.material?.dispose?.();
      }
      this.composer.dispose?.();
    }

    // Half-float target keeps bloom from banding in the dark cyber palette.
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: 0,
    });
    this.composer = new EffectComposer(this.gl, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    if (t.bloom) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.62, 0.75, 0.72);
      this.composer.addPass(this.bloom);
    } else {
      this.bloom = null;
    }

    this.composer.addPass(new OutputPass());

    if (t.fxaa) {
      this.fxaa = new ShaderPass(FXAAShader);
      this.composer.addPass(this.fxaa);
    } else {
      this.fxaa = null;
    }

    this.grade = new ShaderPass(GradeShader);
    this.grade.renderToScreen = true;
    this.composer.addPass(this.grade);

    this.gl.shadowMap.enabled = t.shadow;
  }

  _observeSize() {
    const apply = () => this._resize();
    // The window `resize` event alone is not enough: the canvas can start life
    // in a zero-sized or hidden container and only gain a real box later.
    this._ro = new ResizeObserver(apply);
    this._ro.observe(document.documentElement);
    addEventListener('resize', apply);
    addEventListener('orientationchange', () => setTimeout(apply, 120));
    document.addEventListener('visibilitychange', apply);
    apply();
  }

  _resize() {
    let w = document.documentElement.clientWidth || window.innerWidth || 0;
    let h = document.documentElement.clientHeight || window.innerHeight || 0;
    // A hidden or not-yet-laid-out container reports 0. Rendering at 1x1 and
    // then scaling up looks broken on the first visible frame, so fall back to
    // a sane 16:9 until the ResizeObserver delivers a real box.
    if (w < 2 || h < 2) {
      w = this._forced?.w ?? 1280;
      h = this._forced?.h ?? 720;
    }
    const dpr = clamp(window.devicePixelRatio || 1, 1, this.tier.maxDpr);
    if (w === this.width && h === this.height && dpr === this.dpr) return;

    this.width = w; this.height = h; this.dpr = dpr;
    this.gl.setPixelRatio(dpr);
    this.gl.setSize(w, h, false);          // CSS sizing is owned by the stylesheet
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);

    this.camera.aspect = w / h;
    // A narrow FOV is what makes obstacles readable at reaction distance: at 62°
    // a barrier 25 units out is under 3% of screen height. Portrait needs more
    // vertical angle or the track disappears off the top of the phone.
    const portrait = h > w;
    this.baseFov = portrait ? 64 : 48;
    this.camera.fov = this.baseFov;
    this.camera.updateProjectionMatrix();

    if (this.bloom) this.bloom.setSize(w * this.tier.bloomRes, h * this.tier.bloomRes);
    if (this.fxaa) this.fxaa.material.uniforms.resolution.value.set(1 / (w * dpr), 1 / (h * dpr));
    this.grade.material.uniforms.uResolution.value.set(w * dpr, h * dpr);
    this.onResize?.(w, h, portrait, this.baseFov);
  }

  /** Dev/testing: pin a render size when the page has no real layout. */
  forceSize(w, h) {
    this._forced = { w, h };
    this.dpr = -1;
    this._resize();
  }

  setQuality(name) {
    this.autoQuality = name === 'auto';
    const resolved = this.autoQuality ? detectTier() : name;
    if (resolved === this.tierName) return;
    this.tierName = resolved;
    this.tier = QUALITY[resolved] ?? QUALITY.high;
    this._buildComposer();
    this.dpr = -1;               // force _resize to reapply pixel ratio
    this._resize();
  }

  /** Adaptive governor: drop a tier after a sustained stretch below ~48fps. */
  _governor(dt) {
    this._frameAccum += dt;
    this._frameCount++;
    if (this._frameAccum < 0.5) return;
    this.fps = this._frameCount / this._frameAccum;
    this._frameAccum = 0;
    this._frameCount = 0;
    if (!this.autoQuality) return;

    if (this.fps < 48) { this._slowStreak++; this._fastStreak = 0; }
    else if (this.fps > 58) { this._fastStreak++; this._slowStreak = 0; }
    else { this._slowStreak = 0; this._fastStreak = 0; }

    if (this._slowStreak >= 4) {
      this._slowStreak = 0;
      const next = this.tierName === 'high' ? 'medium' : this.tierName === 'medium' ? 'low' : null;
      if (next) this._applyTier(next, 'down');
    } else if (this._fastStreak >= 20 && this.tierName !== this._ceilingTier) {
      // Recover after a sustained comfortable stretch, so a single hitch during
      // load does not pin the whole session to a lower tier. The ceiling is the
      // tier we started at, so this can never overshoot the device's capability.
      this._fastStreak = 0;
      const up = this.tierName === 'low' ? 'medium' : 'high';
      this._applyTier(up, 'up');
    }
  }

  _applyTier(name, dir) {
    this.tierName = name;
    this.tier = QUALITY[name];
    this._buildComposer();
    this.dpr = -1;
    this._resize();
    this.onQualityChange?.(name, dir);
  }

  get grades() { return this.grade.material.uniforms; }

  render(dt, elapsed) {
    if (this.contextLost) return;
    this.grade.material.uniforms.uTime.value = elapsed;
    this.composer.render(dt);
    this._governor(dt);
  }

  /**
   * Dev helper: read the framebuffer back and hand it over as a JPEG data URL.
   * Needed because automated screenshots cannot capture a WebGL surface.
   */
  capture(w = 1280, h = 720, quality = 0.82) {
    const c = this.canvas;
    const gl = this.gl.getContext();
    // The drawing buffer is not preserved after compositing, so the frame must
    // be re-rendered inside this same task or readPixels returns cleared black.
    this.composer.render(1 / 60);
    const W = c.width, H = c.height;
    const px = new Uint8Array(4 * W * H);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const src = document.createElement('canvas');
    src.width = W; src.height = H;
    const img = src.getContext('2d').createImageData(W, H);
    for (let y = 0; y < H; y++) {                       // GL origin is bottom-left
      const s = (H - 1 - y) * W * 4;
      img.data.set(px.subarray(s, s + W * 4), y * W * 4);
    }
    src.getContext('2d').putImageData(img, 0, 0);
    // Fit the requested box while preserving the framebuffer's aspect. Without
    // this a portrait render squashed into a landscape box looks like a
    // rendering bug when it is only a stretched capture.
    const scale = Math.min(w / W, h / H);
    const outW = Math.max(1, Math.round(W * scale));
    const outH = Math.max(1, Math.round(H * scale));
    const out = document.createElement('canvas');
    out.width = outW; out.height = outH;
    const c2 = out.getContext('2d');
    c2.imageSmoothingQuality = 'high';
    c2.drawImage(src, 0, 0, outW, outH);
    return out.toDataURL('image/jpeg', quality);
  }
}
