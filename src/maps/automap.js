// Auto-mapper: turns any audio into playable maps (5 difficulties).
//
// Pipeline (pure JS, no dependencies, ~0.3–0.6 s for a 3-minute song):
//   1. downmix to mono, decimate to ~22 kHz, loudness-normalise;
//   2. STFT (1024-point Hann, hop 256 ≈ 11.6 ms) with a small radix-2 real FFT;
//   3. log-magnitude spectral flux ("SuperFlux"-style: compared with a frequency-max-filtered frame two hops
//      back) in three bands — low (kick/bass), mid (snare body/instruments/vocals), high (hats/noise);
//   4. onset detection function = weighted, per-band-normalised flux; adaptive threshold (moving mean) and
//      peak picking; sub-frame timing by parabolic interpolation;
//   5. tempo: autocorrelation of the onset envelope scored with a harmonic comb and a log-tempo prior that
//      prefers 90–200 BPM; beats: dynamic-programming beat tracker (Ellis 2007); a robust linear fit of the
//      beats gives a global grid (exact BPM + phase) when the song has a steady tempo, otherwise the tracked
//      beats are used as a local grid;
//   6. when the grid fits the onsets well, onsets are snapped to 1/4 beats (1/3 for clear triplets);
//   7. per difficulty: candidates are scored by onset strength × section loudness (+ metrical position),
//      then selected greedily with a minimum gap; the gap is widened by binary search until the map's
//      computeStars() hits the target. Fast runs are marked `stream: true`; `placeNotes` decides positions.

import { placeNotes } from './patterns.js';
import { computeStars } from '../core/map.js';
import { formatError } from './sspm.js';

export const AUTO_DIFFICULTIES = [
  { id: 'easy', name: 'Easy', stars: 1.2, minGap: 0.35, floor: 0.3 },
  { id: 'normal', name: 'Normal', stars: 2.8, minGap: 0.22, floor: 0.2 },
  { id: 'hard', name: 'Hard', stars: 4.8, minGap: 0.15, floor: 0.12 },
  { id: 'insane', name: 'Insane', stars: 6.8, minGap: 0.09, floor: 0.06 },
  { id: 'extreme', name: 'Extreme', stars: 9, minGap: 0.065, floor: 0.02 },
];

