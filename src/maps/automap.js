// Auto-mapper: turns any audio into playable maps (5 difficulties).
//
// Pipeline (pure JS, no dependencies; ≈ 0.3–0.8 s for a 3-minute song in Chrome):
//   1. downmix to mono, decimate to ~22 kHz, loudness-normalise (RMS 0.1);
//   2. STFT: 1024-point Hann, hop 256 (≈ 11.6 ms), small radix-2 real FFT; power pooled into ~12 bands
//      per octave (30 Hz … 10 kHz) and log-compressed;
//   3. spectral flux ("SuperFlux"-style: vs. a band-max-filtered frame two hops back) in three groups —
//      low (< 200 Hz: kick/bass), mid (< 2.5 kHz: snare body, instruments, vocals), high (hats, noise);
//   4. onset detection function = per-group-normalised weighted flux; adaptive threshold (moving mean
//      + noise guard), peak picking, parabolic sub-frame timing;
//   5. tempo: autocorrelation of the onset envelope scored with a harmonic comb × a log-tempo prior that
//      prefers 90–200 BPM; beats: dynamic-programming beat tracker (Ellis 2007); global grid = period and
//      phase with the most coherent beat phases (|Σ w·e^{2πit/p}|) refined by weighted least squares.
//      Songs with tempo drift / changes keep the (smoothed) tracked beats as a local grid instead;
//   6. if the grid agrees with the onsets (confidence), onsets are snapped to 1/4 beats (1/3, 1/8, 1/6 only
//      when already very close) — never moved by more than 20 ms;
//   7. per difficulty: candidates scored by onset strength × section loudness (+ metrical position), picked
//      greedily with a minimum gap; the gap (≥ the difficulty's floor) is searched so that computeStars()
//      lands near the target. Fast runs are marked `stream: true`; placeNotes() decides the positions.

import { placeNotes } from './patterns.js';
import { computeStars } from '../core/map.js';
import { formatError } from './sspm.js';

export const AUTO_DIFFICULTIES = [
  // stars: target computeStars(); minGap: s between notes; floor: min candidate score;
  // maxRest: longer note-free stretches are filled with the best onsets inside them (if the music has any)
  { id: 'easy', name: 'Easy', stars: 1.2, minGap: 0.35, floor: 0.3, maxRest: 3.0 },
  { id: 'normal', name: 'Normal', stars: 2.8, minGap: 0.22, floor: 0.2, maxRest: 2.4 },
  { id: 'hard', name: 'Hard', stars: 4.8, minGap: 0.15, floor: 0.12, maxRest: 2.0 },
  { id: 'insane', name: 'Insane', stars: 6.8, minGap: 0.09, floor: 0.06, maxRest: 1.6 },
  { id: 'extreme', name: 'Extreme', stars: 9, minGap: 0.065, floor: 0.02, maxRest: 1.4 },
];

const N_FFT = 1024;
const HOP = 256;
// Systematic lag of flux peaks vs. the true onset for this window/hop/lag (measured on clicks and drums).
const ONSET_BIAS_FRAMES = 0.25;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * @param {AudioBuffer|{sampleRate:number, channelData:Float32Array[]}} audio
 * @param {{seed?:number, onProgress?:(f:number, stage:string)=>void, difficulties?:object[]}} opts
 * @returns {Promise<{bpm:number, offset:number, confidence:number, grid:string, duration:number,
 *   onsetCount:number, timings:object, maps:{difficultyId:string, difficultyName:string,
 *   notes:{t:number,x:number,y:number}[], stars:number}[]}>}
 */
