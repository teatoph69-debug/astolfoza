// Web Worker entry for МУХА's training (bundled by tools/build.mjs into __TRAINER_WORKER_SRC__).
//
// Messages (main → worker):
//   { type: 'ping', id }                                   → { type: 'pong', id }
//   { type: 'map', key, packed }                           → (no reply) register a custom training map
//   { type: 'clearMaps' }                                  → (no reply)
//   { type: 'bench', id, arch, params, hand, levels }      → { id, perLevel: [{level, acc, hits, n}] }
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
