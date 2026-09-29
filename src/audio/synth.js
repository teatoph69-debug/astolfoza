// Procedural music engine: composition (pure JS) + rendering (Web Audio, browser only).
//
//   composeSong(def)          → composition (events, beats, sections)      — runs in Node and browsers
//   renderSong(composition)   → Promise<AudioBuffer> (stereo)              — browser only
//   songEnergyAt(comp, t)     → 0..1 intensity for background visuals
//
// The composition's `events` array is the single source of truth: the renderer plays exactly
// these events and the rhythm-game charts (./notetimes.js) are derived from them, so the notes
// are sample-accurately in sync with the audio.
//
// Design notes
// ------------
// * Everything is deterministic from the song seed (mulberry32 RNG from core/rng.js).
// * Arrangement is phrase based: intro → build → drop → break → build → drop → outro, with every
//   section a whole number of 4-bar phrases. Harmony is a 4-chord diatonic loop per style; the
//   lead is built from a rhythmic/melodic motif (A A A' B) that is sequenced over the chords.
// * Rendering pre-synthesises every distinct sound once in plain JS (drum one-shots, one buffer
//   per distinct tonal note/chord) and then lets an OfflineAudioContext mix a few thousand
//   AudioBufferSourceNodes through per-instrument buses (filter sweeps, sidechain ducking,
//   convolution reverb, ping-pong delay). The master bus (glue compressor + look-ahead limiter)
//   runs in JS afterwards so it adds no latency — note timing stays exact.

import { RNG, hashString, mulberry32 } from '../core/rng.js';

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Timing
// ════════════════════════════════════════════════════════════════════════════════════════════

/** Seconds of silence before the first bar (the game needs lead-in time). */
export const LEAD_IN = 2.0;
/** Seconds after the last bar: final chord release + reverb tail. */
const TAIL = 3.2;

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Music theory helpers
// ════════════════════════════════════════════════════════════════════════════════════════════

const NOTE_PC = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6,
  G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
};

const mod = (a, n) => ((a % n) + n) % n;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const round6 = (x) => Math.round(x * 1e6) / 1e6;

function makeHarmony(key, scaleName) {
  const pc = NOTE_PC[key] ?? 9;
  const steps = SCALES[scaleName] ?? SCALES.minor;
  const N = steps.length;
  return {
    pc,
    steps,
    N,
    /** MIDI pitch of scale degree `deg` (0 = tonic, may be negative or ≥ 7) in MIDI octave `oct` (C4 = 60). */
    midi(deg, oct) {
      const o = Math.floor(deg / N);
      return 12 * (oct + 1) + pc + steps[deg - o * N] + 12 * o;
    },
  };
}

/** A diatonic chord on scale degree `deg`. `raise7` turns the minor v into a major V (harmonic minor). */
function makeChord(H, deg, raise7, seventh) {
  const tones = seventh ? [deg, deg + 2, deg + 4, deg + 6] : [deg, deg + 2, deg + 4];
  return { deg, tones, raise7: !!raise7 && mod(deg, 7) === 4 };
}

/** MIDI pitch of scale degree `deg` sounding over chord `ch` (applies the raised leading tone on V). */
function chordMidi(H, ch, deg, oct) {
  let m = H.midi(deg, oct);
  if (ch.raise7 && mod(deg, 7) === 6) m += 1;
  return m;
}

/** Close-position voicing of `ch` whose average pitch is nearest to `center`. */
function voiceChord(H, ch, center) {
  const n = ch.tones.length;
  let best = null;
  let bestCost = Infinity;
  for (let inv = 0; inv < n; inv++) {
    for (let oct = 1; oct <= 6; oct++) {
      const notes = [];
      for (let j = 0; j < n; j++) {
        const k = inv + j;
        notes.push(chordMidi(H, ch, ch.tones[k % n] + (k >= n ? 7 : 0), oct));
      }
      const mean = notes.reduce((a, b) => a + b, 0) / n;
      const cost = Math.abs(mean - center);
      if (cost < bestCost) {
        bestCost = cost;
        best = notes;
      }
    }
  }
  return best;
}