export async function autoMap(audio, opts = {}) {
  const { seed = 1, onProgress = null, difficulties = AUTO_DIFFICULTIES } = opts;
  const rhythm = await analyzeRhythm(audio, { onProgress });
  if (rhythm.onsets.length < 8) {
    throw formatError('В треке не нашлось ритма (слишком тихо или слишком коротко)',
      'No rhythm found in the track (too quiet or too short)');
  }
  const t0 = now();
  const cands = scoreCandidates(rhythm);
  const maps = [];
  const sorted = cands.slice().sort((a, b) => b.score - a.score);
  let prev = null;
  for (let i = 0; i < difficulties.length; i++) {
    const d = difficulties[i];
    const m = buildDifficulty(sorted, d, rhythm, (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0, prev);
    prev = { count: m.notes.length, stars: m.stars };
    maps.push(m);
    onProgress && onProgress(0.7 + 0.3 * ((i + 1) / difficulties.length), 'maps');
    await tick();
  }
  rhythm.timings.maps = now() - t0;
  rhythm.timings.total = Object.values(rhythm.timings).reduce((a, b) => a + b, 0);
  return {
    bpm: rhythm.bpm,
    offset: rhythm.offset,
    confidence: rhythm.confidence,
    grid: rhythm.grid,
    duration: rhythm.duration,
    onsetCount: rhythm.onsets.length,
    timings: rhythm.timings,
    maps,
  };
}

/**
 * Onset detection + tempo / beat analysis.
 * @returns {Promise<{duration:number, bpm:number, offset:number, confidence:number, grid:'global'|'local'|'none',
 *   beats:number[], onsets:{t:number, raw:number, strength:number, snapped:boolean, beatPos:number|null,
 *   energy:number, midi:number|null, low:number, mid:number, high:number}[], timings:object}>}
 */
export async function analyzeRhythm(audio, { onProgress = null } = {}) {
  const timings = {};
  let t0 = now();
  const { mono, sr } = prepareSignal(audio);
  timings.prepare = now() - t0;
  onProgress && onProgress(0.05, 'prepare');
  await tick();

  t0 = now();
  const F = spectralFeatures(mono, sr);
  timings.stft = now() - t0;
  onProgress && onProgress(0.4, 'stft');
  await tick();

  t0 = now();
  const odf = onsetFunction(F);
  const peaks = pickPeaks(odf, F);
  timings.onsets = now() - t0;

  t0 = now();
  const tempo = estimateTempo(odf.salience, F.hopSec);
  const beatFrames = trackBeats(odf.salience, tempo.periodFrames);
  const grid = fitGrid(beatFrames, odf.salience, F.hopSec, tempo, peaks);
  timings.tempo = now() - t0;
  onProgress && onProgress(0.6, 'tempo');

  const onsets = snapOnsets(peaks, grid);
  return {
    duration: mono.length / sr,
    bpm: grid.bpm,
    offset: grid.offset,
    confidence: grid.confidence,
    grid: grid.mode,
    beats: grid.beats,
    onsets,
    timings,
  };
}

// ---- 1. signal preparation -------------------------------------------------------------------

function prepareSignal(audio) {
  const sr0 = audio.sampleRate;
  let chans;
  if (audio.channelData) chans = audio.channelData;
  else if (typeof audio.getChannelData === 'function') {
    chans = [];
    for (let c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c));
  } else throw formatError('Неверный аудиобуфер', 'Invalid audio buffer');
  if (!chans.length || !(sr0 > 0)) throw formatError('Пустой аудиобуфер', 'Empty audio buffer');
  const n0 = chans[0].length;
  let dec = 1;
  while (sr0 / (dec * 2) >= 16000) dec *= 2;
  const n = Math.floor(n0 / dec);
  const mono = new Float32Array(n);
  const nc = chans.length;
  const g = 1 / (nc * dec);
  if (dec === 2 && nc <= 2) {
    const l = chans[0], r = nc === 2 ? chans[1] : null;
    if (r) for (let i = 0, j = 0; i < n; i++, j += 2) mono[i] = (l[j] + l[j + 1] + r[j] + r[j + 1]) * 0.25;
    else for (let i = 0, j = 0; i < n; i++, j += 2) mono[i] = (l[j] + l[j + 1]) * 0.5;
  } else if (dec === 1) {
    for (let c = 0; c < nc; c++) { const ch = chans[c]; for (let i = 0; i < n; i++) mono[i] += ch[i]; }
    if (nc > 1) for (let i = 0; i < n; i++) mono[i] /= nc;
  } else {
    // box-filter decimation (crude anti-aliasing is fine for onset detection)
    for (let c = 0; c < nc; c++) {
      const ch = chans[c];
      for (let i = 0, j = 0; i < n; i++) {
        let s = 0;
        for (let k = 0; k < dec; k++) s += ch[j++];
        mono[i] += s;
      }
    }
    for (let i = 0; i < n; i++) mono[i] *= g;
  }
  // loudness normalisation → RMS 0.1 (so the log compression behaves the same for every file)
  let e = 0;
  for (let i = 0; i < n; i++) e += mono[i] * mono[i];
  const rms = Math.sqrt(e / Math.max(1, n));
  if (rms > 1e-7) { const k = 0.1 / rms; for (let i = 0; i < n; i++) mono[i] *= k; }
  return { mono, sr: sr0 / dec };
}

// ---- 2./3. STFT + band flux ------------------------------------------------------------------

/**
 * Real FFT of a length-N frame (N a power of two) → power spectrum |X[k]|², k = 0..N/2.
 * Computed with an N/2-point complex radix-2 FFT (first two stages fused into multiply-free radix-4
 * butterflies) plus the usual even/odd split.
 */
