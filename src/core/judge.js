// Deterministic gameplay judge shared by the real game (human & AI) and the headless AI trainer.
//
// Rules (Rhythia / Sound Space Plus style):
//   * A note becomes hittable once the song time reaches its timestamp (it crosses the grid plane).
//   * It stays hittable for `hitWindow` seconds. If the cursor centre is inside the note's square
//     hitbox at any judgement tick inside that window, the note is HIT.
//   * Otherwise it is a MISS when the window closes.
//   * Several notes can be active at the same time; each is judged independently.

import { DEFAULT_SETTINGS } from './constants.js';

export const NOTE_PENDING = 0;
export const NOTE_HIT = 1;
export const NOTE_MISS = 2;

export class Judge {
  /**
   * @param {{t: Float64Array, x: Float32Array, y: Float32Array, n: number}} packed notes (sorted by t)
   * @param {object} settings  overrides for DEFAULT_SETTINGS
   * @param {object} [opts]
   * @param {boolean} [opts.recordEvents]  keep an `events` array (for rendering / UI)
   */
  constructor(packed, settings = {}, opts = {}) {
    this.notes = packed;
    this.s = { ...DEFAULT_SETTINGS, ...settings };
    this.recordEvents = !!opts.recordEvents;
    this.state = new Uint8Array(packed.n);
    this.hitTime = new Float32Array(packed.n); // time the note was judged
    this.hitDx = new Float32Array(packed.n);   // cursor offset from note at judgement (for accuracy stats / heatmaps)
    this.hitDy = new Float32Array(packed.n);
    this.reset();
  }

  reset() {
    this.state.fill(NOTE_PENDING);
    this.head = 0;             // first note that might still be pending
    this.hits = 0;
    this.misses = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.multiplier = 1;
    this.multProgress = 0;     // hits accumulated toward the next multiplier step
    this.score = 0;
    this.health = this.s.healthMax;
    this.failed = false;
    this.failTime = -1;
    this.missDistSum = 0;      // sum of (distance outside hitbox) at miss time — used as a learning signal
    this.events = [];
    this.lastTime = -Infinity;
  }

  get judged() { return this.hits + this.misses; }
  get accuracy() { return this.judged === 0 ? 1 : this.hits / this.judged; }
  get finished() { return this.head >= this.notes.n; }
  get progress() { return this.notes.n === 0 ? 1 : this.judged / this.notes.n; }

  /** Index of the first note that is still pending (not yet hit or missed), or n. */
  firstPending() {
    return this.head;
  }

  /**
   * Advance judgement to `time` with the cursor at (cx, cy).
   * Returns the number of notes judged during this call.
   */
  update(time, cx, cy) {
    const { t, x, y, n } = this.notes;
    const hw = this.s.hitWindow;
    const half = this.s.hitbox * 0.5;
    const state = this.state;
    let judgedNow = 0;
    this.lastTime = time;

    for (let i = this.head; i < n; i++) {
      const nt = t[i];
      if (nt > time) break; // notes are sorted: nothing further is active yet
      if (state[i] !== NOTE_PENDING) continue;
      const dx = cx - x[i];
      const dy = cy - y[i];
      if (dx <= half && dx >= -half && dy <= half && dy >= -half) {
        this._hit(i, time, dx, dy);
        judgedNow++;
      } else if (time > nt + hw) {
        this._miss(i, nt + hw, dx, dy, half);
        judgedNow++;
      }
    }
    // advance head over judged notes
    let h = this.head;
    while (h < n && state[h] !== NOTE_PENDING) h++;
    this.head = h;
    return judgedNow;
  }

  _hit(i, time, dx, dy) {
    const s = this.s;
    this.state[i] = NOTE_HIT;
    this.hitTime[i] = time;
    this.hitDx[i] = dx;
    this.hitDy[i] = dy;
    this.hits++;
    this.combo++;
    if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    if (this.multiplier < s.maxMultiplier) {
      this.multProgress++;
      if (this.multProgress >= s.hitsPerMultiplier) {
        this.multiplier++;
        this.multProgress = 0;
      }
    }
    this.score += s.scorePerNote * this.multiplier;
    if (!this.failed) this.health = Math.min(s.healthMax, this.health + s.healthHitGain);
    if (this.recordEvents) this.events.push({ type: 'hit', index: i, time });
  }

  _miss(i, time, dx, dy, half) {
    const s = this.s;
    this.state[i] = NOTE_MISS;
    this.hitTime[i] = time;
    this.hitDx[i] = dx;
    this.hitDy[i] = dy;
    this.misses++;
    this.combo = 0;
    this.multiplier = Math.max(1, this.multiplier - 1);
    this.multProgress = 0;
    const ox = Math.max(0, Math.abs(dx) - half);
    const oy = Math.max(0, Math.abs(dy) - half);
    this.missDistSum += Math.min(3, Math.sqrt(ox * ox + oy * oy));
    if (!this.failed) {
      this.health -= s.healthMissDrain;
      if (this.health <= 0) {
        this.health = 0;
        if (!s.noFail) {
          this.failed = true;
          this.failTime = time;
        }
      }
    }
    if (this.recordEvents) this.events.push({ type: 'miss', index: i, time });
  }

  /** Summary object for result screens / history. */
  summary() {
    return {
      hits: this.hits,
      misses: this.misses,
      total: this.notes.n,
      accuracy: this.accuracy,
      score: this.score,
      maxCombo: this.maxCombo,
      failed: this.failed,
      fullCombo: this.misses === 0 && this.hits === this.notes.n,
    };
  }
}
