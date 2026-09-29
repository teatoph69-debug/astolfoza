// Tiny dependency-free multilayer perceptron with flat Float32Array parameters.
// Flat parameters make it trivial to perturb (evolution strategies), serialize and ship to workers.

export class MLP {
  /** @param {number[]} sizes e.g. [20, 32, 32, 2] */
  constructor(sizes) {
    this.sizes = sizes.slice();
    this.nParams = 0;
    this.layers = [];
    for (let l = 0; l < sizes.length - 1; l++) {
      const nin = sizes[l], nout = sizes[l + 1];
      this.layers.push({ nin, nout, w: this.nParams, b: this.nParams + nin * nout });
      this.nParams += nin * nout + nout;
    }
    this.params = new Float32Array(this.nParams);
    // activation buffers (index 0 = input copy)
    this.acts = sizes.map((s) => new Float32Array(s));
  }

  /** Xavier-style init with a seeded gaussian source `gauss()` */
  init(gauss, gain = 1) {
    const p = this.params;
    for (const L of this.layers) {
      const std = gain / Math.sqrt(L.nin);
      for (let i = 0; i < L.nin * L.nout; i++) p[L.w + i] = gauss() * std;
      for (let i = 0; i < L.nout; i++) p[L.b + i] = 0;
    }
    return this;
  }

  setParams(params) {
    if (params.length !== this.nParams) throw new Error(`param size mismatch ${params.length} != ${this.nParams}`);
    this.params = params;
    return this;
  }

  /** Forward pass; tanh on every layer. Returns the output activation array (reused buffer). */
  forward(input, params = this.params) {
    const acts = this.acts;
    const a0 = acts[0];
    for (let i = 0; i < a0.length; i++) a0[i] = input[i];
    for (let l = 0; l < this.layers.length; l++) {
      const { nin, nout, w, b } = this.layers[l];
      const inp = acts[l], out = acts[l + 1];
      for (let o = 0; o < nout; o++) {
        let s = params[b + o];
        const row = w + o * nin;
        for (let i = 0; i < nin; i++) s += params[row + i] * inp[i];
        out[o] = fastTanh(s);
      }
    }
    return acts[acts.length - 1];
  }
}

// Accurate tanh (Math.tanh is fine in modern engines, but clamp to avoid NaNs from huge inputs).
function fastTanh(x) {
  if (x > 9) return 1;
  if (x < -9) return -1;
  return Math.tanh(x);
}

// ---- (de)serialization -------------------------------------------------------------------------

export function paramsToBase64(params) {
  const bytes = new Uint8Array(params.buffer, params.byteOffset, params.byteLength);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
}