export function makeRealFFT(N) {
  const M = N >> 1;
  const levels = Math.round(Math.log2(M));
  if (M < 4 || 1 << levels !== M) throw new Error('FFT size must be a power of two ≥ 8');
  const rev = new Uint32Array(M);
  for (let i = 0; i < M; i++) {
    let r = 0;
    for (let b = 0, x = i; b < levels; b++, x >>= 1) r = (r << 1) | (x & 1);
    rev[i] = r;
  }
  const stages = [];
  for (let size = 8; size <= M; size <<= 1) {
    const half = size >> 1;
    const c = new Float64Array(half), s = new Float64Array(half);
    for (let k = 0; k < half; k++) { c[k] = Math.cos((2 * Math.PI * k) / size); s[k] = -Math.sin((2 * Math.PI * k) / size); }
    stages.push({ size, half, c, s });
  }
  const cosN = new Float64Array(M + 1), sinN = new Float64Array(M + 1);
  for (let k = 0; k <= M; k++) { cosN[k] = Math.cos((2 * Math.PI * k) / N); sinN[k] = -Math.sin((2 * Math.PI * k) / N); }
  const re = new Float64Array(M), im = new Float64Array(M);

  return function fftPower(input, outPow) {
    for (let i = 0; i < M; i++) { const j = rev[i]; re[j] = input[2 * i]; im[j] = input[2 * i + 1]; }
    for (let a = 0; a < M; a += 4) {
      const r0 = re[a], i0 = im[a], r1 = re[a + 1], i1 = im[a + 1];
      const r2 = re[a + 2], i2 = im[a + 2], r3 = re[a + 3], i3 = im[a + 3];
      const s0r = r0 + r1, s0i = i0 + i1, d0r = r0 - r1, d0i = i0 - i1;
      const s1r = r2 + r3, s1i = i2 + i3, d1r = r2 - r3, d1i = i2 - i3;
      re[a] = s0r + s1r; im[a] = s0i + s1i;
      re[a + 2] = s0r - s1r; im[a + 2] = s0i - s1i;
      re[a + 1] = d0r + d1i; im[a + 1] = d0i - d1r; // d1 · (−i)
      re[a + 3] = d0r - d1i; im[a + 3] = d0i + d1r;
    }
    for (let st = 0; st < stages.length; st++) {
      const { size, half, c, s } = stages[st];
      for (let start = 0; start < M; start += size) {
        for (let k = 0; k < half; k++) {
          const a = start + k, b = a + half;
          const wr = c[k], wi = s[k];
          const br = re[b], bi = im[b];
          const xr = br * wr - bi * wi, xi = br * wi + bi * wr;
          const ar = re[a], ai = im[a];
          re[b] = ar - xr; im[b] = ai - xi;
          re[a] = ar + xr; im[a] = ai + xi;
        }
      }
    }
    // X[k] = E[k] + W^k·O[k], E = (Z[k] + conj Z[M−k]) / 2, O = (Z[k] − conj Z[M−k]) / 2i
    for (let k = 0; k <= M; k++) {
      const k1 = k === M ? 0 : k, k2 = k === 0 ? 0 : M - k;
      const zr = re[k1], zi = im[k1], cr = re[k2], ci = -im[k2];
      const er = (zr + cr) * 0.5, ei = (zi + ci) * 0.5;
      const dr = (zr - cr) * 0.5, di = (zi - ci) * 0.5; // O = (di, −dr)
      const wr = cosN[k], wi = sinN[k];
      const xr = er + di * wr + dr * wi, xi = ei + di * wi - dr * wr;
      outPow[k] = xr * xr + xi * xi;
    }
  };
}

/**
 * STFT → per-frame features. The power spectrum is pooled into ~12 bands per octave (30 Hz … 10 kHz)
 * before log compression: fewer logs, and band energies fluctuate far less than single bins on noise.
 */
function spectralFeatures(x, sr) {
  const N = N_FFT, H = HOP, M = N >> 1;
  const nFrames = Math.max(1, Math.floor(x.length / H) + 1);
  const hopSec = H / sr;
  const fft = makeRealFFT(N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const binOf = (f) => Math.max(1, Math.min(M, Math.round((f * N) / sr)));

  // log-spaced filterbank (rectangular, each bin in exactly one band, every band ≥ 1 bin)
  const edges = [binOf(30)];
  const fMax = Math.min(10000, sr * 0.45);
  for (let f = 30 * Math.pow(2, 1 / 12); f < fMax; f *= Math.pow(2, 1 / 12)) {
    const b = binOf(f);
    if (b > edges[edges.length - 1]) edges.push(b);
  }
  const nb = edges.length - 1;
  const bandLo = Int32Array.from(edges.slice(0, -1)), bandHi = Int32Array.from(edges.slice(1));
  const bandInvW = new Float64Array(nb);
  const group = new Uint8Array(nb); // 0 low (< 200 Hz), 1 mid (< 2.5 kHz), 2 high
  const count = [0, 0, 0];
  for (let j = 0; j < nb; j++) {
    bandInvW[j] = 1 / (bandHi[j] - bandLo[j]);
    const fc = (((bandLo[j] + bandHi[j]) / 2) * sr) / N;
    group[j] = fc < 200 ? 0 : fc < 2500 ? 1 : 2;
    count[group[j]]++;
  }
  const inv = count.map((c) => (c ? 1 / c : 0));
  const pLo = binOf(120), pHi = binOf(1400); // pitch search range (melody → note height)

  const frame = new Float32Array(N);
  const pow = new Float64Array(M + 1);
  const ring = [new Float32Array(nb), new Float32Array(nb), new Float32Array(nb)];
  const low = new Float32Array(nFrames), mid = new Float32Array(nFrames), high = new Float32Array(nFrames);
  const energy = new Float32Array(nFrames);
  const pitch = new Float32Array(nFrames);
  const G = 400; // log(1 + G·power): compression constant (signal is RMS-normalised to 0.1)
  for (let f = 0; f < nFrames; f++) {
    const start = f * H - (N >> 1); // frame f is centred on sample f·H
    if (start >= 0 && start + N <= x.length) {
      for (let i = 0; i < N; i++) frame[i] = x[start + i] * win[i];
    } else {
      for (let i = 0; i < N; i++) { const j = start + i; frame[i] = j >= 0 && j < x.length ? x[j] * win[i] : 0; }
    }
    fft(frame, pow);
    const L = ring[f % 3];
    const R = ring[(f + 1) % 3]; // = frame f − 2
    let e = 0;
    for (let j = 0; j < nb; j++) {
      let s = 0;
      for (let k = bandLo[j], k1 = bandHi[j]; k < k1; k++) s += pow[k];
      e += s;
      L[j] = Math.log(1 + G * s * bandInvW[j]);
    }
    energy[f] = e;
    if (f >= 2) {
      const acc = [0, 0, 0];
      for (let j = 0; j < nb; j++) {
        let ref = R[j];
        if (j > 0 && R[j - 1] > ref) ref = R[j - 1];
        if (j < nb - 1 && R[j + 1] > ref) ref = R[j + 1];
        const d = L[j] - ref;
        if (d > 0) acc[group[j]] += d;
      }
      low[f] = acc[0] * inv[0]; mid[f] = acc[1] * inv[1]; high[f] = acc[2] * inv[2];
    }
    // dominant pitch in the melody range, only when clearly tonal
    let best = 0, bk = 0, sum = 0;
    for (let k = pLo; k <= pHi; k++) { const p = pow[k]; sum += p; if (p > best) { best = p; bk = k; } }
    const avg = sum / (pHi - pLo + 1);
    pitch[f] = best > 20 * avg && best > 1e-6 ? 69 + 12 * Math.log2(((bk * sr) / N) / 440) : 0;
  }
  return { low, mid, high, energy, pitch, nFrames, hopSec, sr };
}

// ---- 4. onset detection function + peak picking ----------------------------------------------

function percentile(arr, q) {
  const a = Float32Array.from(arr).sort();
  if (!a.length) return 0;
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))))];
}

