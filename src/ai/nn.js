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
