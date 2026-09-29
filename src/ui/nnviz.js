// Live neural-network view of МУХА's brain.
//
// Layers are columns of nodes. Static edges show the weights (pink = positive, cyan = negative,
// opacity = magnitude) and are cached in an offscreen canvas; on top of that, every frame the
// "signal flow" (weight × incoming activation) of the strongest connections glows, and each node
// lights up with its live activation. Inputs are labelled with what МУХА actually observes, the two
// outputs are her desired velocity, also drawn as a small joystick.
//
//   const viz = new NNViz(canvas);
//   viz.setBrain(arch, params);
//   viz.draw(driver.activations);    // every animation frame

import { OBS_NOTES, NOTE_FEATS } from '../ai/agent.js';
import { tr } from './i18n.js';

const POS = '#ff3d9a';
const NEG = '#43e8ff';
const POS_RGB = [255, 61, 154];
const NEG_RGB = [67, 232, 255];
const INK = '#f1eeff';
const INK_DIM = '#a59fc7';
const INK_FAINT = '#6f6a92';

/** Human-readable groups of input features (matches Pilot.observe in agent.js). */
export function inputGroups(nInputs) {
  const expected = 5 + OBS_NOTES * NOTE_FEATS;
  if (nInputs !== expected) {
    return [{ title: tr('входы', 'inputs'), items: Array.from({ length: nInputs }, (_, i) => ({ short: `#${i + 1}`, long: tr(`вход ${i + 1}`, `input ${i + 1}`) })) }];
  }
  const groups = [{
    title: tr('рука МУХИ', 'МУХА\'s hand'),
    items: [
      { short: tr('скорость X', 'velocity X'), long: tr('скорость руки по X', 'hand velocity X') },
      { short: tr('скорость Y', 'velocity Y'), long: tr('скорость руки по Y', 'hand velocity Y') },
      { short: tr('позиция X', 'position X'), long: tr('позиция курсора по X', 'cursor position X') },
      { short: tr('позиция Y', 'position Y'), long: tr('позиция курсора по Y', 'cursor position Y') },
      { short: tr('константа', 'constant'), long: tr('константа 1 (смещение)', 'constant 1 (bias)') },
    ],
  }];
  for (let k = 1; k <= OBS_NOTES; k++) {
    groups.push({
      title: tr(`нота ${k}`, `note ${k}`),
      items: [
        { short: 'Δx', long: tr(`нота ${k}: Δx до курсора`, `note ${k}: Δx from cursor`) },
        { short: 'Δy', long: tr(`нота ${k}: Δy до курсора`, `note ${k}: Δy from cursor`) },
        { short: tr('время', 'time'), long: tr(`нота ${k}: через сколько прилетит`, `note ${k}: time until it arrives`) },
        { short: tr('срочность', 'urgency'), long: tr(`нота ${k}: срочность`, `note ${k}: urgency`) },
        { short: tr('шаг', 'step'), long: tr(`нота ${k}: шаг от предыдущей ноты`, `note ${k}: step from the previous note`) },
        { short: tr('нужн. vX', 'need vX'), long: tr(`нота ${k}: нужная скорость по X`, `note ${k}: required velocity X`) },
        { short: tr('нужн. vY', 'need vY'), long: tr(`нота ${k}: нужная скорость по Y`, `note ${k}: required velocity Y`) },
      ],
    });
  }
  return groups;
}

export function outputLabels() {
  return [
    { short: tr('↔ скорость', '↔ velocity'), long: tr('желаемая скорость по горизонтали', 'desired horizontal velocity') },
    { short: tr('↕ скорость', '↕ velocity'), long: tr('желаемая скорость по вертикали', 'desired vertical velocity') },
  ];
}

function glowSprite(rgb) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`);
  grd.addColorStop(0.28, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.55)`);
  grd.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return c;
}

