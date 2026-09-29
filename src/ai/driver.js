// Real-time driver for МУХА: runs the pilot at the fixed simulation tick (exactly like training)
// while the game renders at any frame rate. Positions are interpolated between ticks for smooth
// visuals, but judgement always happens on the fixed ticks — so the AI plays identically to how
// it was evaluated during training.

import { MLP } from './nn.js';
import { Pilot, SIM_DT, HAND_PRESETS } from './agent.js';

export class AIDriver {
  /**
   * @param {{arch:number[], params:Float32Array, hand?:object}} brain
   * @param {import('../core/judge.js').Judge} judge  judge dedicated to the AI
   * @param {object} settings  gameplay settings (cursorBound…)
   */
  constructor(brain, judge, settings = {}) {
    this.net = new MLP(brain.arch);
    this.net.setParams(Float32Array.from(brain.params));
    this.hand = brain.hand || HAND_PRESETS.pro;
    this.judge = judge;
    this.pilot = new Pilot(this.net, this.hand, settings);
    this.simTime = null;
    this.prevX = 1; this.prevY = 1;
    this.x = 1; this.y = 1;
    this.speed = 1; // for time-scaled replays (visual only; ticks stay SIM_DT in song time)
  }

  /** Reset to the centre, starting the simulation at song time `t`. */
  reset(t) {
    this.pilot.reset(1, 1);
    this.simTime = t;
    this.prevX = this.x = 1;
    this.prevY = this.y = 1;
  }

  /** Advance the simulation up to song time `time` (handles big jumps gracefully). */
  advanceTo(time) {
    if (this.simTime == null) this.reset(time);
    if (time - this.simTime > 2) {
      // e.g. tab was hidden: fast-forward without rendering (still fair: same fixed ticks)
      while (this.simTime + SIM_DT <= time - 0.1) this._tick();
    }
    while (this.simTime + SIM_DT <= time) this._tick();
    // interpolation factor between the last two ticks
    const a = Math.max(0, Math.min(1, (time - this.simTime) / SIM_DT));
    this.x = this.prevX + (this.pilot.x - this.prevX) * a;
    this.y = this.prevY + (this.pilot.y - this.prevY) * a;
  }

  _tick() {
    this.prevX = this.pilot.x;
    this.prevY = this.pilot.y;
    this.pilot.step(this.judge, this.simTime, SIM_DT);
    this.simTime += SIM_DT;
    this.judge.update(this.simTime, this.pilot.x, this.pilot.y);
  }

  /** Latest network activations (for the neural-net visualisation). */
  get activations() { return this.net.acts; }
}
