// Worker pool for МУХА's training in the browser.
//
//   const pool = new TrainerPool({ size: 4 });
//   pool.arch = session.arch; pool.hand = session.hand;
//   const { fitness, acc } = await pool.evaluate(candidates, episodes);
//   const { skill, perLevel } = await pool.benchmark(arch, params, hand);
//
// * Workers are created from the bundled source string __TRAINER_WORKER_SRC__ (see tools/build.mjs)
//   through a Blob URL, so the single-file build still gets real parallelism.
// * Each worker must answer a ping before it is trusted. If workers are unavailable (no source,
//   Worker constructor throws, CSP blocks blob: workers, the worker crashes…) the pool FALLS BACK to
//   the main thread and evaluates in small time slices (≤ sliceMs per task, yielding through a
//   MessageChannel) so the page keeps rendering. Tasks in flight on a worker that dies are re-run
//   locally, so a generation never gets lost.
// * trainGeneration() is an async twin of TrainingSession.step() whose benchmark also runs on the
//   pool (split per level across workers) instead of blocking the main thread for ~0.7 s.

import { runEpisode } from './agent.js';
import { episodeNotes, registerTrainingMap, clearTrainingMaps, skillFromLevels, BENCH_LEVELS } from './trainer.js';
import { benchEpisode, BENCH_RUNS, netFor } from './worker.js';

/* global __TRAINER_WORKER_SRC__ */
function bundledWorkerSource() {
  try {
    return typeof __TRAINER_WORKER_SRC__ === 'string' ? __TRAINER_WORKER_SRC__ : '';
  } catch {
    return '';
  }
}

export function hardwareThreads() {
  const n = typeof navigator !== 'undefined' && navigator.hardwareConcurrency;
  return Math.max(1, Math.min(32, n || 4));
}

/** Training speed presets → worker count (and main-thread slice budget when there are no workers). */
export const SPEEDS = {
  eco: { id: 'eco', ru: 'эко', en: 'eco', workers: (hc) => Math.max(1, Math.round(hc / 4)), sliceMs: 5 },
  norm: { id: 'norm', ru: 'норма', en: 'normal', workers: (hc) => Math.max(1, hc > 2 ? hc - 1 : hc), sliceMs: 9 },
  turbo: { id: 'turbo', ru: 'турбо', en: 'turbo', workers: (hc) => hc, sliceMs: 12 },
};

// ---- cooperative yielding (main-thread fallback) --------------------------------------------------

let yieldTask;
if (typeof document !== 'undefined' && typeof MessageChannel !== 'undefined') {
  // browser: a MessageChannel task is not clamped like nested setTimeout(0) (≥ 4 ms)
  const ch = new MessageChannel();
  const queue = [];
  ch.port1.onmessage = () => { const r = queue.shift(); if (r) r(); };
  yieldTask = () => new Promise((resolve) => { queue.push(resolve); ch.port2.postMessage(0); });
} else if (typeof setImmediate === 'function') {
  yieldTask = () => new Promise((resolve) => setImmediate(resolve)); // Node (tests)
} else {
  yieldTask = () => new Promise((resolve) => setTimeout(resolve, 0));
}
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ------------------------------------------------------------------------------------------------

export class TrainerPool {
  /**
   * @param {object} o
   * @param {number} [o.size]            number of workers (default: hardwareConcurrency - 1)
   * @param {string} [o.source]          worker source (default: bundled __TRAINER_WORKER_SRC__)
   * @param {number} [o.sliceMs]         main-thread slice budget in fallback mode
   * @param {boolean} [o.forceMain]      never use workers (tests / debugging)
   * @param {number} [o.readyTimeout]    ms to wait for a worker's first pong
   */
  constructor({ size = SPEEDS.norm.workers(hardwareThreads()), source = bundledWorkerSource(), sliceMs = 12, forceMain = false, readyTimeout = 6000 } = {}) {
    this.source = source || '';
    this.sliceMs = sliceMs;
    this.readyTimeout = readyTimeout;
    this.forceMain = forceMain;
    this.arch = null;
    this.hand = null;
    this.entries = [];
    this.maps = new Map();
    this.closed = false;
    this.mode = 'init';           // 'init' | 'workers' | 'main'
    this.fallbackReason = '';
    this.onstatus = null;         // (pool) => void — mode / size changes
    this._id = 0;
    this._url = null;
    this._target = Math.max(1, size | 0);
    this._init = this._start();
  }

  /** Number of workers currently doing work (0 on the main-thread fallback). */
  get size() { return this._alive().length; }
  get target() { return this._target; }
  get usingWorkers() { return this.mode === 'workers'; }
  /** Resolves once the pool knows whether workers work. */
  ready() { return this._init; }

