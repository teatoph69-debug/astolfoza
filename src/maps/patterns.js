// Pattern-based note placement ("auto-mapper brain").
//
// Given WHEN notes happen (times with optional musical info), decide WHERE they go on the grid.
// Used for: built-in songs, auto-mapping any audio file, and the AI's training curriculum.
//
// The output looks like hand-made Rhythia maps: jumps, zig-zags, squares, triangles, circles and
// spirals made of off-grid ("quantum") notes, streams, stacks and pitch-following melodies.

import { RNG } from '../core/rng.js';

const CELLS = [];
for (let y = 0; y <= 2; y++) for (let x = 0; x <= 2; x++) CELLS.push({ x, y });

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Difficulty knobs derived from a star level (0 … 10+).
 */
export function knobsForStars(stars) {
  const s = clamp(stars, 0, 22);
  return {
    stars: s,
    // max comfortable cursor speed demanded by jumps (grid units / second)
    maxSpeed: 2.6 + 1.55 * s + Math.max(0, s - 12) * 0.9,
    // typical jump length for strong notes
    jump: clamp(0.9 + 0.13 * s, 0.9, 2.6),
    // chance to use off-grid positions
    quantum: s < 2.5 ? 0 : clamp((s - 2.5) * 0.09, 0, 0.75),
    // chance to start a geometric shape (vs. random jumps)
    shapes: clamp(0.35 + s * 0.04, 0.35, 0.8),
    // how much the pattern prefers sharp angles
    sharp: clamp(s / 10, 0, 1),
  };
}

/**
 * @param {Array<number|{t:number,strength?:number,midi?:number|null,stream?:boolean}>} times
 * @param {{stars?:number, seed?:number}} opts
 * @returns {Array<{t:number,x:number,y:number}>}
 */
export function placeNotes(times, { stars = 3, seed = 1 } = {}) {
  const rng = new RNG(seed);
  const K = knobsForStars(stars);
  const items = times.map((v) => (typeof v === 'number' ? { t: v, strength: 0.5 } : v));
  const out = [];
  let pos = { x: 1, y: 1 };
  let prevDir = { x: 1, y: 0 };
  let i = 0;

  while (i < items.length) {
    // choose a pattern segment (a jump stream is kept together as one segment)
    let segLen = rng.int(3, 10);
    if (items[i].jump) { segLen = 1; while (i + segLen < items.length && items[i + segLen].jump && segLen < 40) segLen++; }
    else if (items[i].burst && items[i].hard) { segLen = 1; while (i + segLen < items.length && items[i + segLen].burst && segLen < 16) segLen++; }
    const end = Math.min(items.length, i + segLen);
    const seg = items.slice(i, end);
    const gaps = seg.map((it, k) => (k === 0 ? (i > 0 ? it.t - items[i - 1].t : 1) : it.t - seg[k - 1].t));
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const isStream = seg.some((s) => s.stream) || avgGap < 0.13;
    const hasPitch = seg.filter((s) => s.midi != null).length >= seg.length * 0.7;

    let kind;
    if (seg[0].jump) {
      kind = 'jumpstream';
    } else if (seg[0].burst && seg[0].hard) {
      kind = 'burstjump';
    } else if (isStream && stars > 10 && rng.chance(Math.min(0.85, (stars - 10) * 0.12))) {
      // "jump streams": wide shapes at stream speed — only the hardest maps do this
      kind = rng.weighted(['zigzag', 'star', 'mirror', 'triangle', 'square', 'circle'], [2, 1.5, 1.5, 1.5, 1, 1]);
    } else if (isStream) {
      kind = rng.weighted(['circle', 'zigzag', 'line', 'spiral', 'stack'],
        [3, 2, 2, K.quantum > 0 ? 2 : 0, stars < 5 ? 1.5 : 0.4]);
    } else if (hasPitch && rng.chance(0.35)) {
      kind = 'melody';
    } else if (rng.chance(K.shapes)) {
      kind = rng.weighted(['square', 'triangle', 'zigzag', 'circle', 'star', 'mirror', 'line'],
        [2, 2, 2, K.quantum > 0 ? 2.5 : 0, K.quantum > 0.2 ? 1.5 : 0, 2, 1.5]);
    } else {
      kind = 'jumps';
    }

    const pts = buildShape(kind, seg, gaps, pos, prevDir, rng, K);
    for (let k = 0; k < seg.length; k++) {
      if (seg[k].chord) {
        // chord: a second note at the same moment, one cell away (both reachable from the midpoint)
        const opts = [{ x: pos.x + 1, y: pos.y }, { x: pos.x - 1, y: pos.y }, { x: pos.x, y: pos.y + 1 }, { x: pos.x, y: pos.y - 1 }]
          .filter((q) => q.x >= 0 && q.x <= 2 && q.y >= 0 && q.y <= 2);
        const q = rng.pick(opts);
        out.push({ t: seg[k].t, x: round3(q.x), y: round3(q.y) });
        continue;
      }
      let p = pts[k];
      // enforce the speed limit for this difficulty: pull the note toward the previous one
      const gap = Math.max(0.03, gaps[k]);
      const maxMove = K.maxSpeed * gap + 0.35;
      const d = dist(p, pos);
      if (d > maxMove && (k > 0 || i > 0)) {
        const f = maxMove / d;
        p = { x: pos.x + (p.x - pos.x) * f, y: pos.y + (p.y - pos.y) * f };
      }
      p = { x: clamp(p.x, 0, 2), y: clamp(p.y, 0, 2) };
      if (K.quantum < 0.05) p = snapToGrid(p, pos, rng);
      else p = { x: round3(p.x), y: round3(p.y) };
      if (Math.hypot(p.x - pos.x, p.y - pos.y) > 1e-3) prevDir = { x: p.x - pos.x, y: p.y - pos.y };
      pos = p;
      out.push({ t: seg[k].t, x: p.x, y: p.y });
    }
    i = end;
  }
  return out;
}

