// Chart timing: picks WHEN rhythm-game notes happen, straight from the composition's events,
// so every note lands exactly on a sound. (The game assigns x/y positions itself.)
//
// Approach ("follow the most prominent sound", like a human Rhythia mapper):
//   1. Every distinct onset time in the song becomes a candidate. Its score combines the most
//      salient sound at that moment (lead > snare > kick > chords > bass > arps > hats; the
//      weights come from composition.salience so styles can re-weight, e.g. dubstep wobbles),
//      how many layers hit together, the metric position (downbeats beat off-beats) and the
//      section energy (drops > builds > intro/break).
//   2. Each difficulty only admits candidates up to a rhythmic resolution (half notes … 16ths)
//      and above a score threshold; quiet sections get a coarser resolution.
//   3. Candidates are accepted greedily from the highest score down, rejecting anything closer
//      than the difficulty's minimum gap to an already accepted note — so conflicts are always
//      resolved in favour of the more prominent sound, and the min gap is a hard guarantee.

import { songEnergyAt } from './synth.js';

export const DIFFICULTIES = [
  { id: 'easy', name: 'Easy', ru: 'Легко' },
  { id: 'normal', name: 'Normal', ru: 'Нормально' },
  { id: 'hard', name: 'Hard', ru: 'Сложно' },
  { id: 'insane', name: 'Insane', ru: 'Безумно' },
  { id: 'extreme', name: 'Extreme', ru: 'Экстрим' },
];

// Grid levels: 0 bar, 1 half note, 2 beat, 3 eighth, 4 sixteenth, 5 off-grid (32nds).
//   minGap    hard minimum time between two notes (s)
//   maxLevel  finest grid level allowed in energetic sections (energy ≥ 0.5)
//   lowLevel  finest grid level allowed in quiet sections
//   leadLevel finest grid level allowed for lead-melody onsets (melody rhythm can be finer)
//   thr       minimum candidate score
const CONFIG = {
  easy: { minGap: 0.35, maxLevel: 2, lowLevel: 1, leadLevel: 2, thr: 0.62 },
  normal: { minGap: 0.22, maxLevel: 2, lowLevel: 2, leadLevel: 3, thr: 0.5 },
  hard: { minGap: 0.15, maxLevel: 3, lowLevel: 3, leadLevel: 4, thr: 0.4 },
  insane: { minGap: 0.09, maxLevel: 4, lowLevel: 3, leadLevel: 4, thr: 0.3 },
  extreme: { minGap: 0.065, maxLevel: 5, lowLevel: 4, leadLevel: 5, thr: 0.18 },
};

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

  // 1. filter by resolution + threshold
  const pool = [];
  for (const c of cands) {
    const quiet = c.energy < 0.5;
    let maxLevel = quiet ? cfg.lowLevel : cfg.maxLevel;
    if (c.kind === 'lead' || c.hasLead) maxLevel = Math.max(maxLevel, quiet ? Math.min(cfg.leadLevel, cfg.lowLevel + 1) : cfg.leadLevel);
    if (c.level > maxLevel) continue;
    if (c.score < cfg.thr) continue;
    pool.push(c);
  }

  // 2. greedy selection by score with a hard minimum gap
  pool.sort((a, b) => b.score - a.score || a.t - b.t);
  const taken = []; // sorted times
  const chosen = [];
  const gap = cfg.minGap - 1e-9;
  for (const c of pool) {
    // binary search insertion point
    let lo = 0, hi = taken.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (taken[mid] < c.t) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && c.t - taken[lo - 1] < gap) continue;
    if (lo < taken.length && taken[lo] - c.t < gap) continue;
    taken.splice(lo, 0, c.t);
    chosen.push(c);
  }
  chosen.sort((a, b) => a.t - b.t);

  // 3. output + stream detection
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
  if (!notes.length) return { count: 0, nps: 0, peakNps: 0, streams: 0 };
  const len = Math.max(1, notes[notes.length - 1].t - notes[0].t);
  let peak = 0;
  for (let i = 0, j = 0; i < notes.length; i++) {
    while (notes[i].t - notes[j].t > 1) j++;
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
  let cached = CAND_CACHE.get(comp);
  if (cached) return cached;
  const sal = comp.salience || {};
  const t0 = comp.t0 ?? (comp.beatTimes && comp.beatTimes[0]) ?? 0;
  const step = comp.stepDur ?? 60 / comp.bpm / 4;
  const out = [];
  const evs = comp.events;
  let i = 0;
  while (i < evs.length) {
    // group events starting within 2 ms of each other
    const t = evs[i].t;
    let j = i;
    while (j < evs.length && evs[j].t - t < 0.002) j++;
    let best = 0, bestKind = null, sum = 0, midi = null, midiPri = -1, hasLead = false;
    const kinds = new Set();
    for (let k = i; k < j; k++) {
      const e = evs[k];
      const w = sal[e.kind] ?? 0;
      if (w <= 0) continue;
      const s = w * (0.35 + 0.65 * e.vel);
      kinds.add(e.kind);
      if (s > best) { best = s; bestKind = e.kind; }
      sum += s;
      if (e.kind === 'lead' && e.vel >= 0.4) hasLead = true;
      const pri = TONAL_PRIORITY[e.kind] ?? -1;
      if (e.midi != null && (pri > midiPri || (pri === midiPri && e.midi > midi))) { midi = e.midi; midiPri = pri; }
    }
    if (bestKind) {
      const pos = (t - t0) / step; // position in 16ths
      const r = Math.round(pos);
      let level = 5;
      if (Math.abs(pos - r) < 0.02) {
        const s = mod(r, 16);
        level = s === 0 ? 0 : s % 8 === 0 ? 1 : s % 4 === 0 ? 2 : s % 2 === 0 ? 3 : 4;
      }
      const energy = songEnergyAt(comp, t + 0.001);
      const layers = Math.min(0.25, (sum - best) * 0.2) + (kinds.size >= 3 ? 0.04 : 0);
      const raw = best + layers + METRIC_BONUS[level];
      const score = raw * (0.55 + 0.45 * energy);
      out.push({ t, kind: bestKind, midi, level, energy, score, strength: raw, hasLead });
    }
    i = j;
  }
  CAND_CACHE.set(comp, out);
  return out;
}

function mod(a, n) {
  return ((a % n) + n) % n;
}