function onsetFunction(F) {
  const n = F.nFrames;
  const norm = (a) => { const p = percentile(a, 0.95); return p > 1e-9 ? 1 / p : 0; };
  const kl = norm(F.low) * 1.0, km = norm(F.mid) * 0.8, kh = norm(F.high) * 0.7;
  const ksum = kl + km + kh > 0 ? 1 / ((kl ? 1 : 0) + (km ? 0.8 : 0) + (kh ? 0.7 : 0)) : 0;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = (F.low[i] * kl + F.mid[i] * km + F.high[i] * kh) * ksum;
  // light smoothing against split peaks
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = 0.25 * raw[Math.max(0, i - 1)] + 0.5 * raw[i] + 0.25 * raw[Math.min(n - 1, i + 1)];
  // moving mean (−100 ms … +70 ms) via prefix sums → salience = o − mean (≥ 0)
  const pre = Math.round(0.1 / F.hopSec), post = Math.round(0.07 / F.hopSec);
  const ps = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) ps[i + 1] = ps[i] + o[i];
  const mean = new Float32Array(n), sal = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - pre), b = Math.min(n, i + post + 1);
    mean[i] = (ps[b] - ps[a]) / (b - a);
    sal[i] = Math.max(0, o[i] - mean[i]);
  }
  // section loudness: log energy smoothed over ~3 s, mapped to 0..1 by percentiles
  const w = Math.max(1, Math.round(1.5 / F.hopSec));
  const le = new Float32Array(n);
  for (let i = 0; i < n; i++) le[i] = Math.log10(1e-6 + F.energy[i]);
  const pe = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pe[i + 1] = pe[i] + le[i];
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - w), b = Math.min(n, i + w + 1); sm[i] = (pe[b] - pe[a]) / (b - a); }
  const lo = percentile(sm, 0.1), hi = percentile(sm, 0.95);
  const energy = new Float32Array(n);
  for (let i = 0; i < n; i++) energy[i] = hi > lo ? Math.min(1, Math.max(0, (sm[i] - lo) / (hi - lo))) : 1;
  return { o, mean, salience: sal, energy, kl, km, kh, ksum };
}

function pickPeaks(odf, F) {
  const { o, mean } = odf;
  const n = o.length;
  const hop = F.hopSec;
  const wmax = Math.max(1, Math.round(0.03 / hop));
  const combine = Math.max(1, Math.round(0.025 / hop));
  // absolute floor + a noise guard relative to the typical flux level of the song
  const thr = Math.max(0.06, 0.3 * percentile(o, 0.5));
  const peaks = [];
  let last = -1e9;
  for (let i = 2; i < n - 1; i++) {
    const v = o[i];
    if (v - mean[i] < thr) continue;
    let isMax = true;
    for (let k = Math.max(0, i - wmax); k <= Math.min(n - 1, i + wmax); k++) {
      if (o[k] > v || (o[k] === v && k < i)) { isMax = false; break; }
    }
    if (!isMax) continue;
    if (i - last < combine) {
      const prev = peaks[peaks.length - 1];
      if (prev && v > prev.o) peaks.pop(); else continue;
    }
    // sub-frame position by parabolic interpolation
    const a = o[i - 1], c = o[i + 1];
    const den = a - 2 * v + c;
    const dx = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
    peaks.push({
      frame: i,
      t: (i + dx + ONSET_BIAS_FRAMES) * hop,
      o: v,
      sal: v - mean[i],
      low: F.low[i] * odf.kl * odf.ksum,
      mid: F.mid[i] * odf.km * odf.ksum,
      high: F.high[i] * odf.kh * odf.ksum,
      energy: odf.energy[i],
      midi: F.pitch[Math.min(n - 1, i + 2)] || null,
    });
    last = i;
  }
  // strength 0..1 from salience (robust scale), gently compressed
  const ref = percentile(peaks.map((p) => p.sal), 0.9) || 1;
  for (const p of peaks) p.strength = Math.min(1, Math.pow(p.sal / ref, 0.75));
  return peaks;
}

// ---- 5. tempo + beats ------------------------------------------------------------------------

