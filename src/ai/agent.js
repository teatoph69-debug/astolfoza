// МУХА's body: a physically limited "hand" that moves the cursor, driven by a neural network.
//
// The network never teleports the cursor. Every tick it outputs an ACCELERATION (like muscles),
// the hand has a max acceleration and max speed, so the AI must learn to anticipate notes,
// brake in time, cut corners through hitboxes and flow through streams — the same skills a
// human Rhythia player develops.

import { MLP } from './nn.js';
import { Judge, NOTE_PENDING } from '../core/judge.js';
import { DEFAULT_SETTINGS } from '../core/constants.js';

export const SIM_DT = 1 / 120;        // physics / decision tick (seconds)
export const OBS_NOTES = 4;           // how many upcoming notes the AI looks at
export const NOTE_FEATS = 7;
export const OBS_SIZE = 5 + OBS_NOTES * NOTE_FEATS;
export const ACT_SIZE = 2;
export const DEFAULT_ARCH = [OBS_SIZE, 24, 24, ACT_SIZE];
const RESPONSE = 40; // 1/s — how aggressively the hand chases the desired velocity

export const HAND_PRESETS = {
  human: { id: 'human', maxAccel: 260, maxSpeed: 12, ru: 'Человеческая рука', en: 'Human hand' },
  pro: { id: 'pro', maxAccel: 520, maxSpeed: 24, ru: 'Рука топ-игрока', en: 'Pro hand' },
  cyber: { id: 'cyber', maxAccel: 2000, maxSpeed: 60, ru: 'Кибер-рука', en: 'Cyber hand' },
};

export class Brain {
  constructor(arch = DEFAULT_ARCH, params = null) {
    this.arch = arch.slice();
    this.net = new MLP(this.arch);
    if (params) this.net.setParams(params);
  }
  get nParams() { return this.net.nParams; }
  get params() { return this.net.params; }
}

/**
 * The pilot owns the cursor state and turns observations into motion.
 */
export class Pilot {
  constructor(net, hand = HAND_PRESETS.pro, settings = DEFAULT_SETTINGS) {
    this.net = net;          // MLP instance
    this.params = net.params;
    this.hand = hand;
    this.bound = settings.cursorBound ?? DEFAULT_SETTINGS.cursorBound;
    this.obs = new Float32Array(OBS_SIZE);
    this.reset();
  }

  reset(x = 1, y = 1) {
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.ax = 0; this.ay = 0;
    this.effort = 0;
    this.jerk = 0;
    this.ticks = 0;
  }

  /** Fill `this.obs` for the current judge state at `time`. */
  observe(judge, time) {
    const o = this.obs;
    const { t, x, y, n } = judge.notes;
    const state = judge.state;
    o[0] = this.vx / 10;
    o[1] = this.vy / 10;
    o[2] = this.x - 1;
    o[3] = this.y - 1;
    o[4] = 1; // bias-like constant input
    let k = 0;
    let px = this.x, py = this.y, pt = time;
    for (let i = judge.head; i < n && k < OBS_NOTES; i++) {
      if (state[i] !== NOTE_PENDING) continue;
      const dt = t[i] - time;
      const base = 5 + k * NOTE_FEATS;
      const dx = x[i] - this.x, dy = y[i] - this.y;
      o[base] = clampf(dx / 2, -1.6, 1.6);
      o[base + 1] = clampf(dy / 2, -1.6, 1.6);
      o[base + 2] = clampf(dt / 0.4, -0.3, 3);
      o[base + 3] = Math.exp(-Math.max(0, dt) / 0.1);          // urgency
      // step from the previous observed note (pattern shape)
      o[base + 4] = clampf(Math.hypot(x[i] - px, y[i] - py) / 2, 0, 1.6);
      // velocity needed to arrive exactly on time (relative to the hand's top speed)
      const tt = Math.max(t[i] - pt, 0.04);
      o[base + 5] = clampf(((x[i] - px) / tt) / this.hand.maxSpeed, -2, 2);
      o[base + 6] = clampf(((y[i] - py) / tt) / this.hand.maxSpeed, -2, 2);
      px = x[i]; py = y[i]; pt = Math.max(pt, t[i]);
      k++;
    }
    for (; k < OBS_NOTES; k++) {
      const base = 5 + k * NOTE_FEATS;
      o[base] = 0; o[base + 1] = 0; o[base + 2] = 3; o[base + 3] = 0; o[base + 4] = 0; o[base + 5] = 0; o[base + 6] = 0;
    }
    return o;
  }

