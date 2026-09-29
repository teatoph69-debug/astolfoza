// Training loop for МУХА: curriculum + evolution strategies + skill benchmark.
// Shared by the browser (Web Workers) and Node (tools/train.mjs, worker_threads).

import { MLP } from './nn.js';
import { ES } from './es.js';
import { runEpisode, DEFAULT_ARCH, HAND_PRESETS } from './agent.js';
import { syntheticMap } from '../maps/patterns.js';
import { packNotes, slicePacked } from '../core/map.js';
import { RNG } from '../core/rng.js';

// ------------------------------------------------------------------------------------------------
// Episodes: small descriptors that every worker can turn into the exact same note chart.

const synthCache = new Map();
function synthPacked(level, seed, dur) {
  const key = `${level.toFixed(3)}:${seed}:${dur}`;
  let p = synthCache.get(key);
  if (!p) {
    p = packNotes(syntheticMap(level, seed, dur + 1));
    if (synthCache.size > 256) synthCache.clear();
    synthCache.set(key, p);
  }
  return p;
}

/** Custom (user / real Rhythia) maps registered for training, keyed by id. */
const customMaps = new Map();
export function registerTrainingMap(key, packed) { customMaps.set(key, packed); }
export function clearTrainingMaps() { customMaps.clear(); }

export function episodeNotes(ep) {
  if (ep.kind === 'custom') {
    const p = customMaps.get(ep.key);
    if (!p) return { t: new Float64Array(0), x: new Float32Array(0), y: new Float32Array(0), n: 0 };
    return slicePacked(p, ep.t0, ep.t1, ep.t0 - 1.0);
  }
  return synthPacked(ep.level, ep.seed, ep.dur);
}

/**
 * Evaluate several parameter vectors on a list of episodes.
 * @returns {{fitness: number[], acc: number[]}}
 */
export function evaluateCandidates(arch, candidates, episodes, hand) {
  const net = new MLP(arch);
  const fitness = new Array(candidates.length).fill(0);
  const acc = new Array(candidates.length).fill(0);
  const charts = episodes.map(episodeNotes);
  let totalNotes = 0;
  for (const c of charts) totalNotes += c.n;
  for (let i = 0; i < candidates.length; i++) {
    let f = 0, hits = 0;
    for (let e = 0; e < charts.length; e++) {
      if (!charts[e].n) continue;
      const r = runEpisode(net, charts[e], { params: candidates[i], hand });
      f += r.fitness * charts[e].n;
      hits += r.hits;
    }
    fitness[i] = totalNotes ? f / totalNotes : 0;
    acc[i] = totalNotes ? hits / totalNotes : 0;
  }
  return { fitness, acc };
}

// ------------------------------------------------------------------------------------------------
// Skill benchmark: fixed charts from level 0 to 12. Skill = the difficulty (in stars) the AI can
// reliably play (≥ 90 % accuracy), interpolated between levels.

export const BENCH_LEVELS = Array.from({ length: 21 }, (_, i) => i); // 0 … 20
export const BENCH_DUR = 20;
export const PASS_ACC = 0.9;

export function benchmark(arch, params, hand) {
  const net = new MLP(arch);
  const perLevel = [];
  for (const L of BENCH_LEVELS) {
    let hits = 0, n = 0;
    for (let k = 0; k < 2; k++) {
      const p = synthPacked(L, 90001 + L * 31 + k * 7, BENCH_DUR);
      const r = runEpisode(net, p, { params, hand });
      hits += r.hits; n += r.n;
    }
    perLevel.push({ level: L, acc: n ? hits / n : 0 });
  }
  return { skill: skillFromLevels(perLevel), perLevel };
}

export function skillFromLevels(perLevel) {
  // Walk up the levels while МУХА passes them (≥ 90 %). One isolated dip is forgiven if the next
  // level is passed again (benchmarks are short, so a single unlucky chart shouldn't erase skill).
  // On the real failure, interpolate partial credit.
  let skill = 0;
  let forgiven = false;
  for (let i = 0; i < perLevel.length; i++) {
    const { level, acc } = perLevel[i];
    if (acc >= PASS_ACC) { skill = level + 0.5; continue; }
    const next = perLevel[i + 1];
    if (!forgiven && next && next.acc >= PASS_ACC) { forgiven = true; continue; }
    const part = Math.max(0, Math.min(1, (acc - 0.5) / (PASS_ACC - 0.5)));
    skill = Math.max(skill, level - 0.5 + part);
    break;
  }
  return Math.max(0, skill);
}

// ------------------------------------------------------------------------------------------------
// Ranks / titles shown to the player as МУХА evolves.

