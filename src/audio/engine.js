// Audio engine: one shared AudioContext, music playback with a smooth, drift-corrected song clock,
// and synthesized hit / miss sound effects.

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.source = null;
    this.buffer = null;
    this.rate = 1;
    this.playing = false;
    this._offset = 0;        // song time at _startCtx
    this._startCtx = 0;      // ctx.currentTime when playback (re)started
    this._clockBase = 0;     // smoothed clock: song time at _perfBase
    this._perfBase = 0;
    this.volumes = { master: 0.8, music: 0.8, sfx: 0.5 };
    this.userOffsetMs = 0;   // positive = notes later
    this._sfx = {};
    this.onEnded = null;
  }

  /** Create / resume the AudioContext. Must be called from a user gesture the first time. */
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.musicGain = this.ctx.createGain();
      this.sfxGain = this.ctx.createGain();
      this.musicGain.connect(this.master);
      this.sfxGain.connect(this.master);
      this.master.connect(this.ctx.destination);
      this.setVolumes(this.volumes);
      this._buildSfx();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  setVolumes(v) {
    Object.assign(this.volumes, v);
    if (!this.ctx) return;
    this.master.gain.value = this.volumes.master;
    this.musicGain.gain.value = this.volumes.music;
    this.sfxGain.gain.value = this.volumes.sfx;
  }

  async decode(arrayBuffer) {
    this.ensure();
    // decodeAudioData detaches the buffer: pass a copy so callers can keep theirs
    const copy = arrayBuffer.slice(0);
    return await new Promise((resolve, reject) => {
      const p = this.ctx.decodeAudioData(copy, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  /** Output latency in seconds (what we hear lags the clock by this much). */
  get latency() {
    if (!this.ctx) return 0;
    return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
  }

  /**
   * Start music. `buffer` may be null (silent map): the clock still runs.
   * `startAt` — song time to start from (can be negative for lead-in).
   */
  play(buffer, { startAt = 0, rate = 1 } = {}) {
    this.ensure();
    this.stop();
    this.buffer = buffer;
    this.rate = rate;
    const ctx = this.ctx;
    const now = ctx.currentTime + 0.05;
    this._startCtx = now;
    this._offset = startAt;
    if (buffer) {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
      src.connect(this.musicGain);
      if (startAt >= 0) src.start(now, startAt);
      else src.start(now - startAt / rate, 0); // delayed start for negative lead-in
      src.onended = () => { if (this.source === src && this.onEnded) this.onEnded(); };
      this.source = src;
    }
    this.playing = true;
    this._perfBase = performance.now();
    this._clockBase = startAt - 0.05 * rate;
  }

  stop() {
    if (this.source) {
      try { this.source.onended = null; this.source.stop(); } catch { /* already stopped */ }
      try { this.source.disconnect(); } catch { /* ignore */ }
    }
    this.source = null;
    this.playing = false;
  }

  /** Pause: returns the song time we paused at. */
  pause() {
    const t = this.rawTime();
    this.stop();
    this._offset = t;
    return t;
  }

  resume(fromTime = this._offset) {
    this.play(this.buffer, { startAt: fromTime, rate: this.rate });
  }

  /** Song time according to the audio hardware clock (coarse, but never drifts). */
  rawTime() {
    if (!this.ctx) return 0;
    if (!this.playing) return this._offset;
    return this._offset + (this.ctx.currentTime - this._startCtx) * this.rate;
  }

  /**
   * Smooth song time for rendering/judging: performance.now() based, gently pulled toward the
   * audio clock, compensated for output latency and user offset.
   */
  songTime() {
    if (!this.playing) return this._offset - this.userOffsetMs / 1000;
    const now = performance.now();
    let t = this._clockBase + ((now - this._perfBase) / 1000) * this.rate;
    const raw = this.rawTime();
    const drift = raw - t;
    if (Math.abs(drift) > 0.08) t = raw;          // big jump (tab switch etc.) → snap
    else t += drift * 0.08;                        // otherwise ease toward the hardware clock
    this._clockBase = t;
    this._perfBase = now;
    return t - this.latency * this.rate - this.userOffsetMs / 1000;
  }

  // ---- sound effects ------------------------------------------------------------------------

  _buildSfx() {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const make = (dur, fn) => {
      const n = Math.floor(sr * dur);
      const b = ctx.createBuffer(1, n, sr);
      const d = b.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = fn(i / sr, i);
      return b;
    };
    // crisp "tick" (Rhythia-like hit sound)
    this._sfx.hit = make(0.06, (t) => {
      const env = Math.exp(-t * 90);
      return (Math.sin(2 * Math.PI * 2400 * t) * 0.5 + (Math.random() * 2 - 1) * 0.35 * Math.exp(-t * 300)) * env * 0.9;
    });
    // low muffled thud for misses
    this._sfx.miss = make(0.16, (t) => Math.sin(2 * Math.PI * (140 - t * 400) * t) * Math.exp(-t * 22) * 0.7);
    // UI click
    this._sfx.ui = make(0.04, (t) => Math.sin(2 * Math.PI * 1200 * t) * Math.exp(-t * 120) * 0.4);
    // Win98-style system sounds (original synth, not the Microsoft samples)
    this._sfx.ding = make(0.7, (t) => {
      const e = Math.exp(-t * 6);
      return (Math.sin(2 * Math.PI * 1318.5 * t) * 0.35 + Math.sin(2 * Math.PI * 2637 * t) * 0.12 + Math.sin(2 * Math.PI * 1975.5 * t) * 0.1) * e * Math.min(1, t * 400);
    });
    this._sfx.chord = make(0.9, (t) => {
      const e = Math.exp(-t * 4.5) * Math.min(1, t * 300);
      let s = 0;
      for (const f of [196, 246.9, 293.7, 392]) s += Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t);
      return s * 0.09 * e;
    });
    // startup chime: a slow, shimmering major-7 bloom with a bell arpeggio on top
    this._sfx.startup = make(4.2, (t) => {
      let s = 0;
      const pad = [130.8, 196, 246.9, 329.6, 493.9];
      const env = Math.min(1, t / 0.9) * Math.exp(-Math.max(0, t - 1.6) * 1.3);
      for (let k = 0; k < pad.length; k++) {
        const f = pad[k] * (1 + 0.002 * Math.sin(t * (1.3 + k)));
        s += (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(2 * Math.PI * f * 2.003 * t)) * 0.07;
      }
      s *= env;
      const bells = [523.3, 659.3, 784, 987.8, 1318.5];
      for (let k = 0; k < bells.length; k++) {
        const st = 0.35 + k * 0.22;
        if (t < st) continue;
        const u = t - st;
        s += Math.sin(2 * Math.PI * bells[k] * u) * Math.exp(-u * 2.2) * 0.13 + Math.sin(2 * Math.PI * bells[k] * 3.01 * u) * Math.exp(-u * 6) * 0.03;
      }
      return s;
    });
    // level-up chime (arpeggio)
    this._sfx.levelup = make(0.9, (t) => {
      const notes = [0, 4, 7, 12];
      let s = 0;
      for (let k = 0; k < notes.length; k++) {
        const st = k * 0.09;
        if (t < st) continue;
        const f = 660 * Math.pow(2, notes[k] / 12);
        s += Math.sin(2 * Math.PI * f * (t - st)) * Math.exp(-(t - st) * 5) * 0.25;
      }
      return s;
    });
  }

  sfx(name, gain = 1, pan = 0) {
    if (!this.ctx || !this._sfx[name]) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this._sfx[name];
    let node = src;
    if (gain !== 1) {
      const g = this.ctx.createGain();
      g.gain.value = gain;
      node.connect(g);
      node = g;
    }
    if (pan && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      node.connect(p);
      node = p;
    }
    node.connect(this.sfxGain);
    src.start();
  }
}

export const audio = new AudioEngine();
