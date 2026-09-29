// Evolution Strategies (OpenAI-ES style) with antithetic sampling, centred-rank fitness shaping
// and Adam. Works on any flat Float32Array parameter vector. Parallelism-agnostic: the caller
// evaluates candidates however it likes (main thread, Web Workers, Node worker_threads).
//
// Why ES? Rhythm-game aiming is a control problem with sparse, discontinuous rewards (hit / miss).
// ES needs no gradients through the game, is robust, embarrassingly parallel and — nice for the
// user — every generation produces a visibly better (or worse) "mutant population".

import { RNG } from '../core/rng.js';

export class ES {
  constructor(theta, { popSize = 48, sigma = 0.04, lr = 0.02, weightDecay = 0.002, beta1 = 0.9, beta2 = 0.999, seed = 7 } = {}) {
    this.n = theta.length;
    this.theta = Float32Array.from(theta);
    this.popSize = popSize + (popSize % 2);  // antithetic pairs
    this.sigma = sigma;
    this.lr = lr;
    this.weightDecay = weightDecay;
    this.beta1 = beta1;
    this.beta2 = beta2;
    this.m = new Float32Array(this.n);
    this.v = new Float32Array(this.n);
    this.t = 0;
    this.rng = new RNG(seed);
    this.half = this.popSize / 2;
    this.noise = new Float32Array(this.half * this.n);
    this.candidates = [];
    for (let i = 0; i < this.popSize; i++) this.candidates.push(new Float32Array(this.n));
    this.lastGradNorm = 0;
  }

  /** Sample a new population. Returns array of Float32Array parameter vectors (reused buffers). */
  ask() {
    const { n, half, noise, sigma, theta } = this;
    for (let i = 0; i < half * n; i++) noise[i] = this.rng.gauss();
    for (let k = 0; k < half; k++) {
      const plus = this.candidates[2 * k], minus = this.candidates[2 * k + 1];
      const off = k * n;
      for (let j = 0; j < n; j++) {
        const e = sigma * noise[off + j];
        plus[j] = theta[j] + e;
        minus[j] = theta[j] - e;
      }
    }
    return this.candidates;
  }

  /** Update theta from fitness values (same order as ask()). Higher is better. */
  tell(fitness) {
    const { n, half, noise, popSize } = this;
    const ranks = centeredRanks(fitness);
    const grad = new Float32Array(n);
    for (let k = 0; k < half; k++) {
      const w = ranks[2 * k] - ranks[2 * k + 1];
      if (w === 0) continue;
      const off = k * n;
      for (let j = 0; j < n; j++) grad[j] += w * noise[off + j];
    }
    const scale = 1 / (popSize * this.sigma);
    let gn = 0;
    for (let j = 0; j < n; j++) {
      // ascent direction; weight decay pulls toward 0
      grad[j] = grad[j] * scale - this.weightDecay * this.theta[j];
      gn += grad[j] * grad[j];
    }
    this.lastGradNorm = Math.sqrt(gn);
    // Adam (ascent)
    this.t++;
    const b1 = this.beta1, b2 = this.beta2;
    const bc1 = 1 - Math.pow(b1, this.t), bc2 = 1 - Math.pow(b2, this.t);
    const a = this.lr * Math.sqrt(bc2) / bc1;
    for (let j = 0; j < n; j++) {
      const g = grad[j];
      this.m[j] = b1 * this.m[j] + (1 - b1) * g;
      this.v[j] = b2 * this.v[j] + (1 - b2) * g * g;
      this.theta[j] += a * this.m[j] / (Math.sqrt(this.v[j]) + 1e-8);
    }
  }

  /** Snapshot of optimizer state (for saving progress). */
  state() {
    return { theta: Array.from(this.theta), m: Array.from(this.m), v: Array.from(this.v), t: this.t, sigma: this.sigma, lr: this.lr };
  }
  load(st) {
    this.theta.set(st.theta);
    if (st.m) this.m.set(st.m);
    if (st.v) this.v.set(st.v);
    this.t = st.t || 0;
  }
}

export function centeredRanks(values) {
  const n = values.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b]);
  const r = new Float32Array(n);
  for (let k = 0; k < n; k++) r[idx[k]] = n > 1 ? k / (n - 1) - 0.5 : 0;
  return r;
}
