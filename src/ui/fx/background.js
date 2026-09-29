// Animated neon backdrop for the menus.
//
// A perspective 3×3 grid tunnel (Rhythia's play field seen from the player's seat): depth frames
// rushing toward the camera, glowing rounded-square notes flying in on the beat, a МУХА cursor that
// "plays" them (hit rings + sparks), speed dust, twinkling stars and a slow mouse parallax.
//
// Pure Canvas 2D. Glows are pre-rendered once into sprites (no per-frame shadowBlur), the loop
// pauses itself when stopped / the tab is hidden, and it drops to low quality automatically if
// frames get slow.
//
//   const bg = new NeonBackdrop({ focusX: 0.66 });
//   parent.appendChild(bg.canvas); bg.start();  …  bg.stop();
//   bg.setClock(() => audio.songTime(), bpm)   // sync notes / pulses to music (optional)
//   bg.burst(x, y, ['#ffd43b'])                // screen-space particle explosion (px)

const TAU = Math.PI * 2;
const HIT_Z = 4;            // depth of the grid (hit plane) in world units
const NOTE_SIZE = 0.875;    // note side (grid units), same as the game
const GRID_HALF = 1.5;      // the 3×3 grid spans −1.5 … 1.5 (cell centres at −1, 0, 1)
const FRAME_HALF = 1.62;
const FRAME_GAP = 2.4;      // spacing of tunnel frames

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

