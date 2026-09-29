// Small, fast, seedable PRNG (mulberry32) + helpers. Deterministic across browser and Node,
// which matters: the AI trainer, map generators and music synth all rely on reproducible seeds.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RNG {
  constructor(seed = 1) {
    this.seed = seed >>> 0;
    this._next = mulberry32(this.seed);
    this._spare = null;
  }
  next() { return this._next(); }
  float(min = 0, max = 1) { return min + (max - min) * this._next(); }
  int(min, maxInclusive) { return min + Math.floor(this._next() * (maxInclusive - min + 1)); }
  chance(p) { return this._next() < p; }
  pick(arr) { return arr[Math.floor(this._next() * arr.length)]; }
  weighted(items, weights) {
    let total = 0;
    for (const w of weights) total += w;
    let r = this._next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }
  // Standard normal via Box–Muller (cached pair).
  gauss() {
    if (this._spare !== null) {
      const s = this._spare;
      this._spare = null;
      return s;
    }
    let u = 0, v = 0;
    while (u <= 1e-12) u = this._next();
    v = this._next();
    const mag = Math.sqrt(-2 * Math.log(u));
    this._spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this._next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

// Stable 32-bit string hash (FNV-1a) — used to derive seeds from names.
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