  async _start() {
    if (this.forceMain) return this._fallback('forced');
    if (typeof Worker === 'undefined') return this._fallback('no Worker API');
    if (!this.source) return this._fallback('no worker source');
    for (let i = 0; i < this._target; i++) {
      const e = this._spawn();
      if (!e) break;
    }
    if (!this.entries.length) return this._fallback(this.fallbackReason || 'worker creation failed');
    await Promise.all(this.entries.map((e) => e.ready));
    if (!this._alive().length) return this._fallback(this.fallbackReason || 'workers did not start');
    this.mode = 'workers';
    this._status();
    return this.mode;
  }

  _fallback(reason) {
    this.fallbackReason = reason;
    this.mode = 'main';
    for (const e of this.entries) this._kill(e, false);
    this.entries = [];
    this._status();
    return this.mode;
  }

  _status() { try { this.onstatus && this.onstatus(this); } catch (e) { console.error(e); } }

  _blobUrl() {
    if (!this._url) this._url = URL.createObjectURL(new Blob([this.source], { type: 'text/javascript' }));
    return this._url;
  }

  _spawn() {
    let w;
    try {
      w = new Worker(this._blobUrl(), { name: 'muxa-trainer' });
    } catch (err) {
      this.fallbackReason = 'Worker() threw: ' + (err && err.message || err);
      return null;
    }
    const entry = { w, pending: new Map(), ok: false, alive: true, retiring: false, ready: null, _settle: null };
    entry.ready = new Promise((resolve) => {
      const timer = setTimeout(() => settle(false, 'timeout'), this.readyTimeout);
      const settle = (ok, why) => {
        if (!entry._settle) return;
        entry._settle = null;
        clearTimeout(timer);
        entry.ok = ok && entry.alive;
        if (!ok) { this.fallbackReason = 'worker ' + why; this._kill(entry, true); }
        resolve(entry.ok);
      };
      entry._settle = settle;
    });
    w.onmessage = (e) => this._onMessage(entry, e.data);
    w.onerror = (e) => {
      if (e && e.preventDefault) e.preventDefault();
      const why = 'error: ' + ((e && e.message) || 'unknown');
      if (entry._settle) entry._settle(false, why);
      else { this.fallbackReason = 'worker ' + why; this._kill(entry, true); }
    };
    w.onmessageerror = () => this._kill(entry, true);
    try {
      for (const [key, packed] of this.maps) w.postMessage({ type: 'map', key, packed });
      w.postMessage({ type: 'ping', id: 0 });
    } catch {
      this._kill(entry, true);
      return null;
    }
    this.entries.push(entry);
    return entry;
  }

  _alive() { return this.entries.filter((e) => e.ok && e.alive && !e.retiring); }

  _kill(entry, recover) {
    if (!entry.alive) return;
    entry.alive = false;
    try { entry.w.terminate(); } catch { /* ignore */ }
    const pending = Array.from(entry.pending.values());
    entry.pending.clear();
    this.entries = this.entries.filter((e) => e !== entry);
    for (const p of pending) {
      if (recover) p.recover().then(p.resolve, p.reject);
      else p.reject(new Error('pool terminated'));
    }
    if (recover && this.mode === 'workers' && !this._alive().length && !this.closed) {
      this.mode = 'main';
      this._status();
    }
  }

  _onMessage(entry, data) {
    if (!data) return;
    if (data.type === 'pong') {
      if (entry._settle) entry._settle(true);
      return;
    }
    const p = entry.pending.get(data.id);
    if (!p) return;
    entry.pending.delete(data.id);
    if (data.error) {
      console.warn('[МУХА] worker task failed, retrying on main thread:', data.error);
      p.recover().then(p.resolve, p.reject);
    } else {
      p.resolve(data);
    }
    if (entry.retiring && !entry.pending.size) this._kill(entry, true);
  }

  _call(entry, msg, transfer, recover) {
    return new Promise((resolve, reject) => {
      const id = ++this._id;
      entry.pending.set(id, { resolve, reject, recover });
      try {
        entry.w.postMessage({ ...msg, id }, transfer);
      } catch (err) {
        entry.pending.delete(id);
        console.warn('[МУХА] postMessage failed, running on main thread:', err);
        recover().then(resolve, reject);
      }
    });
  }

