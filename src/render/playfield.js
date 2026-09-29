// 3D playfield renderer (Canvas 2D with manual perspective projection).
//
// Draws: animated tunnel background, the 3x3 grid border, notes flying toward the player
// (glowing rounded squares, pre-rendered sprites for speed), cursors with trails (player and/or
// МУХА), hit bursts and miss markers. The HUD is drawn by the screens (DOM overlay).
//
// frame = {
//   time,                       // song time (s)
//   notes: {t,x,y,n},           // packed notes
//   state,                      // Uint8Array: 0 pending, 1 hit, 2 miss (judge.state) — may be null
//   states?: [Uint8Array],      // versus mode: several judges; a note is hidden once hit in `state`
//   cursors: [{x, y, color, label, trail, main, ghost}],
//   events: [{type:'hit'|'miss', index, time, color?}],
//   energy: 0..1               // music energy for background pulse
// }

import { DEFAULT_SETTINGS, COLOR_SETS } from '../core/constants.js';

const TAU = Math.PI * 2;

export class Playfield {
  constructor(canvas, settings = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.w = 1; this.h = 1; this.dpr = 1;
    this.sprites = new Map();     // colour -> note sprite canvas
    this.particles = [];
    this.rings = [];
    this.missMarks = [];
    this.trails = new Map();      // cursor key -> [{x,y}]
    this.stars = [];
    this.flash = 0;
    this.flashColor = '#ffffff';
    this.lastTime = 0;
    this.shake = 0;
    this._initStars();
    this.setSettings(settings);
    this.resize();
  }