/** Chord root placed in the octave [lo, lo + 12). */
function bassRoot(H, ch, lo) {
  let m = chordMidi(H, ch, ch.deg, 1);
  while (m < lo) m += 12;
  while (m >= lo + 12) m -= 12;
  return m;
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Style presets (arrangement side). Sound design lives in PATCHES / KITS further below.
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// Drum pattern strings: one char per 16th step ('X' 1.0, 'x' 0.8, 'o' 0.55, '-' 0.32, '.' rest).
// 16-char patterns repeat every bar, 32-char patterns span two bars.
// Bass pattern strings: 'r' root, 'o' octave up, 'f' fifth ('R'/'O'/'F' accented), '-' tie, '.' rest.
// Lead rhythm strings: 'x' onset, '-' tie, '.' rest (a note lasts until the next onset / rest).

const DRUM_VEL = { X: 1.0, x: 0.8, o: 0.55, '-': 0.32 };

const STYLES = {
  synthwave: {
    chordBars: 1,
    progs: [[0, 5, 2, 6], [0, 5, 6, 4], [0, 3, 5, 6]],
    breakProgs: [[5, 3, 0, 6], [3, 5, 0, 6]],
    padCenter: 62, arpCenter: 74, leadOct: 4, bassLo: 33,
    drums: {
      intro1: { hat: '..o...o...o...o.' },
      intro2: { kick: 'x.......x.......', hat: 'x-o-x-o-x-o-x-o-' },
      build: { kick: 'x...x...x...x...', snare: '....o.......o...', hat: 'x-o-x-o-x-o-x-o-' },
      drop: { kick: 'X...x...X...x...', snare: '....X.......X...', hat: 'x-o-x-o-x-o-x-o-', openhat: '..............o.' },
      break1: {},
      break2: { hat: '..o...o...o...o.' },
      outro1: { kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'x-o-x-o-x-o-x-o-' },
      outro2: { hat: '..o...o...o...o.' },
    },
    bass: { pattern: 'r.o.r.o.r.o.r.o.', gate: 1.5 },
    arp: { rate: 1, pattern: [0, 1, 2, 3, 2, 1], gate: 0.8, intro: 0.5, drop: 0.42, brk: 0.5 },
    chordMode: 'pad',
    lead: {
      rhythms: ['x---x-x-x---x-x-', 'x-x-x---x-x---x-', 'x---x---x-x-x-x-', 'x-----x-----x-x-'],
      cadences: ['x-x-x---x-------', 'x---x-x-x-------', 'x-----x-x-------'],
      gate: 0.92, allow16: false,
    },
    teaser: true, preDropGap: 0, roll32: true,
    sal: {},
  },

  darksynth: {
    chordBars: 1,
    progs: [[0, 5, 3, 4], [0, 3, 5, 4], [0, 6, 5, 4]],
    breakProgs: [[5, 3, 0, 4]],
    raise7: true,
    padCenter: 60, arpCenter: 72, leadOct: 4, bassLo: 26,
    drums: {
      intro1: { hat: '..x...x...x...x.' },
      intro2: { kick: 'X.......X.......', hat: 'x-x-x-x-x-x-x-x-' },
      build: { kick: 'X...X...X...X...', hat: 'x-x-x-x-x-x-x-x-' },
      drop: { kick: 'X...X...X...X...', snare: '....X.......X...', hat: 'x-x-x-x-x-x-x-x-', openhat: '..............x.' },
      break1: {},
      break2: { hat: '..x...x...x...x.', kick: 'x...............' },
      outro1: { kick: 'X...X...X...X...', snare: '....X.......X...', hat: 'x-x-x-x-x-x-x-x-' },
      outro2: { hat: '..x...x...x...x.' },
    },
    bass: { pattern: 'RrrrRrrrRrrrRrro', gate: 0.75 },
    arp: { rate: 1, pattern: [0, 2, 1, 3, 2, 4, 3, 1], gate: 0.7, intro: 0.5, drop: 0.4, brk: 0.5 },
    chordMode: 'pad',
    lead: {
      rhythms: ['x--x--x-x--x--x-', 'x-x-xx-x-x-xx-x-', 'x--x--x--x--x-x-', 'x-xx-x-xx-x-x---'],
      cadences: ['x--x--x-x-------', 'x-x-x-x-x-------', 'x--x--x---------'],
      gate: 0.85, allow16: true,
    },
    teaser: true, preDropGap: 0, roll32: true,
    sal: { bass: 0.5 },
  },

  house: {
    chordBars: 1,
    progs: [[0, 5, 6, 4], [0, 3, 6, 2], [0, 6, 5, 6]],
    breakProgs: [[3, 6, 2, 5]],
    seventh: true,
    padCenter: 63, arpCenter: 75, leadOct: 4, bassLo: 29,
    drums: {
      intro1: { kick: 'X...X...X...X...', hat: 'x-.-x-.-x-.-x-.-' },
      intro2: { kick: 'X...X...X...X...', hat: 'x-.-x-.-x-.-x-.-', openhat: '..x...x...x...x.', clap: '....x.......x...' },
      build: { kick: 'X...X...X...X...', hat: 'x-.-x-.-x-.-x-.-', openhat: '..x...x...x...x.' },
      drop: { kick: 'X...X...X...X...', clap: '....X.......X...', hat: 'x-.-x-.-x-.-x-.-', openhat: '..x...x...x...x.' },
      break1: { hat: '..-...-...-...-.' },
      break2: { hat: 'x-.-x-.-x-.-x-.-', clap: '....o.......o...' },
      outro1: { kick: 'X...X...X...X...', clap: '....X.......X...', hat: 'x-.-x-.-x-.-x-.-', openhat: '..x...x...x...x.' },
      outro2: { kick: 'X...X...X...X...', hat: 'x-.-x-.-x-.-x-.-' },
    },
    bass: { pattern: '..r...r...r...r...r...r...r..o.r', gate: 1.6 },
    arp: { rate: 2, pattern: [0, 2, 1, 3], gate: 0.5, intro: 0, drop: 0.3, brk: 0.45 },
    chordMode: 'stab',
    stabs: ['x..x..x...x..x..', '..x..x..x..x..x.', 'x..x...x..x..x..'],
    lead: {
      rhythms: ['x--x--x---x--x--', '--x--x--x--x-x--', 'x-x--x-x--x-x---', 'x--x--x-x--x----'],
      cadences: ['x--x--x-x-------', 'x-x--x-x--------', '--x--x--x-------'],
      gate: 0.7, allow16: true,
    },
    teaser: true, preDropGap: 0, roll32: true,
    sal: { chord: 0.7 },
  },

  trance: {
    chordBars: 2,
    progs: [[0, 5, 2, 6], [0, 5, 3, 6], [0, 3, 5, 6]],
    breakProgs: [[5, 6, 3, 4], [3, 5, 6, 6]],
    padCenter: 64, arpCenter: 72, leadOct: 4, bassLo: 31,
    drums: {
      intro1: { kick: 'X...X...X...X...', hat: '..-...-...-...-.' },
      intro2: { kick: 'X...X...X...X...', openhat: '..x...x...x...x.', hat: 'x-x-x-x-x-x-x-x-' },
      build: { kick: 'X...X...X...X...', openhat: '..x...x...x...x.', hat: 'x-x-x-x-x-x-x-x-' },
      drop: { kick: 'X...X...X...X...', clap: '....X.......X...', openhat: '..x...x...x...x.', hat: 'x-x-x-x-x-x-x-x-' },
      break1: {},
      break2: { hat: '..-...-...-...-.' },
      outro1: { kick: 'X...X...X...X...', clap: '....X.......X...', openhat: '..x...x...x...x.', hat: 'x-x-x-x-x-x-x-x-' },
      outro2: { kick: 'X...X...X...X...', openhat: '..x...x...x...x.' },
    },
    bass: { pattern: '.rrr.rrr.rrr.rrr', gate: 0.8 },
    arp: { rate: 1, pattern: [0, 3, 2, 3, 1, 3, 2, 3], gate: 0.6, intro: 0.5, drop: 0.45, brk: 0.6 },
    chordMode: 'pad',
    lead: {
      rhythms: ['x--x--x--x--x-x-', 'x-x-x-xxx-x-x-x-', 'x--x--x-x--x--x-'],
      answers: ['x-------x-x-x---', 'x---x---x-x-----', 'x--x--x-x-------'],
      cadences: ['x--x--x-x-------', 'x-x-x-x-x-------'],
      gate: 0.9, allow16: true,
    },
    teaser: true, preDropGap: 0, roll32: false,
    sal: {},
  },

  dubstep: {
    chordBars: 2,
    progs: [[0, 5, 6, 4], [0, 5, 2, 6], [0, 3, 5, 4]],
    breakProgs: [[5, 3, 0, 6]],
    padCenter: 62, arpCenter: 76, leadOct: 4, bassLo: 30,
    drums: {
      intro1: { hat: '..-...-...-...-.' },
      intro2: { kick: 'X...............X...............', snare: '........o...............o.......', hat: 'x.x.x.x.x.x.x.x.' },
      build: { kick: 'X...X...X...X...', hat: 'x.x.x.x.x.x.x.x.' },
      drop: {
        kick: 'X.........x.....X.....x...x.....',
        snare: '........X...............X.......',
        hat: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.-x',
      },
      break1: {},
      break2: { hat: 'x...x...x...x...' },
      outro1: {
        kick: 'X.........x.....X.....x...x.....',
        snare: '........X...............X.......',
        hat: 'x.x.x.x.x.x.x.x.',
      },
      outro2: { hat: 'x.x.x.x.x.x.x.x.' },
    },
    bass: { wobble: true },
    arp: { rate: 2, pattern: [0, 1, 2, 3, 4, 3, 2, 1], gate: 0.9, intro: 0.5, drop: 0, brk: 0.5 },
    chordMode: 'pad', padDrop: 0.35,
    lead: {
      rhythms: ['x-----x-----x---', 'x-x-----x---x---', 'x-----x---x-x---'],
      answers: ['x---------------', 'x-----x---------'],
      cadences: ['x-----x-x-------', 'x---x---x-------'],
      gate: 0.9, allow16: false,
    },
    leadDrop: false, teaser: false, preDropGap: 1, roll32: false,
    sal: { bass: 0.95, lead: 0.85 },
  },

  chiptune: {
    chordBars: 1,
    progs: [[0, 3, 6, 0], [0, 2, 3, 6], [0, 6, 3, 3]],
    breakProgs: [[3, 6, 0, 0], [2, 3, 6, 6]],
    padCenter: 64, arpCenter: 76, leadOct: 5, bassLo: 40,
    drums: {
      intro1: { hat: 'x.x.x.x.x.x.x.x.' },
      intro2: { kick: 'X.......X.......', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' },
      build: { kick: 'X...X...X...X...', hat: 'x.x.x.x.x.x.x.x.' },
      drop: {
        kick: 'X.....x.X.......X.....x.X.x.....',
        snare: '....X.......X.......X.......X.x.',
        hat: 'x.x.x.x.x.x.x.x.',
      },
      break1: { hat: '....x.......x...' },
      break2: { kick: 'x.......x.......', hat: 'x.x.x.x.x.x.x.x.' },
      outro1: { kick: 'X.....x.X.......', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.' },
      outro2: { hat: 'x.x.x.x.x.x.x.x.' },
    },
    bass: { pattern: 'r.r.o.r.r.r.o.r.r.o.r.o.r.o.f.o.', gate: 1.4 },
    arp: { rate: 1, pattern: [0, 1, 2], gate: 0.9, intro: 0.5, drop: 0.4, brk: 0.55 },
    chordMode: 'pad', padDrop: 0,
    lead: {
      rhythms: ['x-x-x-xxx-x-x-x-', 'x-xxx-x-x-x-xx--', 'x-x-xx-xx-x-x-x-', 'x---x-xxx---x-x-'],
      cadences: ['x-x-x-x-x-------', 'x-xxx-x-x-------', 'x-x-x-xxx-------'],
      gate: 0.85, allow16: true,
    },
    teaser: true, preDropGap: 0, roll32: false,
    sal: { arp: 0.4 },
  },

  dnb: {
    chordBars: 2,
    progs: [[0, 5, 3, 4], [0, 6, 5, 5], [0, 5, 2, 6]],
    breakProgs: [[5, 3, 0, 6]],
    padCenter: 62, arpCenter: 76, leadOct: 5, bassLo: 24,
    drums: {
      intro1: { hat: '..-...-...-...-.' },
      intro2: { kick: 'X.........X.....', snare: '....x.......x...', hat: 'x-x-x-x-x-x-x-x-' },
      build: { kick: 'X.......X.......', hat: 'x-x-x-x-x-x-x-x-' },
      drop: {
        kick: 'X.........X.....X.x.......X.....',
        snare: '....X..-.-..X.......X..-.-..X..-',
        hat: 'x-x-x-x-x-x-x-x-',
        openhat: '..............................x.',
      },
      break1: {},
      break2: { hat: 'x-x-x-x-x-x-x-x-' },
      outro1: { kick: 'X.........X.....', snare: '....X.......X...', hat: 'x-x-x-x-x-x-x-x-' },
      outro2: { hat: 'x-x-x-x-x-x-x-x-' },
    },
    bass: { pattern: 'R---------R-----R-------r-----o-', gate: 1 },
    arp: { rate: 2, pattern: [0, 2, 4, 2, 1, 3, 5, 3], gate: 0.5, intro: 0.45, drop: 0, brk: 0.5 },
    chordMode: 'pad', padDrop: 0.5,
    lead: {
      rhythms: ['x-----x-----x---', 'x---x-----x-x---', 'x-x---x---x---x-'],
      answers: ['x---------------', 'x---x---x-------', 'x-x-x-----------'],
      cadences: ['x---x---x-------', 'x-----x-x-------'],
      gate: 0.9, allow16: false,
    },
    teaser: false, preDropGap: 1, roll32: false,
    sal: { snare: 0.98, bass: 0.6 },
  },

  hardcore: {
    chordBars: 1,
    progs: [[3, 4, 2, 5], [5, 3, 4, 0], [0, 4, 5, 3]],
    breakProgs: [[3, 4, 5, 5], [5, 4, 3, 4]],
    padCenter: 64, arpCenter: 76, leadOct: 4, bassLo: 35,
    drums: {
      intro1: { hat: 'x.x.x.x.x.x.x.x.' },
      intro2: { kick: 'X...X...X...X...', openhat: '..x...x...x...x.' },
      build: { kick: 'X...X...X...X...', openhat: '..x...x...x...x.' },
      drop: { kick: 'X...X...X...X...', clap: '....X.......X...', openhat: '..x...x...x...x.', hat: 'x.x.x.x.x.x.x.x.' },
      break1: {},
      break2: { hat: '..x...x...x...x.' },
      outro1: { kick: 'X...X...X...X...', clap: '....X.......X...', openhat: '..x...x...x...x.' },
      outro2: { kick: 'X...X...X...X...' },
    },
    bass: { pattern: '..r...r...r...r.', gate: 1.6 },
    arp: { rate: 1, pattern: [0, 1, 2, 3, 4, 5, 4, 3], gate: 0.6, intro: 0.5, drop: 0.38, brk: 0.55 },
    chordMode: 'pad',
    lead: {
      rhythms: ['x-x-x-x-x-x-xxxx', 'x-xxx-x-x-xxx-x-', 'x-x-x-xxx-x-x-x-', 'x--x--x-x--x--x-'],
      cadences: ['x-x-x-x-x-------', 'x-xxx-x-x-------', 'x--x--x-x-------'],
      gate: 0.88, allow16: true,
    },
    teaser: true, preDropGap: 0, roll32: false,
    sal: {},
  },
};

/** Base salience ("how prominent is this sound") per event kind — used by notetimes.js. */
const BASE_SALIENCE = {
  kick: 0.8, snare: 0.9, clap: 0.85, hat: 0.3, openhat: 0.35, bass: 0.55,
  lead: 0.95, arp: 0.5, chord: 0.6, riser: 0, impact: 1.0,
};

// Section energy (for visuals + chart density).
const SECTION_ENERGY = {
  intro: [0.28, 0.4], build: [0.55, 0.92], drop: [1, 1], break: [0.38, 0.45], outro: [0.5, 0.2],
};

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Form planning
// ════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Split `wantBars` into sections of whole 4-bar phrases. Drops grow in steps of a full chord
 * cycle so melodies always complete.
 */
function planForm(wantBars, chordBars) {
  const U = 4; // bars per unit
  const secs = [
    { name: 'intro', u: 1, max: 4, inc: 1 },
    { name: 'build', u: 1, max: 2, inc: 1 },
    { name: 'drop', u: 2, max: 8, inc: chordBars },
    { name: 'break', u: 1, max: 4, inc: 1 },
    { name: 'build', u: 1, max: 2, inc: 1 },
    { name: 'drop', u: 2, max: 8, inc: chordBars },
    { name: 'outro', u: 1, max: 2, inc: 1 },
  ];
  // Order in which extra length is handed out.
  const order = [2, 5, 0, 3, 2, 5, 4, 1, 6, 3, 0, 2, 5];
  let left = Math.round(wantBars / U) - secs.reduce((a, s) => a + s.u, 0);
  for (let k = 0, guard = 0; left > 0 && guard < 100; k++, guard++) {
    const s = secs[order[k % order.length]];
    if (s.u + s.inc <= s.max && s.inc <= left) {
      s.u += s.inc;
      left -= s.inc;
    }
  }
  return secs.map((s) => ({ name: s.name, bars: s.u * U }));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Melody construction
// ════════════════════════════════════════════════════════════════════════════════════════════

function parseRhythm(str, offset = 0) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    if (str[i] !== 'x') continue;
    let len = 1;
    while (i + len < str.length && str[i + len] === '-') len++;
    out.push({ step: i + offset, len });
  }
  return out;
}

/** Small random edits so the same template does not always produce the same rhythm. */
function mutateRhythm(rng, notes, allow16) {
  const r = notes.map((n) => ({ ...n }));
  if (r.length > 4 && rng.chance(0.3)) {
    // merge a note into its predecessor (if they are contiguous)
    const i = rng.int(1, r.length - 1);
    if (r[i - 1].step + r[i - 1].len === r[i].step) {
      r[i - 1].len += r[i].len;
      r.splice(i, 1);
    }
  }
  if (allow16 && rng.chance(0.35)) {
    // split a long note in two
    const cands = r.filter((n) => n.len >= 4);
    if (cands.length) {
      const n = rng.pick(cands);
      const h = n.len >> 1;
      r.splice(r.indexOf(n) + 1, 0, { step: n.step + h, len: n.len - h });
      n.len = h;
    }
  }
  return r;
}

const CHORD_TONES_REL = [-3, 0, 2, 4, 7, 9, 11];
function nearestTone(x, avoid) {
  let best = 0;
  let bd = Infinity;
  for (const c of CHORD_TONES_REL) {
    if (c === avoid) continue;
    const d = Math.abs(c - x);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

/** Pitches (scale degrees relative to the chord root) for one rhythmic cell. */
function genCellPitches(rng, rhythm, cadence) {
  let cur = rng.pick([0, 2, 4, 4, 7]);
  let dir = rng.chance(0.5) ? 1 : -1;
  const out = [];
  for (let i = 0; i < rhythm.length; i++) {
    const n = rhythm[i];
    if (i > 0) {
      const strong = n.step % 4 === 0 || n.len >= 4;
      if (rng.chance(0.16)) {
        // repeated note — very common in hooks
      } else if (strong) {
        cur = nearestTone(cur + dir * rng.pick([1, 2, 2, 3]), cur);
      } else {
        cur += dir * (rng.chance(0.78) ? 1 : 2);
      }
      if (cur > 9) { cur = 9; dir = -1; }
      if (cur < -2) { cur = -2; dir = 1; }
      if (rng.chance(0.28)) dir = -dir;
    }
    out.push(cur);
  }
  if (cadence && out.length) {
    // resolve: last note on root/third, approached by step
    const last = out.length - 1;
    const prev = last > 0 ? out[last - 1] : 2;
    out[last] = Math.abs(prev) <= Math.abs(prev - 2) ? 0 : 2;
    if (prev > 4 && rng.chance(0.5)) out[last] += 7; // resolve up to the octave when the line is high
    if (last > 0 && Math.abs(out[last - 1] - out[last]) > 2) out[last - 1] = out[last] + (rng.chance(0.5) ? 1 : -1);
  }
  return out;
}

/**
 * Build the song's hook: a motif (rhythm + contour) sequenced over the chord loop as
 * A A A' B (phrase 1) and A A A' C (phrase 2). Returns notes with absolute scale degrees.
 */
function buildMelody(rng, S, prog) {
  const L = S.lead;
  const cb = S.chordBars;
  const cellRhythm = (templates, cadence) => {
    let r = parseRhythm(rng.pick(templates));
    if (cb === 2) {
      const second = cadence ? 'x---------------' : rng.pick(L.answers || ['x---------------']);
      r = r.concat(parseRhythm(second, 16));
    }
    return cadence ? r : mutateRhythm(rng, r, L.allow16);
  };
  const rA = cellRhythm(L.rhythms, false);
  const pA = genCellPitches(rng, rA, false);
  // A' = same rhythm, ending lifted a step (a "question")
  const pA2 = pA.slice();
  const e = pA2.length - 1;
  pA2[e] = nearestTone(pA2[e] + 2, pA2[e]);
  const rB = cellRhythm(L.cadences, true);
  const pB = genCellPitches(rng, rB, true);
  const rC = cellRhythm(L.cadences, true);
  const pC = genCellPitches(rng, rC, true);

  const cells1 = [[rA, pA], [rA, pA], [rA, pA2], [rB, pB]];
  const cells2 = [[rA, pA], [rA, pA], [rA, pA2], [rC, pC]];
  const range = [-2, 10];
  const realize = (cells) => {
    let prev = 4;
    const notes = [];
    cells.forEach(([rh, pit], c) => {
      const root = prog[c % prog.length];
      const degs = pit.map((p) => p + root);
      let best = 0;
      let bestCost = Infinity;
      for (const sh of [-14, -7, 0, 7, 14]) {
        let cost = Math.abs(degs[0] + sh - prev);
        for (const d of degs) {
          const x = d + sh;
          if (x < range[0]) cost += (range[0] - x) * 3;
          if (x > range[1]) cost += (x - range[1]) * 3;
        }
        if (cost < bestCost) {
          bestCost = cost;
          best = sh;
        }
      }
      rh.forEach((n, i) => {
        const acc = n.step % 4 === 0 ? 1 : n.step % 2 === 0 ? 0.88 : 0.76;
        notes.push({ step: c * 16 * cb + n.step, len: n.len, deg: degs[i] + best, acc });
      });
      prev = degs[degs.length - 1] + best;
    });
    return notes;
  };
  const phrases = [realize(cells1), realize(cells2)];

  // Break version: only the notes on beats, held longer.
  const slow = phrases[0].filter((n) => n.step % 8 === 0 || n.len >= 6);
  const brk = slow.map((n, i) => {
    const next = i + 1 < slow.length ? slow[i + 1].step : 16 * 4 * cb;
    return { ...n, len: Math.min(8, next - n.step), acc: 0.9 };
  });
  return { phrases, brk, phraseSteps: 16 * 4 * cb };
}

// Dubstep wobble chops, two bars each. Letters = wobble rate (cycles per beat): A 1, C 2, D 3,
// E 4, B = short stab without wobble. '-' tie, '.' rest.
const WOB_TEMPLATES = [
  'A---A---.-B-C-------B.B.D-----.-',
  'C-------B.B.B.E-A-------.-B.D---',
  'A-B.A-B.C---C---D-----B.E---B.B.',
  'D-----D-----B.B.A-------C---E---',
  'C---C---B.B.A---E-E-B.--D-----B.',
];
const WOB_RATE = { A: 1, B: 0, C: 2, D: 3, E: 4 };

function buildWobbles(rng) {
  const pickT = () => {
    const tpl = rng.pick(WOB_TEMPLATES);
    const notes = [];
    for (let i = 0; i < tpl.length; i++) {
      const c = tpl[i];
      if (!(c in WOB_RATE)) continue;
      let len = 1;
      while (i + len < tpl.length && tpl[i + len] === '-') len++;
      // pitch: scale degree offset relative to chord root (mostly the root)
      const deg = rng.weighted([0, 7, 4, -1, 2], [6, 2, 1.2, 1, 0.8]);
      notes.push({ step: i, len, wob: WOB_RATE[c], deg });
    }
    return notes;
  };
  const a = pickT();
  const b = pickT();
  const c = pickT();
  return [a, b, a, c]; // one per 2-bar chunk (A B A C)
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  composeSong
// ════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Compose a song from its definition. Pure and deterministic.
 * @param {object} def  entry from SONGS
 * @returns {{def, bpm, duration, beatTimes:number[], barTimes:number[], sections:object[], events:object[]}}
 */
export function composeSong(def) {
  const S = STYLES[def.style] || STYLES.synthwave;
  const bpm = def.bpm;
  const spb = 60 / bpm;
  const stepDur = spb / 4;
  const barDur = spb * 4;
  const cb = S.chordBars;
  const H = makeHarmony(def.key, def.scale);
  const baseSeed = (def.seed >>> 0) || hashString(def.id || def.title || 'song');
  const rngFor = (name) => new RNG((baseSeed ^ hashString(name)) >>> 0);

  // ── form & timing ──
  const wantBars = Math.max(36, Math.floor(((def.lengthSec || 110) - LEAD_IN - TAIL) / barDur));
  const form = planForm(wantBars, cb);
  let barCursor = 0;
  for (const f of form) {
    f.startBar = barCursor;
    barCursor += f.bars;
  }
  const totalBars = barCursor;
  const t0 = LEAD_IN;
  const tAt = (bar, step = 0) => round6(t0 + bar * barDur + step * stepDur);
  const duration = round6(tAt(totalBars) + TAIL);

  const sections = form.map((f) => {
    const [e0, e1] = SECTION_ENERGY[f.name];
    return {
      name: f.name,
      start: tAt(f.startBar),
      end: tAt(f.startBar + f.bars),
      energy: e0,
      energyEnd: e1,
      startBar: f.startBar,
      bars: f.bars,
    };
  });
  let dropNo = 0;
  for (const s of sections) if (s.name === 'drop') s.index = dropNo++;

  const beatTimes = [];
  for (let b = 0; b <= totalBars * 4; b++) beatTimes.push(round6(t0 + b * spb));
  const barTimes = [];
  for (let b = 0; b <= totalBars; b++) barTimes.push(tAt(b));

  // ── harmony ──
  const rh = rngFor('harmony');
  const prog = rh.pick(S.progs);
  const breakProg = S.breakProgs ? rh.pick(S.breakProgs) : prog;
  const chordFor = (sec, barInSec) => {
    const p = sec.name === 'break' ? breakProg : prog;
    let deg = p[Math.floor(barInSec / cb) % p.length];
    // End the song on the tonic.
    if (sec.name === 'outro' && barInSec >= sec.bars - cb) deg = 0;
    return makeChord(H, deg, S.raise7, S.seventh);
  };

  // ── event helpers ──
  const events = [];
  const push = (t, kind, midi, vel, dur, extra) => {
    const e = { t: round6(t), kind, midi: midi ?? null, vel: round6(clamp(vel, 0, 1)), dur: round6(Math.max(0.01, dur)) };
    if (extra) Object.assign(e, extra);
    events.push(e);
  };
  const drumHit = (bar, step, kind, vel) => push(tAt(bar, step), kind, null, vel, kind === 'openhat' ? 0.3 : 0.15);

  const rDrum = rngFor('drums');
  const rMel = rngFor('melody');
  const melody = buildMelody(rMel, S, prog);
  const wobbles = S.bass.wobble ? buildWobbles(rngFor('wobble')) : null;
  const stabPat = S.stabs ? rngFor('stabs').pick(S.stabs) : null;
  const gaps = []; // [start, end) windows silenced before drops

  // ── per-section generation ──
  sections.forEach((sec, si) => {
    const next = sections[si + 1];
    const half = sec.bars / 2;

    for (let b = 0; b < sec.bars; b++) {
      const bar = sec.startBar + b;
      const ch = chordFor(sec, b);
      const prog01 = b / sec.bars;
      const fade = sec.name === 'outro' ? 1 - 0.45 * prog01 : 1;

      // ─ drums ─
      let set;
      switch (sec.name) {
        case 'intro': set = b < half ? S.drums.intro1 : S.drums.intro2; break;
        case 'build': set = S.drums.build; break;
        case 'drop': set = S.drums.drop; break;
        case 'break': set = b < half ? S.drums.break1 : S.drums.break2; break;
        default: set = b < half ? S.drums.outro1 : S.drums.outro2;
      }
      const secVel = { intro: 0.78, build: 0.9, drop: 1, break: 0.72, outro: 0.85 }[sec.name] * fade;
      const rollBars = Math.min(4, sec.bars);
      const inRoll = sec.name === 'build' && b >= sec.bars - rollBars;
      const lastBar = b === sec.bars - 1;

      // Fills in drops: every 4 bars a 1-beat snare fill, every 8 bars (and at the end) 2 beats.
      let fillFrom = 16;
      if (sec.name === 'drop') {
        if (lastBar || (b + 1) % 8 === 0) fillFrom = 8;
        else if ((b + 1) % 4 === 0) fillFrom = 12;
      }

      for (const kind of ['kick', 'snare', 'clap', 'hat', 'openhat']) {
        let p = set[kind];
        if (!p) continue;
        if (p.length > 16) p = p.slice((b % 2) * 16, (b % 2) * 16 + 16);
        if (inRoll && kind !== 'kick' && kind !== 'hat') continue;
        if (inRoll && lastBar && (kind === 'kick' || kind === 'hat')) continue;
        for (let s = 0; s < 16; s++) {
          const v = DRUM_VEL[p[s]];
          if (!v) continue;
          if (s >= fillFrom && (kind === 'snare' || kind === 'clap')) continue;
          if (s >= fillFrom + 4 && kind === 'kick') continue;
          let vel = v * secVel;
          if (kind === 'hat' || kind === 'openhat') vel *= 0.88 + rDrum.float(0, 0.12);
          drumHit(bar, s, kind, vel);
        }
      }
      if (fillFrom < 16) {
        const fillSteps = fillFrom === 8 ? [8, 10, 12, 13, 14, 15] : [12, 13, 14, 15];
        fillSteps.forEach((s, i) => drumHit(bar, s, 'snare', (0.5 + 0.45 * (i / (fillSteps.length - 1))) * secVel));
      }
      // Crash (soft impact) at every 8-bar phrase inside a drop.
      if (sec.name === 'drop' && b > 0 && b % 8 === 0) push(tAt(bar), 'impact', null, 0.38, 2.5);

      // Snare roll in builds: quarters → 8ths → 16ths (→ 32nds) with a crescendo.
      if (inRoll) {
        const r = b - (sec.bars - rollBars);
        const rates = [4, 2, 1, 1].slice(4 - rollBars);
        const rate = rates[r];
        for (let s = 0; s < 16; s += rate) {
          const pr = (r * 16 + s) / (rollBars * 16);
          drumHit(bar, s, 'snare', 0.28 + 0.7 * pr);
          if (S.roll32 && lastBar && s >= 8 && bpm < 132) push(tAt(bar, s + 0.5), 'snare', null, 0.3 + 0.7 * pr, 0.1);
        }
        if (!lastBar) {
          // keep the pulse: kick on quarters
          for (let s = 0; s < 16; s += 4) if (!set.kick || DRUM_VEL[set.kick[s]] === undefined) drumHit(bar, s, 'kick', 0.8);
        }
      }

      // ─ bass ─
      const bassOn =
        (sec.name === 'intro' && b >= half) ||
        (sec.name === 'build' && b < sec.bars - (sec.bars > 4 ? 2 : 1)) ||
        sec.name === 'drop' ||
        sec.name === 'break' ||
        (sec.name === 'outro' && b < half);
      if (bassOn) {
        const root = bassRoot(H, ch, S.bassLo);
        const bVel = { intro: 0.7, build: 0.8, drop: 1, break: 0.6, outro: 0.85 }[sec.name] * fade;
        if (sec.name === 'break' || (sec.name === 'intro' && S.bass.wobble)) {
          // held sub notes, one per chord
          if (b % cb === 0) push(tAt(bar), 'bass', root, bVel, cb * barDur * 0.96, { wob: 0 });
        } else if (S.bass.wobble && (sec.name === 'drop' || sec.name === 'outro' || sec.name === 'build')) {
          if (sec.name === 'drop') {
            if (b % 2 === 0) {
              const chunk = wobbles[(b >> 1) % wobbles.length];
              for (const n of chunk) {
                const barOff = n.step >= 16 ? 1 : 0;
                if (b + barOff >= sec.bars) continue;
                const chN = chordFor(sec, b + barOff);
                let m = bassRoot(H, chN, S.bassLo) + (chordMidi(H, chN, chN.deg + n.deg, 3) - chordMidi(H, chN, chN.deg, 3));
                const isStab = n.wob === 0;
                push(tAt(bar, n.step), 'bass', m, isStab ? 0.9 : 1, (isStab ? Math.min(n.len, 2) : n.len) * stepDur * 0.95, { wob: n.wob });
              }
            }
          } else if (b % cb === 0) {
            push(tAt(bar), 'bass', root, bVel * 0.8, cb * barDur * 0.9, { wob: sec.name === 'build' ? 2 : 1 });
          }
        } else {
          let p = S.bass.pattern;
          const plen = p.length;
          if (plen > 16) p = p.slice((b % (plen / 16)) * 16, (b % (plen / 16)) * 16 + 16);
          for (let s = 0; s < 16; s++) {
            const c = p[s];
            if (c === '.' || c === '-') continue;
            let len = 1;
            while (s + len < 16 && p[s + len] === '-') len++;
            const dur = (len > 1 ? len * 0.97 : S.bass.gate) * stepDur;
            const lc = c.toLowerCase();
            let m = root;
            if (lc === 'o') m = root + 12;
            else if (lc === 'f') m = bassRoot(H, ch, S.bassLo) + (chordMidi(H, ch, ch.deg + 4, 3) - chordMidi(H, ch, ch.deg, 3));
            const acc = c === lc ? 0.82 : 1;
            push(tAt(bar, s), 'bass', m, bVel * acc, dur);
          }
        }
      }

      // ─ chords ─
      let padVel = { intro: 0.55, build: 0.62, drop: S.padDrop ?? 0.7, break: 0.7, outro: 0.6 }[sec.name] * fade;
      const mode = sec.name === 'drop' || (sec.name === 'outro' && b < half) || sec.name === 'build' ? S.chordMode : 'pad';
      if (padVel > 0) {
        const notes = voiceChord(H, ch, S.padCenter);
        if (mode === 'stab') {
          for (let s = 0; s < 16; s++) {
            if (stabPat[s] !== 'x') continue;
            for (const m of notes) push(tAt(bar, s), 'chord', m, (sec.name === 'drop' ? 0.85 : 0.7) * fade, stepDur * 1.6);
          }
        } else if (b % cb === 0) {
          let dur = cb * barDur * 0.98;
          if (sec.name === 'outro' && b + cb >= sec.bars) dur = cb * barDur + 1.8; // final chord rings out
          for (const m of notes) push(tAt(bar), 'chord', m, padVel, dur);
        }
      }

      // ─ arps ─
      const A = S.arp;
      let arpVel = 0;
      if (sec.name === 'intro') arpVel = A.intro * (0.8 + 0.4 * prog01);
      else if (sec.name === 'build') arpVel = 0.5 + 0.4 * prog01;
      else if (sec.name === 'drop') arpVel = A.drop;
      else if (sec.name === 'break') arpVel = A.brk * (b >= half ? 1 : 0.85);
      else if (sec.name === 'outro' && b < half) arpVel = (A.drop || A.brk) * 0.9;
      if (arpVel > 0) {
        const tri = voiceChord(H, makeChord(H, ch.deg, S.raise7, false), S.arpCenter);
        const ext = [tri[0], tri[1], tri[2], tri[0] + 12, tri[1] + 12, tri[2] + 12];
        for (let s = 0, k = 0; s < 16; s += A.rate, k++) {
          const idx = A.pattern[k % A.pattern.length];
          const acc = s % 4 === 0 ? 1 : 0.8;
          push(tAt(bar, s), 'arp', ext[idx], arpVel * acc * fade, A.rate * stepDur * A.gate);
        }
      }
    }

    // ─ lead ─
    const placeLead = (notes, spanSteps, vel, harmony, ornament) => {
      const secSteps = sec.bars * 16;
      for (let off = 0, pi = 0; off < secSteps; off += spanSteps, pi++) {
        const list = typeof notes === 'function' ? notes(pi) : notes;
        for (const n of list) {
          const st = off + n.step;
          if (st >= secSteps) continue;
          const barIn = Math.floor(st / 16);
          const ch = chordFor(sec, barIn);
          const m = chordMidi(H, ch, n.deg, S.leadOct);
          const dur = Math.min(n.len, secSteps - st) * stepDur * S.lead.gate;
          push(tAt(sec.startBar, st), 'lead', m, vel * n.acc, dur);
          if (harmony) push(tAt(sec.startBar, st), 'lead', chordMidi(H, ch, n.deg - 2, S.leadOct), vel * n.acc * 0.5, dur);
        }
        // 16th run into the next phrase (if the phrase ends with a free beat)
        if (ornament && off + spanSteps < secSteps) {
          const lastStep = list[list.length - 1].step;
          if (lastStep <= spanSteps - 8) {
            const target = (typeof notes === 'function' ? notes(pi + 1) : notes)[0].deg;
            const barIn = Math.floor((off + spanSteps - 4) / 16);
            const ch = chordFor(sec, barIn);
            for (let i = 0; i < 4; i++) {
              const st = off + spanSteps - 4 + i;
              push(tAt(sec.startBar, st), 'lead', chordMidi(H, ch, target - 4 + i, S.leadOct), vel * (0.62 + 0.08 * i), stepDur * 0.9);
            }
          }
        }
      }
    };
    const ps = melody.phraseSteps;
    if (sec.name === 'drop' && S.leadDrop !== false) {
      const second = sec.index >= 1;
      placeLead((pi) => melody.phrases[pi % 2], ps, second ? 1 : 0.95, second, second || S.lead.allow16);
    } else if (sec.name === 'break') {
      placeLead(melody.brk, ps, 0.55, false, false);
    } else if (sec.name === 'build' && S.teaser && sec.bars >= 8) {
      // tease the first half of the hook before the roll
      const teaser = melody.phrases[0].filter((n) => n.step < ps / 2);
      const secSteps = (sec.bars - 4) * 16;
      for (const n of teaser) {
        if (n.step >= secSteps) continue;
        const ch = chordFor(sec, Math.floor(n.step / 16));
        push(tAt(sec.startBar, n.step), 'lead', chordMidi(H, ch, n.deg, S.leadOct), 0.5 * n.acc, n.len * stepDur * S.lead.gate);
      }
    } else if (sec.name === 'outro' && S.leadDrop !== false) {
      const firstHalf = melody.phrases[1].filter((n) => n.step < half * 16);
      for (const n of firstHalf) {
        const ch = chordFor(sec, Math.floor(n.step / 16));
        push(tAt(sec.startBar, n.step), 'lead', chordMidi(H, ch, n.deg, S.leadOct), 0.7 * n.acc, n.len * stepDur * S.lead.gate);
      }
    }

    // ─ fx ─
    if (sec.name === 'build') {
      push(sec.start, 'riser', null, 0.9, sec.end - sec.start);
      if (S.preDropGap > 0) gaps.push([round6(sec.end - S.preDropGap * spb), sec.end]);
    }
    if (sec.name === 'drop') push(sec.start, 'impact', null, 1, 3);
    if (sec.name === 'break') push(sec.start, 'impact', null, 0.62, 3);
    if (sec.name === 'outro') push(sec.start, 'impact', null, 0.55, 3);
    if (si === 0) push(sec.start, 'impact', null, 0.42, 3);
    if (!next) push(sec.end, 'impact', null, 0.7, 3);
  });

  // ── post-processing ──
  // silence before drops (only the riser keeps going)
  let out = events.filter((e) => e.kind === 'riser' || !gaps.some(([a, b]) => e.t >= a - 1e-9 && e.t < b - 1e-9));
  // keep everything inside the song
  for (const e of out) if (e.t + e.dur > duration) e.dur = round6(Math.max(0.01, duration - e.t));
  // de-duplicate identical hits (keep the loudest)
  const seen = new Map();
  for (const e of out) {
    const k = `${e.kind}|${e.t}|${e.midi}`;
    const prev = seen.get(k);
    if (!prev || prev.vel < e.vel) seen.set(k, e);
  }
  out = [...seen.values()];
  const KIND_ORDER = { impact: 0, kick: 1, snare: 2, clap: 3, hat: 4, openhat: 5, bass: 6, chord: 7, arp: 8, lead: 9, riser: 10 };
  out.sort((a, b) => a.t - b.t || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.midi ?? 0) - (b.midi ?? 0));

  return {
    def,
    bpm,
    duration,
    beatTimes,
    barTimes,
    sections: sections.map(({ name, start, end, energy, energyEnd, bars }) => ({ name, start, end, energy, energyEnd, bars })),
    events: out,
    // extra info for charting / visuals
    style: def.style,
    t0,
    beatDur: spb,
    stepDur,
    barDur,
    salience: { ...BASE_SALIENCE, ...S.sal },
  };
}

/**
 * Song intensity at time `t` (0..1) for background visuals. Builds ramp up, outros fade out.
 */
export function songEnergyAt(comp, t) {
  const S = comp.sections;
  if (!S || !S.length) return 0;
  if (t < S[0].start) return clamp(0.12 * (t / S[0].start), 0, 0.12);
  const last = S[S.length - 1];
  if (t >= last.end) {
    const e = last.energyEnd ?? last.energy;
    return clamp(e * (1 - (t - last.end) / Math.max(0.1, comp.duration - last.end)), 0, 1);
  }
  let lo = 0;
  let hi = S.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (S[mid].start <= t) lo = mid;
    else hi = mid - 1;
  }
  const s = S[lo];
  const u = (t - s.start) / Math.max(1e-6, s.end - s.start);
  const e1 = s.energyEnd ?? s.energy;
  return clamp(s.energy + (e1 - s.energy) * u, 0, 1);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  DSP primitives (plain JS, used to pre-render every distinct sound once)
// ════════════════════════════════════════════════════════════════════════════════════════════

const TWO_PI = Math.PI * 2;
const SAW = 0, PULSE = 1, TRI = 2, SINE = 3, NTRI = 4, NOISE = 5;

/** tanh-like soft clipper (Padé approximation, exact ±1 beyond |x| = 3). */
function sclip(x) {
  if (x <= -3) return -1;
  if (x >= 3) return 1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** Topology-preserving state variable filter (Simper). mode: 0 LP, 1 BP, 2 HP. */
class SVF {
  constructor(sr) {
    this.sr = sr;
    this.ic1 = 0;
    this.ic2 = 0;
    this.set(1000, 0.707);
  }
  set(fc, q) {
    const g = Math.tan(Math.PI * clamp(fc, 10, this.sr * 0.45) / this.sr);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  lp(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return v2;
  }
  bp(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return v1;
  }
  hp(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return x - this.k * v1 - v2;
  }
}

function fadeEdges(arr, sr, inMs = 0, outMs = 4) {
  const n = arr.length;
  const fi = Math.min(n, Math.floor((inMs / 1000) * sr));
  for (let i = 0; i < fi; i++) arr[i] *= i / fi;
  const fo = Math.min(n, Math.floor((outMs / 1000) * sr));
  for (let i = 0; i < fo; i++) arr[n - 1 - i] *= i / fo;
}

function peakOf(...chs) {
  let p = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > p) p = a; }
  return p;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
//  Subtractive voice: unison oscillators → drive → SVF (env / key / LFO) → VCA, stereo.
// ────────────────────────────────────────────────────────────────────────────────────────────
//
// Patch fields:
//   osc:   [{ w: SAW|PULSE|TRI|SINE|NTRI|NOISE, v: unison voices, det: total detune (semitones),
//             spread: stereo width 0..1, lvl, semi: transpose, pw: pulse width }]
//   sub:   level of an unfiltered sine at the fundamental (bass weight)
//   amp:   [attack, decay, sustain, release] — decay/release are exponential time constants
//   flt:   { type: 'lp'|'bp'|'hp', f, q, env (octaves), a, d, s, key (oct/oct), vel (oct),
//            lfo (octaves), lfoRate (Hz; 0 = use event wobble rate), wobShape }
//   drive: pre-filter saturation, post: post-filter saturation
//   vib:   { rate, depth (semitones), delay }, pitch: { amt (semitones), tau }

const BLOCK = 32;

function renderVoice(P, midis, dur, opt) {
  const sr = opt.sr;
  const [aT, dT, sL, rT] = P.amp;
  const n = Math.max(64, Math.ceil((dur + rT * 6 + 0.005) * sr));
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const rnd = mulberry32(opt.seed >>> 0);

  // ── oscillator bank ──
  const vw = [], vinc = [], vph = [], vgl = [], vgr = [], vpw = [];
  let stereo = false;
  for (const m of midis) {
    for (const o of P.osc) {
      const V = o.v || 1;
      for (let k = 0; k < V; k++) {
        const x = V > 1 ? k / (V - 1) - 0.5 : 0; // -0.5..0.5
        // slightly non-linear detune spacing sounds lusher than a linear spread
        const off = (o.det || 0) * Math.sign(x) * Math.pow(Math.abs(x) * 2, 1.4) * 0.5;
        const f = mtof(m + (o.semi || 0) + off);
        const pan = V > 1 ? x * 2 * (o.spread || 0) : o.pan || 0;
        if (pan !== 0) stereo = true;
        const ang = ((pan + 1) * Math.PI) / 4;
        const lvl = ((o.lvl ?? 1) * (V > 1 ? 1.6 : 1)) / Math.sqrt(V);
        vw.push(o.w);
        vinc.push(f / sr);
        vph.push(o.w === SINE || o.w === NTRI || o.w === TRI ? 0 : rnd());
        vgl.push(Math.cos(ang) * lvl);
        vgr.push(Math.sin(ang) * lvl);
        vpw.push(o.pw ?? 0.5);
      }
    }
  }
  const NV = vw.length;
  const incNow = new Float64Array(NV);
  const avgMidi = midis.reduce((a, b) => a + b, 0) / midis.length;

  // ── envelopes ──
  const aN = Math.max(1, aT * sr);
  const kd = Math.exp(-1 / Math.max(1, dT * sr));
  const kr = Math.exp(-1 / Math.max(1, rT * sr));
  const gOff = Math.floor(dur * sr);
  let env = 0, envStage = 0; // 0 attack, 1 decay/sustain, 2 release

  const F = P.flt;
  let fenv = 0, fStage = 0;
  const fA = F ? Math.max(1, (F.a || 0.001) * sr) : 1;
  const fkd = F ? Math.exp(-BLOCK / Math.max(1, (F.d || 0.2) * sr)) : 0;
  const fkr = F ? Math.exp(-BLOCK / Math.max(1, (F.r || rT || 0.1) * sr)) : 0;
  const fS = F ? F.s ?? 0 : 0;
  const keyOct = F ? (F.key || 0) * ((avgMidi - 60) / 12) : 0;
  const velOct = F ? (F.vel || 0) * ((opt.vel ?? 1) - 0.8) : 0;
  const wobHz = ((opt.wob || 0) * (opt.bpm || 120)) / 60;
  const fL = new SVF(sr);
  const fR = new SVF(sr);
  const ftype = F ? (F.type === 'bp' ? 1 : F.type === 'hp' ? 2 : 0) : -1;

  const drive = P.drive || 0;
  const post = P.post || 0;
  const postNorm = post ? 1 / sclip(post) : 1;
  const sub = P.sub || 0;
  const subInc = sub ? mtof(midis[0] + (P.subSemi || 0)) / sr : 0;
  let subPh = 0;
  const gain = P.gain ?? 1;

  const bl = new Float32Array(BLOCK);
  const br = new Float32Array(BLOCK);
  let noiseState = (opt.seed * 2654435761) >>> 0 || 1;

  for (let b0 = 0; b0 < n; b0 += BLOCK) {
    const len = Math.min(BLOCK, n - b0);
    const t = b0 / sr;

    // pitch modulation for this block
    let semis = 0;
    if (P.pitch) semis += P.pitch.amt * Math.exp(-t / P.pitch.tau);
    if (P.vib) {
      const ramp = clamp((t - P.vib.delay) / 0.3, 0, 1);
      if (ramp > 0) semis += P.vib.depth * ramp * Math.sin(TWO_PI * P.vib.rate * t);
    }
    const ratio = semis !== 0 ? Math.pow(2, semis / 12) : 1;
    for (let v = 0; v < NV; v++) incNow[v] = vinc[v] * ratio;

    bl.fill(0);
    if (stereo) br.fill(0);

    // oscillators
    for (let v = 0; v < NV; v++) {
      const w = vw[v];
      const inc = incNow[v];
      const gl = vgl[v];
      const gr = vgr[v];
      let p = vph[v];
      if (w === SAW) {
        for (let i = 0; i < len; i++) {
          let x = 2 * p - 1;
          if (p < inc) { const q = p / inc; x -= q + q - q * q - 1; }
          else if (p > 1 - inc) { const q = (p - 1) / inc; x -= q * q + q + q + 1; }
          bl[i] += x * gl;
          if (stereo) br[i] += x * gr;
          p += inc;
          if (p >= 1) p -= 1;
        }
      } else if (w === PULSE) {
        const pw = vpw[v];
        for (let i = 0; i < len; i++) {
          let x = p < pw ? 1 : -1;
          if (p < inc) { const q = p / inc; x += q + q - q * q - 1; }
          else if (p > 1 - inc) { const q = (p - 1) / inc; x += q * q + q + q + 1; }
          let p2 = p - pw;
          if (p2 < 0) p2 += 1;
          if (p2 < inc) { const q = p2 / inc; x -= q + q - q * q - 1; }
          else if (p2 > 1 - inc) { const q = (p2 - 1) / inc; x -= q * q + q + q + 1; }
          x -= 2 * pw - 1; // remove DC of asymmetric pulses
          bl[i] += x * gl;
          if (stereo) br[i] += x * gr;
          p += inc;
          if (p >= 1) p -= 1;
        }
      } else if (w === SINE) {
        for (let i = 0; i < len; i++) {
          const x = Math.sin(TWO_PI * p);
          bl[i] += x * gl;
          if (stereo) br[i] += x * gr;
          p += inc;
          if (p >= 1) p -= 1;
        }
      } else if (w === TRI) {
        for (let i = 0; i < len; i++) {
          const x = 4 * Math.abs(p - 0.5) - 1;
          bl[i] += x * gl;
          if (stereo) br[i] += x * gr;
          p += inc;
          if (p >= 1) p -= 1;
        }
      } else if (w === NTRI) {
        // NES-style 4-bit stepped triangle
        for (let i = 0; i < len; i++) {
          const s = Math.floor(p * 32);
          const x = ((s < 16 ? 15 - s : s - 16) / 7.5 - 1);
          bl[i] += x * gl;
          if (stereo) br[i] += x * gr;
          p += inc;
          if (p >= 1) p -= 1;
        }
      } else if (w === NOISE) {
        for (let i = 0; i < len; i++) {
          noiseState ^= noiseState << 13; noiseState >>>= 0;
          noiseState ^= noiseState >>> 17;
          noiseState ^= noiseState << 5; noiseState >>>= 0;
          const x = noiseState / 2147483648 - 1;
          bl[i] += x * gl;
          if (stereo) br[i] += x * gr;
        }
      }
      vph[v] = p;
    }

    // filter coefficients for this block
    if (F) {
      // filter envelope (block rate)
      if (b0 >= gOff && fStage < 2) fStage = 2;
      if (fStage === 0) {
        fenv += BLOCK / fA;
        if (fenv >= 1) { fenv = 1; fStage = 1; }
      } else if (fStage === 1) fenv = fS + (fenv - fS) * fkd;
      else fenv *= fkr;
      let oct = (F.env || 0) * fenv + keyOct + velOct;
      if (F.lfo) {
        const rate = F.lfoRate || wobHz;
        if (rate > 0) {
          oct += F.lfo * (F.lfoRate ? 0.5 + 0.5 * Math.sin(TWO_PI * rate * t) : 0.5 - 0.5 * Math.cos(TWO_PI * rate * t));
        } else if (F.lfoStatic) oct += F.lfoStatic;
      }
      const fc = F.f * Math.pow(2, oct);
      fL.set(fc, F.q || 0.707);
      if (stereo) fR.set(fc, F.q || 0.707);
    }

    for (let i = 0; i < len; i++) {
      const idx = b0 + i;
      // amplitude envelope (sample rate)
      if (idx === gOff && envStage < 2) envStage = 2;
      if (envStage === 0) {
        env += 1 / aN;
        if (env >= 1) { env = 1; envStage = 1; }
      } else if (envStage === 1) env = sL + (env - sL) * kd;
      else env *= kr;

      let xl = bl[i];
      let xr = stereo ? br[i] : 0;
      if (drive) {
        xl = sclip(xl * drive);
        if (stereo) xr = sclip(xr * drive);
      }
      if (ftype === 0) { xl = fL.lp(xl); if (stereo) xr = fR.lp(xr); }
      else if (ftype === 1) { xl = fL.bp(xl); if (stereo) xr = fR.bp(xr); }
      else if (ftype === 2) { xl = fL.hp(xl); if (stereo) xr = fR.hp(xr); }
      if (post) {
        xl = sclip(xl * post) * postNorm;
        if (stereo) xr = sclip(xr * post) * postNorm;
      }
      if (sub) {
        const s = Math.sin(TWO_PI * subPh) * sub;
        subPh += subInc;
        if (subPh >= 1) subPh -= 1;
        xl += s;
        xr += s;
      }
      const g = env * gain;
      L[idx] = xl * g;
      if (stereo) R[idx] = xr * g;
    }
  }
  if (!stereo) R.set(L);
  fadeEdges(L, sr, 0.5, 3);
  fadeEdges(R, sr, 0.5, 3);
  return [L, R];
}

// ────────────────────────────────────────────────────────────────────────────────────────────
//  Sound design per style
// ────────────────────────────────────────────────────────────────────────────────────────────

const PATCHES = {
  synthwave: {
    lead: {
      osc: [{ w: SAW, v: 7, det: 0.32, spread: 0.85 }, { w: PULSE, semi: -12, lvl: 0.35 }],
      amp: [0.006, 0.4, 0.75, 0.2],
      flt: { f: 2100, q: 1.0, env: 1.4, a: 0.004, d: 0.35, s: 0.4, key: 0.4 },
      vib: { rate: 5.2, depth: 0.12, delay: 0.3 },
    },
    arp: {
      osc: [{ w: SAW, v: 2, det: 0.12, spread: 0.6 }, { w: PULSE, pw: 0.35, lvl: 0.5 }],
      amp: [0.002, 0.18, 0, 0.08],
      flt: { f: 600, q: 3, env: 3.2, a: 0.001, d: 0.11, s: 0.05, key: 0.6 },
    },
    chord: {
      osc: [{ w: SAW, v: 5, det: 0.35, spread: 1 }],
      amp: [0.35, 1.0, 0.85, 0.5],
      flt: { f: 1500, q: 0.7, env: 0.7, a: 0.6, d: 1.2, s: 0.6, key: 0.3 },
    },
    bass: {
      osc: [{ w: SAW }, { w: PULSE, lvl: 0.6 }],
      sub: 0.8,
      amp: [0.003, 0.25, 0.85, 0.05],
      flt: { f: 520, q: 1.3, env: 1.6, a: 0.001, d: 0.14, s: 0.25, key: 0.5 },
    },
  },
  darksynth: {
    lead: {
      osc: [{ w: SAW, v: 3, det: 0.14, spread: 0.6 }, { w: PULSE, lvl: 0.5, pw: 0.4 }],
      drive: 2.2,
      amp: [0.004, 0.3, 0.85, 0.16],
      flt: { f: 1600, q: 3.2, env: 2, a: 0.002, d: 0.3, s: 0.45, key: 0.5 },
      vib: { rate: 5.5, depth: 0.1, delay: 0.35 },
    },
    arp: {
      osc: [{ w: PULSE, v: 2, det: 0.1, spread: 0.7, pw: 0.3 }],
      amp: [0.001, 0.14, 0, 0.06],
      flt: { f: 700, q: 4, env: 3, a: 0.001, d: 0.09, s: 0, key: 0.5 },
    },
    chord: {
      osc: [{ w: SAW, v: 5, det: 0.25, spread: 1 }],
      amp: [0.5, 1.2, 0.8, 0.6],
      flt: { f: 900, q: 0.9, env: 0.8, a: 0.8, d: 1.5, s: 0.5, key: 0.3 },
    },
    bass: {
      osc: [{ w: SAW, v: 2, det: 0.08, spread: 0.2 }, { w: PULSE, lvl: 0.5 }],
      sub: 0.9,
      drive: 1.8,
      amp: [0.002, 0.12, 0.6, 0.03],
      flt: { f: 280, q: 4.5, env: 3.2, a: 0.001, d: 0.075, s: 0.05, key: 0.4 },
    },
  },
  house: {
    lead: {
      osc: [{ w: SAW, v: 3, det: 0.15, spread: 0.6 }, { w: PULSE, lvl: 0.5 }],
      amp: [0.002, 0.25, 0.5, 0.12],
      flt: { f: 1200, q: 2, env: 2.6, a: 0.001, d: 0.2, s: 0.25, key: 0.5 },
    },
    arp: {
      osc: [{ w: SINE }, { w: PULSE, pw: 0.25, lvl: 0.35 }],
      amp: [0.001, 0.16, 0, 0.08],
      flt: { f: 2500, q: 1, env: 1.5, a: 0.001, d: 0.08, s: 0, key: 0.3 },
    },
    chord: {
      osc: [{ w: SAW, v: 4, det: 0.2, spread: 0.8 }, { w: PULSE, lvl: 0.4 }],
      amp: [0.002, 0.22, 0.35, 0.1],
      flt: { f: 900, q: 1.6, env: 2.8, a: 0.001, d: 0.16, s: 0.12, key: 0.3 },
    },
    bass: {
      osc: [{ w: SINE }, { w: PULSE, lvl: 0.45 }],
      sub: 0.3,
      drive: 1.2,
      amp: [0.002, 0.18, 0.7, 0.04],
      flt: { f: 700, q: 1, env: 1.5, a: 0.001, d: 0.09, s: 0.3, key: 0.3 },
    },
  },
  trance: {
    lead: {
      osc: [{ w: SAW, v: 7, det: 0.4, spread: 1 }, { w: SAW, semi: 12, lvl: 0.25 }],
      amp: [0.004, 0.5, 0.82, 0.3],
      flt: { f: 4200, q: 0.8, env: 1.0, a: 0.002, d: 0.5, s: 0.6, key: 0.3 },
      vib: { rate: 5.5, depth: 0.08, delay: 0.4 },
    },
    arp: {
      osc: [{ w: SAW, v: 2, det: 0.1, spread: 0.5 }],
      amp: [0.001, 0.13, 0, 0.07],
      flt: { f: 650, q: 3.5, env: 3.4, a: 0.001, d: 0.085, s: 0.02, key: 0.5 },
    },
    chord: {
      osc: [{ w: SAW, v: 7, det: 0.42, spread: 1 }],
      amp: [0.08, 1.0, 0.9, 0.45],
      flt: { f: 2600, q: 0.7, env: 0.6, a: 0.3, d: 1, s: 0.7, key: 0.3 },
    },
    bass: {
      osc: [{ w: SAW }],
      sub: 0.8,
      amp: [0.002, 0.12, 0.5, 0.03],
      flt: { f: 380, q: 2.2, env: 2.8, a: 0.001, d: 0.07, s: 0.08, key: 0.4 },
    },
  },
  dubstep: {
    lead: {
      osc: [{ w: SAW, v: 3, det: 0.2, spread: 0.8 }, { w: PULSE, lvl: 0.4 }],
      drive: 1.6,
      amp: [0.004, 0.3, 0.8, 0.25],
      flt: { f: 1500, q: 2.5, env: 1.8, a: 0.002, d: 0.2, s: 0.5, key: 0.4 },
      vib: { rate: 5.5, depth: 0.12, delay: 0.3 },
    },
    arp: {
      osc: [{ w: SINE }, { w: SINE, semi: 19, lvl: 0.25 }, { w: TRI, semi: 12, lvl: 0.2 }],
      amp: [0.001, 0.4, 0, 0.3],
    },
    chord: {
      osc: [{ w: SAW, v: 5, det: 0.3, spread: 1 }],
      amp: [0.4, 1.2, 0.8, 0.6],
      flt: { f: 1100, q: 0.8, env: 0.8, a: 0.6, d: 1.2, s: 0.5, key: 0.3 },
    },
    bass: {
      // wobble: resonant low-pass swept by an LFO synced to the event's `wob` rate
      osc: [{ w: SAW, v: 2, det: 0.1, spread: 0.15 }, { w: PULSE, pw: 0.4, lvl: 0.7 }, { w: SAW, semi: 12, lvl: 0.35 }],
      sub: 0.9,
      drive: 2.8,
      post: 1.8,
      amp: [0.004, 0.2, 0.9, 0.04],
      flt: { f: 170, q: 5, env: 2.2, a: 0.001, d: 0.09, s: 0.0, key: 0.3, lfo: 4.2, lfoStatic: 2.4 },
    },
  },
  chiptune: {
    lead: {
      osc: [{ w: PULSE, pw: 0.25 }],
      amp: [0.001, 0.12, 0.75, 0.03],
      flt: { f: 9000, q: 0.5 },
      vib: { rate: 6, depth: 0.22, delay: 0.18 },
    },
    arp: {
      osc: [{ w: PULSE, pw: 0.125 }],
      amp: [0.001, 0.08, 0.55, 0.02],
      flt: { f: 8000, q: 0.5 },
    },
    chord: {
      osc: [{ w: PULSE, pw: 0.5 }],
      amp: [0.005, 0.3, 0.6, 0.1],
      flt: { f: 5000, q: 0.5 },
    },
    bass: {
      osc: [{ w: NTRI }],
      amp: [0.001, 0.05, 1.0, 0.01],
    },
  },
  dnb: {
    lead: {
      osc: [{ w: SAW, v: 2, det: 0.08, spread: 0.5 }, { w: PULSE, pw: 0.4, lvl: 0.7 }, { w: SINE, semi: 12, lvl: 0.2 }],
      amp: [0.005, 0.3, 0.8, 0.25],
      flt: { f: 2400, q: 1.2, env: 1.2, a: 0.002, d: 0.25, s: 0.5, key: 0.4 },
      vib: { rate: 5, depth: 0.15, delay: 0.3 },
    },
    arp: {
      osc: [{ w: SINE }, { w: PULSE, pw: 0.3, lvl: 0.4 }],
      amp: [0.001, 0.25, 0, 0.15],
      flt: { f: 1400, q: 2, env: 2.5, a: 0.001, d: 0.12, s: 0, key: 0.4 },
    },
    chord: {
      osc: [{ w: SAW, v: 5, det: 0.25, spread: 1 }, { w: SINE, lvl: 0.5 }],
      amp: [0.6, 1.5, 0.8, 0.9],
      flt: { f: 1300, q: 0.8, env: 0.8, a: 0.8, d: 1.5, s: 0.5, key: 0.3 },
    },
    bass: {
      // reese: detuned saws, slowly moving low-pass
      osc: [{ w: SAW, v: 3, det: 0.3, spread: 0.35 }],
      sub: 0.9,
      drive: 1.6,
      amp: [0.006, 0.4, 0.9, 0.08],
      flt: { f: 600, q: 1.8, env: 0.5, a: 0.01, d: 0.3, s: 0.6, key: 0.3, lfo: 1.2, lfoRate: 0.35 },
    },
  },
  hardcore: {
    lead: {
      osc: [{ w: SAW, v: 7, det: 0.45, spread: 1 }, { w: PULSE, semi: 12, lvl: 0.3 }],
      drive: 1.3,
      amp: [0.003, 0.3, 0.85, 0.15],
      flt: { f: 5000, q: 0.7, env: 0.8, a: 0.002, d: 0.3, s: 0.7, key: 0.3 },
    },
    arp: {
      osc: [{ w: SAW }, { w: SINE, semi: 12, lvl: 0.5 }],
      amp: [0.001, 0.25, 0.1, 0.1],
      flt: { f: 1800, q: 1, env: 2.5, a: 0.001, d: 0.15, s: 0.1, key: 0.4 },
    },
    chord: {
      osc: [{ w: SAW, v: 7, det: 0.4, spread: 1 }],
      amp: [0.05, 1, 0.85, 0.35],
      flt: { f: 3000, q: 0.7, env: 0.4, a: 0.1, d: 1, s: 0.7, key: 0.3 },
    },
    bass: {
      osc: [{ w: SAW, v: 3, det: 0.2, spread: 0.3 }],
      sub: 0.7,
      drive: 2.2,
      amp: [0.002, 0.15, 0.7, 0.04],
      flt: { f: 700, q: 1.5, env: 2, a: 0.001, d: 0.1, s: 0.2, key: 0.4 },
    },
  },
};

// Drum kits: parameters for the one-shot synthesizers below.
const KITS = {
  synthwave: {
    kick: { f0: 150, f1: 47, pt: 0.05, at: 0.3, hold: 0.02, click: 0.35, drive: 1.6, len: 0.7 },
    snare: { tone: 180, tLvl: 0.55, nLvl: 0.9, hp: 900, bp: 3500, nd: 0.16, gate: 0.3, room: 0.55 },
    clap: { bp: 1300, tail: 0.22 },
    hat: { d: 0.05, hp: 7000 },
    openhat: { d: 0.3, hp: 6500 },
  },
  darksynth: {
    kick: { f0: 170, f1: 44, pt: 0.05, at: 0.34, hold: 0.025, click: 0.45, drive: 2.6, len: 0.75 },
    snare: { tone: 170, tLvl: 0.6, nLvl: 1, hp: 800, bp: 3000, nd: 0.18, gate: 0.32, room: 0.6 },
    clap: { bp: 1100, tail: 0.25 },
    hat: { d: 0.04, hp: 7500 },
    openhat: { d: 0.26, hp: 7000 },
  },
  house: {
    kick: { f0: 180, f1: 52, pt: 0.035, at: 0.22, hold: 0.015, click: 0.5, drive: 1.3, len: 0.5 },
    snare: { tone: 200, tLvl: 0.4, nLvl: 0.9, hp: 1200, bp: 4500, nd: 0.13 },
    clap: { bp: 1250, tail: 0.18 },
    hat: { d: 0.04, hp: 8000 },
    openhat: { d: 0.22, hp: 7500 },
  },
  trance: {
    kick: { f0: 170, f1: 50, pt: 0.04, at: 0.24, hold: 0.015, click: 0.45, drive: 1.6, len: 0.5 },
    snare: { tone: 190, tLvl: 0.45, nLvl: 1, hp: 1000, bp: 4000, nd: 0.15 },
    clap: { bp: 1400, tail: 0.2 },
    hat: { d: 0.035, hp: 8500 },
    openhat: { d: 0.2, hp: 8000 },
  },
  dubstep: {
    kick: { f0: 190, f1: 46, pt: 0.05, at: 0.35, hold: 0.02, click: 0.6, drive: 2.2, len: 0.7 },
    snare: { tone: 180, tLvl: 0.7, nLvl: 1.1, hp: 700, bp: 3000, nd: 0.26, clap: 0.6 },
    clap: { bp: 1200, tail: 0.25 },
    hat: { d: 0.045, hp: 7000 },
    openhat: { d: 0.3, hp: 6500 },
  },
  chiptune: {
    kick: { chip: true, f0: 360, f1: 55, pt: 0.03, at: 0.08, len: 0.2 },
    snare: { chip: true, tone: 220, nd: 0.12 },
    clap: { chip: true, tone: 0, nd: 0.1 },
    hat: { chip: true, d: 0.03 },
    openhat: { chip: true, d: 0.14 },
  },
  dnb: {
    kick: { f0: 200, f1: 55, pt: 0.03, at: 0.18, hold: 0.01, click: 0.6, drive: 1.5, len: 0.4 },
    snare: { tone: 210, tLvl: 0.55, nLvl: 1, hp: 1100, bp: 5000, nd: 0.17 },
    clap: { bp: 1500, tail: 0.18 },
    hat: { d: 0.03, hp: 9000 },
    openhat: { d: 0.18, hp: 8000 },
  },
  hardcore: {
    kick: { f0: 260, f1: 56, pt: 0.045, at: 0.24, hold: 0.04, click: 0.6, drive: 5.5, len: 0.42 },
    snare: { tone: 200, tLvl: 0.5, nLvl: 1, hp: 1000, bp: 4000, nd: 0.15 },
    clap: { bp: 1300, tail: 0.2 },
    hat: { d: 0.03, hp: 9000 },
    openhat: { d: 0.18, hp: 8500 },
  },
};

// Mix / FX per style: bus levels (post normalisation), sends, reverb size, delay time (beats).
const MIX_DEFAULT = {
  level: { kick: 1.0, snare: 0.62, clap: 0.55, hat: 0.2, openhat: 0.17, bass: 0.95, lead: 0.62, arp: 0.34, chord: 0.36, riser: 0.3, impact: 0.55 },
  rev: { snare: 0.16, clap: 0.2, hat: 0.03, openhat: 0.08, lead: 0.2, arp: 0.24, chord: 0.3, riser: 0.35, impact: 0.3 },
  dly: { lead: 0.16, arp: 0.24 },
  duck: { bass: 0.75, chord: 0.65, arp: 0.35, lead: 0.2, rev: 0.4 },
  reverb: 2.4, damp: 0.6, delayBeats: 0.75, feedback: 0.38, sweep: true,
  pan: { hat: 0.18, openhat: -0.22, arp: 0 },
};
const MIX = {
  synthwave: { reverb: 3.0, rev: { snare: 0.24 }, level: { snare: 0.58 } },
  darksynth: { reverb: 2.8, damp: 0.45, rev: { snare: 0.22 }, level: { bass: 0.85 } },
  house: { reverb: 1.6, delayBeats: 0.75, dly: { chord: 0.18, arp: 0.25 }, level: { chord: 0.42 } },
  trance: { reverb: 3.2, feedback: 0.45, level: { chord: 0.3, arp: 0.3 } },
  dubstep: { reverb: 2.2, duck: { bass: 0.45, chord: 0.5 }, level: { bass: 1.0, snare: 0.7 } },
  chiptune: { reverb: 0.9, damp: 0.8, sweep: false, rev: { lead: 0.08, arp: 0.06, chord: 0.08, snare: 0.05 }, dly: { lead: 0.2, arp: 0.1 }, delayBeats: 0.5, feedback: 0.3, duck: { bass: 0, chord: 0, arp: 0, lead: 0, rev: 0 }, level: { bass: 0.8, lead: 0.5, arp: 0.28, chord: 0.22 } },
  dnb: { reverb: 2.0, duck: { bass: 0.4, chord: 0.5 }, level: { snare: 0.7, bass: 0.9 } },
  hardcore: { reverb: 1.8, level: { kick: 1.0, lead: 0.58 } },
};
function mixFor(style) {
  const o = MIX[style] || {};
  const m = { ...MIX_DEFAULT, ...o };
  for (const k of ['level', 'rev', 'dly', 'duck', 'pan']) m[k] = { ...MIX_DEFAULT[k], ...(o[k] || {}) };
  return m;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
//  Drum one-shots
// ────────────────────────────────────────────────────────────────────────────────────────────

function whiteNoise(rnd) {
  return rnd() * 2 - 1;
}

function synthKick(p, sr, rnd) {
  const n = Math.ceil(p.len * sr);
  const out = new Float32Array(n);
  let ph = 0;
  if (p.chip) {
    // triangle pitch sweep + a burst of noise — NES style
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const f = p.f1 + (p.f0 - p.f1) * Math.exp(-t / p.pt);
      ph += f / sr;
      const s = Math.floor((ph % 1) * 32);
      const tri = (s < 16 ? 15 - s : s - 16) / 7.5 - 1;
      const env = Math.exp(-t / p.at);
      const nz = t < 0.012 ? whiteNoise(rnd) * (1 - t / 0.012) * 0.5 : 0;
      out[i] = tri * env + nz;
    }
  } else {
    const hp = new SVF(sr);
    hp.set(2500, 0.7);
    const dn = 1 / sclip(p.drive);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const f = p.f1 + (p.f0 - p.f1) * Math.exp(-t / p.pt);
      ph += f / sr;
      const body = Math.sin(TWO_PI * ph);
      const env = t < p.hold ? 1 : Math.exp(-(t - p.hold) / p.at);
      const click = hp.hp(whiteNoise(rnd)) * Math.exp(-t / 0.0025) * p.click;
      out[i] = sclip((body * env + click) * p.drive) * dn;
    }
  }
  fadeEdges(out, sr, 0, 8);
  return out;
}

function nesNoise(n, sr, rateHz, short, rnd) {
  const out = new Float32Array(n);
  let reg = 1 + Math.floor(rnd() * 32000);
  let acc = 0;
  const step = rateHz / sr;
  let v = 1;
  for (let i = 0; i < n; i++) {
    acc += step;
    while (acc >= 1) {
      acc -= 1;
      const fb = (reg & 1) ^ ((reg >> (short ? 6 : 1)) & 1);
      reg = (reg >> 1) | (fb << 14);
      v = reg & 1 ? 1 : -1;
    }
    out[i] = v;
  }
  return out;
}

function synthSnare(p, sr, rnd) {
  const len = p.chip ? 0.25 : (p.gate || 0) + p.nd * 5 + 0.05;
  const n = Math.ceil(len * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  if (p.chip) {
    const nz = nesNoise(n, sr, 9000, false, rnd);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let x = nz[i] * Math.exp(-t / p.nd) * 0.7;
      if (p.tone) {
        ph += (p.tone * (1 + Math.exp(-t / 0.02))) / sr;
        const s = Math.floor((ph % 1) * 32);
        x += ((s < 16 ? 15 - s : s - 16) / 7.5 - 1) * Math.exp(-t / 0.04) * 0.6;
      }
      L[i] = R[i] = x;
    }
  } else {
    const hpL = new SVF(sr), hpR = new SVF(sr), bpL = new SVF(sr), bpR = new SVF(sr);
    hpL.set(p.hp, 0.7); hpR.set(p.hp, 0.7);
    bpL.set(p.bp, 1.2); bpR.set(p.bp, 1.2);
    let ph1 = 0, ph2 = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const f = p.tone * (1 + 0.25 * Math.exp(-t / 0.015));
      ph1 += f / sr;
      ph2 += (f * 1.63) / sr;
      const tone = (Math.sin(TWO_PI * ph1) * Math.exp(-t / 0.06) + 0.4 * Math.sin(TWO_PI * ph2) * Math.exp(-t / 0.035)) * p.tLvl;
      let nenv;
      if (p.gate) {
        // gated-reverb snare: dense plateau, then a hard (but click-free) cut
        const burst = Math.exp(-t / 0.05);
        const plateau = t < p.gate ? (1 - 0.35 * (t / p.gate)) * p.room : p.room * 0.65 * Math.exp(-(t - p.gate) / 0.012);
        nenv = Math.max(burst, plateau);
      } else {
        nenv = Math.exp(-t / p.nd);
      }
      const nl = whiteNoise(rnd), nr = whiteNoise(rnd);
      const xl = (hpL.hp(nl) * 0.7 + bpL.bp(nl) * 0.5) * nenv * p.nLvl;
      const xr = (hpR.hp(nr) * 0.7 + bpR.bp(nr) * 0.5) * nenv * p.nLvl;
      L[i] = sclip((tone + xl) * 1.4);
      R[i] = sclip((tone + xr) * 1.4);
    }
    if (p.clap) {
      const c = synthClap({ bp: 1300, tail: 0.2 }, sr, rnd);
      for (let i = 0; i < Math.min(n, c[0].length); i++) {
        L[i] += c[0][i] * p.clap;
        R[i] += c[1][i] * p.clap;
      }
    }
  }
  fadeEdges(L, sr, 0, 6);
  fadeEdges(R, sr, 0, 6);
  return [L, R];
}

function synthClap(p, sr, rnd) {
  const n = Math.ceil(((p.tail || 0.2) * 5 + 0.06) * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  if (p.chip) {
    const nz = nesNoise(n, sr, 12000, false, rnd);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      L[i] = R[i] = nz[i] * Math.exp(-t / p.nd) * 0.8;
    }
  } else {
    const bursts = [0, 0.011, 0.023, 0.036];
    const bl = new SVF(sr), br = new SVF(sr), hl = new SVF(sr), hr = new SVF(sr);
    bl.set(p.bp, 1.4); br.set(p.bp * 1.08, 1.4);
    hl.set(500, 0.7); hr.set(500, 0.7);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let env = 0;
      for (const b of bursts) if (t >= b) env = Math.max(env, Math.exp(-(t - b) / 0.0045));
      const last = bursts[bursts.length - 1];
      if (t >= last) env = Math.max(env, 0.55 * Math.exp(-(t - last) / p.tail));
      L[i] = hl.hp(bl.bp(whiteNoise(rnd))) * env * 2.2;
      R[i] = hr.hp(br.bp(whiteNoise(rnd))) * env * 2.2;
    }
  }
  fadeEdges(L, sr, 0, 6);
  fadeEdges(R, sr, 0, 6);
  return [L, R];
}

function synthHat(p, sr, rnd) {
  const n = Math.ceil((p.d * 6 + 0.02) * sr);
  const out = new Float32Array(n);
  if (p.chip) {
    const nz = nesNoise(n, sr, 28000, true, rnd);
    for (let i = 0; i < n; i++) out[i] = nz[i] * Math.exp(-(i / sr) / p.d) * 0.6;
  } else {
    // 808-style: six detuned square waves + noise through band/high-pass filters
    const freqs = [205.3, 304.4, 369.6, 522.7, 540, 800].map((f) => f * 1.9);
    const ph = freqs.map(() => rnd());
    const bp = new SVF(sr), hp = new SVF(sr);
    bp.set(10000, 1.1);
    hp.set(p.hp, 0.7);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let m = 0;
      for (let k = 0; k < 6; k++) {
        ph[k] += freqs[k] / sr;
        if (ph[k] >= 1) ph[k] -= 1;
        m += ph[k] < 0.5 ? 1 : -1;
      }
      const x = m / 6 * 0.6 + whiteNoise(rnd) * 0.5;
      const env = Math.exp(-t / p.d) * (t < 0.0008 ? t / 0.0008 : 1);
      out[i] = hp.hp(bp.bp(x)) * env * 2.5;
    }
  }
  fadeEdges(out, sr, 0, 4);
  return out;
}

function synthImpact(sr, rnd, chip) {
  const n = Math.ceil(3.0 * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const hl = new SVF(sr), hr = new SVF(sr);
  hl.set(chip ? 2000 : 3500, 0.7);
  hr.set(chip ? 2000 : 3500, 0.7);
  const nz = chip ? nesNoise(n, sr, 16000, false, rnd) : null;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = 34 + 70 * Math.exp(-t / 0.08);
    ph += f / sr;
    const boom = Math.sin(TWO_PI * ph) * Math.exp(-t / 0.7) * (chip ? 0.6 : 0.9);
    const env = Math.exp(-t / (chip ? 0.5 : 1.0)) * (t < 0.002 ? t / 0.002 : 1);
    const nl = chip ? nz[i] : whiteNoise(rnd);
    const nr = chip ? nz[i] : whiteNoise(rnd);
    L[i] = sclip(boom * 1.2) + hl.hp(nl) * env * 0.5;
    R[i] = sclip(boom * 1.2) + hr.hp(nr) * env * 0.5;
  }
  fadeEdges(L, sr, 0, 30);
  fadeEdges(R, sr, 0, 30);
  return [L, R];
}

/** White-noise sweep + rising supersaw "uplifter" over `dur` seconds. */
function synthRiser(dur, sr, rnd) {
  const n = Math.max(64, Math.ceil(dur * sr));
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const fl = new SVF(sr), fr = new SVF(sr);
  const saws = [-0.2, 0, 0.2].map((d) => ({ d, p: rnd() }));
  for (let b0 = 0; b0 < n; b0 += BLOCK) {
    const u = b0 / n;
    const fc = 250 * Math.pow(12000 / 250, u);
    fl.set(fc, 2.2);
    fr.set(fc * 1.05, 2.2);
    const amp = 0.05 + 0.95 * u * u;
    const sawAmp = 0.22 * u * u * u;
    const m = 48 + 36 * u;
    for (let i = b0; i < Math.min(n, b0 + BLOCK); i++) {
      let s = 0;
      for (const v of saws) {
        v.p += mtof(m + v.d) / sr;
        if (v.p >= 1) v.p -= 1;
        s += 2 * v.p - 1;
      }
      s *= sawAmp / 3;
      L[i] = fl.bp(whiteNoise(rnd)) * amp * 1.4 + s;
      R[i] = fr.bp(whiteNoise(rnd)) * amp * 1.4 + s;
    }
  }
  fadeEdges(L, sr, 5, 25);
  fadeEdges(R, sr, 5, 25);
  return [L, R];
}

/** Synthetic stereo reverb impulse response: pre-delay, early reflections, darkening tail. */
function makeImpulse(sr, seconds, damp, rnd) {
  const n = Math.ceil(seconds * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const pre = Math.floor(0.012 * sr);
  let lpl = 0, lpr = 0;
  for (let i = pre; i < n; i++) {
    const t = (i - pre) / sr;
    const env = Math.exp((-6.9 * t) / seconds);
    const c = (1 - damp) * 0.9 * Math.exp((-t * 3) / seconds) + 0.06;
    lpl += c * (whiteNoise(rnd) - lpl);
    lpr += c * (whiteNoise(rnd) - lpr);
    const fi = t < 0.01 ? t / 0.01 : 1;
    L[i] = lpl * env * fi;
    R[i] = lpr * env * fi;
  }
  // early reflections
  for (let k = 0; k < 8; k++) {
    const idx = pre + Math.floor((0.004 + rnd() * 0.05) * sr);
    const a = (0.4 + rnd() * 0.4) * (k % 2 ? -1 : 1);
    if (idx < n) (k % 2 ? L : R)[idx] += a;
  }
  return [L, R];
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Rendering (browser only)
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// Pipeline:
//   1. JS: synthesise drum one-shots and one buffer per distinct note / chord / riser.
//   2. JS: block mixer (512 samples). Each instrument kind has a bus: sum of its voices →
//      section-driven low-pass sweep (SVF) → kick-triggered sidechain ducking → level, with
//      sends to a tempo-synced ping-pong delay (JS) and to the reverb.
//   3. OfflineAudioContext at half rate: reverb send → high-pass → ConvolverNode (generated IR).
//   4. JS: add the (ducked) reverb return, then the master bus (normalise → glue compressor →
//      look-ahead limiter). No stage adds latency, so the audio stays aligned to event times.
//
// Why not one AudioBufferSourceNode per event? An OfflineAudioContext processes every scheduled
// (not yet started) source on every render quantum, so a few thousand sources make a 2-minute
// render take tens of seconds. Mixing pre-rendered voices in JS is ~100x cheaper.

const yieldToUI = () => new Promise((r) => setTimeout(r, 0));
const MIX_BLOCK = 512;
const KIND_LIST = ['kick', 'snare', 'clap', 'hat', 'openhat', 'bass', 'lead', 'arp', 'chord', 'riser', 'impact'];
const SWEPT = new Set(['bass', 'lead', 'arp', 'chord']);

/** Kick-triggered ducking amount ("dip", 0..1), produced block by block. */
function makeDipper(kicks, sr, bpm) {
  const starts = kicks.map((k) => Math.round(k.t * sr));
  const amts = kicks.map((k) => clamp(k.vel / 0.9, 0.4, 1));
  const holdN = Math.round(0.02 * sr);
  const atk = 1 - Math.exp(-1 / (0.003 * sr));
  const rel = 1 - Math.exp(-1 / (Math.min(0.12, (60 / bpm) * 0.2) * sr));
  let k = 0;
  let dip = 0;
  let target = 0;
  let holdUntil = -1;
  return (out, i0, len) => {
    for (let j = 0; j < len; j++) {
      const i = i0 + j;
      while (k < starts.length && starts[k] <= i) {
        target = amts[k];
        holdUntil = starts[k] + holdN;
        k++;
      }
      if (i < holdUntil) dip += (target - dip) * atk;
      else dip -= dip * rel;
      out[j] = dip;
    }
  };
}

/** Section-driven low-pass cutoff curve: closed intros, opening builds, open drops, dark breaks. */
function makeSweep(sections) {
  const segs = [];
  let cur = 20000;
  for (const s of sections) {
    let f0 = 20000;
    let f1 = 20000;
    if (s.name === 'intro') { f0 = 500; f1 = 3200; }
    else if (s.name === 'build') { f0 = cur; f1 = 19000; }
    else if (s.name === 'break') { f0 = 900; f1 = 4000; }
    else if (s.name === 'outro') { f0 = 20000; f1 = 1100; }
    segs.push({ a: s.start, b: s.end, f0, f1 });
    cur = f1;
  }
  let idx = 0;
  return (t) => {
    if (!segs.length) return 20000;
    if (t < segs[0].a) return segs[0].f0;
    while (idx < segs.length - 1 && t >= segs[idx].b) idx++;
    const s = segs[idx];
    if (t >= s.b) return s.f1;
    return s.f0 * Math.pow(s.f1 / s.f0, (t - s.a) / (s.b - s.a));
  };
}

function makeAudioBuffer(OAC, channels, length, sampleRate) {
  try {
    return new AudioBuffer({ numberOfChannels: channels, length, sampleRate });
  } catch {
    return new OAC(channels, 1, sampleRate).createBuffer(channels, length, sampleRate);
  }
}

/**
 * Render a composition to a stereo AudioBuffer. Browser only (needs OfflineAudioContext).
 * @param {object} comp  result of composeSong
 * @param {object} [opts]
 * @param {number} [opts.sampleRate=44100]
 * @param {(p:number)=>void} [opts.onProgress]  called with 0..1 while rendering
 * @param {string[]} [opts.mute]   event kinds to leave out (debugging / stems)
 * @param {boolean} [opts.master=true]  apply the master bus (normalise + compress + limit)
 * @param {object} [opts.stats]  if given, receives timing / voice-count diagnostics
 * @returns {Promise<AudioBuffer>}
 */
export async function renderSong(comp, { sampleRate = 44100, onProgress, mute, master: doMaster = true, stats } = {}) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OAC) throw new Error('renderSong() needs the Web Audio API (OfflineAudioContext)');
  const now = () => (globalThis.performance ? performance.now() : Date.now());
  const tStart = now();
  const sr = sampleRate;
  const style = comp.def.style in PATCHES ? comp.def.style : 'synthwave';
  const PT = PATCHES[style];
  const KT = KITS[style];
  const MX = mixFor(style);
  const bpm = comp.bpm;
  const seed = (comp.def.seed >>> 0) || 1;
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  const N = Math.ceil(comp.duration * sr);
  const muted = new Set(mute || []);
  const progress = (p) => {
    if (onProgress) try { onProgress(Math.min(1, p)); } catch { /* ignore listener errors */ }
  };
  let lastYield = now();
  const maybeYield = async (p) => {
    if (now() - lastYield > 30) {
      progress(p);
      await yieldToUI();
      lastYield = now();
    }
  };

  // ── 1. sounds ──
  const normPeak = (chs) => {
    const p = peakOf(...chs) || 1;
    for (const c of chs) for (let i = 0; i < c.length; i++) c[i] /= p;
    return chs;
  };
  const panMono = (x, pan) => {
    const a = ((pan + 1) * Math.PI) / 4;
    const L = new Float32Array(x.length);
    const R = new Float32Array(x.length);
    const gl = Math.cos(a) * Math.SQRT2;
    const gr = Math.sin(a) * Math.SQRT2;
    for (let i = 0; i < x.length; i++) { L[i] = x[i] * gl; R[i] = x[i] * gr; }
    return [L, R];
  };
  const kick = normPeak([synthKick(KT.kick, sr, rnd)])[0];
  const drums = {
    kick: [kick, kick],
    snare: normPeak(synthSnare(KT.snare, sr, rnd)),
    clap: normPeak(synthClap(KT.clap, sr, rnd)),
    hat: normPeak(panMono(synthHat(KT.hat, sr, rnd), MX.pan.hat)),
    openhat: normPeak(panMono(synthHat(KT.openhat, sr, rnd), MX.pan.openhat)),
    impact: normPeak(synthImpact(sr, rnd, style === 'chiptune')),
  };

  // Tonal voices are loudness-normalised per patch (RMS of a reference note), so bus levels
  // in MIX mean the same thing for every style.
  const norms = new Map();
  const REF = { lead: 72, arp: 72, chord: 64, bass: 40 };
  const patchNorm = (kind) => {
    if (!norms.has(kind)) {
      const [L, R] = renderVoice(PT[kind], [REF[kind]], 0.5, { sr, bpm, wob: 0, vel: 1, seed: 7 });
      const m = Math.min(L.length, Math.floor(0.5 * sr));
      let s = 0;
      for (let i = 0; i < m; i++) s += L[i] * L[i] + R[i] * R[i];
      norms.set(kind, 0.2 / (Math.sqrt(s / (2 * m)) || 1));
    }
    return norms.get(kind);
  };
  const cache = new Map();
  const voice = (kind, midis, dur, e) => {
    const P = PT[kind];
    const velQ = P.flt && P.flt.vel ? Math.round((e.vel ?? 1) * 4) / 4 : 1;
    const durQ = Math.round(dur * 200) / 200;
    const key = `${kind}|${midis.join(',')}|${durQ}|${e.wob ?? ''}|${velQ}`;
    let v = cache.get(key);
    if (!v) {
      v = renderVoice(P, midis, durQ, { sr, bpm, wob: e.wob || 0, vel: velQ, seed: hashString(key) });
      const g = patchNorm(kind);
      for (const c of v) for (let i = 0; i < c.length; i++) c[i] *= g;
      cache.set(key, v);
    }
    return v;
  };

  const plays = []; // { s0, L, R, g, kind }
  const evs = comp.events;
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    if (muted.has(e.kind)) continue;
    let buf = null;
    let g = e.vel;
    if (drums[e.kind]) buf = drums[e.kind];
    else if (e.kind === 'riser') {
      const key = `riser|${Math.round(e.dur * 100)}`;
      buf = cache.get(key);
      if (!buf) {
        buf = normPeak(synthRiser(e.dur, sr, mulberry32(hashString(key) ^ seed)));
        cache.set(key, buf);
      }
    } else if (e.kind === 'chord') {
      // notes of a chord that start together are rendered as one voice
      const group = [e];
      while (i + 1 < evs.length && evs[i + 1].kind === 'chord' && evs[i + 1].t === e.t && evs[i + 1].dur === e.dur) group.push(evs[++i]);
      const midis = group.map((x) => x.midi).sort((a, b) => a - b);
      g = group.reduce((a, x) => a + x.vel, 0) / group.length;
      buf = voice('chord', midis, e.dur, e);
    } else if (PT[e.kind]) buf = voice(e.kind, [e.midi], e.dur, e);
    if (buf) plays.push({ s0: Math.round(e.t * sr), L: buf[0], R: buf[1], g, kind: e.kind });
    if ((i & 31) === 0) await maybeYield(0.4 * (i / evs.length));
  }
  plays.sort((a, b) => a.s0 - b.s0);
  const tSynth = now();

  // ── 2. JS mixer ──
  const out = makeAudioBuffer(OAC, 2, N, sr);
  const oL = out.getChannelData(0);
  const oR = out.getChannelData(1);
  const rsr = sr / 2; // reverb runs at half rate
  const M = Math.ceil(N / 2);
  const rctx = new OAC(2, M, rsr);
  const sendBuf = rctx.createBuffer(1, M, rsr);
  const send = sendBuf.getChannelData(0);

  const bus = {};
  for (const kind of KIND_LIST) {
    const swept = MX.sweep && SWEPT.has(kind);
    bus[kind] = {
      L: new Float32Array(MIX_BLOCK),
      R: new Float32Array(MIX_BLOCK),
      active: [],
      level: MX.level[kind] ?? 0.5,
      duck: MX.duck[kind] || 0,
      rev: MX.rev[kind] || 0,
      dly: MX.dly[kind] || 0,
      fl: swept ? new SVF(sr) : null,
      fr: swept ? new SVF(sr) : null,
      q: kind === 'bass' ? 0.7 : 1.2,
      open: true, // filter bypassed (fully open)
    };
  }
  const kicks = muted.has('kick') ? [] : comp.events.filter((e) => e.kind === 'kick');
  const dipper = makeDipper(kicks, sr, bpm);
  const sweepAt = makeSweep(comp.sections);
  const dip = new Float32Array(MIX_BLOCK);
  const revBlock = new Float32Array(MIX_BLOCK);
  const dlyBlock = new Float32Array(MIX_BLOCK);

  // ping-pong delay state
  const D = Math.max(1, Math.round(Math.min(1.9, (60 / bpm) * MX.delayBeats) * sr));
  const dBufL = new Float32Array(D);
  const dBufR = new Float32Array(D);
  let dIdx = 0, hpX = 0, hpY = 0, fbLp = 0;
  const hpA = Math.exp((-TWO_PI * 350) / sr);
  const lpA = 1 - Math.exp((-TWO_PI * 3400) / sr);
  const fb = MX.feedback;
  const DLY_OUT = 0.8;
  const DLY_REV = 0.25;
  let x1 = 0, x2 = 0; // decimator history

  let pi = 0;
  for (let b0 = 0; b0 < N; b0 += MIX_BLOCK) {
    const len = Math.min(MIX_BLOCK, N - b0);
    const b1 = b0 + len;
    while (pi < plays.length && plays[pi].s0 < b1) {
      bus[plays[pi].kind].active.push(plays[pi]);
      pi++;
    }
    dipper(dip, b0, len);
    revBlock.fill(0);
    dlyBlock.fill(0);
    const fc = sweepAt((b0 + len / 2) / sr);

    for (let k = 0; k < KIND_LIST.length; k++) {
      const s = bus[KIND_LIST[k]];
      if (!s.active.length) {
        s.open = true;
        continue;
      }
      const L = s.L, R = s.R;
      L.fill(0);
      R.fill(0);
      let keep = 0;
      for (let a = 0; a < s.active.length; a++) {
        const p = s.active[a];
        const end = p.s0 + p.L.length;
        const from = p.s0 > b0 ? p.s0 : b0;
        const to = end < b1 ? end : b1;
        const pl = p.L, pr = p.R, g = p.g, off = p.s0;
        for (let i = from; i < to; i++) {
          L[i - b0] += pl[i - off] * g;
          R[i - b0] += pr[i - off] * g;
        }
        if (end > b1) s.active[keep++] = p;
      }
      s.active.length = keep;

      if (s.fl) {
        if (fc < 18000) {
          if (s.open) {
            s.fl.ic1 = s.fl.ic2 = s.fr.ic1 = s.fr.ic2 = 0;
            s.open = false;
          }
          s.fl.set(fc, s.q);
          s.fr.set(fc, s.q);
          for (let i = 0; i < len; i++) {
            L[i] = s.fl.lp(L[i]);
            R[i] = s.fr.lp(R[i]);
          }
        } else s.open = true;
      }

      const lvl = s.level, depth = s.duck, rv = s.rev, dl = s.dly;
      for (let i = 0; i < len; i++) {
        const g = (depth ? 1 - depth * dip[i] : 1) * lvl;
        const l = L[i] * g, r = R[i] * g;
        oL[b0 + i] += l;
        oR[b0 + i] += r;
        if (rv) revBlock[i] += (l + r) * 0.5 * rv;
        if (dl) dlyBlock[i] += (l + r) * 0.5 * dl;
      }
    }

    // ping-pong delay: left line → right line → (filtered feedback) → left line
    for (let i = 0; i < len; i++) {
      const x = dlyBlock[i];
      hpY = hpA * (hpY + x - hpX);
      hpX = x;
      const eL = dBufL[dIdx], eR = dBufR[dIdx];
      fbLp += lpA * (eR - fbLp);
      dBufL[dIdx] = hpY + fb * fbLp;
      dBufR[dIdx] = eL;
      if (++dIdx >= D) dIdx = 0;
      oL[b0 + i] += (eL * 0.9 + eR * 0.1) * DLY_OUT;
      oR[b0 + i] += (eR * 0.9 + eL * 0.1) * DLY_OUT;
      revBlock[i] += (eL + eR) * 0.5 * DLY_REV;
    }

    // 2:1 decimation of the reverb send ([1 2 1] / 4 kernel)
    for (let i = 0; i < len; i++) {
      const gi = b0 + i;
      const x = revBlock[i];
      if (gi & 1) send[gi >> 1] = 0.25 * x2 + 0.5 * x1 + 0.25 * x;
      x2 = x1;
      x1 = x;
    }
    if ((b0 & 0xffff) === 0) await maybeYield(0.4 + 0.3 * (b0 / N));
  }
  const tMix = now();

  // ── 3. convolution reverb (OfflineAudioContext) ──
  const [irL, irR] = makeImpulse(rsr, MX.reverb, MX.damp, mulberry32(seed ^ 0x51f15e));
  const ir = rctx.createBuffer(2, irL.length, rsr);
  ir.copyToChannel(irL, 0);
  ir.copyToChannel(irR, 1);
  const src = rctx.createBufferSource();
  src.buffer = sendBuf;
  const hp = rctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 220;
  const conv = rctx.createConvolver();
  conv.buffer = ir;
  src.connect(hp).connect(conv).connect(rctx.destination);
  src.start(0);
  progress(0.72);
  const wet = await rctx.startRendering();
  const tRev = now();

  // ── 4. reverb return (ducked, linear-interpolated back to full rate) + master ──
  {
    const wL = wet.getChannelData(0);
    const wR = wet.getChannelData(1);
    const dip2 = makeDipper(kicks, sr, bpm);
    const depth = MX.duck.rev || 0;
    const RET = 0.9;
    for (let b0 = 0; b0 < N; b0 += MIX_BLOCK) {
      const len = Math.min(MIX_BLOCK, N - b0);
      dip2(dip, b0, len);
      for (let i = 0; i < len; i++) {
        const gi = b0 + i;
        const j = gi >> 1;
        const g = RET * (1 - depth * dip[i]);
        let l = wL[j], r = wR[j];
        if (gi & 1 && j + 1 < M) {
          l = 0.5 * (l + wL[j + 1]);
          r = 0.5 * (r + wR[j + 1]);
        }
        oL[gi] += l * g;
        oR[gi] += r * g;
      }
    }
  }
  progress(0.85);
  await yieldToUI();
  if (doMaster) masterBus(out, comp, sr);
  if (stats) {
    Object.assign(stats, {
      synthMs: Math.round(tSynth - tStart),
      mixMs: Math.round(tMix - tSynth),
      reverbMs: Math.round(tRev - tMix),
      masterMs: Math.round(now() - tRev),
      totalMs: Math.round(now() - tStart),
      voices: cache.size,
      plays: plays.length,
    });
  }
  progress(1);
  return out;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
//  Master bus: loudness normalisation → glue compressor → look-ahead brick-wall limiter
// ────────────────────────────────────────────────────────────────────────────────────────────

const TARGET_DROP_RMS = 0.25;
const CEILING = 0.95;

function sectionRms(L, R, sr, sections) {
  let s = 0, n = 0;
  for (const sec of sections) {
    if (sec.name !== 'drop') continue;
    const a = Math.floor(sec.start * sr), b = Math.min(L.length, Math.floor(sec.end * sr));
    for (let i = a; i < b; i += 2) { s += L[i] * L[i] + R[i] * R[i]; n += 2; }
  }
  if (!n) {
    for (let i = 0; i < L.length; i += 2) { s += L[i] * L[i] + R[i] * R[i]; n += 2; }
  }
  return Math.sqrt(s / Math.max(1, n));
}

function applyGain(L, R, g) {
  for (let i = 0; i < L.length; i++) { L[i] *= g; R[i] *= g; }
}

/** RMS-detecting feed-forward compressor (stereo linked), gain computed every 16 samples. */
function compress(L, R, sr, { threshDb = -14, ratio = 2.5, kneeDb = 6, attack = 0.01, release = 0.15 } = {}) {
  const n = L.length;
  const D = 16;
  const aA = Math.exp(-D / (attack * sr));
  const aR = Math.exp(-D / (release * sr));
  let env = 0;
  let prevG = 1;
  for (let b0 = 0; b0 < n; b0 += D) {
    const b1 = Math.min(n, b0 + D);
    let s = 0;
    for (let i = b0; i < b1; i++) s += L[i] * L[i] + R[i] * R[i];
    const ms = s / (2 * (b1 - b0));
    env = ms > env ? aA * env + (1 - aA) * ms : aR * env + (1 - aR) * ms;
    const db = 10 * Math.log10(env + 1e-12);
    const over = db - threshDb;
    let gr = 0;
    if (over > kneeDb / 2) gr = over * (1 - 1 / ratio);
    else if (over > -kneeDb / 2) gr = ((over + kneeDb / 2) ** 2 / (2 * kneeDb)) * (1 - 1 / ratio);
    const g = Math.pow(10, -gr / 20);
    // interpolate gain across the block to avoid zipper noise
    const len = b1 - b0;
    for (let i = 0; i < len; i++) {
      const gi = prevG + (g - prevG) * (i / len);
      L[b0 + i] *= gi;
      R[b0 + i] *= gi;
    }
    prevG = g;
  }
}

/**
 * Zero-latency look-ahead limiter: the gain curve is the box-smoothed running minimum of the
 * required gain, which provably keeps |x·g| ≤ ceiling, followed by an exponential release.
 */
function limit(L, R, sr, ceiling = CEILING, lookMs = 3, relMs = 80) {
  const n = L.length;
  const W = Math.max(2, Math.round((lookMs / 1000) * sr));
  const req = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    req[i] = a > ceiling ? ceiling / a : 1;
  }
  // M[i] = min(req[i-W+1 .. i]) via monotonic deque
  const M = new Float32Array(n);
  const dq = new Int32Array(n);
  let h = 0, tl = 0;
  for (let i = 0; i < n; i++) {
    while (tl > h && req[dq[tl - 1]] >= req[i]) tl--;
    dq[tl++] = i;
    if (dq[h] <= i - W) h++;
    M[i] = req[dq[h]];
  }
  // g[k] = mean(M[k .. k+W-1]) then release smoothing (can only lower the gain further)
  const rc = 1 - Math.exp(-1 / ((relMs / 1000) * sr));
  let sum = 0;
  for (let i = 0; i < Math.min(W, n); i++) sum += M[i];
  let g2 = 1;
  for (let k = 0; k < n; k++) {
    const cnt = Math.min(W, n - k);
    const g = cnt === W ? sum / W : Math.min(sum / cnt, 1);
    g2 = Math.min(g, g2 + (1 - g2) * rc);
    L[k] *= g2;
    R[k] *= g2;
    sum -= M[k];
    if (k + W < n) sum += M[k + W];
  }
  for (let i = 0; i < n; i++) {
    if (L[i] > ceiling) L[i] = ceiling; else if (L[i] < -ceiling) L[i] = -ceiling;
    if (R[i] > ceiling) R[i] = ceiling; else if (R[i] < -ceiling) R[i] = -ceiling;
  }
}

function masterBus(buf, comp, sr) {
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  let rms = sectionRms(L, R, sr, comp.sections);
  applyGain(L, R, clamp(0.2 / (rms || 1), 0.05, 50));
  compress(L, R, sr, { threshDb: -16, ratio: 2.5, kneeDb: 8, attack: 0.012, release: 0.16 });
  rms = sectionRms(L, R, sr, comp.sections);
  applyGain(L, R, clamp(TARGET_DROP_RMS / (rms || 1), 0.05, 50));
  limit(L, R, sr, CEILING);
}

/** Style ids known to the engine (for tools / debug UIs). */
export const STYLE_IDS = Object.keys(STYLES);
