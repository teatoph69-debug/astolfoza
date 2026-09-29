// Small dependency-free canvas charts for the AI Lab (HiDPI, dark theme, animated, hover readout).
//
//   const c = new LineChart(host, { series: [{ key: 'acc', label: 'МУХА', color: CHART_COLORS[0], band: true }], yMin: 0, yMax: 1 });
//   c.setData(rows);          // rows: [{ x, acc, ... }]
//   c.tick();                 // call every animation frame; redraws only when something changed
//
//   const b = new BarChart(host, { threshold: 0.9 });
//   b.setData([0.98, 0.95, …], { marker: 6.42 });
//
// Colours: a categorical palette validated for the dark panel surface (#16122a) with the dataviz
// validator (lightness band, chroma, CVD separation, contrast): pink, blue, amber — in that order.

export const CHART_COLORS = ['#ef3f96', '#1a9fc2', '#bf8a12'];

/**
 * Chart themes: every colour the canvas draws comes from here, so the look can be switched
 * without touching the drawing code. `series` is the default categorical order for callers.
 */
export const THEMES = {
  // glassy neon on the dark panel surface (palette validated with the dataviz validator)
  neon: {
    bg: null, series: CHART_COLORS,
    ink: '#f1eeff', inkDim: '#a59fc7', inkFaint: '#6f6a92',
    grid: 'rgba(165, 150, 230, 0.10)', axis: 'rgba(165, 150, 230, 0.22)', ring: '#16122a',
    crosshair: 'rgba(241, 238, 255, 0.35)', threshold: 'rgba(241, 238, 255, 0.55)', marker: '#f1eeff',
    barFailAlpha: 0.38, bandAlpha: 0.16, rawAlpha: 0.32,
    font: '11px Rubik, system-ui, sans-serif', mono: '11px "JetBrains Mono", ui-monospace, monospace',
    bold: '600 11px Rubik, system-ui, sans-serif',
  },
  // Windows "Task Manager / System Monitor": black scope, 25% green grid, bright traces
  taskmgr: {
    bg: '#000000', series: ['#00ff00', '#ffff00', '#00ffff', '#ff00ff'],
    ink: '#ffffff', inkDim: '#00c000', inkFaint: '#00c000',
    grid: 'rgba(0, 255, 0, 0.25)', axis: 'rgba(0, 255, 0, 0.45)', ring: '#000000',
    crosshair: 'rgba(255, 255, 255, 0.7)', threshold: '#ff0000', marker: '#ffffff',
    barFailAlpha: 0.4, bandAlpha: 0.22, rawAlpha: 0.4,
    font: '11px Tahoma, "Segoe UI", "MS Sans Serif", Verdana, sans-serif', mono: '11px Tahoma, "Segoe UI", "MS Sans Serif", Verdana, sans-serif',
    bold: 'bold 11px Tahoma, "Segoe UI", "MS Sans Serif", Verdana, sans-serif',
    gridScroll: true, square: true,
  },
};
let defaultTheme = THEMES.neon;
/** Set the theme used by charts created afterwards (e.g. setChartTheme('taskmgr')). */
export function setChartTheme(name) { defaultTheme = THEMES[name] || THEMES.neon; }

// ---- helpers -------------------------------------------------------------------------------------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function hexToRgba(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