  /** Change the number of workers (spawns / retires workers; no effect in main-thread mode). */
  setSize(n) {
    this._target = Math.max(1, n | 0);
    if (this.mode !== 'workers') return;
    const alive = this._alive();
    if (alive.length > this._target) {
      for (const e of alive.slice(this._target)) {
        e.retiring = true;
        if (!e.pending.size) this._kill(e, true);
      }
      this._status();
    } else {
      const spawned = [];
      for (let i = alive.length; i < this._target; i++) {
        const e = this._spawn();
        if (e) spawned.push(e);
      }
      Promise.all(spawned.map((e) => e.ready)).then(() => this._status());
    }
  }

  /** Register a custom (user) map for training on every worker + the main thread. */
  registerMap(key, packed) {
    this.maps.set(key, packed);
    registerTrainingMap(key, packed);
    for (const e of this.entries) {
      try { e.w.postMessage({ type: 'map', key, packed }); } catch { /* worker will be replaced */ }
    }
  }

  clearMaps() {
    this.maps.clear();
    clearTrainingMaps();
    for (const e of this.entries) {
      try { e.w.postMessage({ type: 'clearMaps' }); } catch { /* ignore */ }
    }
  }

  /**
   * Evaluate candidates (Float32Array[]) on episode descriptors.
   * @returns {Promise<{fitness:number[], acc:number[]}>}  same values as trainer.evaluateCandidates
   */
  async evaluate(candidates, episodes, { arch = this.arch, hand = this.hand } = {}) {
    if (!arch || !hand) throw new Error('TrainerPool.evaluate: arch / hand not set');
    await this._init;
    const live = this._alive();
    if (!live.length) return this._evalLocal(arch, candidates, episodes, hand);
    const P = candidates[0].length;
    const chunks = live.map(() => []);
    candidates.forEach((_, i) => chunks[i % live.length].push(i));
    const parts = await Promise.all(live.map((entry, wi) => {
      const idx = chunks[wi];
      if (!idx.length) return { fitness: [], acc: [] };
      // one buffer per worker, transferred (zero-copy); views keep the Float32Array[] contract
      const buf = new Float32Array(idx.length * P);
      const views = idx.map((ci, k) => {
        const v = buf.subarray(k * P, (k + 1) * P);
        v.set(candidates[ci]);
        return v;
      });
      const recover = () => this._evalLocal(arch, idx.map((ci) => candidates[ci]), episodes, hand);
      return this._call(entry, { arch, hand, episodes, candidates: views }, [buf.buffer], recover);
    }));
    const fitness = new Array(candidates.length);
    const acc = new Array(candidates.length);
    parts.forEach((r, wi) => chunks[wi].forEach((ci, k) => { fitness[ci] = r.fitness[k]; acc[ci] = r.acc[k]; }));
    return { fitness, acc };
  }

  /** Skill benchmark (same result as trainer.benchmark), split per level across workers. */
  async benchmark(arch, params, hand) {
    await this._init;
    const live = this._alive();
    let perLevel;
    if (!live.length) {
      perLevel = await this._benchLocal(arch, params, hand, BENCH_LEVELS);
    } else {
      const groups = live.map(() => []);
      BENCH_LEVELS.forEach((L, i) => groups[i % live.length].push(L));
      const parts = await Promise.all(live.map((entry, wi) => {
        const levels = groups[wi];
        if (!levels.length) return [];
        const p = Float32Array.from(params);
        const recover = () => this._benchLocal(arch, params, hand, levels).then((perLevel) => ({ perLevel }));
        return this._call(entry, { type: 'bench', arch, params: p, hand, levels }, [p.buffer], recover).then((r) => r.perLevel);
      }));
      perLevel = parts.flat().sort((a, b) => a.level - b.level);
    }
    const clean = perLevel.map(({ level, acc }) => ({ level, acc }));
    return { skill: skillFromLevels(clean), perLevel: clean };
  }

  // ---- main-thread fallback (time-sliced) -------------------------------------------------------

  /** Exactly trainer.evaluateCandidates, but yielding every `sliceMs` (per episode granularity). */
  async _evalLocal(arch, candidates, episodes, hand) {
    const net = netFor(arch);
    const charts = episodes.map(episodeNotes);
    let totalNotes = 0;
    for (const c of charts) totalNotes += c.n;
    const fitness = new Array(candidates.length).fill(0);
    const acc = new Array(candidates.length).fill(0);
    let sliceStart = now();
    for (let i = 0; i < candidates.length; i++) {
      let f = 0, hits = 0;
      for (let e = 0; e < charts.length; e++) {
        if (!charts[e].n) continue;
        if (now() - sliceStart > this.sliceMs) { await yieldTask(); sliceStart = now(); }
        const r = runEpisode(net, charts[e], { params: candidates[i], hand });
        f += r.fitness * charts[e].n;
        hits += r.hits;
      }
      fitness[i] = totalNotes ? f / totalNotes : 0;
      acc[i] = totalNotes ? hits / totalNotes : 0;
    }
    return { fitness, acc };
  }

