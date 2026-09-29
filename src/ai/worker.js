// Web Worker entry for МУХА's training (bundled by tools/build.mjs into __TRAINER_WORKER_SRC__).
//
// Messages (main → worker):
//   { type: 'ping', id }                                   → { type: 'pong', id }
//   { type: 'map', key, packed }                           → (no reply) register a custom training map
//   { type: 'clearMaps' }                                  → (no reply)
//   { type: 'bench', id, arch, params, hand, levels }      → { id, perLevel: [{level, acc, hits, n}] }
//   { type: 'benchRuns', id, arch, params, hand, runs }    → { id, hits: Int32Array, n: Int32Array }
//   { type: 'units', id, arch, candidates, c0, episodes, u0, u1, hand } → { id, fit: Float64Array, hits: Int32Array }
//   { id, arch, candidates, episodes, hand }               → { id, fitness: Float64Array, acc: Float64Array }
//
// `candidates` is an array of Float32Array views; the pool packs them into ONE ArrayBuffer and
// transfers it, so a 49 × 2k-param population crosses the thread boundary without copying.
//
// The handler is a pure function (`handleMessage`) so it can be unit-tested in Node and reused by
// the main-thread fallback in pool.js.

import { evaluateCandidates, registerTrainingMap, clearTrainingMaps, episodeNotes, BENCH_LEVELS, BENCH_DUR } from './trainer.js';
import { runEpisode } from './agent.js';
import { MLP } from './nn.js';

// ---- benchmark, split per level ----------------------------------------------------------------
// Mirrors trainer.js benchmark(): two fixed 20-second charts per level, seed 90001 + L·31 + k·7.
// Splitting per level lets the pool spread the (≈0.7 s single-threaded) benchmark across workers.

export const BENCH_RUNS = 2;
export function benchEpisode(level, k) {
  return { kind: 'synth', level, seed: 90001 + level * 31 + k * 7, dur: BENCH_DUR };
}

const netCache = new Map();
export function netFor(arch) {
  const key = arch.join(',');
  let net = netCache.get(key);
  if (!net) {
    net = new MLP(arch);
    netCache.set(key, net);
  }
  return net;
}

/** Benchmark accuracy for a subset of levels (default: all). */
export function benchLevels(arch, params, hand, levels = BENCH_LEVELS) {
  const net = netFor(arch);
  const out = [];
  for (const level of levels) {
    let hits = 0, n = 0;
    for (let k = 0; k < BENCH_RUNS; k++) {
      const r = runEpisode(net, episodeNotes(benchEpisode(level, k)), { params, hand });
      hits += r.hits;
      n += r.n;
    }
    out.push({ level, acc: n ? hits / n : 0, hits, n });
  }
  return out;
}

/**
 * Evaluate a contiguous range of work units. Unit u = (candidate ⌊u/E⌋, episode u mod E), so the
 * pool can split a generation evenly across any number of workers (24 workers, 49 candidates).
 * `candidates[k]` holds candidate c0 + k. Returns per-unit raw episode fitness and hits; the pool
 * sums them in the same order as evaluateCandidates, so the result is bit-identical.
 */
export function evaluateUnits(arch, candidates, c0, episodes, u0, u1, hand) {
  const net = netFor(arch);
  const E = episodes.length;
  const charts = new Array(E);
  const fit = new Float64Array(u1 - u0);
  const hits = new Int32Array(u1 - u0);
  for (let u = u0; u < u1; u++) {
    const ci = Math.floor(u / E), e = u - ci * E;
    const chart = charts[e] || (charts[e] = episodeNotes(episodes[e]));
    if (!chart.n) continue;
    const r = runEpisode(net, chart, { params: candidates[ci - c0], hand });
    fit[u - u0] = r.fitness;
    hits[u - u0] = r.hits;
  }
  return { fit, hits };
}

/** Benchmark runs [[level, k], …] → per-run hits / note counts. */
export function benchRuns(arch, params, hand, runs) {
  const net = netFor(arch);
  const hits = new Int32Array(runs.length);
  const n = new Int32Array(runs.length);
  runs.forEach(([level, k], i) => {
    const r = runEpisode(net, episodeNotes(benchEpisode(level, k)), { params, hand });
    hits[i] = r.hits;
    n[i] = r.n;
  });
  return { hits, n };
}

// ---- message handler ---------------------------------------------------------------------------

/**
 * Handle one message. Returns `null` (no reply) or `{ reply, transfer }`.
 */
export function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  switch (msg.type) {
    case 'ping':
      return { reply: { type: 'pong', id: msg.id }, transfer: [] };
    case 'map':
      registerTrainingMap(msg.key, msg.packed);
      return null;
    case 'clearMaps':
      clearTrainingMaps();
      return null;
    case 'units': {
      const { id, arch, candidates, c0, episodes, u0, u1, hand } = msg;
      const { fit, hits } = evaluateUnits(arch, candidates.map(toF32), c0, episodes, u0, u1, hand);
      return { reply: { id, fit, hits }, transfer: [fit.buffer, hits.buffer] };
    }
    case 'benchRuns': {
      const { hits, n } = benchRuns(msg.arch, toF32(msg.params), msg.hand, msg.runs);
      return { reply: { id: msg.id, hits, n }, transfer: [hits.buffer, n.buffer] };
    }
    case 'bench': {
      const perLevel = benchLevels(msg.arch, toF32(msg.params), msg.hand, msg.levels || BENCH_LEVELS);
      return { reply: { id: msg.id, perLevel }, transfer: [] };
    }
    default: {
      const { id, arch, candidates, episodes, hand } = msg;
      const res = evaluateCandidates(arch, candidates.map(toF32), episodes, hand);
      const fitness = Float64Array.from(res.fitness);
      const acc = Float64Array.from(res.acc);
      return { reply: { id, fitness, acc }, transfer: [fitness.buffer, acc.buffer] };
    }
  }
}

function toF32(a) {
  return a instanceof Float32Array ? a : Float32Array.from(a);
}

// ---- install when running inside a dedicated worker ----------------------------------------------

const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;
if (inWorker) {
  self.onmessage = (e) => {
    const msg = e.data;
    let out;
    try {
      out = handleMessage(msg);
    } catch (err) {
      self.postMessage({ id: msg && msg.id, error: String((err && err.stack) || err) });
      return;
    }
    if (out) self.postMessage(out.reply, out.transfer);
  };
}