function round3(v) { return Math.round(v * 1000) / 1000; }

function snapToGrid(p, prev, rng) {
  let x = Math.round(p.x), y = Math.round(p.y);
  // rounding may collapse a move into a stack — nudge toward intended direction
  if (x === Math.round(prev.x) && y === Math.round(prev.y) && Math.hypot(p.x - prev.x, p.y - prev.y) > 0.3) {
    if (Math.abs(p.x - prev.x) > Math.abs(p.y - prev.y)) x = clamp(x + Math.sign(p.x - prev.x), 0, 2);
    else y = clamp(y + Math.sign(p.y - prev.y), 0, 2);
  }
  return { x, y };
}

function randomCellAway(from, minD, maxD, rng) {
  const cands = CELLS.filter((c) => {
    const d = dist(c, from);
    return d >= minD - 1e-6 && d <= maxD + 1e-6;
  });
  if (!cands.length) return rng.pick(CELLS.filter((c) => dist(c, from) > 0.5));
  return rng.pick(cands);
}

function randomPointAway(from, minD, maxD, rng) {
  for (let tries = 0; tries < 30; tries++) {
    const a = rng.float(0, Math.PI * 2);
    const r = rng.float(minD, maxD);
    const p = { x: from.x + Math.cos(a) * r, y: from.y + Math.sin(a) * r };
    if (p.x >= 0 && p.x <= 2 && p.y >= 0 && p.y <= 2) return p;
  }
  return { x: 2 - from.x, y: 2 - from.y };
}