  async _benchLocal(arch, params, hand, levels) {
    const net = netFor(arch);
    const p = Float32Array.from(params);
    const out = [];
    let sliceStart = now();
    for (const level of levels) {
      let hits = 0, n = 0;
      for (let k = 0; k < BENCH_RUNS; k++) {
        if (now() - sliceStart > this.sliceMs) { await yieldTask(); sliceStart = now(); }
        const r = runEpisode(net, episodeNotes(benchEpisode(level, k)), { params: p, hand });
        hits += r.hits;
        n += r.n;
      }
      out.push({ level, acc: n ? hits / n : 0 });
    }
    return out;
  }

  terminate() {
    this.closed = true;
    for (const e of this.entries.slice()) this._kill(e, false);
    this.entries = [];
    if (this._url) { try { URL.revokeObjectURL(this._url); } catch { /* ignore */ } this._url = null; }
  }
}

// ------------------------------------------------------------------------------------------------

/**
 * Apply a benchmark result to a session (the same rules as TrainingSession.step()).
 * @param {Float32Array} params  the parameters that were benchmarked (becomes the champion if best)
 * @returns {{fastForward:boolean}}
 */
export function applyBenchmark(session, bench, params) {
  session.skill = bench.skill;
  session.perLevel = bench.perLevel;
  let fastForward = false;
  const cur = session.curriculum;
  if (bench.skill - 1 > cur.level) {
    cur.level = Math.min(cur.maxLevel, Math.floor((bench.skill - 1) * 2) / 2);
    fastForward = true;
  }
  if (bench.skill > session.bestSkill) {
    session.bestSkill = bench.skill;
    session.champion = Float32Array.from(params);
  }
  return { fastForward };
}

/**
 * One generation: runs TrainingSession.step() (so annealing, curriculum, bookkeeping stay
 * single-sourced in trainer.js) but with its synchronous benchmark disabled; when a benchmark is
 * due (gen 1 and every `benchEvery` gens) it runs through `benchmark(arch, params, hand)` —
 * asynchronously, on the worker pool — and is applied with the same rules as step().
 * Returns step()'s record (patched with the benchmark result) plus `accMean` (population mean
 * accuracy), `fastForward` (benchmark jumped the curriculum) and `benchMs`.
 *
 * @param {import('./trainer.js').TrainingSession} session
 * @param {(candidates:Float32Array[], episodes:object[]) => Promise<{fitness:number[], acc:number[]}>} evaluate
 * @param {null | ((arch:number[], params:Float32Array, hand:object) => Promise<{skill:number, perLevel:object[]}>)} benchmark
 * @param {{benchEvery?: number}} [opts]
 */
export async function trainGeneration(session, evaluate, benchmark, { benchEvery = 5 } = {}) {
  const firstGen = session.gen === 0;
  const savedEvery = session.benchEvery;
  let popAcc = null;
  let rec;
  // step() benchmarks when `gen % benchEvery === 0 || gen === 1` (checked right after `gen++`).
  // benchEvery = Infinity disables the first test; for the very first generation we shift `gen`
  // by -1.5 for that one check (it is only read again after the benchmark test) and restore it.
  session.benchEvery = Infinity;
  try {
    rec = await session.step(async (cands, eps) => {
      const res = await evaluate(cands, eps);
      popAcc = res.acc;
      if (firstGen) session.gen = -0.5;
      return res;
    });
  } finally {
    session.benchEvery = savedEvery;
    if (firstGen && session.gen !== 1 && session.gen < 1) session.gen = session.gen === 0.5 ? 1 : 0;
  }
  rec.gen = session.gen;

  let fastForward = false, benchMs = 0;
  if (benchmark && Number.isFinite(benchEvery) && benchEvery > 0 && (session.gen % benchEvery === 0 || session.gen === 1)) {
    const params = Float32Array.from(session.es.theta);
    const t0 = now();
    const bench = await benchmark(session.arch, params, session.hand);
    benchMs = now() - t0;
    fastForward = applyBenchmark(session, bench, params).fastForward;
    rec.bench = true;
    rec.skill = session.skill;
    rec.bestSkill = session.bestSkill;
    rec.level = session.curriculum.level;
  }
  let accSum = 0;
  const nc = popAcc ? popAcc.length - 1 : 0;
  for (let i = 0; i < nc; i++) accSum += popAcc[i];
  rec.accMean = nc ? accSum / nc : rec.acc;
  rec.fastForward = fastForward;
  rec.benchMs = benchMs;
  return rec;
}
