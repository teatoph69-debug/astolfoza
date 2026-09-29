// Map (beatmap) model + helpers.
//
// A map is a plain object:
// {
//   id, title, artist, mapper, difficultyName,
//   notes: [{ t /*seconds*/, x, y }]   // sorted by t, grid units (see constants.js)
//   stars,                              // computed difficulty
//   duration,                           // seconds (audio length if known, else last note + 2s)
//   source: 'builtin' | 'sspm' | 'txt' | 'auto' | 'training',
//   audio: null | { kind: 'song', songId } | { kind: 'bytes', bytes: ArrayBuffer, mime } | { kind: 'none' }
//   cover?: dataURL, color?: css colour
// }

import { DEFAULT_SETTINGS } from './constants.js';

export function sortNotes(notes) {
  return notes.slice().sort((a, b) => a.t - b.t);
}

/** Convert notes array to typed arrays for the judge / AI (fast, allocation-free loops). */
export function packNotes(notes) {
  const n = notes.length;
  const t = new Float64Array(n);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = notes[i].t;
    x[i] = notes[i].x;
    y[i] = notes[i].y;
  }
  return { t, x, y, n };
}

/** Slice of packed notes within [t0, t1), times shifted so the slice starts at `shiftTo`. */
export function slicePacked(p, t0, t1, shift = 0) {
  let a = 0;
  while (a < p.n && p.t[a] < t0) a++;
  let b = a;
  while (b < p.n && p.t[b] < t1) b++;
  const n = b - a;
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = p.t[a + i] - shift;
  return { t, x: p.x.slice(a, b), y: p.y.slice(a, b), n };
}

export function mapDuration(map) {
  if (map.duration) return map.duration;
  const last = map.notes.length ? map.notes[map.notes.length - 1].t : 0;
  return last + 2;
}

/**
 * Difficulty ("stars") estimation, 0 … ~12+.
 * Idea (osu!-like strain model adapted to aim-only gameplay): for each note, estimate how fast the
 * cursor must travel from the previous note, *after* discounting the free movement the hitbox gives
 * you (you only need to reach the edge of the hitbox). Movement demand is combined with raw density
 * (notes per second), accumulated into a decaying strain, and the hardest peaks dominate the result.
 */
export function computeStars(notes, settings = DEFAULT_SETTINGS) {
  const n = notes.length;
  if (n < 2) return 0;
  const reach = (settings.hitbox ?? DEFAULT_SETTINGS.hitbox) * 0.5; // slack on each side
  const strains = [];
  let strain = 0;
  let prevT = notes[0].t;
  // track the "ideal" cursor position: the point inside the previous hitbox closest to the next note
  let cx = notes[0].x, cy = notes[0].y;
  for (let i = 1; i < n; i++) {
    const nt = notes[i];
    if (nt.t - prevT < 0.004) continue; // simultaneous notes (chords / drawings) share one moment
    const dt = Math.max(0.025, nt.t - prevT);
    // Chebyshev-box slack: need to get inside [x-reach, x+reach] × [y-reach, y+reach]
    const ex = Math.max(0, Math.abs(nt.x - cx) - reach * 0.85);
    const ey = Math.max(0, Math.abs(nt.y - cy) - reach * 0.85);
    const move = Math.hypot(ex, ey);
    // advance ideal cursor to the closest point of the new note's hitbox
    cx = clamp(cx, nt.x - reach * 0.85, nt.x + reach * 0.85);
    cy = clamp(cy, nt.y - reach * 0.85, nt.y + reach * 0.85);
    // demand: required accel-ish term (move/dt^2 grows fast for jumps at speed) + density
    const speed = move / dt;
    const accel = move / (dt * dt);
    const density = 1 / dt;
    const angleBonus = i >= 2 ? directionChange(notes[i - 2], notes[i - 1], nt) : 0;
    const d = 0.55 * Math.sqrt(accel) + 0.35 * speed + 0.28 * density + angleBonus * speed * 0.18;
    const decay = Math.pow(0.18, dt); // strain decays over time
    strain = strain * decay + d * (1 - decay) * 1.6;
    strains.push(Math.max(strain, d * 0.6));
    prevT = nt.t;
  }
  if (!strains.length) return 0;
  strains.sort((a, b) => b - a);
  // weighted sum of top strains (like osu! pp weighting)
  let total = 0, weight = 1, wsum = 0;
  const count = Math.min(strains.length, 400);
  for (let i = 0; i < count; i++) {
    total += strains[i] * weight;
    wsum += weight;
    weight *= 0.985;
  }
  const peak = total / wsum;
  // length bonus: longer maps slightly harder (stamina)
  const lengthBonus = 1 + Math.min(0.12, Math.log10(1 + n / 150) * 0.1);
  const raw = peak * lengthBonus;
  const lin = Math.max(0, STAR_SCALE * Math.pow(raw, STAR_POW) - STAR_OFFSET);
  // compress the very top so stars ≈ the curriculum level the AI is benchmarked on
  return lin;
}

// Calibrated so that the procedural curriculum level L produces ≈ L stars (fit on syntheticMap levels 0…12).
export let STAR_SCALE = 0.74;
export let STAR_POW = 1.0;
export let STAR_OFFSET = 0.98;
export function setStarCalibration(scale, pow, offset) {
  STAR_SCALE = scale; STAR_POW = pow; STAR_OFFSET = offset;
}

function directionChange(a, b, c) {
  const x1 = b.x - a.x, y1 = b.y - a.y, x2 = c.x - b.x, y2 = c.y - b.y;
  const l1 = Math.hypot(x1, y1), l2 = Math.hypot(x2, y2);
  if (l1 < 1e-3 || l2 < 1e-3) return 0;
  const cos = (x1 * x2 + y1 * y2) / (l1 * l2);
  return (1 - cos) * 0.5; // 0 = straight on, 1 = full reversal
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

export function starColor(stars) {
  const stops = [
    [0, '#4dabf7'], [2, '#69db7c'], [3.5, '#ffd43b'], [5, '#ff922b'],
    [6.5, '#ff6b6b'], [8, '#cc5de8'], [10, '#7048e8'], [12, '#222']
  ];
  for (let i = stops.length - 1; i >= 0; i--) if (stars >= stops[i][0]) return stops[i][1];
  return stops[0][1];
}

export function formatTime(sec) {
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
