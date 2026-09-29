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
import { benchEpisode, BENCH_RUNS, netFor, evaluateUnits, benchRuns } from './worker.js';

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

/**
 * Default worker count: leave two hardware threads for the page and the OS, cap at 24
 * (e.g. i9-14900HX: 32 threads → 24 workers; 4-thread laptop → 2 workers).
 */
export function defaultWorkers(hc = hardwareThreads()) {
  return Math.max(1, Math.min(hc - 2, 24));
}

/** Training speed presets → worker count (and main-thread slice budget when there are no workers). */
export const SPEEDS = {
  eco: { id: 'eco', ru: 'эко', en: 'eco', workers: (hc) => Math.max(1, Math.round(defaultWorkers(hc) / 2)), sliceMs: 5 },
  norm: { id: 'norm', ru: 'норма', en: 'normal', workers: (hc) => Math.max(1, Math.round(defaultWorkers(hc) * 0.75)), sliceMs: 9 },
  turbo: { id: 'turbo', ru: 'турбо', en: 'turbo', workers: (hc) => defaultWorkers(hc), sliceMs: 12 },
};
export const DEFAULT_SPEED = 'turbo';

/** Split [0, total) into `parts` contiguous, near-equal ranges (empty ones dropped). */
export function splitRanges(total, parts) {
  const out = [];
  for (let k = 0; k < parts; k++) {
    const a = Math.floor((k * total) / parts), b = Math.floor(((k + 1) * total) / parts);
    if (b > a) out.push([a, b]);
  }
  return out;
}

/**
 * Combine per-unit results (unit = candidate × episode) exactly like trainer.evaluateCandidates:
 * same summation order, so the fitness values are bit-identical.
 */
export function aggregateUnits(C, noteCounts, fitPair, hitsPair) {
  const E = noteCounts.length;
  let total = 0;
  for (const n of noteCounts) total += n;
  const fitness = new Array(C).fill(0);
  const acc = new Array(C).fill(0);
  for (let i = 0; i < C; i++) {
    let f = 0, hits = 0;
    for (let e = 0; e < E; e++) {
      const n = noteCounts[e];
      if (!n) continue;
      f += fitPair[i * E + e] * n;
      hits += hitsPair[i * E + e];
    }
    fitness[i] = total ? f / total : 0;
    acc[i] = total ? hits / total : 0;
  }
  return { fitness, acc };
}

/** The benchmark as a flat list of runs [[level, k], …] (21 levels × 2 charts). */
export const BENCH_RUN_LIST = BENCH_LEVELS.flatMap((L) => Array.from({ length: BENCH_RUNS }, (_, k) => [L, k]));

/** Per-run hits / notes → perLevel (same integer sums as trainer.benchmark). */
export function aggregateRuns(runs, hits, n) {
  const byLevel = new Map();
  runs.forEach(([L], i) => {
    const e = byLevel.get(L) || { hits: 0, n: 0 };
    e.hits += hits[i];
    e.n += n[i];
    byLevel.set(L, e);
  });
  return Array.from(byLevel.entries()).sort((a, b) => a[0] - b[0]).map(([level, e]) => ({ level, acc: e.n ? e.hits / e.n : 0 }));
}

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
  constructor({ size = defaultWorkers(), source = bundledWorkerSource(), sliceMs = 12, forceMain = false, readyTimeout = 6000 } = {}) {
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
   * The generation is cut into candidate × episode units, split evenly over the workers.
   * @returns {Promise<{fitness:number[], acc:number[]}>}  same values as trainer.evaluateCandidates
   */
  async evaluate(candidates, episodes, { arch = this.arch, hand = this.hand } = {}) {
    if (!arch || !hand) throw new Error('TrainerPool.evaluate: arch / hand not set');
    await this._init;
    const live = this._alive();
    if (!live.length) return this._evalLocal(arch, candidates, episodes, hand);
    const C = candidates.length, E = episodes.length;
    if (!C || !E) return { fitness: new Array(C).fill(0), acc: new Array(C).fill(0) };
    const P = candidates[0].length;
    const U = C * E;
    const fitPair = new Float64Array(U);
    const hitsPair = new Int32Array(U);
    const ranges = splitRanges(U, live.length);
    await Promise.all(ranges.map(([u0, u1], wi) => {
      const c0 = Math.floor(u0 / E), c1 = Math.floor((u1 - 1) / E) + 1;
      // one buffer per worker, transferred (zero-copy); views keep the Float32Array[] contract
      const buf = new Float32Array((c1 - c0) * P);
      const views = [];
      for (let c = c0; c < c1; c++) {
        const v = buf.subarray((c - c0) * P, (c - c0 + 1) * P);
        v.set(candidates[c]);
        views.push(v);
      }
      const recover = async () => {
        await yieldTask();
        return evaluateUnits(arch, candidates.slice(c0, c1), c0, episodes, u0, u1, hand);
      };
      return this._call(live[wi], { type: 'units', arch, hand, episodes, candidates: views, c0, u0, u1 }, [buf.buffer], recover)
        .then((r) => { fitPair.set(r.fit, u0); hitsPair.set(r.hits, u0); });
    }));
    const noteCounts = episodes.map((ep) => episodeNotes(ep).n);
    return aggregateUnits(C, noteCounts, fitPair, hitsPair);
  }

  /** Skill benchmark (same result as trainer.benchmark), its 42 runs split across workers. */
  async benchmark(arch, params, hand) {
    await this._init;
    const live = this._alive();
    let perLevel;
    if (!live.length) {
      perLevel = await this._benchLocal(arch, params, hand, BENCH_LEVELS);
    } else {
      const runs = BENCH_RUN_LIST;
      const hits = new Int32Array(runs.length), n = new Int32Array(runs.length);
      await Promise.all(splitRanges(runs.length, live.length).map(([a, b], wi) => {
        const part = runs.slice(a, b);
        const p = Float32Array.from(params);
        const recover = async () => { await yieldTask(); return benchRuns(arch, Float32Array.from(params), hand, part); };
        return this._call(live[wi], { type: 'benchRuns', arch, params: p, hand, runs: part }, [p.buffer], recover)
          .then((r) => { hits.set(r.hits, a); n.set(r.n, a); });
      }));
      perLevel = aggregateRuns(runs, hits, n);
    }
    return { skill: skillFromLevels(perLevel), perLevel };
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