function buildShape(kind, seg, gaps, start, prevDir, rng, K) {
  const n = seg.length;
  const pts = [];
  const quantum = rng.chance(K.quantum);
  switch (kind) {
    case 'stack': {
      const p = quantum ? randomPointAway(start, 0.4, 1.2, rng) : randomCellAway(start, 1, 1.5, rng);
      for (let k = 0; k < n; k++) pts.push(p);
      break;
    }
    case 'line': {
      // sweep across the grid along a row/column/diagonal
      const horizontal = rng.chance(0.5);
      const fixed = quantum ? rng.float(0, 2) : rng.int(0, 2);
      const dir = rng.chance(0.5) ? 1 : -1;
      for (let k = 0; k < n; k++) {
        const u = n === 1 ? 0.5 : k / (n - 1);
        const v = dir > 0 ? u * 2 : 2 - u * 2;
        const p = horizontal ? { x: v, y: fixed } : { x: fixed, y: v };
        pts.push(quantum ? p : { x: Math.round(p.x), y: Math.round(p.y) });
      }
      break;
    }
    case 'zigzag': {
      const horizontal = rng.chance(0.5);
      const a = rng.int(0, 1), b = a + (K.stars > 4 && rng.chance(0.5) ? 2 - a : 1);
      let along = rng.int(0, 2);
      let dirAlong = rng.chance(0.5) ? 1 : -1;
      for (let k = 0; k < n; k++) {
        const side = k % 2 === 0 ? a : Math.min(2, b);
        const p = horizontal ? { x: side, y: along } : { x: along, y: side };
        pts.push(p);
        if (quantum) along += dirAlong * 0.5; else if (k % 2 === 1) along += dirAlong;
        if (along > 2 || along < 0) { dirAlong *= -1; along = clamp(along, 0, 2); }
      }
      break;
    }
    case 'square': {
      const inset = quantum ? rng.float(0.2, 0.6) : 0;
      const corners = [
        { x: inset, y: inset }, { x: 2 - inset, y: inset }, { x: 2 - inset, y: 2 - inset }, { x: inset, y: 2 - inset },
      ];
      const small = !quantum && K.stars < 4 && rng.chance(0.5);
      const c0 = rng.int(0, 1), r0 = rng.int(0, 1);
      const smallCorners = [{ x: c0, y: r0 }, { x: c0 + 1, y: r0 }, { x: c0 + 1, y: r0 + 1 }, { x: c0, y: r0 + 1 }];
      const cs = small ? smallCorners : corners;
      const dir = rng.chance(0.5) ? 1 : 3;
      let idx = rng.int(0, 3);
      for (let k = 0; k < n; k++) { pts.push(cs[idx]); idx = (idx + dir) % 4; }
      break;
    }
    case 'triangle': {
      const tri = rng.pick([
        [{ x: 1, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }],
        [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 2 }],
        [{ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 2 }],
        [{ x: 2, y: 0 }, { x: 0, y: 1 }, { x: 2, y: 2 }],
      ]);
      const dir = rng.chance(0.5) ? 1 : 2;
      let idx = rng.int(0, 2);
      for (let k = 0; k < n; k++) { pts.push(tri[idx]); idx = (idx + dir) % 3; }
      break;
    }
    case 'star': {
      // pentagram: jump across a circle (every 2nd vertex of a pentagon)
      const r = rng.float(0.8, 1.0);
      let a = rng.float(0, Math.PI * 2);
      const step = (Math.PI * 4) / 5 * (rng.chance(0.5) ? 1 : -1);
      for (let k = 0; k < n; k++) { pts.push({ x: 1 + Math.cos(a) * r, y: 1 + Math.sin(a) * r }); a += step; }
      break;
    }
    case 'circle':
    case 'spiral': {
      const avgGap = gaps.reduce((s, g) => s + g, 0) / n;
      // pick a radius so the per-note arc respects the speed budget
      let r = rng.float(0.55, 1.0);
      const cx = 1 + (quantum ? rng.float(-0.25, 0.25) : 0);
      const cy = 1 + (quantum ? rng.float(-0.25, 0.25) : 0);
      const maxStep = Math.PI / 2 + clamp((K.stars - 10) * 0.08, 0, Math.PI / 6);
      const stepAngle = clamp((K.maxSpeed * avgGap * 0.8) / Math.max(0.3, r), 0.35, maxStep) * (rng.chance(0.5) ? 1 : -1);
      let a = Math.atan2(start.y - cy, start.x - cx) + stepAngle;
      for (let k = 0; k < n; k++) {
        const rr = kind === 'spiral' ? r * (1 - 0.6 * (k / Math.max(1, n - 1))) + 0.15 : r;
        let p = { x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr };
        if (!quantum && K.quantum < 0.05) {
          // grid-only circle: walk the 8 outer cells
          const ring = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }, { x: 0, y: 2 }, { x: 0, y: 1 }];
          p = ring[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
        }
        pts.push(p);
        a += stepAngle;
      }
      break;
    }
    case 'mirror': {
      let p = quantum ? randomPointAway(start, 0.8, 2, rng) : randomCellAway(start, 1, 2.9, rng);
      const axis = rng.pick(['x', 'y', 'xy']);
      for (let k = 0; k < n; k++) {
        pts.push(p);
        p = axis === 'x' ? { x: 2 - p.x, y: p.y } : axis === 'y' ? { x: p.x, y: 2 - p.y } : { x: 2 - p.x, y: 2 - p.y };
        if (dist(p, pts[pts.length - 1]) < 0.5) p = quantum ? randomPointAway(p, 0.8, 1.8, rng) : randomCellAway(p, 1, 2.3, rng);
      }
      break;
    }
    case 'melody': {
      // pitch → height; melody direction drives horizontal motion
      const mids = seg.map((s) => s.midi ?? 60);
      const lo = Math.min(...mids), hi = Math.max(...mids);
      let x = start.x;
      let dx = rng.chance(0.5) ? 1 : -1;
      for (let k = 0; k < n; k++) {
        const yRaw = hi === lo ? 1 : 2 - ((mids[k] - lo) / (hi - lo)) * 2;
        x += dx * (quantum ? rng.float(0.4, 0.9) : 1);
        if (x > 2 || x < 0) { dx *= -1; x = clamp(x, 0, 2); x += dx * 0.5; }
        pts.push({ x: clamp(x, 0, 2), y: quantum ? yRaw : Math.round(yRaw) });
      }
      break;
    }
    case 'jumpstream': {
      // cross-grid jumps on every note: corner/edge cells ≥ 1.4 apart, rarely going straight back
      let p = { x: Math.round(start.x), y: Math.round(start.y) };
      let prev = null;
      for (let k = 0; k < n; k++) {
        let next;
        for (let tries = 0; tries < 8; tries++) {
          next = randomCellAway(p, 1.4, 2.83, rng);
          if (!prev || dist(next, prev) > 0.5 || rng.chance(0.25)) break;
        }
        pts.push(next);
        prev = p;
        p = next;
      }
      break;
    }
    case 'burstjump': {
      // 1/8 bursts where every note moves one cell (the hardest thing in human-made maps)
      let p = { x: Math.round(start.x), y: Math.round(start.y) };
      let dir = null;
      for (let k = 0; k < n; k++) {
        const opts = CELLS.filter((c) => { const d = dist(c, p); return d > 0.9 && d < 1.5; });
        let next = rng.pick(opts);
        if (dir && rng.chance(0.6)) {
          const back = { x: p.x - dir.x, y: p.y - dir.y };
          if (back.x >= 0 && back.x <= 2 && back.y >= 0 && back.y <= 2) next = back; // vibro-like back-and-forth
        }
        dir = { x: next.x - p.x, y: next.y - p.y };
        pts.push(next);
        p = next;
      }
      break;
    }
    case 'jumps':
    default: {
      let p = start;
      for (let k = 0; k < n; k++) {
        const strength = seg[k].strength ?? 0.5;
        const want = clamp(K.jump * (0.6 + strength * 0.7), 0.7, 2.83);
        const next = quantum
          ? randomPointAway(p, want * 0.7, want, rng)
          : randomCellAway(p, Math.max(1, want * 0.6), Math.max(1.01, want), rng);
        // prefer changing direction (sharper patterns at higher difficulty)
        pts.push(next);
        p = next;
      }
    }
  }
  return pts;
}