export function base64ToParams(b64) {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

// ---- supervised learning (behaviour cloning) ---------------------------------------------------
//
// Backpropagation for the tanh MLP above + Adam, mini-batches, global-norm gradient clipping and a
// weighted MSE loss. Used to clone the player's aiming ("МУХА watches how I play"). Everything runs
// on preallocated typed arrays: no allocations inside the sample / batch loops.

/**
 * Per-network backprop workspace. Works on any flat parameter vector with the MLP's layout
 * (Float32Array for real training, Float64Array for exact gradient checks).
 */
export class Backprop {
  constructor(net) {
    this.net = net;
    this.layers = net.layers;
    this.sizes = net.sizes;
    this.nParams = net.nParams;
    this.acts = net.sizes.map((s) => new Float64Array(s));          // acts[0] = input
    this.deltas = net.sizes.map((s) => new Float64Array(s));        // dLoss/dPreactivation per layer
    this.grad = new Float64Array(net.nParams);
  }

  zeroGrad() { this.grad.fill(0); }

  /** Forward pass reading the input straight from `X` at offset `off`. Returns the output acts. */
  forwardAt(X, off, params) {
    const acts = this.acts, layers = this.layers;
    const a0 = acts[0];
    for (let i = 0; i < a0.length; i++) a0[i] = X[off + i];
    for (let l = 0; l < layers.length; l++) {
      const L = layers[l];
      const nin = L.nin, nout = L.nout, w = L.w, b = L.b;
      const inp = acts[l], out = acts[l + 1];
      for (let o = 0; o < nout; o++) {
        let s = params[b + o];
        const row = w + o * nin;
        for (let i = 0; i < nin; i++) s += params[row + i] * inp[i];
        out[o] = s > 9 ? 1 : s < -9 ? -1 : Math.tanh(s);
      }
    }
    return acts[acts.length - 1];
  }

  /**
   * Forward + backward for one sample; adds `scale · ∂(Σ_d (ŷ_d − y_d)²)/∂θ` into `this.grad`.
   * Returns the sample's unscaled squared error Σ_d (ŷ_d − y_d)².
   */
  accumulate(X, xOff, Y, yOff, scale, params) {
    const out = this.forwardAt(X, xOff, params);
    const layers = this.layers, acts = this.acts, deltas = this.deltas, grad = this.grad;
    const nL = layers.length;
    const dOut = deltas[nL];
    let se = 0;
    for (let o = 0; o < out.length; o++) {
      const a = out[o];
      const e = a - Y[yOff + o];
      se += e * e;
      dOut[o] = 2 * e * scale * (1 - a * a);        // through tanh
    }
    if (scale === 0) return se;
    for (let l = nL - 1; l >= 0; l--) {
      const L = layers[l];
      const nin = L.nin, nout = L.nout, w = L.w, b = L.b;
      const inp = acts[l], d = deltas[l + 1];
      const dPrev = deltas[l];
      if (l > 0) for (let i = 0; i < nin; i++) dPrev[i] = 0;
      for (let o = 0; o < nout; o++) {
        const dl = d[o];
        if (dl === 0) continue;
        grad[b + o] += dl;
        const row = w + o * nin;
        if (l > 0) {
          for (let i = 0; i < nin; i++) {
            grad[row + i] += dl * inp[i];
            dPrev[i] += dl * params[row + i];
          }
        } else {
          for (let i = 0; i < nin; i++) grad[row + i] += dl * inp[i];
        }
      }
      if (l > 0) for (let i = 0; i < nin; i++) { const a = inp[i]; dPrev[i] *= 1 - a * a; }
    }
    return se;
  }
}

/** Adam with decoupled weight decay (AdamW) and global-norm gradient clipping. */
export class AdamOptimizer {
  constructor(n, { lr = 2e-3, beta1 = 0.9, beta2 = 0.999, eps = 1e-8, weightDecay = 0, clip = 1 } = {}) {
    this.lr = lr; this.beta1 = beta1; this.beta2 = beta2; this.eps = eps;
    this.weightDecay = weightDecay; this.clip = clip;
    this.m = new Float64Array(n);
    this.v = new Float64Array(n);
    this.t = 0;
    this.lastGradNorm = 0;
  }

  /** Gradient DESCENT step on `params` in place. `grad` is left clipped. */
  step(params, grad) {
    const n = params.length;
    let gn = 0;
    for (let j = 0; j < n; j++) gn += grad[j] * grad[j];
    gn = Math.sqrt(gn);
    this.lastGradNorm = gn;
    const k = this.clip > 0 && gn > this.clip ? this.clip / gn : 1;
    this.t++;
    const b1 = this.beta1, b2 = this.beta2;
    const bc1 = 1 - Math.pow(b1, this.t), bc2 = 1 - Math.pow(b2, this.t);
    const a = this.lr * Math.sqrt(bc2) / bc1;
    const wd = this.lr * this.weightDecay;
    const m = this.m, v = this.v, eps = this.eps;
    for (let j = 0; j < n; j++) {
      const g = grad[j] * k;
      m[j] = b1 * m[j] + (1 - b1) * g;
      v[j] = b2 * v[j] + (1 - b2) * g * g;
      params[j] -= a * m[j] / (Math.sqrt(v[j]) + eps) + wd * params[j];
    }
  }
}

/** Weighted MSE (mean over samples and outputs) of `params` on rows `idx[from..to)` (all rows if no idx). */
export function supervisedLoss(net, X, Y, { W = null, params = net.params, idx = null, from = 0, to = -1, bp = null } = {}) {
  const inDim = net.sizes[0], outDim = net.sizes[net.sizes.length - 1];
  const n = idx ? idx.length : (Y.length / outDim) | 0;
  const end = to < 0 ? n : Math.min(n, to);
  const B = bp || new Backprop(net);
  let sum = 0, wsum = 0;
  for (let k = from; k < end; k++) {
    const r = idx ? idx[k] : k;
    const w = W ? W[r] : 1;
    if (w <= 0) continue;
    const out = B.forwardAt(X, r * inDim, params);
    let se = 0;
    for (let o = 0; o < outDim; o++) { const e = out[o] - Y[r * outDim + o]; se += e * e; }
    sum += w * se;
    wsum += w;
  }
  return wsum > 0 ? sum / (wsum * outDim) : 0;
}

/** Hand control back to the event loop (keeps the UI responsive during long training). */
export function yieldToEventLoop() {
  if (typeof setImmediate === 'function') return new Promise((r) => setImmediate(r));
  if (typeof MessageChannel === 'function') {
    return new Promise((r) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { ch.port1.close(); r(); };
      ch.port2.postMessage(0);
    });
  }
  return new Promise((r) => setTimeout(r, 0));
}

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Train `net` (or an explicit `params` vector) to map rows of X to rows of Y.
 *
 * @param {MLP} net
 * @param {Float32Array} X  n × inDim inputs (row-major)
 * @param {Float32Array} Y  n × outDim targets in (−1, 1) (the output layer is tanh)
 * @param {object} [o]
 * @param {Float32Array} [o.W]   per-sample weights (0 = masked out)
 * @param {number} [o.n]         number of rows (default Y.length / outDim)
 * @param {number} [o.epochs=10]
 * @param {number} [o.batch=128]
 * @param {number} [o.lr=2e-3]   peak learning rate (short warm-up, cosine decay to lr·lrFloor)
 * @param {number} [o.lrFloor=0.1]
 * @param {number} [o.weightDecay=1e-4]  decoupled (AdamW)
 * @param {number} [o.clip=1]    global gradient-norm clip
 * @param {number} [o.valFrac=0.05]  share of rows held out for validation loss
 * @param {number} [o.seed=1]
 * @param {Float32Array|Float64Array} [o.params=net.params]  trained in place
 * @param {number} [o.yieldMs=14]  yield to the event loop after this much work (Infinity = never)
 * @param {(p:object)=>void} [o.onProgress]  {epoch, epochs, step, steps, progress, loss, valLoss, ms}
 * @param {()=>boolean} [o.shouldStop]
 * @returns {Promise<{steps:number, epochs:number, losses:{step:number,loss:number}[], epochLoss:number[], valLoss:number[], stopped:boolean, ms:number, samples:number}>}
 */
