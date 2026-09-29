// Chart timing: picks WHEN rhythm-game notes happen, straight from the composition's events,
// so every note lands exactly on a sound. (The game assigns x/y positions itself.)
//
// Approach ("follow the most prominent sound", like a human Rhythia mapper):
//   1. Every distinct onset in the song becomes a candidate. Its score combines the most salient
//      sound at that moment (lead > snare > kick > chords > bass > arps > hats; weights come from
//      composition.salience so styles can re-weight, e.g. dubstep wobble bass), how many layers
//      hit together, the metric position (downbeats beat off-beats) and the section energy
//      (drops > builds > intro / break). Wobble-bass notes also contribute one onset per wobble.
//   2. Each difficulty has a score threshold per rhythmic level (bar, half, beat, 8th, 16th,
//      32nd). Thresholds rise when that level is fast at the song's tempo, so e.g. "hard" at
//      188 BPM does not turn into a wall of 8ths. Background 16ths (arps / hats / bass) are only
//      admitted inside "stream windows" on insane / extreme, which gives bursts and streams
//      instead of monotone machine-gun charts.
//      Quiet sections are charted one rhythmic level coarser (e.g. half notes instead of beats).
//   3. Candidates are accepted greedily from the highest score down, rejecting anything closer
//      than the difficulty's minimum gap to an already accepted note — conflicts always resolve
//      in favour of the more prominent sound, and the minimum gap is a hard guarantee.

import { songEnergyAt } from './synth.js';

export const DIFFICULTIES = [
  { id: 'easy', name: 'Easy', ru: 'Легко' },
  { id: 'normal', name: 'Normal', ru: 'Нормально' },
  { id: 'hard', name: 'Hard', ru: 'Сложно' },
  { id: 'insane', name: 'Insane', ru: 'Безумно' },
  { id: 'extreme', name: 'Extreme', ru: 'Экстрим' },
];

// Levels: 0 bar, 1 half note, 2 beat, 3 eighth, 4 sixteenth, 5 thirty-second / off-grid.
//   minGap   hard minimum time between two notes (s)
//   thr      minimum candidate score per level (9 = never)
//   comfort  note interval (s) below which a level gets progressively harder to enter
//   streams  background 16ths: 'none' | 'bursts' (last beat of every 2nd bar) |
//            'phrases' (2nd half of each 4-bar phrase + last beat of every bar) | 'all'
//   maxNps   soft density cap: a note is rejected if the 1 s window around it is already full
const CONFIG = {
  easy: { minGap: 0.35, thr: [0.45, 0.72, 1.0, 9, 9, 9], comfort: 0.5, streams: 'none', maxNps: 3 },
  normal: { minGap: 0.22, thr: [0.36, 0.4, 0.46, 0.9, 9, 9], comfort: 0.24, streams: 'none', maxNps: 4.5 },
  hard: { minGap: 0.15, thr: [0.3, 0.32, 0.38, 0.5, 0.75, 9], comfort: 0.2, streams: 'none', maxNps: 5.5 },
  insane: { minGap: 0.09, thr: [0.22, 0.24, 0.28, 0.25, 0.25, 9], comfort: 0.12, streams: 'bursts', maxNps: 9 },
  extreme: { minGap: 0.065, thr: [0.15, 0.16, 0.2, 0.22, 0.15, 0.4], comfort: 0.075, streams: 'phrases', maxNps: 15 },
};
const LEVEL_STEPS = [16, 8, 4, 2, 1, 0.5]; // 16ths per level
const FOREGROUND = new Set(['lead', 'snare', 'clap', 'kick', 'impact']);
const METRIC_BONUS = [0.2, 0.13, 0.08, 0, -0.05, -0.1];
const TONAL_PRIORITY = { lead: 4, arp: 3, bass: 2, chord: 1 };
const STREAM_GAP = 0.17; // notes closer than this (s) that form a run of ≥ 4 are a "stream"