  setSettings(s) {
    this.settings = { ...DEFAULT_SETTINGS, ...s };
    const set = COLOR_SETS[this.settings.colorSet] || COLOR_SETS.Rhythia;
    this.colors = set;
    this.lowQuality = this.settings.quality === 'low';
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(this.lowQuality ? 1 : 2, window.devicePixelRatio || 1);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.dpr = dpr;
    const cw = Math.round(this.w * dpr), ch = Math.round(this.h * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    this._bg = null;
  }

  _initStars() {
    this.stars = [];
    for (let i = 0; i < 160; i++) {
      this.stars.push({ x: (Math.random() - 0.5) * 16 + 1, y: (Math.random() - 0.5) * 16 + 1, z: Math.random() * 40 });
    }
  }

  sprite(color) {
    let s = this.sprites.get(color);
    if (s) return s;
    const size = 160;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const pad = 28;
    const inner = size - pad * 2;
    const rad = inner * 0.2;
    // glow
    g.shadowColor = color;
    g.shadowBlur = 22;
    g.strokeStyle = color;
    g.lineWidth = inner * 0.11;
    roundRect(g, pad, pad, inner, inner, rad);
    g.stroke();
    g.shadowBlur = 0;
    // translucent fill
    g.fillStyle = hexA(color, 0.16);
    roundRect(g, pad, pad, inner, inner, rad);
    g.fill();
    // bright core line
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = inner * 0.025;
    roundRect(g, pad + inner * 0.03, pad + inner * 0.03, inner * 0.94, inner * 0.94, rad * 0.9);
    g.stroke();
    s = { canvas: c, size, inner };
    this.sprites.set(color, s);
    return s;
  }

  /** Projection parameters for the current frame. */
  _camera(frame) {
    const st = this.settings;
    const w = this.w, h = this.h;
    const S = Math.min(w, h) * 0.62 / 3;                 // pixels per grid unit on the hit plane
    const fov = Math.max(40, Math.min(110, st.fov || 70)) * Math.PI / 180;
    const D = (1.5 / Math.tan(fov / 2)) * 1.35;          // camera distance to the plane (grid units)
    const main = frame.cursors?.find((c) => c.main) || frame.cursors?.[0] || { x: 1, y: 1 };
    const p = st.spin ? 1 : Math.max(0, Math.min(1, st.parallax ?? 0.3));
    const camX = 1 + (main.x - 1) * p;
    const camY = 1 + (main.y - 1) * p;
    return { S, D, camX, camY, cx: w / 2, cy: h / 2 };
  }

  _proj(cam, x, y, z) {
    const k = cam.D / Math.max(0.05, z + cam.D);
    return { x: cam.cx + (x - cam.camX) * cam.S * k, y: cam.cy + (y - cam.camY) * cam.S * k, k };
  }

  draw(frame) {
    const ctx = this.ctx;
    const st = this.settings;
    const dt = Math.max(0, Math.min(0.1, (frame.realDt ?? 1 / 60)));
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const cam = this._camera(frame);
    if (this.shake > 0) {
      const a = this.shake * 6;
      ctx.translate((Math.random() - 0.5) * a, (Math.random() - 0.5) * a);
      this.shake = Math.max(0, this.shake - dt * 4);
    }
    this._drawBackground(ctx, cam, frame, dt);
    this._drawTunnel(ctx, cam, frame);
    this._drawGrid(ctx, cam, frame, dt);
    if (frame.events && frame.events.length) this._spawnEffects(cam, frame);
    if (frame.links && frame.links.length) this._drawLinks(ctx, cam, frame.links);
    this._drawNotes(ctx, cam, frame);
    this._drawEffects(ctx, cam, dt);
    this._drawCursors(ctx, cam, frame);
  }

  _drawBackground(ctx, cam, frame, dt) {
    const w = this.w, h = this.h;
    const e = Math.max(0, Math.min(1, frame.energy ?? 0.5));
    ctx.fillStyle = '#06050b';
    ctx.fillRect(-20, -20, w + 40, h + 40);
    // radial glow at the vanishing point, pulsing with music energy
    const vp = this._proj(cam, 1, 1, 60);
    const r = Math.max(w, h) * (0.55 + e * 0.25);
    const g = ctx.createRadialGradient(vp.x, vp.y, 0, vp.x, vp.y, r);
    const dim = 1 - (st(this).backgroundDim ?? 0.35);
    g.addColorStop(0, `rgba(${Math.round(60 + 70 * e)}, 20, ${Math.round(90 + 60 * e)}, ${0.55 * dim})`);
    g.addColorStop(0.45, `rgba(24, 12, 48, ${0.35 * dim})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // flying stars (depth streaks)
    if (!this.lowQuality) {
      const speed = (this.settings.approachRate || 30) * 0.35 * (0.6 + e);
      ctx.fillStyle = 'rgba(200, 190, 255, 0.55)';
      for (const s of this.stars) {
        s.z -= speed * dt;
        if (s.z < 0.2) { s.z = 40; s.x = (Math.random() - 0.5) * 16 + 1; s.y = (Math.random() - 0.5) * 16 + 1; }
        const p = this._proj(cam, s.x, s.y, s.z);
        if (p.x < 0 || p.y < 0 || p.x > w || p.y > h) continue;
        const size = Math.max(0.6, p.k * 2.2);
        ctx.globalAlpha = Math.min(1, (40 - s.z) / 30) * 0.8;
        ctx.fillRect(p.x, p.y, size, size);
      }
      ctx.globalAlpha = 1;
    }
  }

  _drawTunnel(ctx, cam, frame) {
    const st = this.settings;
    const far = st.approachDistance || 14;
    const lo = -0.5 - 0.15, hi = 2.5 + 0.15;
    const corners = [[lo, lo], [hi, lo], [hi, hi], [lo, hi]];
    ctx.lineWidth = 1;
    // converging edges
    ctx.strokeStyle = 'rgba(140, 120, 255, 0.10)';
    ctx.beginPath();
    for (const [x, y] of corners) {
      const a = this._proj(cam, x, y, 0), b = this._proj(cam, x, y, far * 1.6);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    // depth rings scrolling toward the player (motion cue synced with approach rate)
    const spacing = 3;
    const offset = ((frame.time || 0) * (st.approachRate || 30)) % spacing;
    for (let z = spacing - offset; z < far * 1.6; z += spacing) {
      const alpha = Math.max(0, 1 - z / (far * 1.6)) * 0.16;
      if (alpha <= 0.005) continue;
      const a = this._proj(cam, lo, lo, z), b = this._proj(cam, hi, hi, z);
      ctx.strokeStyle = `rgba(160, 140, 255, ${alpha})`;
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    }
  }

  _drawGrid(ctx, cam, frame, dt) {
    const lo = -0.5, hi = 2.5;
    const a = this._proj(cam, lo, lo, 0), b = this._proj(cam, hi, hi, 0);
    const size = b.x - a.x;
    // subtle cell guides
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      const p = this._proj(cam, lo + i, lo, 0), q = this._proj(cam, lo + i, hi, 0);
      ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y);
      const r = this._proj(cam, lo, lo + i, 0), s = this._proj(cam, hi, lo + i, 0);
      ctx.moveTo(r.x, r.y); ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();
    // border (flashes on hits)
    this.flash = Math.max(0, this.flash - dt * 6);
    const f = this.flash * 0.6;
    ctx.lineWidth = 2 + f * 1.5;
    ctx.strokeStyle = f > 0.02 ? mixHex('#8f82c8', this.flashColor, f) : 'rgba(184,168,255,0.5)';
    if (!this.lowQuality && f > 0.05) { ctx.shadowColor = this.flashColor; ctx.shadowBlur = 14 * f; }
    roundRect(ctx, a.x, a.y, size, size, size * 0.04);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  /** "Vision lines": what МУХА is planning — path through the next notes she looks at. */
  _drawLinks(ctx, cam, links) {
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1.5;
    for (const l of links) {
      const a = this._proj(cam, l.x1, l.y1, l.z1 || 0);
      const b = this._proj(cam, l.x2, l.y2, l.z2 || 0);
      ctx.globalAlpha = l.alpha ?? 0.5;
      ctx.strokeStyle = l.color || '#b6ff3b';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawNotes(ctx, cam, frame) {
    const notes = frame.notes;
    if (!notes || !notes.n) return;
    const st = this.settings;
    const AR = st.approachRate || 30;
    const far = st.approachDistance || 14;
    const fadeLen = far * (st.fadeIn ?? 0.35);
    const hw = st.hitWindow ?? 0.055;
    const time = frame.time;
    const state = frame.state;
    const opacity = st.noteOpacity ?? 1;
    const tFar = time + far / AR;
    const tNear = time - 0.25;
    // binary search first visible note
    let lo = 0, hi = notes.n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (notes.t[m] < tNear) lo = m + 1; else hi = m; }
    let end = lo;
    while (end < notes.n && notes.t[end] <= tFar) end++;
    const colors = this.colors;
    const noteSize = st.noteSize ?? 0.875;
    // far to near
    for (let i = end - 1; i >= lo; i--) {
      const s = state ? state[i] : 0;
      if (s === 1) continue; // hit notes vanish (burst effect drawn separately)
      const nt = notes.t[i];
      const z = (nt - time) * AR;
      let alpha = Math.min(1, Math.max(0, (far - z) / Math.max(0.01, fadeLen)));
      let color = colors[i % colors.length];
      if (z < 0) {
        // past the plane: keep flying toward the player, fading out
        const past = -z / AR;
        if (s === 2) {
          const since = time - (nt + hw);
          if (since > 0.18) continue;
          alpha *= Math.max(0, 1 - since / 0.18);
          color = '#ff4d6d';
        } else {
          alpha *= Math.max(0, 1 - past / (hw + 0.1));
        }
      }
      if (alpha <= 0.01) continue;
      const p = this._proj(cam, notes.x[i], notes.y[i], z);
      const spr = this.sprite(color);
      const px = noteSize * cam.S * p.k * (spr.size / spr.inner);
      ctx.globalAlpha = alpha * opacity;
      ctx.drawImage(spr.canvas, p.x - px / 2, p.y - px / 2, px, px);
    }
    ctx.globalAlpha = 1;
  }

  _spawnEffects(cam, frame) {
    const notes = frame.notes;
    for (const ev of frame.events) {
      const i = ev.index;
      if (i == null || !notes || i >= notes.n) continue;
      const p = this._proj(cam, notes.x[i], notes.y[i], 0);
      if (ev.type === 'hit') {
        const color = ev.color || this.colors[i % this.colors.length];
        this.rings.push({ wx: notes.x[i], wy: notes.y[i], t: 0, color });
        const n = this.lowQuality ? 5 : 12;
        for (let k = 0; k < n; k++) {
          const a = Math.random() * TAU;
          const sp = (0.8 + Math.random() * 2.2) * cam.S;
          this.particles.push({ x: p.x, y: p.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.35 + Math.random() * 0.25, age: 0, color, size: 2 + Math.random() * 2.5 });
        }
        if (!ev.silentFlash) { this.flash = 1; this.flashColor = color; }
      } else if (ev.type === 'miss') {
        this.missMarks.push({ wx: notes.x[i], wy: notes.y[i], t: 0 });
        if (ev.shake !== false) this.shake = Math.max(this.shake, 0.6);
      }
    }
    if (this.particles.length > 600) this.particles.splice(0, this.particles.length - 600);
  }

  _drawEffects(ctx, cam, dt) {
    const noteSize = this.settings.noteSize ?? 0.875;
    // rings
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      const k = r.t / 0.28;
      if (k >= 1) { this.rings.splice(i, 1); continue; }
      const p = this._proj(cam, r.wx, r.wy, 0);
      const size = noteSize * cam.S * (1 + k * 0.7);
      ctx.globalAlpha = (1 - k) * 0.9;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 3 * (1 - k) + 1;
      roundRect(ctx, p.x - size / 2, p.y - size / 2, size, size, size * 0.2);
      ctx.stroke();
    }
    // particles
    ctx.globalCompositeOperation = 'lighter';
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const q = this.particles[i];
      q.age += dt;
      if (q.age >= q.life) { this.particles.splice(i, 1); continue; }
      q.x += q.vx * dt; q.y += q.vy * dt;
      q.vx *= 1 - dt * 3; q.vy *= 1 - dt * 3;
      ctx.globalAlpha = 1 - q.age / q.life;
      ctx.fillStyle = q.color;
      ctx.fillRect(q.x - q.size / 2, q.y - q.size / 2, q.size, q.size);
    }
    ctx.globalCompositeOperation = 'source-over';
    // miss marks
    for (let i = this.missMarks.length - 1; i >= 0; i--) {
      const m = this.missMarks[i];
      m.t += dt;
      const k = m.t / 0.45;
      if (k >= 1) { this.missMarks.splice(i, 1); continue; }
      const p = this._proj(cam, m.wx, m.wy, 0);
      const s = noteSize * cam.S * 0.28 * (1 + k * 0.3);
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = '#ff4d6d';
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(p.x - s, p.y - s); ctx.lineTo(p.x + s, p.y + s);
      ctx.moveTo(p.x + s, p.y - s); ctx.lineTo(p.x - s, p.y + s);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  _drawCursors(ctx, cam, frame) {
    const cursors = frame.cursors || [];
    const st = this.settings;
    cursors.forEach((c, idx) => {
      const key = c.label || String(idx);
      const p = this._proj(cam, c.x, c.y, 0);
      const color = c.color || '#ffffff';
      // trail
      if (c.trail !== false && st.cursorTrail !== false) {
        let tr = this.trails.get(key);
        if (!tr) { tr = []; this.trails.set(key, tr); }
        tr.push({ x: c.x, y: c.y });
        const maxLen = this.lowQuality ? 6 : 14;
        while (tr.length > maxLen) tr.shift();
        if (tr.length > 1) {
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          for (let i = 1; i < tr.length; i++) {
            const a = this._proj(cam, tr[i - 1].x, tr[i - 1].y, 0);
            const b = this._proj(cam, tr[i].x, tr[i].y, 0);
            const k = i / tr.length;
            ctx.globalAlpha = k * 0.55 * (c.ghost ? 0.6 : 1);
            ctx.strokeStyle = color;
            ctx.lineWidth = cam.S * 0.11 * k;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
        }
      }
      // body
      const r = cam.S * 0.085;
      ctx.globalAlpha = c.ghost ? 0.7 : 1;
      if (!this.lowQuality) { ctx.shadowColor = color; ctx.shadowBlur = 16; }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.45, 0, TAU);
      ctx.fill();
      if (c.fly) drawWings(ctx, p.x, p.y, r, color, frame.time);
      if (c.label) {
        ctx.font = `600 ${Math.max(10, Math.round(cam.S * 0.11))}px Rubik, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.9;
        ctx.fillText(c.label, p.x, p.y - r * 2.4);
      }
      ctx.globalAlpha = 1;
    });
  }
}

function st(pf) { return pf.settings; }

function drawWings(ctx, x, y, r, color, time) {
  // tiny flapping fly wings — МУХА's signature look
  const flap = Math.sin((time || 0) * 60) * 0.35;
  ctx.save();
  ctx.globalAlpha *= 0.55;
  ctx.fillStyle = 'rgba(220, 240, 255, 0.9)';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(x + side * r * 1.25, y - r * 0.6, r * 1.2, r * 0.55, side * (0.5 + flap), 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

export function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function hexA(hex, a) {
  const { r, g, b } = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

function hexRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function mixHex(a, b, t) {
  const A = hexRgb(a), B = hexRgb(b);
  const m = (x, y) => Math.round(x + (y - x) * t);
  return `rgb(${m(A.r, B.r)},${m(A.g, B.g)},${m(A.b, B.b)})`;
}