function estimateTempo(env, hop) {
  const n = env.length;
  const minBpm = 55;
  const maxLag = Math.min(n - 1, Math.ceil((4 * 60) / minBpm / hop) + 2);
  const r = new Float64Array(maxLag + 1);
  let mu = 0;
  for (let i = 0; i < n; i++) mu += env[i];
  mu /= Math.max(1, n);
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) e[i] = env[i] - mu;
  for (let L = 0; L <= maxLag; L++) {
    let s = 0;
    for (let i = 0, m = n - L; i < m; i++) s += e[i] * e[i + L];
    r[L] = s / (n - L);
  }
  const r0 = r[0] || 1;
  const at = (lag) => {
    if (lag >= maxLag) return 0;
    const i = Math.floor(lag), f = lag - i;
    return (r[i] * (1 - f) + r[i + 1] * f) / r0;
  };
  const prior = (b) => Math.exp(-0.5 * Math.pow(Math.log2(b / 140) / 0.8, 2)) * (b >= 90 && b <= 200 ? 1 : 0.85);
  let best = -Infinity, bestB = 120;
  const scores = [];
  for (let b = 60; b <= 240.0001; b += 0.25) {
    const L = 60 / b / hop;
    const s = at(L) + 0.5 * at(2 * L) + 0.33 * at(3 * L) + 0.25 * at(4 * L);
    const v = s * prior(b);
    scores.push([b, v]);
    if (v > best) { best = v; bestB = b; }
  }
  // parabolic refinement on the score curve
  const idx = scores.findIndex((s) => s[0] === bestB);
  if (idx > 0 && idx < scores.length - 1) {
    const a = scores[idx - 1][1], c = scores[idx + 1][1];
    const den = a - 2 * best + c;
    if (den < 0) bestB += 0.25 * Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
  }
  return { bpm: bestB, periodFrames: 60 / bestB / hop };
}

/** Dynamic-programming beat tracker (Ellis 2007). Returns beat frame indices. */
function trackBeats(env, P) {
  const n = env.length;
  let sd = 0, mu = 0;
  for (let i = 0; i < n; i++) mu += env[i];
  mu /= Math.max(1, n);
  for (let i = 0; i < n; i++) sd += (env[i] - mu) * (env[i] - mu);
  sd = Math.sqrt(sd / Math.max(1, n)) || 1;
  const local = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    local[i] = (0.25 * env[Math.max(0, i - 1)] + 0.5 * env[i] + 0.25 * env[Math.min(n - 1, i + 1)]) / sd;
  }
  const C = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.max(1, Math.round(P / 2)), hi = Math.max(lo + 1, Math.round(P * 2));
  const TIGHT = 100;
  const pen = new Float64Array(hi + 1);
  for (let d = lo; d <= hi; d++) pen[d] = -TIGHT * Math.pow(Math.log(d / P), 2);
  for (let t = 0; t < n; t++) {
    let best = -Infinity, bi = -1;
    for (let d = lo; d <= hi; d++) {
      const tau = t - d;
      if (tau < 0) break;
      const v = C[tau] + pen[d];
      if (v > best) { best = v; bi = tau; }
    }
    if (bi >= 0 && best > 0) { C[t] = local[t] + best; back[t] = bi; } else C[t] = local[t];
  }
  // last beat: best cumulative score among the final two periods
  let end = n - 1, bestC = -Infinity;
  for (let t = Math.max(0, n - Math.round(2 * P)); t < n; t++) if (C[t] > bestC) { bestC = C[t]; end = t; }
  const beats = [];
  for (let t = end; t >= 0; t = back[t]) { beats.push(t); if (back[t] < 0) break; }
  beats.reverse();
  return beats;
}

/**
 * Turn tracked beats into a beat grid: a global one (exact period + phase) for steady songs, else the
 * smoothed tracked beats (local grid). Reports how well the onsets agree with it (confidence 0..1;
 * < 0.3 → mode 'none', no snapping).
 */