export const TITLES = [
  { min: 0, ru: 'Личинка', en: 'Larva', emoji: '🥚' },
  { min: 1.5, ru: 'Куколка', en: 'Pupa', emoji: '🐛' },
  { min: 3, ru: 'Муха-новичок', en: 'Rookie Fly', emoji: '🪰' },
  { min: 4.5, ru: 'Жужжалка', en: 'Buzzer', emoji: '🪰' },
  { min: 6, ru: 'Ловкая муха', en: 'Agile Fly', emoji: '⚡' },
  { min: 7.5, ru: 'Аим-муха', en: 'Aim Fly', emoji: '🎯' },
  { min: 9, ru: 'Муха-снайпер', en: 'Sniper Fly', emoji: '🎯' },
  { min: 10.5, ru: 'Про-муха', en: 'Pro Fly', emoji: '🔥' },
  { min: 12, ru: 'Кибер-муха', en: 'Cyber Fly', emoji: '🤖' },
  { min: 13.5, ru: 'Легенда Rhythia', en: 'Rhythia Legend', emoji: '👑' },
  { min: 15.5, ru: 'Повелитель сетки', en: 'Grid Overlord', emoji: '🌌' },
  { min: 17.5, ru: 'Бог ритма', en: 'Rhythm God', emoji: '⭐' },
  { min: 19.5, ru: 'Абсолют', en: 'Absolute', emoji: '💎' },
];

export function titleFor(skill) {
  let t = TITLES[0], idx = 0;
  for (let i = 0; i < TITLES.length; i++) if (skill >= TITLES[i].min) { t = TITLES[i]; idx = i; }
  const next = TITLES[idx + 1] || null;
  const progress = next ? (skill - t.min) / (next.min - t.min) : 1;
  return { ...t, index: idx, next, progress: Math.max(0, Math.min(1, progress)) };
}

// ------------------------------------------------------------------------------------------------
// Curriculum: train on the current level, mixed with easier levels so nothing is forgotten.

export class Curriculum {
  constructor({ level = 0.5, maxLevel = 20, step = 0.5, passAcc = 0.93, customWeight = 0 } = {}) {
    this.level = level;
    this.maxLevel = maxLevel;
    this.step = step;
    this.passAcc = passAcc;
    this.ema = 0;
    this.customWeight = customWeight;   // share of episodes drawn from custom maps (0..1)
    this.customKeys = [];               // [{key, duration}]
  }

  episodes(rng, count = 6, dur = 8) {
    const eps = [];
    for (let i = 0; i < count; i++) {
      if (this.customKeys.length && rng.chance(this.customWeight)) {
        const m = rng.pick(this.customKeys);
        const t0 = rng.float(0, Math.max(0, m.duration - dur));
        eps.push({ kind: 'custom', key: m.key, t0, t1: t0 + dur });
        continue;
      }
      let L;
      if (i < Math.ceil(count * 0.5)) L = this.level + rng.float(-0.4, 0.4);   // the frontier
      else if (i === count - 1) L = rng.float(0, Math.min(2, this.level));     // slow-map refresher
      else L = rng.float(0, this.level);                                        // everything learned so far
      L = Math.max(0, Math.min(this.maxLevel, L));
      eps.push({ kind: 'synth', level: Math.round(L * 100) / 100, seed: rng.int(1, 2 ** 30), dur });
    }
    return eps;
  }

  /** Feed the accuracy of the current policy on this generation's episodes. Returns true on level-up. */
  report(acc) {
    this.ema = this.ema * 0.8 + acc * 0.2;
    if (this.ema >= this.passAcc && this.level < this.maxLevel) {
      this.level = Math.min(this.maxLevel, this.level + this.step);
      this.ema = acc * 0.85;
      return true;
    }
    return false;
  }
}

// ------------------------------------------------------------------------------------------------

/**
 * A complete training session. `evaluate(candidates, episodes)` is injected so the same logic
 * runs on a worker pool (browser / node) or synchronously.
 */