export async function trainSupervised(net, X, Y, o = {}) {
  const inDim = net.sizes[0], outDim = net.sizes[net.sizes.length - 1];
  const n = o.n ?? ((Y.length / outDim) | 0);
  const params = o.params || net.params;
  const W = o.W || null;
  const epochs = Math.max(1, o.epochs ?? 10);
  const batch = Math.max(1, o.batch ?? 128);
  const lr = o.lr ?? 2e-3;
  const lrFloor = o.lrFloor ?? 0.1;
  const yieldMs = o.yieldMs ?? 14;
  const t0 = nowMs();

  // shuffled index; a fixed tail is held out for validation
  let seed = (o.seed ?? 1) >>> 0 || 1;
  const rand = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const all = new Uint32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) if (!W || W[i] > 0) all[m++] = i;
  const rows = all.subarray(0, m);
  for (let i = m - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = rows[i]; rows[i] = rows[j]; rows[j] = t; }
  const nVal = m >= 200 ? Math.floor(m * Math.max(0, Math.min(0.5, o.valFrac ?? 0.05))) : 0;
  const val = rows.subarray(m - nVal);
  const train = rows.subarray(0, m - nVal);
  const nTrain = train.length;

  const bp = new Backprop(net);
  const opt = new AdamOptimizer(params.length, { lr, weightDecay: o.weightDecay ?? 1e-4, clip: o.clip ?? 1 });
  const stepsPerEpoch = Math.max(1, Math.ceil(nTrain / batch));
  const steps = stepsPerEpoch * epochs;
  const warm = Math.min(200, Math.floor(steps * 0.05));
  const res = { steps: 0, epochs: 0, losses: [], epochLoss: [], valLoss: [], stopped: false, ms: 0, samples: nTrain };
  if (!nTrain) { res.ms = nowMs() - t0; return res; }
  const lossEvery = Math.max(1, Math.floor(steps / 240));
  let lastYield = nowMs();
  let ema = -1;
  const grad = bp.grad;

  outer:
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = nTrain - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = train[i]; train[i] = train[j]; train[j] = t; }
    let epSum = 0, epW = 0;
    for (let s = 0; s < stepsPerEpoch; s++) {
      const from = s * batch, to = Math.min(nTrain, from + batch);
      let wsum = 0;
      for (let k = from; k < to; k++) wsum += W ? W[train[k]] : 1;
      if (wsum <= 0) continue;
      const scale = 1 / (wsum * outDim);
      bp.zeroGrad();
      let bl = 0;
      for (let k = from; k < to; k++) {
        const r = train[k];
        const w = W ? W[r] : 1;
        bl += w * bp.accumulate(X, r * inDim, Y, r * outDim, w * scale, params);
      }
      // learning-rate schedule: linear warm-up, cosine decay
      const g = res.steps;
      opt.lr = g < warm ? lr * (g + 1) / warm : lr * (lrFloor + (1 - lrFloor) * 0.5 * (1 + Math.cos(Math.PI * (g - warm) / Math.max(1, steps - warm))));
      opt.step(params, grad);
      res.steps++;
      const bLoss = bl * scale;
      epSum += bl; epW += wsum;
      ema = ema < 0 ? bLoss : ema * 0.95 + bLoss * 0.05;
      if (res.steps % lossEvery === 0) res.losses.push({ step: res.steps, loss: ema });
      if (yieldMs !== Infinity) {
        const now = nowMs();
        if (now - lastYield >= yieldMs) {
          if (o.onProgress) o.onProgress({ epoch: ep, epochs, step: res.steps, steps, progress: res.steps / steps, loss: ema, valLoss: res.valLoss.at(-1) ?? null, ms: now - t0 });
          await yieldToEventLoop();
          lastYield = nowMs();
          if (o.shouldStop && o.shouldStop()) { res.stopped = true; break outer; }
        }
      } else if (o.shouldStop && (res.steps & 63) === 0 && o.shouldStop()) { res.stopped = true; break outer; }
    }
    res.epochs = ep + 1;
    res.epochLoss.push(epW > 0 ? epSum / (epW * outDim) : 0);
    if (nVal) res.valLoss.push(supervisedLoss(net, X, Y, { W, params, idx: val, bp }));
    if (o.onProgress) o.onProgress({ epoch: ep + 1, epochs, step: res.steps, steps, progress: res.steps / steps, loss: ema, valLoss: res.valLoss.at(-1) ?? null, ms: nowMs() - t0, epochDone: true });
  }
  res.ms = nowMs() - t0;
  return res;
}