function fitGrid(beatFrames, env, hop, tempo, peaks) {
  const n = env.length;
  const times = beatFrames.map((b) => {
    const a = env[Math.max(0, b - 1)], v = env[b], c = env[Math.min(n - 1, b + 1)];
    const den = a - 2 * v + c;
    const dx = den < 0 && v >= a && v >= c ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
    return (b + dx + ONSET_BIAS_FRAMES) * hop;
  });
  const P0 = tempo.periodFrames * hop;
  const result = { bpm: round2(tempo.bpm), offset: 0, confidence: 0, mode: 'none', beats: times, period: P0 };
  if (times.length < 8) return result;

  // 1) period + phase with the most coherent beat phases (weighted by onset strength at the beat):
  //    R(p) = |Σ w·e^{2πi·t/p}|, searched ±1 % around the autocorrelation tempo, coarse → fine.
  //    Using absolute phase (not beat counting) makes this immune to skipped / doubled beats in breaks.
  const w = beatFrames.map((b) => 0.2 + Math.min(3, env[b]));
  const span = Math.max(1, times[times.length - 1] - times[0]);
  const coherence = (q) => {
    let cr = 0, ci = 0;
    const k = (2 * Math.PI) / q;
    for (let i = 0; i < times.length; i++) { const ang = times[i] * k; cr += w[i] * Math.cos(ang); ci += w[i] * Math.sin(ang); }
    return [Math.hypot(cr, ci), Math.atan2(ci, cr)];
  };
  const fine = Math.max(1e-6, (0.01 * P0 * P0) / span);
  let bestP = P0, bestR = -1, bestPh = 0;
  const scan = (from, to, step) => {
    for (let q = from; q <= to; q += step) {
      const [R, ph] = coherence(q);
      if (R > bestR) { bestR = R; bestP = q; bestPh = ph; }
    }
  };
  scan(P0 * 0.99, P0 * 1.01, fine * 6);
  scan(bestP - fine * 6, bestP + fine * 6, fine);
  let p = bestP;
  let a = (bestPh / (2 * Math.PI)) * p;
  // 2) refine with a weighted least-squares line through the in-phase beats
  let inl = times.map(() => true);
  let idx = times.map((t) => Math.round((t - a) / p));
  for (let iter = 0; iter < 3; iter++) {
    const tol = Math.max(0.015, 0.06 * p);
    idx = times.map((t) => Math.round((t - a) / p));
    inl = times.map((t, i) => Math.abs(t - (a + p * idx[i])) < tol);
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < times.length; i++) {
      if (!inl[i]) continue;
      const wi = w[i];
      sw += wi; sx += wi * idx[i]; sy += wi * times[i]; sxx += wi * idx[i] * idx[i]; sxy += wi * idx[i] * times[i];
    }
    const den = sw * sxx - sx * sx;
    if (!(den > 0)) break;
    const p2 = (sw * sxy - sx * sy) / den;
    if (!(Math.abs(p2 / p - 1) < 0.01)) break;
    p = p2;
    a = (sy - p * sx) / sw;
  }
  const globalBpm = 60 / p;

  // grid quality: how many (strength-weighted) onsets sit near a 1/4-beat point of each candidate grid
  const globalPos = (t) => (t - a) / p;
  const localPos = (t) => beatPosLocal(times, t, P0);
  const qGlobal = gridAgreement(peaks, globalPos, p);
  const qLocal = gridAgreement(peaks, localPos, P0);
  let wIn = 0, wAll = 0;
  for (let i = 0; i < times.length; i++) { wAll += w[i]; if (inl[i]) wIn += w[i]; }
  const inlierFrac = wIn / wAll;
  let mode, conf, period;
  if (Number.isFinite(globalBpm) && globalBpm > 40 && globalBpm < 400 && inlierFrac > 0.5 && qGlobal >= qLocal - 0.03) {
    mode = 'global'; conf = qGlobal; period = p;
  } else {
    mode = 'local'; conf = qLocal; period = P0;
  }
  if (conf < 0.3) mode = 'none';
  let beats = mode === 'global' ? times.map((_, i) => a + p * idx[i]) : smoothBeats(times, P0);
  let posFn = mode === 'global' ? (t) => (t - a) / p : (t) => beatPosLocal(beats, t, P0);
  // Beats come from the (smoothed) envelope, onsets from peak picking: align the grid's phase to the strong
  // onsets themselves (weighted median of their distance to the nearest 1/4 point).
  if (mode !== 'none') {
    const res = [];
    for (const pk of peaks) {
      if (pk.strength < 0.4) continue;
      const b = posFn(pk.t);
      const r = (b - Math.round(b * 4) / 4) * period;
      if (Math.abs(r) < Math.min(0.03, period / 10)) res.push(r);
    }
    if (res.length >= 8) {
      res.sort((x, y) => x - y);
      const shift = res[res.length >> 1];
      if (mode === 'global') { a += shift; posFn = (t) => (t - a) / p; beats = beats.map((t) => t + shift); }
      else { beats = beats.map((t) => t + shift); posFn = (t) => beatPosLocal(beats, t, P0); }
    }
  }
  const bpm = mode === 'global' ? globalBpm : tempo.bpm;
  let offset = mode === 'global' ? a : beats[0];
  offset = ((offset % period) + period) % period;
  return { bpm: round2(bpm), offset: round4(offset), confidence: round2(Math.max(0, conf)), mode, beats, period, pos: posFn, a, p, times: beats };
}

/** Remove frame-quantisation jitter from tracked beats: local line fit over ±3 beats where the tempo is steady. */
function smoothBeats(times, P0) {
  const n = times.length;
  const out = times.slice();
  const R = 3;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - R), hi = Math.min(n - 1, i + R);
    if (hi - lo < 3) continue;
    let steady = true;
    for (let j = lo + 1; j <= hi; j++) { const d = times[j] - times[j - 1]; if (Math.abs(d / P0 - 1) > 0.15) { steady = false; break; } }
    if (!steady) continue;
    let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
    for (let j = lo; j <= hi; j++) { const x = j - i; sx += x; sy += times[j]; sxx += x * x; sxy += x * times[j]; m++; }
    const den = m * sxx - sx * sx;
    if (den > 0) out[i] = (sy - ((m * sxy - sx * sy) / den) * sx) / m; // intercept at x = 0
  }
  return out;
}

function beatPosLocal(times, t, P0) {
  const m = times.length;
  if (t <= times[0]) return (t - times[0]) / P0;
  if (t >= times[m - 1]) return m - 1 + (t - times[m - 1]) / P0;
  let lo = 0, hi = m - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
  return lo + (t - times[lo]) / (times[hi] - times[lo]);
}

function beatTimeLocal(times, pos, P0) {
  const m = times.length;
  if (pos <= 0) return times[0] + pos * P0;
  if (pos >= m - 1) return times[m - 1] + (pos - (m - 1)) * P0;
  const i = Math.floor(pos), f = pos - i;
  return times[i] + f * (times[i + 1] - times[i]);
}