/** "Nice" tick step for a range (1, 2, 2.5, 5 × 10^k). */
export function niceStep(range, target = 5) {
  if (!(range > 0)) return 1;
  const raw = range / Math.max(1, target);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  const k = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return k * p;
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h));
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Base: canvas + tooltip inside `host` (which becomes position:relative), HiDPI sizing. */
class ChartBase {
  constructor(host, { ariaLabel = '', empty = '', theme = null } = {}) {
    this.theme = typeof theme === 'string' ? THEMES[theme] : theme || defaultTheme;
    this.host = host;
    host.classList.add('chart-host');
    this.canvas = el('canvas', 'chart-canvas');
    this.canvas.setAttribute('role', 'img');
    if (ariaLabel) this.canvas.setAttribute('aria-label', ariaLabel);
    this.tip = el('div', 'chart-tip');
    this.emptyEl = el('div', 'chart-empty', empty);
    host.append(this.canvas, this.tip, this.emptyEl);
    this.ctx = this.canvas.getContext('2d');
    this.w = 1; this.h = 1; this.dpr = 1;
    this.dirty = true;
    this.hover = null;          // pointer position in CSS px or null
    this.canvas.addEventListener('pointermove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.dirty = true;
    });
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; this.dirty = true; this._hideTip(); });
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (w !== this.w || h !== this.h || dpr !== this.dpr) {
      this.w = w; this.h = h; this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.dirty = true;
    }
  }

  setEmpty(text) {
    this.emptyEl.textContent = text || '';
    this.emptyEl.classList.toggle('show', !!text);
  }

  _showTip(title, rows, px, py) {
    const tip = this.tip;
    tip.textContent = '';
    tip.appendChild(el('div', 'chart-tip-title', title));
    for (const r of rows) {
      const row = el('div', 'chart-tip-row');
      const key = el('span', 'chart-tip-key');
      key.style.background = r.color;
      if (r.dash) key.classList.add('dash');
      row.append(key, el('b', 'chart-tip-val', r.value), el('span', 'chart-tip-lab', r.label));
      tip.appendChild(row);
    }
    tip.classList.add('show');
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = px + 14;
    if (x + tw > this.w - 4) x = px - tw - 14;
    x = Math.max(4, x);
    const y = Math.max(4, Math.min(this.h - th - 4, py - th / 2));
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  _hideTip() { this.tip.classList.remove('show'); }

  setTheme(theme) {
    this.theme = typeof theme === 'string' ? THEMES[theme] || this.theme : theme;
    this.dirty = true;
  }

  _begin() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.theme.bg) { ctx.fillStyle = this.theme.bg; ctx.fillRect(0, 0, this.w, this.h); } else ctx.clearRect(0, 0, this.w, this.h);
    return ctx;
  }
}

// ================================================================================================
// Line chart
// ================================================================================================

/**
 * series: [{ key, label, color, width=2, band=false (raw min–max envelope + EMA trend line),
 *            ema=0.12, step=false, dash=null, format?: (v)=>string }]
 */
export class LineChart extends ChartBase {
  constructor(host, { series, yMin = 0, yMax = null, yPad = 0.08, yFormat = (v) => String(v), yTickFormat = null, xFormat = (x) => String(x), xTitle = '', ariaLabel = '', empty = '', minSpan = 10, theme = null, trendWord = 'trend' } = {}) {
    super(host, { ariaLabel, empty, theme });
    this.series = series;
    this.yMin = yMin;
    this.yMax = yMax;
    this.yPad = yPad;
    this.yFormat = yFormat;
    this.yTickFormat = yTickFormat || yFormat;
    this.xFormat = xFormat;
    this.xTitle = xTitle;
    this.minSpan = minSpan;
    this.rows = [];
    this.smooth = {};             // key -> Float64Array of EMA values
    this.trendWord = trendWord;
    this.view = null;             // animated {x0, x1, y0, y1}
    this.target = null;
  }

