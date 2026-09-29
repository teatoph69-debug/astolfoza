// Brain manager: which neural networks can play.
//   * 'live'        — YOUR МУХА, trained in the AI Lab (persisted in IndexedDB, survives reloads)
//   * 'pre:<id>'    — pretrained checkpoints shipped with the game (trained with tools/train.mjs)
//   * 'file:<id>'   — brains imported from a .json file

import PRETRAINED from '../../assets/brains.json';
import { base64ToParams } from './nn.js';
import { HAND_PRESETS, DEFAULT_ARCH } from './agent.js';
import { titleFor } from './trainer.js';
import { idb, local } from '../ui/store.js';
import { Emitter } from '../ui/dom.js';

export class BrainManager extends Emitter {
  constructor() {
    super();
    this.live = null;          // serialized TrainingSession (see trainer.js serialize())
    this.imported = [];        // [{ id, name, arch, params(base64), hand, skill }]
    this.selected = local.get('brain.selected', null);
  }

  async init() {
    this.live = (await idb.get('brains', 'live')) || null;
    this.imported = (await idb.get('brains', 'imported')) || [];
    if (!this.selected || !this._exists(this.selected)) this.selected = this.defaultId();
    this.emit('change');
  }

  _exists(id) { return this.list().some((b) => b.id === id); }

  /** All brains, strongest pretrained last. */
  list() {
    const out = [];
    if (this.live) {
      const skill = Math.max(0, this.live.bestSkill ?? this.live.skill ?? 0);
      out.push({ id: 'live', kind: 'live', name: 'Твоя МУХА', en: 'Your МУХА', skill, title: titleFor(skill), hand: this.live.hand, gen: this.live.gen });
    }
    for (const p of PRETRAINED) {
      out.push({ id: 'pre:' + p.id, kind: 'pretrained', name: p.name, en: p.en || p.name, skill: p.skill, title: titleFor(p.skill), hand: p.hand, gen: p.gen });
    }
    for (const b of this.imported) {
      out.push({ id: 'file:' + b.id, kind: 'imported', name: b.name, en: b.name, skill: b.skill || 0, title: titleFor(b.skill || 0), hand: b.hand, gen: b.gen });
    }
    return out;
  }

  /** The strongest pretrained brain, else live. */
  defaultId() {
    const pre = PRETRAINED.slice().sort((a, b) => b.skill - a.skill)[0];
    if (pre) return 'pre:' + pre.id;
    return this.live ? 'live' : null;
  }

  select(id) {
    this.selected = id;
    local.set('brain.selected', id);
    this.emit('change');
  }

  /** Resolve a brain id into something playable: { id, name, arch, params: Float32Array, hand, skill } */
  get(id = this.selected) {
    if (!id) id = this.defaultId();
    if (id === 'live' && this.live) {
      const params = Float32Array.from(this.live.champion || this.live.theta);
      return { id, name: 'Твоя МУХА', arch: this.live.arch, params, hand: HAND_PRESETS[this.live.hand] || HAND_PRESETS.pro, skill: Math.max(0, this.live.bestSkill ?? 0) };
    }
    if (id && id.startsWith('pre:')) {
      const p = PRETRAINED.find((b) => 'pre:' + b.id === id);
      if (p) return { id, name: p.name, arch: p.arch, params: base64ToParams(p.params), hand: HAND_PRESETS[p.hand] || HAND_PRESETS.pro, skill: p.skill };
    }
    if (id && id.startsWith('file:')) {
      const b = this.imported.find((x) => 'file:' + x.id === id);
      if (b) return { id, name: b.name, arch: b.arch, params: base64ToParams(b.params), hand: HAND_PRESETS[b.hand] || HAND_PRESETS.pro, skill: b.skill || 0 };
    }
    // fallback: first available
    const first = this.list()[0];
    if (first && first.id !== id) return this.get(first.id);
    return null;
  }

  /** Store the live training session (called by the AI Lab). */
  async saveLive(serialized) {
    this.live = serialized;
    await idb.set('brains', 'live', serialized);
    this.emit('change');
  }

  async resetLive() {
    this.live = null;
    await idb.del('brains', 'live');
    if (this.selected === 'live') this.select(this.defaultId());
    this.emit('change');
  }

  async addImported(brain) {
    this.imported = this.imported.filter((b) => b.id !== brain.id).concat([brain]);
    await idb.set('brains', 'imported', this.imported);
    this.emit('change');
  }

  static pretrainedRaw() { return PRETRAINED; }
  static defaultArch() { return DEFAULT_ARCH; }
}