export class TrainingSession {
  constructor({ arch = DEFAULT_ARCH, hand = HAND_PRESETS.pro, seed = 12345, params = null, es = {}, curriculum = {}, episodesPerGen = 6, episodeDur = 8, benchEvery = 5, anneal = 0.9985 } = {}) {
    this.arch = arch.slice();
    this.hand = hand;
    this.rng = new RNG(seed);
    const net = new MLP(this.arch);
    if (params) net.setParams(Float32Array.from(params));
    else net.init(() => this.rng.gauss(), 1.0);
    this.es = new ES(net.params, { seed: seed + 1, ...es });
    // exploration noise and step size anneal slowly so late training can fine-tune precisely
    this.sigma0 = this.es.sigma;
    this.lr0 = this.es.lr;
    this.anneal = anneal;
    this.curriculum = new Curriculum(curriculum);
    this.episodesPerGen = episodesPerGen;
    this.episodeDur = episodeDur;
    this.benchEvery = benchEvery;
    this.gen = 0;
    this.history = [];          // per-generation stats
    this.skill = 0;
    this.bestSkill = -1;
    this.champion = Float32Array.from(this.es.theta);
    this.perLevel = null;
    this.trainSeconds = 0;      // simulated gameplay seconds
    this.notesPlayed = 0;
  }

  /** Run one generation. `evaluate` may be async. */
  async step(evaluate) {
    const episodes = this.curriculum.episodes(this.rng, this.episodesPerGen, this.episodeDur);
    const decay = Math.pow(this.anneal, this.gen);
    this.es.sigma = Math.max(this.sigma0 * 0.35, this.sigma0 * decay);
    this.es.lr = Math.max(this.lr0 * 0.3, this.lr0 * decay);
    const cands = this.es.ask();
    const all = cands.concat([this.es.theta]);
    const { fitness, acc } = await evaluate(all, episodes);
    const thetaAcc = acc[acc.length - 1];
    this.es.tell(fitness.slice(0, cands.length));
    const leveledUp = this.curriculum.report(thetaAcc);
    this.gen++;
    this.trainSeconds += all.length * episodes.length * this.episodeDur;
    let notes = 0;
    for (const ep of episodes) notes += episodeNotes(ep).n;
    this.notesPlayed += notes * all.length;

    let bench = null;
    if (this.gen % this.benchEvery === 0 || this.gen === 1) {
      bench = benchmark(this.arch, this.es.theta, this.hand);
      this.skill = bench.skill;
      this.perLevel = bench.perLevel;
      // fast-forward the curriculum when the benchmark shows МУХА is already better than it
      if (bench.skill - 1 > this.curriculum.level) {
        this.curriculum.level = Math.min(this.curriculum.maxLevel, Math.floor((bench.skill - 1) * 2) / 2);
      }
      if (bench.skill > this.bestSkill) {
        this.bestSkill = bench.skill;
        this.champion = Float32Array.from(this.es.theta);
      }
    }
    const fitSorted = fitness.slice(0, cands.length).sort((a, b) => b - a);
    const rec = {
      gen: this.gen,
      level: this.curriculum.level,
      acc: thetaAcc,
      bestAcc: Math.max(...acc),
      fitMean: fitSorted.reduce((a, b) => a + b, 0) / fitSorted.length,
      fitBest: fitSorted[0],
      skill: this.skill,
      bestSkill: this.bestSkill,
      leveledUp,
      bench: !!bench,
    };
    this.history.push(rec);
    if (this.history.length > 5000) this.history.splice(0, this.history.length - 5000);
    return rec;
  }

  serialize() {
    return {
      version: 1,
      arch: this.arch,
      hand: this.hand.id,
      gen: this.gen,
      level: this.curriculum.level,
      ema: this.curriculum.ema,
      skill: this.skill,
      bestSkill: this.bestSkill,
      trainSeconds: this.trainSeconds,
      notesPlayed: this.notesPlayed,
      theta: Array.from(this.es.theta),
      champion: Array.from(this.champion),
      adam: { m: Array.from(this.es.m), v: Array.from(this.es.v), t: this.es.t },
      history: this.history.filter((h, i) => h.bench || i % 5 === 0 || h.leveledUp).slice(-2000),
      perLevel: this.perLevel,
    };
  }

  static deserialize(data, opts = {}) {
    const hand = HAND_PRESETS[data.hand] || HAND_PRESETS.pro;
    const s = new TrainingSession({ ...opts, arch: data.arch, hand, params: data.theta });
    s.gen = data.gen || 0;
    s.curriculum.level = data.level ?? 0.5;
    s.curriculum.ema = data.ema ?? 0;
    s.skill = data.skill || 0;
    s.bestSkill = data.bestSkill ?? -1;
    s.trainSeconds = data.trainSeconds || 0;
    s.notesPlayed = data.notesPlayed || 0;
    if (data.champion) s.champion = Float32Array.from(data.champion);
    if (data.adam) { s.es.m.set(data.adam.m); s.es.v.set(data.adam.v); s.es.t = data.adam.t; }
    s.history = data.history || [];
    s.perLevel = data.perLevel || null;
    return s;
  }
}