export class NNViz {
  constructor(canvas, { tooltip = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tooltip = tooltip;         // optional DOM element for hover readouts
    this.arch = null;
    this.params = null;
    this.w = 1; this.h = 1; this.dpr = 1;
    this.edgeCache = null;
    this.layout = null;
    this.flowMax = [];              // smoothed per-layer max |flow| (avoids flicker)
    this.hover = null;
    this.spritePos = glowSprite(POS_RGB);
    this.spriteNeg = glowSprite(NEG_RGB);
    this.lastActs = null;
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
    });
    canvas.addEventListener('pointerleave', () => { this.hover = null; if (this.tooltip) this.tooltip.classList.remove('show'); });
    this.resize();
  }

  setBrain(arch, params) {
    const same = this.arch && arch && this.arch.length === arch.length && this.arch.every((v, i) => v === arch[i]);
    if (same && this.params === params) return;
    this.arch = arch.slice();
    this.params = params;
    this.groups = inputGroups(arch[0]);
    this.outs = outputLabels();
    this.layers = [];
    let off = 0;
    for (let l = 0; l < arch.length - 1; l++) {
      const nin = arch[l], nout = arch[l + 1];
      this.layers.push({ nin, nout, w: off, b: off + nin * nout });
      off += nin * nout + nout;
    }
    this.nParams = off;
    this.flowMax = this.layers.map(() => 0.5);
    if (!same) this.layout = null;
    this.edgeCache = null;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (w !== this.w || h !== this.h || dpr !== this.dpr) {
      this.w = w; this.h = h; this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.layout = null;
      this.edgeCache = null;
    }
  }

  _layout() {
    if (this.layout) return this.layout;
    const W = this.w, H = this.h, arch = this.arch;
    const labelsLeft = W >= 560 ? 132 : W >= 400 ? 70 : 38;
    const labelsRight = W >= 560 ? 128 : W >= 400 ? 84 : 64;
    const top = 30, bottom = 14;
    const xIn = labelsLeft + 8;
    const xOut = W - labelsRight - 8;
    const cols = arch.map((_, l) => xIn + (l / (arch.length - 1)) * (xOut - xIn));
    // inputs: grouped with gaps
    const nIn = arch[0];
    const nGroups = this.groups.length;
    const gap = Math.min(14, (H - top - bottom) * 0.04);
    const usable = H - top - bottom - gap * (nGroups - 1);
    const stepIn = usable / Math.max(1, nIn - 1 + 0.0001);
    const nodes = [];
    const inNodes = [];
    let y = top, idx = 0;
    const groupSpans = [];
    for (const g of this.groups) {
      const y0 = y;
      for (let k = 0; k < g.items.length; k++) {
        inNodes.push({ x: cols[0], y, label: g.items[k], group: g });
        idx++;
        if (k < g.items.length - 1) y += stepIn;
      }
      groupSpans.push({ title: g.title, y0, y1: y });
      y += stepIn + gap;
    }
    nodes.push(inNodes);
    for (let l = 1; l < arch.length; l++) {
      const n = arch[l];
      const isOut = l === arch.length - 1;
      const span = isOut ? Math.min(H - top - bottom, 150) : Math.min(H - top - bottom, n * Math.min(stepIn * 1.3, 16));
      const y0 = top + (H - top - bottom - span) / 2;
      const col = [];
      for (let i = 0; i < n; i++) col.push({ x: cols[l], y: n === 1 ? top + (H - top - bottom) / 2 : y0 + (i / (n - 1)) * span, label: isOut ? this.outs[i] || { short: `out ${i + 1}`, long: `out ${i + 1}` } : null });
      nodes.push(col);
    }
    const r = Math.max(2.2, Math.min(5.5, stepIn * 0.36));
    this.layout = { cols, nodes, r, top, labelsLeft, labelsRight, groupSpans, stepIn };
    return this.layout;
  }

  _buildEdges() {
    const lay = this._layout();
    const c = document.createElement('canvas');
    c.width = this.canvas.width; c.height = this.canvas.height;
    const g = c.getContext('2d');
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const p = this.params;
    const BUCKETS = 6;
    for (let l = 0; l < this.layers.length; l++) {
      const L = this.layers[l];
      const A = lay.nodes[l], B = lay.nodes[l + 1];
      // robust scale: 97th percentile of |w|
      const mags = new Float32Array(L.nin * L.nout);
      for (let i = 0; i < mags.length; i++) mags[i] = Math.abs(p[L.w + i]);
      const sorted = Float32Array.from(mags).sort();
      const scale = sorted[Math.floor(sorted.length * 0.97)] || 1;
      const paths = [];
      for (let s = 0; s < 2; s++) { paths.push([]); for (let b = 0; b < BUCKETS; b++) paths[s].push(new Path2D()); }
      for (let o = 0; o < L.nout; o++) {
        for (let i = 0; i < L.nin; i++) {
          const w = p[L.w + o * L.nin + i];
          const m = Math.min(1, Math.abs(w) / scale);
          if (m < 0.08) continue;
          const b = Math.min(BUCKETS - 1, Math.floor(m * BUCKETS));
          const path = paths[w >= 0 ? 0 : 1][b];
          path.moveTo(A[i].x, A[i].y);
          path.lineTo(B[o].x, B[o].y);
        }
      }
      g.lineWidth = 0.7;
      for (let s = 0; s < 2; s++) {
        for (let b = 0; b < BUCKETS; b++) {
          const k = (b + 1) / BUCKETS;
          g.strokeStyle = s === 0 ? `rgba(255,61,154,${0.025 + 0.2 * k * k})` : `rgba(67,232,255,${0.025 + 0.2 * k * k})`;
          g.stroke(paths[s][b]);
        }
      }
    }
    this.edgeCache = c;
  }

  /** @param {Float32Array[]} acts  MLP activation buffers (acts[0] = inputs) */
  draw(acts) {
    if (!this.arch || !this.params) return;
    const ctx = this.ctx;
    const lay = this._layout();
    if (!this.edgeCache) this._buildEdges();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.edgeCache, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const W = this.w;
    const ok = acts && acts.length === this.arch.length;
    this.lastActs = ok ? acts : null;

    // ---- signal flow: strongest weight × activation contributions glow
    if (ok) {
      const p = this.params;
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      const BK = 4;
      for (let l = 0; l < this.layers.length; l++) {
        const L = this.layers[l];
        const a = acts[l];
        const A = lay.nodes[l], B = lay.nodes[l + 1];
        let mx = 1e-6;
        for (let o = 0; o < L.nout; o++) {
          const row = L.w + o * L.nin;
          for (let i = 0; i < L.nin; i++) {
            const f = Math.abs(p[row + i] * a[i]);
            if (f > mx) mx = f;
          }
        }
        // smoothed normaliser (fast attack, slow release)
        this.flowMax[l] = mx > this.flowMax[l] ? mx : this.flowMax[l] * 0.97 + mx * 0.03;
        const norm = this.flowMax[l];
        const paths = [[], []];
        for (let s = 0; s < 2; s++) for (let b = 0; b < BK; b++) paths[s].push(new Path2D());
        for (let o = 0; o < L.nout; o++) {
          const row = L.w + o * L.nin;
          for (let i = 0; i < L.nin; i++) {
            const f = p[row + i] * a[i];
            const m = Math.abs(f) / norm;
            if (m < 0.3) continue;
            const b = Math.min(BK - 1, Math.floor(((m - 0.3) / 0.7) * BK));
            const path = paths[f >= 0 ? 0 : 1][b];
            path.moveTo(A[i].x, A[i].y);
            path.lineTo(B[o].x, B[o].y);
          }
        }
        for (let s = 0; s < 2; s++) {
          for (let b = 0; b < BK; b++) {
            const k = (b + 1) / BK;
            ctx.lineWidth = 0.8 + k * 1.4;
            ctx.strokeStyle = s === 0 ? `rgba(255,61,154,${0.18 + 0.5 * k})` : `rgba(67,232,255,${0.18 + 0.5 * k})`;
            ctx.stroke(paths[s][b]);
          }
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // ---- nodes
    const r = lay.r;
    for (let l = 0; l < lay.nodes.length; l++) {
      const col = lay.nodes[l];
      const a = ok ? acts[l] : null;
      const isOut = l === lay.nodes.length - 1;
      const rr = isOut ? r * 1.9 : r;
      for (let i = 0; i < col.length; i++) {
        const n = col[i];
        const v = a ? a[i] : 0;
        const m = Math.min(1, Math.abs(v));
        if (m > 0.04) {
          const spr = v >= 0 ? this.spritePos : this.spriteNeg;
          const gs = rr * (3.2 + 2.2 * m);
          ctx.globalAlpha = 0.25 + 0.75 * m;
          ctx.drawImage(spr, n.x - gs, n.y - gs, gs * 2, gs * 2);
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = '#0b0916';
        ctx.beginPath(); ctx.arc(n.x, n.y, rr, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = v >= 0 ? `rgba(255,61,154,${0.25 + 0.75 * m})` : `rgba(67,232,255,${0.25 + 0.75 * m})`;
        ctx.beginPath(); ctx.arc(n.x, n.y, rr * 0.72, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(200,190,255,0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(n.x, n.y, rr, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // ---- labels
    ctx.textBaseline = 'middle';
    const wide = W >= 560, mid = W >= 400;
    // column headers
    ctx.font = '600 11px Rubik, system-ui, sans-serif';
    ctx.fillStyle = INK_DIM;
    ctx.textAlign = 'center';
    const heads = this.arch.map((n, l) => (l === 0 ? tr(`входы · ${n}`, `inputs · ${n}`) : l === this.arch.length - 1 ? tr(`выходы · ${n}`, `outputs · ${n}`) : tr(`слой ${l} · ${n}`, `layer ${l} · ${n}`)));
    for (let l = 0; l < heads.length; l++) {
      if (!mid && l > 0 && l < heads.length - 1) continue;
      let x = lay.cols[l];
      const tw = ctx.measureText(heads[l]).width;
      x = Math.max(tw / 2 + 2, Math.min(W - tw / 2 - 2, x));
      ctx.fillText(heads[l], x, 11);
    }
    // input labels
    const inCol = lay.nodes[0];
    if (mid) {
      ctx.textAlign = 'right';
      for (let i = 0; i < inCol.length; i++) {
        const n = inCol[i];
        const v = ok ? acts[0][i] : 0;
        ctx.font = (wide ? '10.5px' : '9.5px') + ' Rubik, system-ui, sans-serif';
        ctx.fillStyle = Math.abs(v) > 0.35 ? INK : INK_FAINT;
        ctx.fillText(n.label.short, n.x - r - 6, n.y);
      }
    }
    // group brackets / titles
    ctx.font = '600 10px Rubik, system-ui, sans-serif';
    for (const g of lay.groupSpans) {
      const x = mid ? (wide ? 12 : 4) : 4;
      ctx.strokeStyle = 'rgba(165,150,230,0.28)';
      ctx.lineWidth = 1;
      if (wide) {
        ctx.beginPath();
        ctx.moveTo(x + 4, g.y0 - 2); ctx.lineTo(x, g.y0 - 2); ctx.lineTo(x, g.y1 + 2); ctx.lineTo(x + 4, g.y1 + 2);
        ctx.stroke();
        ctx.save();
        ctx.translate(x - 4, (g.y0 + g.y1) / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillStyle = INK_DIM;
        ctx.fillText(g.title, 0, 0);
        ctx.restore();
      } else if (!mid) {
        ctx.textAlign = 'left';
        ctx.fillStyle = INK_DIM;
        ctx.fillText(g.title.replace(/[^0-9]/g, '') ? '♪' + g.title.replace(/[^0-9]/g, '') : '✋', x, (g.y0 + g.y1) / 2);
      }
    }
    // outputs: labels + values + joystick
    const outCol = lay.nodes[lay.nodes.length - 1];
    ctx.textAlign = 'left';
    for (let i = 0; i < outCol.length; i++) {
      const n = outCol[i];
      const v = ok ? acts[acts.length - 1][i] : 0;
      ctx.font = '600 11px Rubik, system-ui, sans-serif';
      ctx.fillStyle = INK;
      ctx.fillText(n.label.short, n.x + r * 1.9 + 8, n.y - 7);
      ctx.font = '11px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillStyle = v >= 0 ? POS : NEG;
      ctx.fillText((v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2), n.x + r * 1.9 + 8, n.y + 8);
    }
    if (ok && outCol.length >= 2) {
      const o = acts[acts.length - 1];
      const R = Math.min(34, lay.labelsRight * 0.3);
      const cx = W - R - 8, cy = this.h - R - 10;
      ctx.strokeStyle = 'rgba(165,150,230,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
      ctx.strokeStyle = 'rgba(165,150,230,0.14)';
      ctx.stroke();
      const vx = o[0] * R, vy = o[1] * R;
      ctx.strokeStyle = '#b6ff3b';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + vx, cy + vy); ctx.stroke();
      ctx.fillStyle = '#b6ff3b';
      ctx.beginPath(); ctx.arc(cx + vx, cy + vy, 4, 0, Math.PI * 2); ctx.fill();
      if (R >= 24) {
        ctx.font = '10px Rubik, system-ui, sans-serif';
        ctx.fillStyle = INK_FAINT;
        ctx.textAlign = 'center';
        ctx.fillText(tr('куда тянет', 'where to'), cx, cy - R - 8);
      }
    }
    this._hoverReadout(lay, ok ? acts : null);
  }

  _hoverReadout(lay, acts) {
    if (!this.tooltip) return;
    if (!this.hover) { this.tooltip.classList.remove('show'); return; }
    let best = null, bd = 12 * 12;
    lay.nodes.forEach((col, l) => col.forEach((n, i) => {
      const d = (n.x - this.hover.x) ** 2 + (n.y - this.hover.y) ** 2;
      if (d < bd) { bd = d; best = { n, l, i }; }
    }));
    if (!best) { this.tooltip.classList.remove('show'); return; }
    const v = acts ? acts[best.l][best.i] : 0;
    const last = lay.nodes.length - 1;
    const name = best.l === 0 ? best.n.label.long : best.l === last ? best.n.label.long : tr(`нейрон ${best.i + 1} · слой ${best.l}`, `neuron ${best.i + 1} · layer ${best.l}`);
    this.tooltip.textContent = '';
    const b = document.createElement('b');
    b.textContent = (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(3);
    const s = document.createElement('span');
    s.textContent = ' ' + name;
    this.tooltip.append(b, s);
    this.tooltip.classList.add('show');
    const tw = this.tooltip.offsetWidth;
    let x = best.n.x + 12;
    if (x + tw > this.w - 4) x = best.n.x - tw - 12;
    this.tooltip.style.transform = `translate(${Math.round(Math.max(4, x))}px, ${Math.round(best.n.y - 12)}px)`;
  }
}