export function hexToRgb(hex) {
  let s = String(hex || '#ffffff').trim().replace('#', '');
  if (s.startsWith('rgb')) {
    const m = s.match(/[\d.]+/g) || [255, 255, 255];
    return [+m[0], +m[1], +m[2]];
  }
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [255, 255, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgba = (rgb, a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
export function mixRgb(a, b, t) { return [lerp(a[0], b[0], t) | 0, lerp(a[1], b[1], t) | 0, lerp(a[2], b[2], t) | 0]; }

function rrect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---- sprites ---------------------------------------------------------------------------------

const spriteCache = new Map();

function noteSprite(color) {
  const key = 'n' + color;
  let s = spriteCache.get(key);
  if (s) return s;
  const size = 128, inner = 64, pad = (size - inner) / 2, r = inner * 0.22;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const rgb = hexToRgb(color);
  g.shadowColor = color;
  g.shadowBlur = 20;
  g.strokeStyle = color;
  g.lineWidth = inner * 0.13;
  rrect(g, pad, pad, inner, inner, r);
  g.stroke();
  g.stroke();
  g.shadowBlur = 0;
  g.fillStyle = rgba(rgb, 0.16);
  rrect(g, pad, pad, inner, inner, r);
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.7)';
  g.lineWidth = inner * 0.035;
  rrect(g, pad + 1, pad + 1, inner - 2, inner - 2, r * 0.95);
  g.stroke();
  s = { canvas: c, k: size / inner };
  spriteCache.set(key, s);
  return s;
}

function dotSprite(color) {
  const key = 'd' + color;
  let s = spriteCache.get(key);
  if (s) return s;
  const size = 48;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const rgb = hexToRgb(color);
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, rgba(rgb, 0.95));
  grd.addColorStop(0.45, rgba(rgb, 0.35));
  grd.addColorStop(1, rgba(rgb, 0));
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  s = { canvas: c };
  spriteCache.set(key, s);
  return s;
}

// ---- backdrop --------------------------------------------------------------------------------

export class NeonBackdrop {
  /**
   * @param {object} o
   *  quality 'high'|'low', intensity 0..1 (speed/brightness), notes, cursor, tunnel, dust, stars,
   *  focusX/focusY (vanishing point as a fraction of the canvas), gridScale, bpm,
   *  colors [pink, cyan] note colours, accent (tunnel tint), vignette 0..1
   */
  constructor(o = {}) {
    this.o = {
      quality: 'high', intensity: 1, notes: true, cursor: true, tunnel: true, dust: true, stars: true,
      focusX: 0.5, focusY: 0.5, gridScale: 1, bpm: 120, colors: ['#ff3d9a', '#43e8ff'], accent: '#8b5cf6',
      vignette: 0.85, density: 1, ...o,
    };
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fx-backdrop';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.w = 1; this.h = 1; this.dpr = 1;
    this.running = false;
    this.time = 0;              // internal clock (s)
    this.clock = null;          // optional external song clock
    this.lastSong = null;
    this.pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    this.cam = { x: 0, y: 0, roll: 0 };
    this.notes = [];
    this.rings = [];
    this.sparks = [];           // world-plane sparks (screen px)
    this.bursts = [];           // screen-space burst particles
    this.trail = [];
    this.flash = 0;
    this.flashRgb = [255, 255, 255];
    this.pulse = 0;
    this.slot = null;           // next half-beat slot to schedule
    this.lastPos = { x: 0, y: 0 };
    this.colorIdx = 0;
    this.perf = { acc: 0, n: 0, slowStrikes: 0 };
    this.reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this._accent = hexToRgb(this.o.accent);
    this._accentTarget = this._accent.slice();
    this._frame = (ts) => this._tick(ts);
    this._onMove = (e) => {
      const r = this.canvas.getBoundingClientRect();
      if (!r.width) return;
      this.pointer.tx = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
      this.pointer.ty = clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1);
    };
    this._onVis = () => { if (!document.hidden && this.running) this._last = performance.now(); };
    this._initField();
  }

  _initField() {
    const hi = this.o.quality !== 'low';
    this.stars = [];
    const ns = hi ? 140 : 60;
    for (let i = 0; i < ns; i++) {
      this.stars.push({ x: Math.random(), y: Math.random(), s: Math.random() < 0.12 ? 2 : 1, p: Math.random() * TAU, sp: 0.5 + Math.random() * 2, d: 0.3 + Math.random() * 0.7 });
    }
    this.dust = [];
    const nd = hi ? 110 : 36;
    for (let i = 0; i < nd; i++) this.dust.push(this._newDust(true));
  }

  _newDust(anyZ) {
    const a = Math.random() * TAU;
    const r = 2.1 + Math.pow(Math.random(), 0.7) * 9;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r * 0.8, z: anyZ ? 0.6 + Math.random() * 60 : 50 + Math.random() * 12, c: Math.random() < 0.5 ? 0 : 1 };
  }

  // ---- public API ------------------------------------------------------------------------------

  mount(parent) { parent.appendChild(this.canvas); this.resize(); return this; }

  start() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    window.addEventListener('pointermove', this._onMove, { passive: true });
    document.addEventListener('visibilitychange', this._onVis);
    this.resize();
    this._raf = requestAnimationFrame(this._frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    window.removeEventListener('pointermove', this._onMove);
    document.removeEventListener('visibilitychange', this._onVis);
  }

  destroy() { this.stop(); this.canvas.remove(); }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const hi = this.o.quality !== 'low';
    const dpr = Math.min(hi ? 1.5 : 1, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width || this.canvas.parentElement?.clientWidth || 1));
    const h = Math.max(1, Math.round(r.height || this.canvas.parentElement?.clientHeight || 1));
    const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    this.w = w; this.h = h; this.dpr = dpr;
    this._vign = null;
  }

  /** Update options on the fly (focus, intensity, colours, …). */
  set(opts) {
    const qChanged = opts.quality && opts.quality !== this.o.quality;
    Object.assign(this.o, opts);
    if (opts.accent) this._accentTarget = hexToRgb(opts.accent);
    if (qChanged) { this._initField(); this.resize(); }
    if (opts.focusX != null || opts.focusY != null) this._vign = null;
  }

  setAccent(color) { this._accentTarget = hexToRgb(color); }

  /** Sync the beat grid to an external clock (e.g. menu music). Pass null to go back to the internal clock. */
  setClock(fn, bpm) {
    this.clock = fn || null;
    if (bpm) this.o.bpm = bpm;
    this._resync();
  }

  kick(amount = 1) { this.pulse = Math.max(this.pulse, amount); }

  /** Screen-space particle explosion at (x, y) in CSS pixels relative to the canvas. */
  burst(x, y, colors = ['#ff3d9a', '#43e8ff'], n = 70, power = 1) {
    const hi = this.o.quality !== 'low';
    n = hi ? n : Math.round(n * 0.4);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = (140 + Math.random() * 520) * power;
      this.bursts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80 * power, life: 0.7 + Math.random() * 0.9, age: 0, c: colors[i % colors.length], s: 5 + Math.random() * 12 });
    }
    if (!this.running) this.start();
  }

  // ---- simulation ------------------------------------------------------------------------------

  _songTime() {
    if (this.clock) {
      const t = this.clock();
      if (t != null && Number.isFinite(t)) {
        if (this.lastSong != null && t < this.lastSong - 0.5) this._resync();
        this.lastSong = t;
        return t;
      }
    }
    return this.time;
  }

  _resync() {
    this.notes.length = 0;
    this.slot = null;
    this.lastSong = null;
  }

  _speed() {
    const i = clamp(this.o.intensity, 0.1, 1.5);
    return (this.reduced ? 7 : 17) * (0.55 + 0.45 * i);
  }

  _schedule(song) {
    if (!this.o.notes) return;
    const spb = 60 / (this.o.bpm || 120);
    const half = spb / 2;
    const travel = 26 / this._speed();
    if (this.slot == null) this.slot = Math.ceil((song + 0.2) / half);
    const dens = clamp(this.o.density * (0.55 + 0.45 * this.o.intensity), 0.1, 1.5);
    while (this.slot * half <= song + travel) {
      const k = this.slot++;
      const onBeat = k % 2 === 0;
      const bar = k % 16;
      let p = onBeat ? 0.8 : 0.28;
      if (bar >= 12 && !onBeat) p = 0.6;               // little stream at the end of each bar
      if (Math.random() > p * dens) continue;
      this._placeNote(k * half);
    }
  }

  _placeNote(ta) {
    const last = this.lastPos;
    let x, y, tries = 0;
    do {
      x = Math.floor(Math.random() * 3) - 1;
      y = Math.floor(Math.random() * 3) - 1;
      tries++;
    } while (tries < 8 && (x === last.x && y === last.y));
    if (Math.random() < 0.22) { x += (Math.random() - 0.5) * 0.7; y += (Math.random() - 0.5) * 0.7; }
    x = clamp(x, -1.2, 1.2); y = clamp(y, -1.2, 1.2);
    this.lastPos = { x, y };
    const colors = this.o.colors;
    const color = colors[this.colorIdx++ % colors.length];
    this.notes.push({ x, y, ta, color, hit: false });
  }

  _cursorAt(song) {
    // МУХА aims ahead: glide from the previous note to the next one, arriving a bit early.
    let prev = null, next = null;
    for (const n of this.notes) {
      if (n.ta <= song) prev = n;
      else { next = n; break; }
    }
    const from = prev ? prev : (this._lastHit || { x: 0, y: 0, ta: song - 1 });
    if (!next) return { x: from.x, y: from.y };
    const span = Math.max(0.05, next.ta - from.ta);
    const u = smooth(clamp((song - from.ta) / (span * 0.78), 0, 1));
    const wob = Math.sin(this.time * 31) * 0.012;
    return { x: lerp(from.x, next.x, u) + wob, y: lerp(from.y, next.y, u) - wob };
  }

  // ---- render loop -----------------------------------------------------------------------------

  _tick(ts) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._frame);
    const dt = clamp((ts - (this._last || ts)) / 1000, 0, 0.05);
    this._last = ts;
    if (document.hidden) return;
    const t0 = performance.now();
    this.time += dt;
    this._draw(dt);
    this._watchPerf(performance.now() - t0, dt);
  }

  _watchPerf(ms) {
    const p = this.perf;
    p.acc += ms; p.n++;
    if (p.n >= 90) {
      const avg = p.acc / p.n;
      p.acc = 0; p.n = 0;
      if (avg > 14 && this.o.quality !== 'low') {
        p.slowStrikes++;
        if (p.slowStrikes >= 2) this.set({ quality: 'low' });
      } else p.slowStrikes = 0;
    }
  }

  _draw(dt) {
    const ctx = this.ctx, o = this.o, W = this.w, H = this.h;
    const hi = o.quality !== 'low';
    const song = this._songTime();
    const speed = this._speed();

    // pointer / camera easing
    const P = this.pointer;
    const ease = 1 - Math.exp(-dt * 2.2);
    P.x += (P.tx - P.x) * ease;
    P.y += (P.ty - P.y) * ease;
    const sway = this.reduced ? 0 : 1;
    this.cam.x += ((P.x * 0.75 + Math.sin(this.time * 0.23) * 0.25 * sway) - this.cam.x) * ease;
    this.cam.y += ((P.y * 0.5 + Math.cos(this.time * 0.19) * 0.18 * sway) - this.cam.y) * ease;
    this.cam.roll += ((P.x * 0.05 + Math.sin(this.time * 0.13) * 0.035 * sway) - this.cam.roll) * ease;
    for (let i = 0; i < 3; i++) this._accent[i] += (this._accentTarget[i] - this._accent[i]) * Math.min(1, dt * 3);
    const acc = this._accent.map((v) => v | 0);

    // beat pulse
    const bpm = o.bpm || 120;
    const beat = song * bpm / 60;
    const frac = beat - Math.floor(beat);
    const beatPulse = Math.exp(-frac * 5) * (this.clock ? 1 : 0.7);
    this.pulse = Math.max(this.pulse * Math.exp(-dt * 4), beatPulse * o.intensity);
    this.flash = Math.max(0, this.flash - dt * 3);

    // projection
    const S = Math.min(W, H);
    const gridPx = S * 0.2 * o.gridScale * (1 + this.pulse * 0.015);
    const f = gridPx * HIT_Z / GRID_HALF;
    const vx = W * o.focusX + P.x * W * 0.02;
    const vy = H * o.focusY + P.y * H * 0.02;
    const cr = Math.cos(this.cam.roll), sr = Math.sin(this.cam.roll);
    const cx = this.cam.x, cy = this.cam.y;
    const proj = (x, y, z) => {
      const s = f / z;
      const dx = x - cx, dy = y - cy;
      return [vx + (dx * cr - dy * sr) * s, vy + (dx * sr + dy * cr) * s, s];
    };

    // ---- background
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#07060d';
    ctx.fillRect(0, 0, W, H);
    const R = Math.max(W, H);
    let g = ctx.createRadialGradient(vx, vy, 0, vx, vy, R * 0.75);
    g.addColorStop(0, rgba(mixRgb([40, 14, 70], acc, 0.25), 0.95));
    g.addColorStop(0.35, 'rgba(22,12,44,0.75)');
    g.addColorStop(1, 'rgba(7,6,13,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // stars
    if (o.stars) {
      ctx.fillStyle = '#d8d0ff';
      for (const s of this.stars) {
        const a = (0.25 + 0.55 * (0.5 + 0.5 * Math.sin(this.time * s.sp + s.p))) * s.d;
        ctx.globalAlpha = a;
        const x = s.x * W - this.cam.x * 14 * s.d, y = s.y * H - this.cam.y * 10 * s.d;
        ctx.fillRect(x, y, s.s, s.s);
      }
      ctx.globalAlpha = 1;
    }

    ctx.globalCompositeOperation = 'lighter';

    // bloom behind the grid
    {
      const [gx, gy] = proj(0, 0, HIT_Z * 3.5);
      const rr = gridPx * (2.6 + this.pulse * 0.5);
      g = ctx.createRadialGradient(gx, gy, 0, gx, gy, rr);
      g.addColorStop(0, rgba(acc, 0.22 * (0.6 + 0.4 * o.intensity) + this.pulse * 0.08));
      g.addColorStop(1, rgba(acc, 0));
      ctx.fillStyle = g;
      ctx.fillRect(gx - rr, gy - rr, rr * 2, rr * 2);
    }

    // ---- tunnel
    if (o.tunnel) {
      const far = 64;
      // rails
      const c = FRAME_HALF;
      const rails = [[-c, -c], [c, -c], [c, c], [-c, c], [-c / 3, -c], [c / 3, -c], [-c / 3, c], [c / 3, c], [-c, -c / 3], [-c, c / 3], [c, -c / 3], [c, c / 3]];
      ctx.lineWidth = 1;
      rails.forEach(([x, y], i) => {
        const [ax, ay] = proj(x, y, 0.9);
        const [bx, by] = proj(x, y, far);
        const lg = ctx.createLinearGradient(ax, ay, bx, by);
        const base = i < 4 ? 0.3 : 0.1;
        lg.addColorStop(0, rgba(acc, 0));
        lg.addColorStop(0.08, rgba(acc, base * (0.7 + this.pulse * 0.6)));
        lg.addColorStop(1, rgba(acc, 0));
        ctx.strokeStyle = lg;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      });
      // frames rushing toward the camera
      const phase = (song * speed) % FRAME_GAP;
      const nFrames = hi ? 24 : 12;
      for (let k = -2; k < nFrames; k++) {
        const z = HIT_Z + k * FRAME_GAP - phase;
        if (z < 0.7) continue;
        let a;
        if (z < HIT_Z) a = smooth(clamp((z - 0.7) / (HIT_Z - 0.7), 0, 1)) * 0.35;
        else a = Math.pow(1 - clamp((z - HIT_Z) / (nFrames * FRAME_GAP), 0, 1), 1.6) * 0.42;
        a *= 0.55 + 0.45 * o.intensity;
        if (k === 0 || k === 1) a += this.pulse * 0.25;
        if (a < 0.01) continue;
        const [x0, y0, s0] = proj(0, 0, z);
        const half = FRAME_HALF * s0;
        ctx.save();
        ctx.translate(x0, y0);
        ctx.rotate(this.cam.roll);
        ctx.strokeStyle = rgba(mixRgb(acc, [120, 220, 255], clamp((z - HIT_Z) / 40, 0, 1)), a);
        ctx.lineWidth = Math.max(0.6, 2.2 * s0 / (f / HIT_Z));
        rrect(ctx, -half, -half, half * 2, half * 2, half * 0.12);
        ctx.stroke();
        ctx.restore();
      }
    }

    // ---- dust (speed streaks)
    if (o.dust) {
      const pk = [hexToRgb(o.colors[0]), hexToRgb(o.colors[1] || o.colors[0])];
      ctx.lineWidth = hi ? 1.4 : 1;
      for (let i = 0; i < this.dust.length; i++) {
        const d = this.dust[i];
        d.z -= speed * 1.7 * dt;
        if (d.z < 0.6) { this.dust[i] = this._newDust(false); continue; }
        const [ax, ay] = proj(d.x, d.y, d.z);
        if (ax < -50 || ay < -50 || ax > W + 50 || ay > H + 50) continue;
        const a = clamp(1 - d.z / 60, 0, 1) * 0.55 * (0.5 + 0.5 * o.intensity);
        if (hi) {
          const [bx, by] = proj(d.x, d.y, d.z + 0.8 + speed * 0.05);
          ctx.strokeStyle = rgba(pk[d.c], a);
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
        } else {
          ctx.fillStyle = rgba(pk[d.c], a);
          ctx.fillRect(ax, ay, 2, 2);
        }
      }
    }

    // ---- notes
    this._schedule(song);
    const travelZ = 26;
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i];
      if (!n.hit && n.ta <= song) {
        n.hit = true;
        this._lastHit = n;
        this._onHit(n, proj, f);
      }
      if (n.hit && song - n.ta > 1) this.notes.splice(i, 1);
    }
    // far → near
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i];
      if (n.hit) continue;
      const z = HIT_Z + (n.ta - song) * speed;
      if (z > HIT_Z + travelZ) continue;
      const fade = clamp((HIT_Z + travelZ - z) / (travelZ * 0.35), 0, 1);
      const [px, py, s] = proj(n.x, n.y, z);
      const spr = noteSprite(n.color);
      const size = NOTE_SIZE * s * spr.k;
      ctx.globalAlpha = fade * (0.55 + 0.45 * o.intensity);
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(this.cam.roll);
      ctx.drawImage(spr.canvas, -size / 2, -size / 2, size, size);
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    // ---- the grid (hit plane)
    if (o.tunnel) {
      const [gx, gy, gs] = proj(0, 0, HIT_Z);
      const half = GRID_HALF * gs;
      ctx.save();
      ctx.translate(gx, gy);
      ctx.rotate(this.cam.roll);
      const fl = this.flash;
      const col = mixRgb([190, 175, 255], this.flashRgb, fl);
      // soft wide glow
      ctx.strokeStyle = rgba(col, 0.1 + fl * 0.2 + this.pulse * 0.08);
      ctx.lineWidth = 10;
      rrect(ctx, -half, -half, half * 2, half * 2, half * 0.08);
      ctx.stroke();
      ctx.strokeStyle = rgba(col, 0.55 + fl * 0.4);
      ctx.lineWidth = 2 + fl * 1.5;
      ctx.stroke();
      // faint cells
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 1; k < 3; k++) {
        const p = -half + (half * 2 * k) / 3;
        ctx.moveTo(p, -half); ctx.lineTo(p, half);
        ctx.moveTo(-half, p); ctx.lineTo(half, p);
      }
      ctx.stroke();
      ctx.restore();
    }

    // ---- hit rings & sparks
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      const k = r.t / 0.4;
      if (k >= 1) { this.rings.splice(i, 1); continue; }
      const [px, py, s] = proj(r.x, r.y, HIT_Z);
      const size = NOTE_SIZE * s * (1 + smooth(k) * 0.8);
      ctx.globalAlpha = (1 - k) * 0.9;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 3 * (1 - k) + 0.8;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(this.cam.roll);
      rrect(ctx, -size / 2, -size / 2, size, size, size * 0.22);
      ctx.stroke();
      ctx.restore();
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const q = this.sparks[i];
      q.age += dt;
      if (q.age >= q.life) { this.sparks.splice(i, 1); continue; }
      q.x += q.vx * dt; q.y += q.vy * dt;
      q.vx *= 1 - dt * 3.5; q.vy *= 1 - dt * 3.5;
      const k = 1 - q.age / q.life;
      ctx.globalAlpha = k;
      const spr = dotSprite(q.c);
      const s = q.s * (0.4 + 0.6 * k);
      ctx.drawImage(spr.canvas, q.x - s, q.y - s, s * 2, s * 2);
    }
    ctx.globalAlpha = 1;

    // ---- МУХА cursor
    if (o.cursor && o.notes) {
      const cp = this._cursorAt(song);
      const [px, py, s] = proj(cp.x, cp.y, HIT_Z);
      const tr = this.trail;
      tr.push(px, py);
      const maxPts = hi ? 26 : 10;
      while (tr.length > maxPts * 2) tr.splice(0, 2);
      if (tr.length >= 4) {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const n = tr.length / 2;
        for (let i = 1; i < n; i++) {
          const k = i / n;
          ctx.strokeStyle = rgba([255, 255, 255], k * 0.35);
          ctx.lineWidth = Math.max(1, s * 0.12 * k);
          ctx.beginPath();
          ctx.moveTo(tr[(i - 1) * 2], tr[(i - 1) * 2 + 1]);
          ctx.lineTo(tr[i * 2], tr[i * 2 + 1]);
          ctx.stroke();
        }
      }
      const spr = dotSprite('#ffffff');
      const r = s * 0.34;
      ctx.drawImage(spr.canvas, px - r, py - r, r * 2, r * 2);
      // tiny flapping wings — it's a fly after all
      const flap = Math.sin(this.time * 55) * 0.4;
      ctx.fillStyle = 'rgba(210,235,255,0.35)';
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(px + side * s * 0.1, py - s * 0.05, s * 0.1, s * 0.045, side * (0.55 + flap), 0, TAU);
        ctx.fill();
      }
    }

    // ---- screen-space bursts
    if (this.bursts.length) {
      for (let i = this.bursts.length - 1; i >= 0; i--) {
        const q = this.bursts[i];
        q.age += dt;
        if (q.age >= q.life) { this.bursts.splice(i, 1); continue; }
        q.vx *= 1 - dt * 2.2; q.vy = q.vy * (1 - dt * 2.2) + 260 * dt;
        q.x += q.vx * dt; q.y += q.vy * dt;
        const k = 1 - q.age / q.life;
        ctx.globalAlpha = k;
        const spr = dotSprite(q.c);
        const s = q.s * (0.5 + 0.5 * k);
        ctx.drawImage(spr.canvas, q.x - s, q.y - s, s * 2, s * 2);
      }
      ctx.globalAlpha = 1;
    }

    // ---- vignette
    ctx.globalCompositeOperation = 'source-over';
    if (o.vignette > 0) {
      if (!this._vign || this._vignKey !== `${W}x${H}:${o.vignette}`) {
        const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) * 0.62);
        vg.addColorStop(0, 'rgba(4,3,10,0)');
        vg.addColorStop(1, `rgba(4,3,10,${o.vignette})`);
        this._vign = vg;
        this._vignKey = `${W}x${H}:${o.vignette}`;
      }
      ctx.fillStyle = this._vign;
      ctx.fillRect(0, 0, W, H);
    }
  }

  _onHit(n, proj, f) {
    const hi = this.o.quality !== 'low';
    this.rings.push({ x: n.x, y: n.y, t: 0, color: n.color });
    this.flash = Math.min(1, 0.6 + 0.4 * this.o.intensity);
    this.flashRgb = hexToRgb(n.color);
    const [px, py, s] = proj(n.x, n.y, HIT_Z);
    const count = hi ? 10 : 4;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const sp = (0.8 + Math.random() * 2.4) * s;
      this.sparks.push({ x: px, y: py, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.35 + Math.random() * 0.3, age: 0, c: n.color, s: 3 + Math.random() * 4 });
    }
    if (this.sparks.length > 400) this.sparks.splice(0, this.sparks.length - 400);
  }
}