/** 0 = random w.r.t. the 1/4 grid, 1 = every onset on it (strength-weighted). */
function gridAgreement(peaks, posFn, period) {
  const tol = Math.min(0.025, period / 12);
  const chance = Math.min(1, (2 * tol) / (period / 4));
  let hit = 0, tot = 0;
  for (const pk of peaks) {
    const w = pk.strength;
    const b = posFn(pk.t);
    const d = Math.abs(b - Math.round(b * 4) / 4) * period;
    tot += w;
    if (d <= tol) hit += w;
  }
  if (!tot) return 0;
  return (hit / tot - chance) / (1 - chance);
}

// ---- 6. snapping -----------------------------------------------------------------------------

// [subdivision per beat, max distance in seconds]
const SNAP_GRIDS = [[4, 0.02], [3, 0.015], [8, 0.01], [6, 0.008]];

function snapOnsets(peaks, grid) {
  const out = [];
  const snap = grid.mode !== 'none';
  const period = grid.period;
  const tolScale = grid.mode === 'global' ? 1 : 0.6; // a tracked (local) grid is less exact
  for (const pk of peaks) {
    let t = pk.t, beatPos = null, snapped = false;
    if (snap) {
      const b = grid.pos(pk.t);
      // coarse grids first; finer subdivisions only for onsets that are already very close to them
      for (const [div, tolMs] of SNAP_GRIDS) {
        const q = Math.round(b * div) / div;
        const d = Math.abs(b - q) * period;
        if (d <= tolMs * tolScale) {
          t = grid.mode === 'global' ? grid.a + grid.p * q : beatTimeLocal(grid.times, q, period);
          beatPos = q;
          snapped = true;
          break;
        }
      }
      if (!snapped) beatPos = b;
    }
    out.push({
      t: round4(Math.max(0, t)), raw: round4(pk.t), strength: pk.strength, snapped, beatPos,
      energy: pk.energy, midi: pk.midi ? Math.round(pk.midi) : null, low: pk.low, mid: pk.mid, high: pk.high,
    });
  }
  // two onsets snapped onto the same grid point → keep the stronger
  out.sort((x, y) => x.t - y.t);
  const merged = [];
  for (const o of out) {
    const prev = merged[merged.length - 1];
    if (prev && o.t - prev.t < 0.012) { if (o.strength > prev.strength) merged[merged.length - 1] = o; } else merged.push(o);
  }
  return merged;
}

// ---- 7. difficulties -------------------------------------------------------------------------

function scoreCandidates(rhythm) {
  const conf = rhythm.grid !== 'none' ? rhythm.confidence : 0;
  return rhythm.onsets.map((o) => {
    let metric = 0;
    if (o.snapped && o.beatPos != null) {
      const frac = ((o.beatPos % 1) + 1) % 1;
      if (frac < 1e-6 || frac > 1 - 1e-6) metric = 0.15;
      else if (Math.abs(frac - 0.5) < 1e-6) metric = 0.07;
    }
    // kicks / snares feel better to aim at than hats: slight preference to low+mid content
    const tot = o.low + o.mid + o.high || 1;
    const body = (o.low + o.mid) / tot;
    const score = o.strength * (0.55 + 0.6 * o.energy) * (0.85 + 0.15 * body) + metric * conf;
    return { t: o.t, strength: o.strength, score, midi: o.midi };
  });
}

/**
 * Greedy selection by score with a minimum gap. `sorted` = candidates by score, descending.
 * Returns the accepted candidates in acceptance (= score) order: any prefix of it also respects the gap.
 */
function selectOrder(sorted, gap, floor) {
  const buckets = new Map();
  const chosen = [];
  const eps = 1e-6;
  for (const c of sorted) {
    if (c.score < floor) break;
    const k = Math.floor(c.t / gap);
    let ok = true;
    for (let j = k - 1; j <= k + 1 && ok; j++) {
      const arr = buckets.get(j);
      if (arr) for (const t of arr) if (Math.abs(t - c.t) < gap - eps) { ok = false; break; }
    }
    if (!ok) continue;
    const arr = buckets.get(k);
    if (arr) arr.push(c.t); else buckets.set(k, [c.t]);
    chosen.push(c);
  }
  return chosen;
}

const byTime = (a, b) => a.t - b.t;

/**
 * Fill long note-free stretches (quiet intros / breakdowns that lost to louder sections) with the
 * best-scoring onsets inside them, keeping the minimum gap. `pool` = candidates sorted by time.
 */
function fillRests(sel, pool, poolT, gap, maxRest) {
  if (!pool.length || !(maxRest > 0)) return sel;
  const out = sel.slice();
  const lowerBound = (t) => { let lo = 0, hi = poolT.length; while (lo < hi) { const m = (lo + hi) >> 1; if (poolT[m] < t) lo = m + 1; else hi = m; } return lo; };
  const stack = [];
  const edges = [pool[0].t - gap - 1e-6, ...out.map((c) => c.t), pool[pool.length - 1].t + gap + 1e-6];
  for (let i = 1; i < edges.length; i++) if (edges[i] - edges[i - 1] > maxRest) stack.push([edges[i - 1], edges[i]]);
  let guard = 0;
  while (stack.length && guard++ < 5000) {
    const [a, b] = stack.pop();
    let best = null;
    for (let j = lowerBound(a + gap); j < pool.length && pool[j].t <= b - gap; j++) {
      const c = pool[j];
      // prefer strong onsets near the middle of the rest
      const mid = 1 - Math.abs((c.t - a) / (b - a) - 0.5);
      const v = c.score * (0.6 + 0.4 * mid);
      if (!best || v > best.v) best = { c, v };
    }
    if (!best) continue;
    out.push(best.c);
    if (best.c.t - a > maxRest) stack.push([a, best.c.t]);
    if (b - best.c.t > maxRest) stack.push([best.c.t, b]);
  }
  return out.length === sel.length ? sel : out.sort(byTime);
}

