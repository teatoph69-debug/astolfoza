// Gameplay constants modelled after Rhythia / Sound Space Plus.
//
// Coordinate system used everywhere inside this project ("grid units"):
//   * the 3x3 grid has cell centres at 0, 1, 2 on both axes;
//   * x grows to the RIGHT, y grows DOWNWARD (screen-like);
//   * (1, 1) is the centre of the grid;
//   * "quantum" (off-grid) notes may sit at any float position, usually within [-0.5, 2.5].
// Map parsers convert from the file conventions into this space.

export const GRID_CENTER = 1;

export const DEFAULT_SETTINGS = Object.freeze({
  // Judgement — values taken from the Sound Space Plus / Rhythia source code
  hitWindow: 0.055,        // s, one-sided: from the note time to +55 ms (no early hits, no clicking)
  hitbox: 1.1375,          // full side of the square hit area (SS+ special-cases its 1.14 default to this)
  noteSize: 0.875,         // visual size of a note (grid units)

  // Cursor centre is clamped to ±1.36875 around the grid centre → [-0.36875, 2.36875]
  cursorBound: 0.36875,

  // Visual approach (does not affect judgement). SS+: AR 40, spawn distance 40 → 1 s on screen.
  approachRate: 40,        // grid units per second
  approachDistance: 36,    // grid units — spawn distance
  fadeIn: 0.45,            // fraction of the approach distance over which notes fade in
  parallax: 0.1625,        // camera follows the cursor by this fraction (SS+ default)

  // Health — SS+ default ("same as Sound Space"): 5 HP, +0.5 per hit, −1 per miss, fail at 0
  healthMax: 5,
  healthMissDrain: 1,
  healthHitGain: 0.5,
  noFail: false,

  // Score — SS+: 50 per hit × level (1…8); level +1 every 10 consecutive hits, −1 on a miss
  scorePerNote: 50,
  maxMultiplier: 8,
  hitsPerMultiplier: 10,
  speed: 1.0,              // playback rate (Speed mod)
});

// Accuracy → grade
export const GRADES = [
  { name: 'SS', min: 1.0, color: '#ffe066' },
  { name: 'S', min: 0.98, color: '#ffd43b' },
  { name: 'A', min: 0.95, color: '#69db7c' },
  { name: 'B', min: 0.9, color: '#4dabf7' },
  { name: 'C', min: 0.85, color: '#da77f2' },
  { name: 'D', min: 0.8, color: '#ff922b' },
  { name: 'F', min: 0.0, color: '#ff4d4d' },
];

export function gradeFor(accuracy, failed = false) {
  if (failed) return { name: 'F', min: 0, color: '#ff4d4d' };
  for (const g of GRADES) if (accuracy >= g.min - 1e-9) return g;
  return GRADES[GRADES.length - 1];
}

// Default note colour set — alternating colours per note (SS+ default is "Cotton Candy").
export const NOTE_COLORS = ['#00ffed', '#ff8ff9'];

export const COLOR_SETS = {
  'Rhythia': ['#ff3d9a', '#43e8ff'],
  'Cotton Candy': ['#00ffed', '#ff8ff9'],
  'Rhythia 2026': ['#ff0059', '#ffd8e6'],
  'Неон': ['#ff2e63', '#08d9d6', '#f9ed69'],
  'Радуга': ['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93'],
  'Лёд': ['#a5f3fc', '#60a5fa', '#e0f2fe'],
  'Закат': ['#ff7b54', '#ffb26b', '#ffd56f', '#939b62'],
  'Моно': ['#ffffff'],
};