  setData(rows) {
    this.rows = rows || [];
    for (const s of this.series) {
      if (!s.band && !s.smooth) continue;
      const a = s.ema ?? 0.12;
      const out = new Float64Array(this.rows.length);
      let m = null;
      for (let i = 0; i < this.rows.length; i++) {
        const v = this.rows[i][s.key];
        if (v == null || Number.isNaN(v)) { out[i] = m ?? NaN; continue; }
        m = m == null ? v : m + (v - m) * a;
        out[i] = m;
      }
      this.smooth[s.key] = out;
    }
    const n = this.rows.length;
    const x0 = n ? this.rows[0].x : 0;
    const x1 = n ? Math.max(this.rows[n - 1].x, x0 + this.minSpan) : this.minSpan;
    let y0 = this.yMin, y1 = this.yMax;
    if (y1 == null || y0 == null) {
      let lo = Infinity, hi = -Infinity;
      for (const r of this.rows) for (const s of this.series) {
        const v = r[s.key];
        if (v == null || Number.isNaN(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
      if (y0 == null) y0 = lo;
      if (y1 == null) {
        const st = niceStep(Math.max(1e-6, hi - y0), 4);
        y1 = Math.max(y0 + st, Math.ceil((hi + (hi - y0) * this.yPad) / st) * st);
      }
    }
    this.target = { x0, x1, y0, y1 };
    if (!this.view || reducedMotion()) this.view = { ...this.target };
    this.setEmpty(n ? '' : this.emptyEl.textContent);
    this.emptyEl.classList.toggle('show', !n);
    this.dirty = true;
  }

  /** Advance the animation and redraw when needed. */
  tick() {
    let animating = false;
    if (this.view && this.target) {
      for (const k of ['x0', 'x1', 'y0', 'y1']) {
        const d = this.target[k] - this.view[k];
        if (Math.abs(d) > 1e-4 * Math.max(1, Math.abs(this.target[k]))) {
          this.view[k] += d * 0.14;
          animating = true;
        } else {
          this.view[k] = this.target[k];
        }
      }
    }
    if (animating) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    this.draw();
  }

  draw() {
    const ctx = this._begin();
    const th = this.theme;
    const W = this.w, H = this.h;
    const rows = this.rows;
    const v = this.view || { x0: 0, x1: this.minSpan, y0: this.yMin ?? 0, y1: this.yMax ?? 1 };
    // plot rect
    ctx.font = th.mono;
    const yStep = niceStep(v.y1 - v.y0, H < 150 ? 3 : 4);
    let labW = 0;
    for (let y = Math.ceil(v.y0 / yStep) * yStep; y <= v.y1 + 1e-9; y += yStep) labW = Math.max(labW, ctx.measureText(this.yTickFormat(y)).width);
    const L = Math.ceil(labW) + 10, R = 10, T = 10, B = 24;
    const pw = Math.max(10, W - L - R), ph = Math.max(10, H - T - B);
    const sx = (x) => L + ((x - v.x0) / Math.max(1e-9, v.x1 - v.x0)) * pw;
    const sy = (y) => T + (1 - (y - v.y0) / Math.max(1e-9, v.y1 - v.y0)) * ph;
    this._geom = { L, T, pw, ph, sx, sy, v };

    // grid + y labels
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let y = Math.ceil(v.y0 / yStep - 1e-9) * yStep; y <= v.y1 + 1e-9; y += yStep) {
      const py = Math.round(sy(y)) + 0.5;
      ctx.strokeStyle = Math.abs(y - v.y0) < 1e-9 ? th.axis : th.grid;
      ctx.beginPath(); ctx.moveTo(L, py); ctx.lineTo(L + pw, py); ctx.stroke();
      ctx.fillStyle = th.inkFaint;
      ctx.fillText(this.yTickFormat(y), L - 6, py);
    }
    // x labels
    const xStep = Math.max(1, niceStep(v.x1 - v.x0, Math.max(2, Math.floor(pw / 90))));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = th.inkFaint;
    for (let x = Math.ceil(v.x0 / xStep) * xStep; x <= v.x1 + 1e-9; x += xStep) {
      const px = sx(x);
      if (px < L - 1 || px > L + pw + 1) continue;
      if (th.gridScroll) {
        // scope-style vertical grid that scrolls with the data (Task Manager look)
        ctx.strokeStyle = th.grid;
        ctx.beginPath(); ctx.moveTo(Math.round(px) + 0.5, T); ctx.lineTo(Math.round(px) + 0.5, T + ph); ctx.stroke();
      }
      ctx.fillText(this.xFormat(Math.round(x)), px, T + ph + 7);
    }
    if (!rows.length) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(L - 1, T - 4, pw + 6, ph + 8);
    ctx.clip();

    // bucket rows per pixel column for dense histories
    const n = rows.length;
    const cols = Math.max(1, Math.floor(pw));
    const dense = n > cols * 1.5;
    for (const s of this.series) {
      const color = this._sc(s);
      if (s.smooth && !s.band) {
        this._strokeSeries(ctx, rows, (i) => this.smooth[s.key][i], sx, sy, color, s.width || 2, false, null, dense ? cols : 0, L);
      } else if (s.band) {
        // raw spread as a quiet envelope, EMA trend on top
        const ema = this.smooth[s.key];
        if (dense) {
          const lo = new Float64Array(cols).fill(Infinity), hi = new Float64Array(cols).fill(-Infinity);
          for (let i = 0; i < n; i++) {
            const val = rows[i][s.key];
            if (val == null || Number.isNaN(val)) continue;
            const c = Math.max(0, Math.min(cols - 1, Math.floor(sx(rows[i].x) - L)));
            if (val < lo[c]) lo[c] = val;
            if (val > hi[c]) hi[c] = val;
          }
          ctx.fillStyle = hexToRgba(color, th.bandAlpha);
          ctx.beginPath();
          let started = false;
          const top = [];
          for (let c = 0; c < cols; c++) {
            if (!Number.isFinite(lo[c])) continue;
            const px = L + c + 0.5;
            if (!started) { ctx.moveTo(px, sy(hi[c])); started = true; } else ctx.lineTo(px, sy(hi[c]));
            top.push(c);
          }
          for (let k = top.length - 1; k >= 0; k--) { const c = top[k]; ctx.lineTo(L + c + 0.5, sy(lo[c]) + 0.5); }
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.strokeStyle = hexToRgba(color, th.rawAlpha);
          ctx.lineWidth = 1;
          ctx.lineJoin = 'round';
          ctx.beginPath();
          let started = false;
          for (let i = 0; i < n; i++) {
            const val = rows[i][s.key];
            if (val == null || Number.isNaN(val)) continue;
            const px = sx(rows[i].x), py = sy(val);
            if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
        this._strokeSeries(ctx, rows, (i) => ema[i], sx, sy, color, s.width || 2, false, null, dense ? cols : 0, L);
      } else {
        this._strokeSeries(ctx, rows, (i) => rows[i][s.key], sx, sy, color, s.width || 2, !!s.step, s.dash, dense ? cols : 0, L);
      }
    }
    ctx.restore();

    // end dots (latest value), with a surface ring
    for (const s of this.series) {
      const i = lastIndex(rows, s.key);
      if (i < 0) continue;
      const val = s.band || s.smooth ? this.smooth[s.key][i] : rows[i][s.key];
      const px = sx(rows[i].x), py = sy(val);
      ctx.fillStyle = th.ring;
      ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = this._sc(s);
      ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
    }

    // hover crosshair + readout
    if (this.hover && this.hover.x >= L - 6 && this.hover.x <= L + pw + 6) {
      const xv = v.x0 + ((this.hover.x - L) / pw) * (v.x1 - v.x0);
      const i = nearestIndex(rows, xv);
      if (i >= 0) {
        const r = rows[i];
        const px = Math.round(sx(r.x)) + 0.5;
        ctx.strokeStyle = th.crosshair;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px, T); ctx.lineTo(px, T + ph); ctx.stroke();
        const tipRows = [];
        for (const s of this.series) {
          const trend = s.band || s.smooth ? this.smooth[s.key][i] : null;
          const val = trend != null ? trend : r[s.key];
          if (val == null || Number.isNaN(val)) continue;
          const py = sy(val);
          ctx.fillStyle = th.ring;
          ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = this._sc(s);
          ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
          const fmt = s.format || this.yFormat;
          const raw = r[s.key];
          // value = this generation's raw number; the trend (drawn line) is secondary
          tipRows.push({ color: this._sc(s), dash: !!s.dash, value: fmt(raw != null ? raw : val), label: s.label + (trend != null ? ` · ${this.trendWord} ${fmt(trend)}` : '') });
        }
        this._showTip(this.xTitle ? `${this.xTitle} ${this.xFormat(r.x)}` : this.xFormat(r.x), tipRows, px, this.hover.y);
      }
    } else if (!this.hover) {
      this._hideTip();
    }
  }

  /** Series colour: explicit, else the theme's categorical order. */
  _sc(s) { return s.color || this.theme.series[this.series.indexOf(s) % this.theme.series.length]; }

  _strokeSeries(ctx, rows, get, sx, sy, color, width, step, dash, cols, L) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    let started = false, prevY = 0;
    const n = rows.length;
    if (cols) {
      // one averaged point per pixel column
      let c0 = -1, sum = 0, cnt = 0, xs = 0;
      const flush = () => {
        if (!cnt) return;
        const px = xs / cnt, py = sy(sum / cnt);
        if (!started) { ctx.moveTo(px, py); started = true; } else if (step) { ctx.lineTo(px, prevY); ctx.lineTo(px, py); } else ctx.lineTo(px, py);
        prevY = py;
      };
      for (let i = 0; i < n; i++) {
        const val = get(i);
        if (val == null || Number.isNaN(val)) continue;
        const px = sx(rows[i].x);
        const c = Math.floor(px - L);
        if (c !== c0) { flush(); c0 = c; sum = 0; cnt = 0; xs = 0; }
        sum += val; cnt++; xs += px;
      }
      flush();
    } else {
      for (let i = 0; i < n; i++) {
        const val = get(i);
        if (val == null || Number.isNaN(val)) continue;
        const px = sx(rows[i].x), py = sy(val);
        if (!started) { ctx.moveTo(px, py); started = true; } else if (step) { ctx.lineTo(px, prevY); ctx.lineTo(px, py); } else ctx.lineTo(px, py);
        prevY = py;
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function lastIndex(rows, key) {
  for (let i = rows.length - 1; i >= 0; i--) { const v = rows[i][key]; if (v != null && !Number.isNaN(v)) return i; }
  return -1;
}

function nearestIndex(rows, x) {
  let lo = 0, hi = rows.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (rows[m].x < x) lo = m + 1; else hi = m;
  }
  if (lo > 0 && Math.abs(rows[lo - 1].x - x) < Math.abs(rows[lo].x - x)) lo--;
  return lo;
}

// ================================================================================================
// Bar chart (one series; bars below the threshold are drawn as a lighter step of the same hue)
// ================================================================================================

export class BarChart extends ChartBase {
  constructor(host, { color = null, threshold = null, thresholdLabel = '', xLabel = (i) => String(i), yFormat = (v) => Math.round(v * 100) + '%', tipTitle = (i) => String(i), tipText = null, markerLabel = (m) => String(m), ariaLabel = '', empty = '', theme = null } = {}) {
    super(host, { ariaLabel, empty, theme });
    this.fixedColor = color;
    this.threshold = threshold;
    this.thresholdLabel = thresholdLabel;
    this.xLabel = xLabel;
    this.yFormat = yFormat;
    this.tipTitle = tipTitle;
    this.tipText = tipText;
    this.markerLabel = markerLabel;
    this.values = [];
    this.shown = [];
    this.marker = null;
    this.markerShown = null;
  }

  setData(values, { marker = null } = {}) {
    this.values = (values || []).slice();
    if (this.shown.length !== this.values.length) this.shown = this.values.map(() => 0);
    if (reducedMotion()) this.shown = this.values.map((v) => v || 0);
    this.marker = marker;
    if (this.markerShown == null || reducedMotion()) this.markerShown = marker;
    this.emptyEl.classList.toggle('show', !this.values.some((v) => v != null));
    this.dirty = true;
  }

  tick() {
    let animating = false;
    for (let i = 0; i < this.values.length; i++) {
      const t = this.values[i] || 0;
      const d = t - this.shown[i];
      if (Math.abs(d) > 0.0005) { this.shown[i] += d * 0.12; animating = true; } else this.shown[i] = t;
    }
    if (this.marker != null && this.markerShown != null) {
      const d = this.marker - this.markerShown;
      if (Math.abs(d) > 0.002) { this.markerShown += d * 0.12; animating = true; } else this.markerShown = this.marker;
    }
    if (animating) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    this.draw();
  }

  draw() {
    const ctx = this._begin();
    const th = this.theme;
    const color = this.fixedColor || th.series[0];
    const W = this.w, H = this.h;
    const n = this.values.length || 21;
    ctx.font = th.mono;
    const L = Math.ceil(ctx.measureText('100%').width) + 10, R = 8, T = 22, B = 22;
    const pw = Math.max(10, W - L - R), ph = Math.max(10, H - T - B);
    const slot = pw / n;
    const bw = Math.min(24, Math.max(3, slot - 2));    // ≤ 24 px, ≥ 2 px surface gap
    const sy = (v) => T + (1 - v) * ph;
    // grid
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const g of [0, 0.25, 0.5, 0.75, 1]) {
      const py = Math.round(sy(g)) + 0.5;
      ctx.strokeStyle = g === 0 ? th.axis : th.grid;
      ctx.beginPath(); ctx.moveTo(L, py); ctx.lineTo(L + pw, py); ctx.stroke();
      ctx.fillStyle = th.inkFaint;
      ctx.fillText(this.yFormat(g), L - 6, py);
    }
    // bars
    let hoverIdx = -1;
    if (this.hover && this.hover.x >= L && this.hover.x <= L + pw) hoverIdx = Math.min(n - 1, Math.floor((this.hover.x - L) / slot));
    for (let i = 0; i < this.values.length; i++) {
      const v = this.values[i];
      if (v == null) continue;
      const s = Math.max(0, Math.min(1, this.shown[i]));
      const x = L + i * slot + (slot - bw) / 2;
      const y = sy(s);
      const pass = this.threshold == null || v >= this.threshold;
      ctx.fillStyle = pass ? color : hexToRgba(color, th.barFailAlpha);
      if (i === hoverIdx) ctx.fillStyle = pass ? hexToRgba(color, 0.82) : hexToRgba(color, Math.min(1, th.barFailAlpha + 0.18));
      if (T + ph - y > 0.5) {
        if (th.square) ctx.fillRect(x, y, bw, T + ph - y);
        else { roundRectPath(ctx, x, y, bw, T + ph - y, Math.min(4, bw / 2)); ctx.fill(); }
      }
    }
    // x labels (thin out when crowded)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = th.inkFaint;
    const every = slot < 16 ? (slot < 9 ? 5 : 2) : 1;
    for (let i = 0; i < n; i++) {
      if (i % every) continue;
      ctx.fillText(this.xLabel(i), L + i * slot + slot / 2, T + ph + 6);
    }
    // threshold line (a threshold, so it is dashed and labelled)
    if (this.threshold != null) {
      const py = Math.round(sy(this.threshold)) + 0.5;
      ctx.strokeStyle = th.threshold;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(L, py); ctx.lineTo(L + pw, py); ctx.stroke();
      ctx.setLineDash([]);
      if (this.thresholdLabel) {
        ctx.font = th.font;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = th.inkDim;
        ctx.fillText(this.thresholdLabel, L + pw, py - 3);
        ctx.font = th.mono;
      }
    }
    // marker: where she is right now (skill in ★ → x position: passing level L ⇒ skill L + 0.5)
    if (this.markerShown != null && this.markerShown > 0) {
      const mx = L + Math.max(0, Math.min(n, this.markerShown + 0.5)) * slot;
      ctx.strokeStyle = th.marker;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(mx, T - 4); ctx.lineTo(mx, T + ph); ctx.stroke();
      ctx.fillStyle = th.marker;
      ctx.beginPath(); ctx.moveTo(mx - 5, T - 10); ctx.lineTo(mx + 5, T - 10); ctx.lineTo(mx, T - 3); ctx.closePath(); ctx.fill();
      const label = this.markerLabel(this.marker ?? this.markerShown);
      ctx.font = th.bold;
      const tw = ctx.measureText(label).width;
      ctx.textBaseline = 'middle';
      const right = mx + 9 + tw < L + pw;
      ctx.textAlign = right ? 'left' : 'right';
      ctx.fillText(label, right ? mx + 9 : mx - 9, T - 10);
    }
    // hover readout
    if (hoverIdx >= 0 && this.values[hoverIdx] != null) {
      const v = this.values[hoverIdx];
      const rows = [{ color, value: this.yFormat(v), label: this.tipText ? this.tipText(hoverIdx, v) : '' }];
      this._showTip(this.tipTitle(hoverIdx), rows, L + hoverIdx * slot + slot / 2, Math.max(T + 10, sy(v)));
    } else if (!this.hover || hoverIdx < 0) {
      this._hideTip();
    }
  }
}

/** Plain HTML table twin of a chart (accessibility / exact values). */
export function tableView(columns, rows) {
  const table = el('table', 'chart-table');
  const thead = el('thead');
  const tr = el('tr');
  for (const c of columns) tr.appendChild(el('th', null, c));
  thead.appendChild(tr);
  const tbody = el('tbody');
  for (const r of rows) {
    const row = el('tr');
    for (const c of r) row.appendChild(el('td', null, c));
    tbody.appendChild(row);
  }
  table.append(thead, tbody);
  return table;
}