function toTimes(sel, period) {
  const streamGap = Math.max(0.1, Math.min(0.17, period ? period / 3 : 0.15));
  const n = sel.length;
  const fast = new Uint8Array(n);
  for (let i = 1; i < n; i++) if (sel[i].t - sel[i - 1].t <= streamGap) { fast[i] = 1; fast[i - 1] = 1; }
  const out = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && fast[j + 1] && sel[j + 1].t - sel[j].t <= streamGap) j++;
    const run = j - i + 1;
    for (let k = i; k <= j; k++) {
      const s = sel[k];
      out[k] = { t: s.t, strength: s.strength, midi: s.midi ?? null, stream: run >= 3 };
    }
    i = j + 1;
  }
  return out;
}

/**
 * Pick the note subset for one difficulty. The minimum gap (≥ the difficulty's floor gap) is the main
 * knob: widening it thins the densest passages first while leaving sparse sections intact. Candidate
 * gaps are tried on a geometric ladder (+ a refinement step) and the map whose computeStars() is closest
 * to the target wins; a map that is not denser than the previous difficulty is heavily penalised.
 */
function buildDifficulty(sorted, diff, rhythm, seed, prev) {
  const period = rhythm.bpm > 0 ? 60 / rhythm.bpm : 0.5;
  const orders = new Map();
  const order = (gap, floor) => {
    const key = gap.toFixed(5) + '|' + floor;
    if (!orders.has(key)) orders.set(key, selectOrder(sorted, gap, floor));
    return orders.get(key);
  };
  const pool = sorted.filter((c) => c.strength >= 0.15).sort(byTime);
  const poolT = pool.map((c) => c.t);
  const evalAt = (gap, floor, sd = seed, count = Infinity) => {
    const all = order(gap, floor);
    const sel = fillRests((count < all.length ? all.slice(0, count) : all.slice()).sort(byTime), pool, poolT, gap, diff.maxRest);
    const notes = placeNotes(toTimes(sel, period), { stars: diff.stars, seed: sd });
    return { notes, stars: notes.length > 1 ? computeStars(notes) : 0, gap, floor, seed: sd, count };
  };
  // distance to the target stars (overshooting is worse), must not be sparser than the easier difficulty
  const cost = (r) => {
    let c = Math.abs(r.stars - diff.stars) + (r.stars > diff.stars ? 0.25 * (r.stars - diff.stars) : 0);
    if (prev) {
      if (r.notes.length < prev.count) c += 20;
      else if (r.notes.length === prev.count) c += 3;
      if (r.stars <= prev.stars) c += 2;
    }
    if (r.notes.length < 2) c += 100;
    return c;
  };
  let best = null, bestCost = Infinity;
  const consider = (r) => { const c = cost(r); if (c < bestCost) { best = r; bestCost = c; } return r; };

  // A) widen the minimum gap on a geometric ladder: thins the densest passages first
  const STEPS = 9, RANGE = 8;
  const ratio = Math.pow(RANGE, 1 / (STEPS - 1));
  for (let i = 0; i < STEPS; i++) consider(evalAt(diff.minGap * Math.pow(ratio, i), diff.floor));
  if (best.stars < diff.stars) consider(evalAt(diff.minGap, Math.min(diff.floor, 0.05))); // sparse songs: weak onsets too
  let step = Math.sqrt(ratio);
  for (let k = 0; k < 2 && best.gap > diff.minGap * 1.0001; k++, step = Math.sqrt(step)) {
    const g = best.gap, fl = best.floor;
    consider(evalAt(Math.max(diff.minGap, g / step), fl));
    consider(evalAt(g * step, fl));
  }
  // B) keep the tightest gap but only the k best-scoring notes (drops weak / quiet-section notes first);
  //    stars grow ~monotonically with k → bisection. Gives the in-between densities the ladder skips.
  const full = order(diff.minGap, diff.floor).length;
  let lo = Math.min(full, Math.max(2, Math.round((prev ? prev.count : 0) * 0.9))), hi = full;
  for (let it = 0; it < 8 && hi - lo > 2; it++) {
    const k = (lo + hi) >> 1;
    const r = consider(evalAt(diff.minGap, diff.floor, seed, k));
    if (r.stars > diff.stars) hi = k; else lo = k;
  }
  // placement randomness moves the stars too: try alternative floors / pattern seeds around the winner
  const g = best.gap, fl = best.floor, cnt = best.count;
  if (cnt === Infinity) { consider(evalAt(g, fl * 0.5)); consider(evalAt(g, fl * 1.8)); }
  consider(evalAt(g, fl, (seed ^ 0x5bd1e995) >>> 0, cnt));
  consider(evalAt(g, fl, (seed ^ 0x27d4eb2f) >>> 0, cnt));
  return {
    difficultyId: diff.id,
    difficultyName: diff.name,
    notes: best.notes.map((n) => ({ t: n.t, x: n.x, y: n.y })),
    stars: Math.round(best.stars * 100) / 100,
    minGap: round4(best.gap),
  };
}

function round2(v) { return Math.round(v * 100) / 100; }
function round4(v) { return Math.round(v * 10000) / 10000; }