// ---------------------------------------------------------------------------------------------
// Rhythm generator for synthetic maps (AI curriculum, "endless" practice).

/**
 * Generate note times for a synthetic map at a given difficulty level.
 * Level 0 ≈ slow quarter notes at 100 BPM; level 10 ≈ 200+ BPM jumps with 1/4 streams.
 */
export function syntheticTimes(level, seed, duration = 30, lead = 1.0) {
  const rng = new RNG(seed ^ 0x9e3779b9);
  const L = clamp(level, 0, 22);
  // tempo rises with level, then density rises through subdivisions
  const bpm = Math.min(90 + L * 11, 235) + rng.float(-8, 8);
  const beat = 60 / bpm;
  const times = [];
  let t = lead;
  const streamChance = L < 3 ? 0 : clamp((L - 3) * 0.045, 0, 0.55);
  const restChance = clamp(0.12 - L * 0.01, 0.02, 0.12);
  const p8 = clamp((L - 0.5) / 3.5, 0, 0.9);
  const p16 = L < 5 ? 0 : clamp((L - 5) * 0.035, 0, 0.6);
  // human-map style elements for the top levels (measured on real SS+/Rhythia maps):
  // sustained 1/4 "jump streams" at 145–185 BPM with cross-grid jumps, 1/8 bursts, and chords.
  const jumpChance = L < 11 ? 0 : clamp((L - 11) * 0.085, 0, 0.75);
  const burstChance = L < 13 ? 0 : clamp((L - 13) * 0.06, 0, 0.4);
  const chordChance = L < 6 ? 0 : clamp((L - 6) * 0.004, 0, 0.04);
  while (t < duration) {
    if (rng.chance(jumpChance)) {
      const step = 60 / rng.float(145 + (L - 11) * 2, 150 + (L - 11) * 5) / 4;
      const len = rng.int(8, 10 + 3 * Math.floor(L - 11));
      for (let k = 0; k < len && t < duration; k++) {
        times.push({ t, strength: 0.8, stream: true, jump: true });
        t += step;
      }
      t += step * 2;
      continue;
    }
    if (rng.chance(burstChance)) {
      const step = 60 / rng.float(150, 175) / 8;
      const len = rng.int(3, 6 + Math.floor(Math.max(0, L - 14)));
      const hard = rng.chance(clamp((L - 14) * 0.15, 0, 0.8));
      for (let k = 0; k < len && t < duration; k++) {
        times.push({ t, strength: k === 0 ? 0.9 : 0.3, stream: true, burst: true, hard });
        t += step;
      }
      t += beat / 2;
      continue;
    }
    const r = rng.next();
    if (r < streamChance) {
      // burst / stream of fast notes
      const len = rng.int(3, 4 + Math.floor(L));
      const step = beat / (L >= 6 ? 4 : 3);
      for (let k = 0; k < len && t < duration; k++) {
        times.push({ t, strength: k === 0 ? 0.9 : 0.35, stream: true });
        t += step;
      }
      t += beat / 2;
    } else if (r < streamChance + restChance) {
      t += beat * rng.int(1, 2);
    } else {
      const strong = Math.abs(((t - lead) / beat) % 1) < 0.01;
      times.push({ t, strength: strong ? 0.9 : 0.5 });
      if (rng.chance(chordChance)) times.push({ t, strength: 0.9, chord: true });
      // subdivision: eighths become common as the level rises, sixteenth doubles appear late
      let div = rng.chance(p8) ? 2 : 1;
      if (rng.chance(p16)) div = 4;
      if (L < 0.8 && rng.chance(0.5)) div = 0.5;
      t += beat / div;
    }
  }
  return times;
}

/** Complete synthetic map (notes only) for a curriculum level. */
export function syntheticMap(level, seed, duration = 30) {
  const times = syntheticTimes(level, seed, duration);
  const notes = placeNotes(times, { stars: level, seed: seed * 7 + 3 });
  return notes;
}