  /** One physics tick: observe → think → accelerate → move. */
  step(judge, time, dt = SIM_DT) {
    const out = this.net.forward(this.observe(judge, time), this.params);
    const h = this.hand;
    // The network chooses a desired velocity; "muscles" accelerate toward it, limited by maxAccel.
    const tvx = out[0] * h.maxSpeed;
    const tvy = out[1] * h.maxSpeed;
    let ax = (tvx - this.vx) * RESPONSE;
    let ay = (tvy - this.vy) * RESPONSE;
    const am = Math.hypot(ax, ay);
    if (am > h.maxAccel) { ax *= h.maxAccel / am; ay *= h.maxAccel / am; }
    this.jerk += Math.abs(out[0] - this.ax) + Math.abs(out[1] - this.ay);
    this.effort += (ax * ax + ay * ay) / (h.maxAccel * h.maxAccel);
    this.ax = out[0]; this.ay = out[1];
    let vx = this.vx + ax * dt;
    let vy = this.vy + ay * dt;
    const sp = Math.hypot(vx, vy);
    if (sp > h.maxSpeed) { vx *= h.maxSpeed / sp; vy *= h.maxSpeed / sp; }
    let nx = this.x + vx * dt;
    let ny = this.y + vy * dt;
    const lo = -this.bound, hi = 2 + this.bound;
    if (nx < lo) { nx = lo; vx = 0; } else if (nx > hi) { nx = hi; vx = 0; }
    if (ny < lo) { ny = lo; vy = 0; } else if (ny > hi) { ny = hi; vy = 0; }
    this.x = nx; this.y = ny; this.vx = vx; this.vy = vy;
    this.ticks++;
  }
}

function clampf(v, a, b) { return v < a ? a : v > b ? b : v; }

/**
 * Run a full headless episode. Returns stats + a scalar fitness used by the trainer.
 * @param {MLP} net  network whose params are used (params may be overridden)
 * @param {{t,x,y,n}} packed notes
 */
export function runEpisode(net, packed, { params = null, hand = HAND_PRESETS.pro, settings = null, dt = SIM_DT, record = false } = {}) {
  const s = settings ? { ...DEFAULT_SETTINGS, ...settings, noFail: true } : EPISODE_SETTINGS;
  const judge = new Judge(packed, s);
  const pilot = new Pilot(net, hand, s);
  if (params) pilot.params = params;
  const start = packed.n ? packed.t[0] - 1.0 : 0;
  const end = packed.n ? packed.t[packed.n - 1] + s.hitWindow + dt : 0;
  pilot.reset(1, 1);
  const path = record ? [] : null;
  let time = start;
  while (time <= end && !judge.finished) {
    pilot.step(judge, time, dt);
    time += dt;
    judge.update(time, pilot.x, pilot.y);
    if (path) path.push(pilot.x, pilot.y);
  }
  const n = Math.max(1, packed.n);
  const ticks = Math.max(1, pilot.ticks);
  const acc = judge.hits / n;
  const fitness = acc - 0.12 * (judge.missDistSum / n) - 0.015 * (pilot.effort / ticks) - 0.03 * (pilot.jerk / ticks);
  return { hits: judge.hits, misses: judge.misses, n: packed.n, acc, fitness, path, judge };
}

const EPISODE_SETTINGS = { ...DEFAULT_SETTINGS, noFail: true };