const N_FFT = 1024;
const HOP = 256;
// Systematic lag of flux peaks vs. the true onset for this window/hop/lag (measured on clicks and drums).
const ONSET_BIAS_FRAMES = 0.0;

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
  let prevCount = 0;
  for (let i = 0; i < difficulties.length; i++) {
    const d = difficulties[i];
    const m = buildDifficulty(cands, d, rhythm, (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0, prevCount);
    prevCount = m.notes.length;
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
    _energy: odf.energy,
    _hopSec: F.hopSec,
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
  if (dec === 1) {
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

/** Real FFT magnitude of a length-N (power of two) frame, computed with an N/2 complex FFT. */
export function makeRealFFT(N) {
  const M = N >> 1;
  const levels = Math.round(Math.log2(M));
  if (1 << levels !== M) throw new Error('FFT size must be a power of two');
  const rev = new Uint32Array(M);
  for (let i = 0; i < M; i++) {
    let r = 0;
    for (let b = 0, x = i; b < levels; b++, x >>= 1) r = (r << 1) | (x & 1);
    rev[i] = r;
  }
  const cosM = new Float64Array(M >> 1), sinM = new Float64Array(M >> 1);
  for (let i = 0; i < M >> 1; i++) { cosM[i] = Math.cos((2 * Math.PI * i) / M); sinM[i] = Math.sin((2 * Math.PI * i) / M); }
  const cosN = new Float64Array(M + 1), sinN = new Float64Array(M + 1);
  for (let k = 0; k <= M; k++) { cosN[k] = Math.cos((2 * Math.PI * k) / N); sinN[k] = Math.sin((2 * Math.PI * k) / N); }
  const re = new Float64Array(M), im = new Float64Array(M);

  /** input: length N real; outMag: length M + 1 (bins 0..N/2) */
  return function fftMag(input, outMag) {
    for (let i = 0; i < M; i++) { const j = rev[i]; re[j] = input[2 * i]; im[j] = input[2 * i + 1]; }
    for (let size = 2; size <= M; size <<= 1) {
      const half = size >> 1, step = M / size;
      for (let start = 0; start < M; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = cosM[t], wi = -sinM[t];
          const a = start + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
    // split the packed spectrum: E = (Z[k] + conj Z[M−k]) / 2, O = (Z[k] − conj Z[M−k]) / 2i, X = E + W^k O
    for (let k = 0; k <= M; k++) {
      const k1 = k === M ? 0 : k, k2 = k === 0 ? 0 : M - k;
      const zr = re[k1], zi = im[k1], cr = re[k2], ci = -im[k2];
      const er = (zr + cr) * 0.5, ei = (zi + ci) * 0.5;
      const dr = (zr - cr) * 0.5, di = (zi - ci) * 0.5;
      const or = di, oi = -dr;
      const wr = cosN[k], wi = -sinN[k];
      const xr = er + or * wr - oi * wi, xi = ei + or * wi + oi * wr;
      outMag[k] = Math.sqrt(xr * xr + xi * xi);
    }
  };
}

function spectralFeatures(x, sr) {
  const N = N_FFT, H = HOP, M = N >> 1;
  const nFrames = Math.max(1, Math.floor(x.length / H) + 1);
  const hopSec = H / sr;
  const fft = makeRealFFT(N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const bin = (f) => Math.max(1, Math.min(M, Math.round((f * N) / sr)));
  const b0 = bin(30), b1 = bin(200), b2 = bin(2500), b3 = Math.min(bin(10000), M - 1);
  const pLo = bin(120), pHi = bin(1400); // pitch search range (melody → note height)
  const frame = new Float32Array(N);
  const mag = new Float32Array(M + 1);
  // ring buffer of log spectra (current, −1, −2), max-filtered over ±1 bin for the reference
  const ring = [new Float32Array(M + 1), new Float32Array(M + 1), new Float32Array(M + 1)];
  const low = new Float32Array(nFrames), mid = new Float32Array(nFrames), high = new Float32Array(nFrames);
  const energy = new Float32Array(nFrames);
  const pitch = new Float32Array(nFrames);
  const GAMMA = 20;
  const invLo = 1 / (b1 - b0), invMid = 1 / (b2 - b1), invHi = 1 / (b3 - b2);
  for (let f = 0; f < nFrames; f++) {
    const start = f * H - (N >> 1); // frame f is centred on sample f·H
    if (start >= 0 && start + N <= x.length) {
      for (let i = 0; i < N; i++) frame[i] = x[start + i] * win[i];
    } else {
      for (let i = 0; i < N; i++) { const j = start + i; frame[i] = j >= 0 && j < x.length ? x[j] * win[i] : 0; }
    }
    fft(frame, mag);
    const L = ring[f % 3];
    const R = ring[(f + 1) % 3]; // = frame f − 2
    let e = 0;
    for (let k = 0; k <= b3; k++) { const m = mag[k]; e += m * m; L[k] = Math.log1p(GAMMA * m); }
    energy[f] = e;
    if (f >= 2) {
      let sl = 0, sm = 0, sh = 0;
      for (let k = b0; k < b3; k++) {
        let ref = R[k];
        if (R[k - 1] > ref) ref = R[k - 1];
        if (R[k + 1] > ref) ref = R[k + 1];
        const d = L[k] - ref;
        if (d > 0) { if (k < b1) sl += d; else if (k < b2) sm += d; else sh += d; }
      }
      low[f] = sl * invLo; mid[f] = sm * invMid; high[f] = sh * invHi;
    }
    // dominant pitch in the melody range, only when clearly tonal
    let best = 0, bk = 0, sum = 0;
    for (let k = pLo; k <= pHi; k++) { const m = mag[k]; sum += m; if (m > best) { best = m; bk = k; } }
    const avg = sum / (pHi - pLo + 1);
    pitch[f] = best > 6 * avg && best > 1e-3 ? 69 + 12 * Math.log2(((bk * sr) / N) / 440) : 0;
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
  const DELTA = 0.06;
  const peaks = [];
  let last = -1e9;
  for (let i = 2; i < n - 1; i++) {
    const v = o[i];
    if (v - mean[i] < DELTA) continue;
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
  const minBpm = 55, maxBpm = 250;
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
  const vals = scores.map((s) => s[1]).sort((p, q) => p - q);
  const median = vals[vals.length >> 1] || 0;
  return { bpm: bestB, periodFrames: 60 / bestB / hop, strength: best, peakiness: best > 0 ? 1 - median / best : 0 };
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
 * Fit a global tempo grid to the tracked beats (robust linear regression on beat index vs time).
 * Falls back to the tracked beats as a local grid when the tempo drifts; reports how well the
 * onsets agree with the grid (confidence 0..1).
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

  // beat indices from the gaps (tolerates skipped / doubled beats in breaks)
  const idx = [0];
  for (let i = 1; i < times.length; i++) idx.push(idx[i - 1] + Math.max(1, Math.round((times[i] - times[i - 1]) / P0)));
  const w = beatFrames.map((b) => 0.2 + Math.min(3, env[b]));
  let inl = times.map(() => true);
  let a = 0, p = P0;
  for (let iter = 0; iter < 4; iter++) {
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < times.length; i++) {
      if (!inl[i]) continue;
      const wi = w[i];
      sw += wi; sx += wi * idx[i]; sy += wi * times[i]; sxx += wi * idx[i] * idx[i]; sxy += wi * idx[i] * times[i];
    }
    const den = sw * sxx - sx * sx;
    if (!(den > 0)) break;
    p = (sw * sxy - sx * sy) / den;
    a = (sy - p * sx) / sw;
    const tol = Math.max(0.012, 0.06 * p) * (iter < 2 ? 2 : 1);
    inl = times.map((t, i) => Math.abs(t - (a + p * idx[i])) < tol);
  }
  const globalBpm = 60 / p;

  // grid quality: how many (strength-weighted) onsets sit near a 1/4-beat point of each candidate grid
  const globalPos = (t) => (t - a) / p;
  const localPos = (t) => beatPosLocal(times, t, P0);
  const qGlobal = gridAgreement(peaks, globalPos, p);
  const qLocal = gridAgreement(peaks, localPos, P0);
  const inlierFrac = inl.filter(Boolean).length / inl.length;
  let mode, conf, pos, period;
  if (Number.isFinite(globalBpm) && globalBpm > 40 && globalBpm < 400 && inlierFrac > 0.5 && qGlobal >= qLocal - 0.03) {
    mode = 'global'; conf = qGlobal; pos = globalPos; period = p;
  } else {
    mode = 'local'; conf = qLocal; pos = localPos; period = P0;
  }
  if (conf < 0.3) mode = 'none';
  const bpm = mode === 'global' ? globalBpm : tempo.bpm;
  let offset = mode === 'global' ? a : times[0];
  offset = ((offset % period) + period) % period;
  const beats = mode === 'global' ? times.map((_, i) => a + p * idx[i]) : times;
  return { bpm: round2(bpm), offset: round4(offset), confidence: round2(Math.max(0, conf)), mode, beats, period, pos, a, p, times };
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

function snapOnsets(peaks, grid) {
  const out = [];
  const snap = grid.mode !== 'none';
  const period = grid.period;
  for (const pk of peaks) {
    let t = pk.t, beatPos = null, snapped = false;
    if (snap) {
      const b = grid.pos(pk.t);
      const q4 = Math.round(b * 4) / 4, q3 = Math.round(b * 3) / 3;
      const d4 = Math.abs(b - q4) * period, d3 = Math.abs(b - q3) * period;
      let q = null;
      if (d4 <= Math.min(0.035, 0.1 * period)) q = q4;
      else if (d3 <= Math.min(0.02, 0.06 * period)) q = q3;
      if (q != null) {
        t = grid.mode === 'global' ? grid.a + grid.p * q : beatTimeLocal(grid.times, q, period);
        beatPos = q;
        snapped = true;
      } else beatPos = b;
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

/** Greedy selection by score with a minimum gap; returns time-sorted items. */
function selectNotes(cands, gap, floor) {
  const order = cands.filter((c) => c.score >= floor).sort((a, b) => b.score - a.score);
  const buckets = new Map();
  const chosen = [];
  const eps = 1e-6;
  for (const c of order) {
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
  chosen.sort((a, b) => a.t - b.t);
  return chosen;
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

function buildDifficulty(cands, diff, rhythm, seed, prevCount) {
  const period = rhythm.bpm > 0 ? 60 / rhythm.bpm : 0.5;
  const evalAt = (gap, floor) => {
    const sel = selectNotes(cands, gap, floor);
    const times = toTimes(sel, period);
    const notes = placeNotes(times, { stars: diff.stars, seed });
    return { notes, stars: computeStars(notes), gap, floor };
  };
  let best = evalAt(diff.minGap, diff.floor);
  if (best.stars < diff.stars || best.notes.length < prevCount) {
    // not hard enough even at the densest allowed spacing: also take the weaker onsets
    const all = evalAt(diff.minGap, 0);
    if (all.notes.length >= best.notes.length) best = all;
  } else {
    // too hard: widen the minimum gap (thins the densest passages first) until the stars fit
    let lo = diff.minGap, hi = Math.max(diff.minGap * 6, 2);
    let within = best;
    for (let it = 0; it < 12; it++) {
      const g = Math.sqrt(lo * hi);
      const r = evalAt(g, diff.floor);
      if (r.stars > diff.stars) lo = g;
      else { hi = g; within = r; }
      if (hi / lo < 1.03) break;
    }
    best = within;
    // never sparser than the easier difficulty
    if (best.notes.length < prevCount) {
      const denser = evalAt(lo, diff.floor);
      if (denser.notes.length >= prevCount) best = denser;
    }
  }
  const notes = best.notes.map((n) => ({ t: n.t, x: n.x, y: n.y }));
  return {
    difficultyId: diff.id,
    difficultyName: diff.name,
    notes,
    stars: Math.round(best.stars * 100) / 100,
    minGap: round4(best.gap),
  };
}

function round2(v) { return Math.round(v * 100) / 100; }
function round4(v) { return Math.round(v * 10000) / 10000; }