/** Minimum gap (s) between notes for a difficulty id. */
export function minGapFor(difficulty) {
  return (CONFIG[difficulty] || CONFIG.normal).minGap;
}

/**
 * @param {object} comp  composition from composeSong()
 * @param {'easy'|'normal'|'hard'|'insane'|'extreme'} difficulty
 * @returns {{t:number, strength:number, midi:number|null, kind:string, stream:boolean}[]} sorted by t
 */
export function noteTimesForDifficulty(comp, difficulty) {
  const cfg = CONFIG[difficulty] || CONFIG.normal;
  const cands = buildCandidates(comp);
  const step = comp.stepDur ?? 60 / comp.bpm / 4;

  // Tempo-aware thresholds: a level whose note interval is shorter than `comfort` costs extra
  // (only if consecutive notes at that level are possible at all, i.e. interval ≥ minGap).
  const thr = cfg.thr.map((t, lvl) => {
    const interval = LEVEL_STEPS[lvl] * step;
    if (interval < cfg.minGap) return t;
    return t + 2 * Math.min(1, Math.max(0, (cfg.comfort - interval) / cfg.comfort));
  });
  // Slow songs get wider stream windows (16ths at ≤ 125 BPM are still readable).
  let streams = cfg.streams;
  if (step >= 0.12) streams = { bursts: 'phrases', phrases: 'all' }[streams] || streams;

  // 1. filter by threshold (+ stream windows for background 16ths)
  const pool = [];
  for (const c of cands) {
    // quiet sections (intro / break / outro tail) use one level coarser resolution
    const lvl = c.energy < 0.5 ? Math.min(5, c.level + 1) : c.level;
    if (c.score < thr[lvl]) continue;
    if (c.level >= 4 && !FOREGROUND.has(c.kind) && !c.hasLead) {
      if (streams === 'none' || c.energy < 0.5) continue;
      const inWindow =
        streams === 'all' ||
        (streams === 'phrases' && (c.barInSec % 4 >= 2 || c.stepInBar >= 12)) ||
        (streams === 'bursts' && c.barInSec % 2 === 1 && c.stepInBar >= 12);
      if (!inWindow) continue;
    }
    pool.push(c);
  }

  // 2. greedy selection by score with a hard minimum gap and a soft density cap
  pool.sort((a, b) => b.score - a.score || a.t - b.t);
  const taken = []; // sorted accepted times
  const chosen = [];
  const gap = cfg.minGap - 1e-9;
  const lowerBound = (x) => {
    let lo = 0, hi = taken.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (taken[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (const c of pool) {
    const lo = lowerBound(c.t);
    if (lo > 0 && c.t - taken[lo - 1] < gap) continue;
    if (lo < taken.length && taken[lo] - c.t < gap) continue;
    if (lowerBound(c.t + 0.5) - lowerBound(c.t - 0.5) >= Math.floor(cfg.maxNps)) continue;
    taken.splice(lo, 0, c.t);
    chosen.push(c);
  }
  chosen.sort((a, b) => a.t - b.t);

  // 3. output + stream flags (runs of ≥ 4 notes closer than STREAM_GAP)
  const notes = chosen.map((c) => ({
    t: c.t,
    strength: Math.round(Math.min(1, Math.max(0, c.strength)) * 1000) / 1000,
    midi: c.midi,
    kind: c.kind,
    stream: false,
  }));
  let runStart = 0;
  for (let i = 1; i <= notes.length; i++) {
    const cont = i < notes.length && notes[i].t - notes[i - 1].t < STREAM_GAP;
    if (!cont) {
      if (i - runStart >= 4) for (let k = runStart; k < i; k++) notes[k].stream = true;
      runStart = i;
    }
  }
  return notes;
}

/** Note count / NPS summary for a chart (handy for song-select screens). */
export function chartStats(notes, comp) {
  if (!notes.length) return { count: 0, nps: 0, peakNps: 0, streams: 0, duration: comp ? comp.duration : 0 };
  const len = Math.max(1, notes[notes.length - 1].t - notes[0].t);
  let peak = 0;
  for (let i = 0, j = 0; i < notes.length; i++) {
    while (notes[i].t - notes[j].t >= 1) j++;
    peak = Math.max(peak, i - j + 1);
  }
  return {
    count: notes.length,
    nps: notes.length / len,
    peakNps: peak,
    streams: notes.filter((n) => n.stream).length,
    duration: comp ? comp.duration : len,
  };
}

// Candidates are cached per composition (the five difficulties share them).
const CAND_CACHE = new WeakMap();

function buildCandidates(comp) {
  const cached = CAND_CACHE.get(comp);
  if (cached) return cached;
  const sal = comp.salience || {};
  const t0 = comp.t0 ?? (comp.beatTimes && comp.beatTimes[0]) ?? 0;
  const step = comp.stepDur ?? 60 / comp.bpm / 4;
  const spb = step * 4;
  const barDur = step * 16;

  // Onset list: real events + one virtual onset per wobble cycle of wobble-bass notes.
  const evs = [];
  for (const e of comp.events) {
    if (!(sal[e.kind] > 0)) continue;
    evs.push(e);
    if (e.kind === 'bass' && e.wob >= 2) {
      const period = spb / e.wob;
      for (let k = 1; k * period < e.dur - 0.02; k++) {
        evs.push({ t: Math.round((e.t + k * period) * 1e6) / 1e6, kind: 'bass', midi: e.midi, vel: e.vel * 0.85, pulse: true });
      }
    }
  }
  evs.sort((a, b) => a.t - b.t);

  const out = [];
  const secs = comp.sections.length ? comp.sections : [{ start: t0 }];
  let secIdx = 0;
  let i = 0;
  while (i < evs.length) {
    // group onsets within 2 ms of each other
    const t = evs[i].t;
    let j = i;
    while (j < evs.length && evs[j].t - t < 0.002) j++;
    let best = 0, bestKind = null, sum = 0, midi = null, midiPri = -1, hasLead = false, allPulse = true;
    const kinds = new Set();
    for (let k = i; k < j; k++) {
      const e = evs[k];
      const s = sal[e.kind] * (0.35 + 0.65 * e.vel);
      kinds.add(e.kind);
      if (!e.pulse) allPulse = false;
      if (s > best) { best = s; bestKind = e.kind; }
      sum += s;
      if (e.kind === 'lead' && e.vel >= 0.4) hasLead = true;
      const pri = TONAL_PRIORITY[e.kind] ?? -1;
      if (e.midi != null && (pri > midiPri || (pri === midiPri && e.midi > midi))) { midi = e.midi; midiPri = pri; }
    }
    const pos = (t - t0) / step; // position in 16ths
    const r = Math.round(pos);
    let level = 5;
    if (Math.abs(pos - r) < 0.02) {
      const s = mod(r, 16);
      level = s === 0 ? 0 : s % 8 === 0 ? 1 : s % 4 === 0 ? 2 : s % 2 === 0 ? 3 : 4;
    } else if (allPulse) level = 4; // triplet wobbles read like 16ths
    const energy = songEnergyAt(comp, t + 0.001);
    while (secIdx < secs.length - 1 && t >= secs[secIdx + 1].start - 1e-6) secIdx++;
    const barInSec = Math.max(0, Math.floor((t - secs[secIdx].start) / barDur + 1e-6));
    const stepInBar = mod(r, 16);
    const layers = Math.min(0.25, (sum - best) * 0.2) + (kinds.size >= 3 ? 0.04 : 0);
    const raw = best + layers + METRIC_BONUS[level];
    const score = raw * (0.55 + 0.45 * energy);
    out.push({ t, kind: bestKind, midi, level, energy, score, strength: raw, hasLead, barInSec, stepInBar });
    i = j;
  }
  CAND_CACHE.set(comp, out);
  return out;
}

function mod(a, n) {
  return ((a % n) + n) % n;
}
