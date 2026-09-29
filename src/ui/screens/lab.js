// МУХА: Лаборатория — the neural network trains live in the browser and you watch her evolve.
//
//  * LabController (module-level singleton, survives screen changes): owns the TrainingSession,
//    the worker pool, the training loop, autosave, brain snapshots for «Эволюция», the diary,
//    celebrations and the tray status. It can keep training while the player browses other
//    programs («Учиться в фоне») and always pauses during gameplay.
//  * LabScreen (the client area of the Win98 window «МУХА: Лаборатория»): live arena (the current
//    brain plays a fresh chart in real time, 1×/2×/4×), rank / training / stats group boxes and a
//    tab control with charts, the exam, the live neural net, the evolution race and an explainer.
//
// Integrators: `getLabController(app)` gives the singleton (e.g. for a "training…" indicator).

import { Screen } from '../app.js';
import { h, clear, Emitter } from '../dom.js';
import { tr, getLang, fmtNum, plural } from '../i18n.js';
import { local, downloadFile, pickFiles } from '../store.js';
import { button98, checkbox98, radio98, progress98, listview98 } from '../win98.js';
import { icon } from '../icons.js';
import { TrainingSession, titleFor, TITLES, PASS_ACC } from '../../ai/trainer.js';
import { HAND_PRESETS } from '../../ai/agent.js';
import { paramsToBase64, base64ToParams } from '../../ai/nn.js';
import { AIDriver } from '../../ai/driver.js';
import { TrainerPool, SPEEDS, DEFAULT_SPEED, hardwareThreads, trainGeneration } from '../../ai/pool.js';
import { Judge } from '../../core/judge.js';
import { DEFAULT_SETTINGS } from '../../core/constants.js';
import { packNotes, mapDuration } from '../../core/map.js';
import { syntheticMap } from '../../maps/patterns.js';
import { Playfield } from '../../render/playfield.js';
import { LineChart, BarChart, THEMES, tableView } from '../charts.js';
import { NNViz } from '../nnviz.js';

const BENCH_EVERY = 5;           // skill exam every N generations (runs on the workers)
const AUTOSAVE_EVERY = 10;       // generations …
const AUTOSAVE_MS = 15000;       // … and at most this often
const SNAP_MAX = 12;             // brain snapshots kept for «Эволюция»
const SNAP_EVERY = 50;
const JOURNAL_MAX = 40;
const CUSTOM_WEIGHT = 0.35;      // share of episodes drawn from the player's maps
const ARENA_DUR = 20;            // seconds of chart per arena run
const ARENA_LEAD = 1.2;
const RESULT_MS = 1900;
const AI_COLOR = '#b6ff3b';      // МУХА's colour everywhere in the game
const JUDGE_SETTINGS = { ...DEFAULT_SETTINGS, noFail: true };
const TM = THEMES.taskmgr.series; // [#00ff00, #ffff00, #00ffff, #ff00ff]

const randomSeed = () => ((Math.random() * 2 ** 30) | 0) || 1;
const fmtStars = (v) => (Math.round(v * 10) / 10).toFixed(v % 1 ? 1 : 0);
const pct = (v, d = 1) => (v * 100).toFixed(d) + '%';
const sfx = (app, name, gain = 1) => { try { app.audio.sfx(name, gain); } catch { /* audio locked */ } };
const titleName = (t) => (t ? (getLang() === 'en' ? t.en : t.ru) : '');
const threads = (n) => tr(`${n} ${plural(n, 'поток', 'потока', 'потоков')}`, `${n} thread${n === 1 ? '' : 's'}`);

// =================================================================================================
// Sessions <-> JSON
// =================================================================================================

function newSession(handId) {
  const hand = HAND_PRESETS[handId] || HAND_PRESETS.pro;
  return new TrainingSession({ hand, seed: randomSeed(), benchEvery: BENCH_EVERY });
}

/** Build a session (+ evolution snapshots) from a saved/loaded object. Throws on bad data. */
export function sessionFromData(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.arch)) {
    throw new Error(tr('это не мозг МУХИ (нет архитектуры сети)', 'not a МУХА brain (no network architecture)'));
  }
  const opts = { seed: randomSeed(), benchEvery: BENCH_EVERY };
  let session;
  if (Array.isArray(data.theta)) {
    session = TrainingSession.deserialize(data, opts);
  } else if (typeof data.params === 'string') {
    // a single exported brain { arch, params (base64), hand, skill, gen }
    const params = base64ToParams(data.params);
    session = new TrainingSession({ ...opts, arch: data.arch, hand: HAND_PRESETS[data.hand] || HAND_PRESETS.pro, params });
    session.gen = data.gen || 0;
    session.skill = session.bestSkill = Math.max(0, data.skill || 0);
    session.curriculum.level = Math.max(0.5, Math.floor(Math.max(0, session.skill - 1) * 2) / 2);
  } else {
    throw new Error(tr('в файле нет весов сети', 'the file has no network weights'));
  }
  const n = session.es.n;
  const snapshots = (Array.isArray(data.snapshots) ? data.snapshots : [])
    .map((s) => { try { return { gen: s.gen | 0, skill: +s.skill || 0, params: base64ToParams(s.params) }; } catch { return null; } })
    .filter((s) => s && s.params.length === n);
  return { session, snapshots };
}

function buildJournal(session) {
  const out = [];
  let prevLevel = null, prevTitle = 0;
  for (const r of session.history || []) {
    if (prevLevel != null && r.level > prevLevel + 1e-9) out.push({ gen: r.gen, kind: 'level', from: prevLevel, to: r.level });
    prevLevel = r.level;
    const ti = titleFor(Math.max(0, r.bestSkill ?? 0)).index;
    if (ti > prevTitle) { out.push({ gen: r.gen, kind: 'rank', title: ti, skill: r.bestSkill }); prevTitle = ti; }
  }
  return out.reverse().slice(0, JOURNAL_MAX);
}

/** Keep the snapshot list short but telling: drop the one whose neighbours are closest. */
function thinSnapshots(snaps) {
  let bi = 1, bs = Infinity;
  for (let i = 1; i < snaps.length - 1; i++) {
    const s = (snaps[i + 1].skill - snaps[i - 1].skill) + 0.004 * (snaps[i + 1].gen - snaps[i - 1].gen);
    if (s < bs) { bs = s; bi = i; }
  }
  snaps.splice(bi, 1);
}

// =================================================================================================
// Controller (singleton)
// =================================================================================================

let controller = null;
/** The Lab's training controller (created on first use). */
export function getLabController(app) {
  if (!controller) controller = new LabController(app);
  return controller;
}

export class LabController extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    this.session = null;
    this.pool = null;
    this.running = false;
    this.autoPaused = false;
    this.background = !!local.get('lab.background', false);
    const sp = local.get('lab.speed', DEFAULT_SPEED);
    this.speed = SPEEDS[sp] ? sp : DEFAULT_SPEED;
    this.useMyMaps = !!local.get('lab.myMaps', false);
    this.snapshots = [];
    this.journal = [];
    this.genStamps = [];
    this.lastGenMs = 0;
    this.customCount = 0;
    this._loopP = null;
    this._saveChain = Promise.resolve();
    this._saved = { session: null, gen: -1, at: 0 };
    this._lastLevelToast = 0;
    this._trayAt = 0;
    app.on('screen', (name) => this._onScreen(name));
    if (app.library && typeof app.library.on === 'function') {
      app.library.on('change', () => { if (this.useMyMaps && this.session) { this._applyCustomMaps(); this.emit('state'); } });
    }
    app.on('shutdown', () => { this.running = false; this.save({ force: true }); });
  }

  get hand() { return this.session ? this.session.hand : HAND_PRESETS[this.app.settings.aiHand] || HAND_PRESETS.pro; }
  get workers() { return this.pool ? this.pool.size : 0; }
  get poolMode() { return this.pool ? this.pool.mode : 'idle'; }
  /** Worker count the current speed preset asks for. */
  get targetWorkers() { return SPEEDS[this.speed].workers(hardwareThreads()); }

  ensureSession() {
    if (this.session) return this.session;
    const live = this.app.brains && this.app.brains.live;
    let res = null;
    if (live) {
      try { res = sessionFromData(live); } catch (e) { console.warn('[МУХА] live brain unreadable, starting fresh', e); }
    }
    if (res) this._adopt(res.session, res.snapshots, false);
    else this._adopt(newSession(this.app.settings.aiHand), [], true);
    return this.session;
  }

  _adopt(session, snapshots = [], fresh = false) {
    this.session = session;
    this.snapshots = snapshots.slice().sort((a, b) => a.gen - b.gen);
    this.genStamps = [];
    this._prevTitle = titleFor(Math.max(0, session.bestSkill)).index;
    this._prevLevel = session.curriculum.level;
    this.journal = buildJournal(session);
    if (fresh) this.journal.unshift({ gen: 0, kind: 'birth', hand: session.hand.id });
    if (this.pool) { this.pool.arch = session.arch; this.pool.hand = session.hand; }
    this._applyCustomMaps();
    this.emit('session', session);
    this.emit('journal');
  }

  async ensurePool() {
    if (!this.pool) {
      const sp = SPEEDS[this.speed];
      this.pool = new TrainerPool({ size: sp.workers(hardwareThreads()), sliceMs: sp.sliceMs });
      this.pool.onstatus = () => this.emit('state');
      if (this.session) { this.pool.arch = this.session.arch; this.pool.hand = this.session.hand; }
      this._applyCustomMaps();
    }
    await this.pool.ready();
    return this.pool;
  }

  /** Register the player's imported maps as training material (or remove them). */
  _applyCustomMaps() {
    const s = this.session;
    if (!s) return 0;
    const cur = s.curriculum;
    if (!this.useMyMaps) {
      cur.customKeys = [];
      cur.customWeight = 0;
      this.customCount = 0;
      return 0;
    }
    const keys = [];
    for (const set of (this.app.library && this.app.library.sets) || []) {
      if (!set || set.source === 'builtin') continue;
      (set.maps || []).forEach((m, i) => {
        if (!m || !Array.isArray(m.notes) || m.notes.length < 8) return;
        const key = 'user:' + (m.id || `${set.id}:${i}`);
        if (this.pool && !this.pool.maps.has(key)) this.pool.registerMap(key, packNotes(m.notes));
        const last = m.notes[m.notes.length - 1].t;
        keys.push({ key, duration: Math.min(mapDuration(m), last + 1) });
      });
    }
    // keys only go live once the pool (and so every worker) knows the maps
    cur.customKeys = this.pool ? keys : [];
    cur.customWeight = keys.length ? CUSTOM_WEIGHT : 0;
    this.customCount = keys.length;
    return keys.length;
  }

  // ---- training loop ---------------------------------------------------------------------------

  start() {
    if (this.running) return;
    this.ensureSession();
    this.running = true;
    this.autoPaused = false;
    this.genStamps = [];
    this._tray(true);
    this.emit('state');
    if (!this._loopP) this._loopP = this._loop().finally(() => { this._loopP = null; this.emit('state'); });
  }

  pause() {
    if (!this.running) return;
    this.running = false;
    this._tray(false);
    this.emit('state');
    this.save();
  }

  toggle() { if (this.running) this.pause(); else this.start(); }

  /** Resolves when no generation is in flight. */
  idle() { return this._loopP || Promise.resolve(); }

  async _loop() {
    try {
      await this.ensurePool();
    } catch (e) {
      console.error(e);
      this.running = false;
      return;
    }
    while (this.running) {
      const session = this.session;
      const pool = this.pool;
      const t0 = performance.now();
      let rec;
      try {
        rec = await trainGeneration(session,
          (c, e) => pool.evaluate(c, e, { arch: session.arch, hand: session.hand }),
          (arch, params, hand) => pool.benchmark(arch, params, hand),
          { benchEvery: BENCH_EVERY });
      } catch (err) {
        console.error(err);
        this.running = false;
        this._tray(false);
        this.app.toast(tr('Обучение остановлено: ', 'Training stopped: ') + ((err && err.message) || err), 'error', 6000);
        break;
      }
      if (session !== this.session) continue; // brain was reset / replaced meanwhile
      this.lastGenMs = performance.now() - t0;
      this._afterGen(rec);
    }
    await this.save();
  }

  _afterGen(rec) {
    const s = this.session;
    const now = performance.now();
    this.genStamps.push(now);
    while (this.genStamps.length > 3 && now - this.genStamps[0] > 60000) this.genStamps.shift();
    const info = { rankUp: null, levelUp: false, from: this._prevLevel, to: s.curriculum.level };
    if (s.curriculum.level > this._prevLevel + 1e-9) {
      info.levelUp = true;
      this._journal({ gen: rec.gen, kind: 'level', from: this._prevLevel, to: s.curriculum.level });
    }
    this._prevLevel = s.curriculum.level;
    const ti = titleFor(Math.max(0, s.bestSkill));
    if (ti.index > this._prevTitle) {
      info.rankUp = ti;
      this._journal({ gen: rec.gen, kind: 'rank', title: ti.index, skill: s.bestSkill });
      this._prevTitle = ti.index;
    }
    if (rec.gen === 1 || info.rankUp || info.levelUp || rec.gen % SNAP_EVERY === 0) this._snapshot(rec.gen);

    // celebrations — global, so they also show up in other programs while training in the background
    if (info.rankUp) {
      this.app.toast(tr(`МУХА стала «${ti.ru}»! ${ti.emoji}`, `МУХА became «${ti.en}»! ${ti.emoji}`), 'level', 5200);
      sfx(this.app, 'levelup', 0.9);
    } else if (info.levelUp && now - this._lastLevelToast > 5000) {
      this._lastLevelToast = now;
      this.app.toast(tr(`Карты стали сложнее: теперь ★${fmtStars(info.to)}`, `Harder maps: now ★${fmtStars(info.to)}`), 'info', 2600);
      sfx(this.app, 'levelup', 0.3);
    }
    if (now - this._trayAt > 1000) this._tray(true);
    this.emit('gen', rec, info);
    if (rec.gen - this._saved.gen >= AUTOSAVE_EVERY && now - this._saved.at > AUTOSAVE_MS) this.save();
  }

  _tray(training) {
    this._trayAt = performance.now();
    if (typeof this.app.setTrayStatus !== 'function') return;
    const s = this.session;
    const text = training && s
      ? tr(`МУХА учится · пок. ${fmtNum(s.gen)} · ★${Math.max(0, s.bestSkill).toFixed(1)}`, `МУХА is learning · gen ${fmtNum(s.gen)} · ★${Math.max(0, s.bestSkill).toFixed(1)}`)
      : 'МУХА';
    try { this.app.setTrayStatus({ training: !!training, text }); } catch { /* optional */ }
  }

  _snapshot(gen) {
    const s = this.session;
    const last = this.snapshots[this.snapshots.length - 1];
    if (last && last.gen === gen) return;
    this.snapshots.push({ gen, skill: Math.max(0, s.skill), params: Float32Array.from(s.es.theta) });
    while (this.snapshots.length > SNAP_MAX) thinSnapshots(this.snapshots);
  }

  _journal(e) {
    this.journal.unshift(e);
    if (this.journal.length > JOURNAL_MAX) this.journal.length = JOURNAL_MAX;
    this.emit('journal');
  }

  /** Generations per minute over the last minute of training (0 when unknown). */
  genRate() {
    const st = this.genStamps;
    if (st.length < 2) return 0;
    return ((st.length - 1) / (st[st.length - 1] - st[0])) * 60000;
  }

  // ---- persistence -----------------------------------------------------------------------------

  /** Session JSON (+ evolution snapshots). `compact` keeps only milestone history rows. */
  serialize({ compact = false } = {}) {
    const data = this.session.serialize();
    data.kind = 'muxa-brain';
    data.snapshots = this.snapshots.map((s) => ({ gen: s.gen, skill: s.skill, params: paramsToBase64(Float32Array.from(s.params)) }));
    if (compact) data.history = data.history.filter((r) => r.bench || r.leveledUp);
    return data;
  }

  /** Save the live brain (IndexedDB via app.brains). Brains that never trained are not saved. */
  save({ force = false } = {}) {
    const s = this.session;
    if (!s || !this.app.brains || (!force && s.gen === 0)) return this._saveChain;
    if (!force && this._saved.session === s && this._saved.gen === s.gen) return this._saveChain;
    const data = this.serialize();
    this._saved = { session: s, gen: s.gen, at: performance.now() };
    this._saveChain = this._saveChain.then(() => this.app.brains.saveLive(data)).catch((e) => console.warn('[МУХА] save failed', e));
    return this._saveChain;
  }

  async reset(handId = this.app.settings.aiHand) {
    const wasRunning = this.running;
    this.running = false;
    this.emit('state');
    await this.idle();
    if (HAND_PRESETS[handId] && handId !== this.app.settings.aiHand) {
      this.app.settings.aiHand = handId;
      if (typeof this.app.saveSettings === 'function') this.app.saveSettings();
    }
    if (this.app.brains) await this.app.brains.resetLive();
    this._adopt(newSession(handId), [], true);
    this._saved = { session: null, gen: -1, at: 0 };
    this._tray(false);
    this.emit('state');
    if (wasRunning) this.start();
  }

  async load(data) {
    const { session, snapshots } = sessionFromData(data); // throws before touching anything
    const wasRunning = this.running;
    this.running = false;
    this.emit('state');
    await this.idle();
    this._adopt(session, snapshots, false);
    this._journal({ gen: session.gen, kind: 'load' });
    this._saved = { session: null, gen: -1, at: 0 };
    await this.save({ force: true });
    this.emit('state');
    if (wasRunning) this.start();
    return session;
  }

  // ---- settings --------------------------------------------------------------------------------

  setSpeed(id) {
    if (!SPEEDS[id]) return;
    this.speed = id;
    local.set('lab.speed', id);
    if (this.pool) {
      this.pool.sliceMs = SPEEDS[id].sliceMs;
      this.pool.setSize(SPEEDS[id].workers(hardwareThreads()));
    }
    this.emit('state');
  }

  setBackground(on) {
    this.background = !!on;
    local.set('lab.background', this.background);
    this.emit('state');
  }

  async setUseMyMaps(on) {
    this.useMyMaps = !!on;
    local.set('lab.myMaps', this.useMyMaps);
    this.ensureSession();
    if (this.useMyMaps) await this.ensurePool();
    const n = this._applyCustomMaps();
    this.emit('state');
    return n;
  }

  _onScreen(name) {
    if (name === 'game') {
      if (this.running) { this.autoPaused = true; this.pause(); }
      return;
    }
    if (this.autoPaused) {
      this.autoPaused = false;
      if (this.background || name === 'lab') this.start();
    }
  }
}

// =================================================================================================
// Arena: the current brain (or every snapshot, in «Эволюция») plays a fresh chart
// =================================================================================================

function evoColor(k) {
  // old → dim red, new → bright lime
  const hue = (350 + 95 * k) % 360;
  return `hsl(${hue.toFixed(0)}, ${(62 + 38 * k).toFixed(0)}%, ${(50 + 12 * k).toFixed(0)}%)`;
}

class Arena {
  /**
   * @param {LabScreen} screen
   * @param {'train'|'evolution'} mode
   */
  constructor(screen, mode = 'train') {
    this.screen = screen;
    this.app = screen.app;
    this.ctrl = screen.ctrl;
    this.mode = mode;
    const sp = +local.get('lab.arenaSpeed', 1);
    this.speed = [1, 2, 4].includes(sp) ? sp : 1;
    this.run = null;
    this.onStart = null;          // (run) => void
    this.hud = {};
    this._buildDom();
    this.pf = new Playfield(this.canvas, { ...this.app.settings, cursorTrail: true });
  }

  _buildDom() {
    const u = this.ui = {};
    this.canvas = h('canvas.lab-pf', { 'aria-label': tr('МУХА играет тренировочную карту', 'МУХА playing a training chart') });
    u.gen = h('span.lcd.lab-lcd-sm', '');
    u.level = h('span.lcd.lab-lcd-sm', '');
    u.acc = h('div.lcd.lab-lcd-big', '--.-%');
    u.combo = h('div.lcd.lab-lcd-sm', '');
    u.prog = h('div.lab-lcd-prog-fill');
    u.queue = h('div.tooltip98.lab-queue', '');
    u.hint = h('div.tooltip98.lab-hint', '');
    u.resultBody = h('div.lab-result-body');
    u.resultTitle = h('div.win-title-text', '');
    u.result = h('div.win.lab-result', h('div.win-title', u.resultTitle), u.resultBody);
    u.speed = h('div.lab-arena-speed', { role: 'group', 'aria-label': tr('Скорость показа', 'Replay speed') },
      [1, 2, 4].map((v) => h('button.btn.btn-sm', { type: 'button', dataset: { v }, title: tr(`Показ ×${v}`, `Replay ×${v}`), onclick: () => this.setSpeed(v) }, v + '×')));
    this.root = h('div.lab-arena.sunken.black',
      this.canvas,
      h('div.lab-arena-tl', u.gen, u.level),
      h('div.lab-arena-tr', u.acc, u.combo),
      u.queue, u.hint, u.result,
      h('div.lab-arena-bottom', h('div.lab-lcd-prog', u.prog), u.speed));
    this._syncSpeed();
  }

  setSettings(s) { this.pf.setSettings({ ...s, cursorTrail: true }); }

  setSpeed(v) {
    this.speed = v;
    local.set('lab.arenaSpeed', v);
    this._syncSpeed();
  }

  _syncSpeed() {
    for (const b of this.ui.speed.children) {
      const on = +b.dataset.v === this.speed;
      b.classList.toggle('pressed', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  resize() { this.pf.resize(); }

  restart() { this.run = null; }

  startRun() {
    const s = this.ctrl.session;
    if (!s) return null;
    const level = Math.max(0, s.curriculum.level);
    const seed = randomSeed();
    let packed = packNotes(syntheticMap(level, seed, ARENA_DUR));
    if (!packed.n) packed = packNotes(syntheticMap(1, seed, ARENA_DUR));
    const racers = this.mode === 'evolution' ? this._evolutionRacers(s) : [{ gen: s.gen, skill: s.skill, label: 'МУХА', color: AI_COLOR, params: s.es.theta, main: true }];
    const simStart = packed.t[0] - 1.0;
    for (const r of racers) {
      r.judge = new Judge(packed, JUDGE_SETTINGS, { recordEvents: true });
      r.driver = new AIDriver({ arch: s.arch, params: r.params, hand: s.hand }, r.judge, JUDGE_SETTINGS);
      r.driver.reset(simStart);
      r.params = null; // the driver keeps its own copy
    }
    const main = racers.find((r) => r.main) || racers[racers.length - 1];
    this.run = {
      packed, level, seed, racers, main, gen: s.gen, arch: s.arch, mode: this.mode,
      t: packed.t[0] - ARENA_LEAD, simStart, tEnd: packed.t[packed.n - 1] + 0.7,
      phase: 'play', resultAt: 0, maxCombo: 0,
    };
    const u = this.ui;
    u.result.classList.remove('show');
    u.level.textContent = `★${fmtStars(level)}`;
    u.gen.textContent = this.mode === 'evolution' ? tr(`${racers.length} ВЕРСИЙ`, `${racers.length} VERSIONS`) : tr(`ПОК ${s.gen}`, `GEN ${s.gen}`);
    this.hud = {};
    if (this.onStart) this.onStart(this.run);
    return this.run;
  }

  _evolutionRacers(s) {
    const snaps = this.ctrl.snapshots.slice();
    if (!snaps.length || snaps[snaps.length - 1].gen < s.gen) snaps.push({ gen: s.gen, skill: s.skill, params: s.es.theta, now: true });
    const n = snaps.length;
    return snaps.map((sn, i) => {
      const k = n > 1 ? i / (n - 1) : 1;
      return {
        gen: sn.gen, skill: sn.skill, now: !!sn.now,
        label: tr(`пок. ${sn.gen}`, `gen ${sn.gen}`),
        color: i === n - 1 ? AI_COLOR : evoColor(k * 0.85),
        params: sn.params, main: i === n - 1,
      };
    });
  }

  /** Advance the run by `realDt` seconds (× replay speed); draw the playfield + HUD when `draw`. */
  frame(realDt, draw = true) {
    let run = this.run;
    if (!run || run.phase === 'done') run = this.startRun();
    if (!run) return;
    const events = [];
    if (run.phase === 'play') {
      run.t += realDt * this.speed;
      if (run.t >= run.simStart) {
        for (const r of run.racers) {
          r.driver.advanceTo(run.t);
          const evs = r.judge.events;
          if (!evs.length) continue;
          if (r === run.main) {
            for (const ev of evs) events.push(ev.type === 'miss' ? { ...ev, shake: false } : ev);
          } else {
            for (const ev of evs) if (ev.type === 'hit') events.push({ type: 'hit', index: ev.index, time: ev.time, color: r.color, silentFlash: true });
          }
          evs.length = 0;
        }
        run.maxCombo = Math.max(run.maxCombo, run.main.judge.combo);
      }
      if (run.t > run.tEnd) {
        run.phase = 'result';
        run.resultAt = performance.now();
        this._showResult(run);
      }
    } else if (run.phase === 'result') {
      run.t += realDt * this.speed;
      if (performance.now() - run.resultAt > RESULT_MS) run.phase = 'done';
    }
    if (!draw) return;
    const cursors = run.racers.map((r) => ({
      x: r.driver.x, y: r.driver.y, color: r.color, label: run.mode === 'evolution' ? r.label : 'МУХА',
      trail: true, main: r === run.main, fly: r === run.main, ghost: r !== run.main,
    }));
    const mainIdx = cursors.findIndex((c) => c.main); // newest brain on top
    if (mainIdx >= 0 && mainIdx !== cursors.length - 1) cursors.push(cursors.splice(mainIdx, 1)[0]);
    this.pf.draw({
      time: run.t, realDt, notes: run.packed, state: run.main.judge.state, cursors, events,
      energy: this._energy(run),
      links: run.mode === 'train' && run.phase === 'play' ? this._visionLinks(run) : null,
    });
    this._hud(run);
  }

  _hud(run) {
    const u = this.ui, hud = this.hud;
    const j = run.main.judge;
    const judged = j.hits + j.misses;
    const acc = judged ? pct(j.hits / judged) : '--.-%';
    if (hud.acc !== acc) { u.acc.textContent = acc; hud.acc = acc; }
    const combo = j.combo >= 2 ? `×${j.combo}` : tr('ТОЧНОСТЬ', 'ACCURACY');
    if (hud.combo !== combo) { u.combo.textContent = combo; hud.combo = combo; }
    const pw = ((run.packed.n ? judged / run.packed.n : 0) * 100).toFixed(1) + '%';
    if (hud.prog !== pw) { u.prog.style.width = pw; hud.prog = pw; }
    const s = this.ctrl.session;
    const ahead = s ? s.gen - run.gen : 0;
    const q = run.mode === 'train' && ahead > 0
      ? tr(`▲ ещё ${ahead} ${plural(ahead, 'поколение', 'поколения', 'поколений')} — новый мозг в следующем забеге`, `▲ ${ahead} more generation${ahead === 1 ? '' : 's'} — new brain next run`)
      : '';
    if (hud.q !== q) { u.queue.textContent = q; u.queue.classList.toggle('show', !!q); hud.q = q; }
    const hint = run.mode === 'train' && s && s.gen === 0 && !this.ctrl.running
      ? tr('Это новорождённая МУХА: её мозг — случайный шум, поэтому она мечется. Нажми «Обучать» и смотри, как она учится.', 'This is a newborn МУХА: her brain is random noise, so she flails. Press «Train» and watch her learn.')
      : '';
    if (hud.hint !== hint) { u.hint.textContent = hint; u.hint.classList.toggle('show', !!hint); hud.hint = hint; }
  }

  _showResult(run) {
    const u = this.ui;
    const j = run.main.judge;
    const n = Math.max(1, j.notes.n);
    clear(u.resultBody);
    const s = this.ctrl.session;
    if (run.mode === 'evolution') {
      const best = run.racers.slice().sort((a, b) => b.judge.hits - a.judge.hits || b.gen - a.gen)[0];
      u.resultTitle.textContent = tr('Забег поколений', 'Generations race');
      u.resultBody.append(
        h('div', tr('Победитель:', 'Winner:')),
        h('div.display.lab-result-big', best.label),
        h('div.tnum', tr(`${best.judge.hits} из ${j.notes.n} нот · ${pct(best.judge.hits / n)}`, `${best.judge.hits} of ${j.notes.n} notes · ${pct(best.judge.hits / n)}`)));
    } else {
      u.resultTitle.textContent = tr('Забег окончен', 'Run finished');
      u.resultBody.append(
        h('div.display.lab-result-big', pct(j.hits / n)),
        h('div.tnum', tr(`${j.hits} из ${j.notes.n} нот · макс. комбо ${run.maxCombo}`, `${j.hits} of ${j.notes.n} notes · max combo ${run.maxCombo}`)),
        h('div.dim', s && s.gen > run.gen ? tr(`дальше — мозг поколения ${fmtNum(s.gen)}`, `next: generation ${fmtNum(s.gen)} brain`) : tr('новая карта…', 'new chart…')));
    }
    u.result.classList.add('show');
  }

  _energy(run) {
    const p = run.packed, t = run.t;
    let lo = 0, hi = p.n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (p.t[m] < t - 1) lo = m + 1; else hi = m; }
    let c = 0;
    for (let i = lo; i < p.n && p.t[i] < t + 1; i++) c++;
    return Math.max(0.15, Math.min(1, c / 14));
  }

  /** МУХА's "vision": dashed lines through the notes she is looking at. */
  _visionLinks(run) {
    const j = run.main.judge, p = run.packed, d = run.main.driver;
    const links = [];
    const st = this.app.settings;
    const AR = st.approachRate || 30, far = st.approachDistance || 14;
    let px = d.x, py = d.y, pz = 0, k = 0;
    for (let i = j.head; i < p.n && k < 4; i++) {
      if (j.state[i] !== 0) continue;
      const z = Math.max(0, (p.t[i] - run.t) * AR);
      if (z > far) break;
      links.push({ x1: px, y1: py, z1: pz, x2: p.x[i], y2: p.y[i], z2: z, alpha: 0.5 - k * 0.1, color: AI_COLOR });
      px = p.x[i]; py = p.y[i]; pz = z; k++;
    }
    return links;
  }
}

// =================================================================================================
// «Что она видит»: flat top-down view of her observation (next to the brain)
// =================================================================================================

function drawRadar(canvas, run) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const ctx = canvas.getContext('2d');
  const r = canvas.getBoundingClientRect();
  const W = Math.max(1, Math.round(r.width)), H = Math.max(1, Math.round(r.height));
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (!run) return;
  const S = Math.min(W, H) / 3.4;
  const ox = W / 2 - S, oy = H / 2 - S;
  const X = (x) => ox + x * S, Y = (y) => oy + y * S;
  ctx.strokeStyle = 'rgba(0, 255, 0, 0.25)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const a = Math.round(X(-0.5 + i)) + 0.5, b = Math.round(Y(-0.5 + i)) + 0.5;
    ctx.beginPath(); ctx.moveTo(a, Y(-0.5)); ctx.lineTo(a, Y(2.5)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(X(-0.5), b); ctx.lineTo(X(2.5), b); ctx.stroke();
  }
  const j = run.main.judge, p = run.packed, d = run.main.driver;
  const hb = (JUDGE_SETTINGS.hitbox || 1.14) * S;
  const seen = [];
  for (let i = j.head; i < p.n && seen.length < 4; i++) if (j.state[i] === 0) seen.push(i);
  ctx.font = 'bold 11px Tahoma, Verdana, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let q = seen.length - 1; q >= 0; q--) {
    const i = seen[q];
    const dt = Math.max(0, p.t[i] - run.t);
    ctx.globalAlpha = Math.max(0.3, 1 - dt / 1.2);
    const col = q === 0 ? '#ffff00' : '#00ff00';
    ctx.strokeStyle = col;
    ctx.lineWidth = q === 0 ? 2 : 1;
    ctx.strokeRect(Math.round(X(p.x[i]) - hb / 2) + 0.5, Math.round(Y(p.y[i]) - hb / 2) + 0.5, Math.round(hb), Math.round(hb));
    ctx.fillStyle = col;
    ctx.fillText(String(q + 1), X(p.x[i]), Y(p.y[i]));
  }
  ctx.globalAlpha = 1;
  if (seen.length) {
    ctx.strokeStyle = 'rgba(182, 255, 59, 0.6)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(X(d.x), Y(d.y));
    for (const i of seen) ctx.lineTo(X(p.x[i]), Y(p.y[i]));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const pl = d.pilot;
  const vs = 0.05 * S;
  ctx.strokeStyle = '#ff00ff';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(X(d.x), Y(d.y)); ctx.lineTo(X(d.x) + pl.vx * vs, Y(d.y) + pl.vy * vs); ctx.stroke();
  ctx.fillStyle = AI_COLOR;
  ctx.fillRect(Math.round(X(d.x)) - 4, Math.round(Y(d.y)) - 4, 8, 8);
}

// =================================================================================================
// Screen
// =================================================================================================

const TABS = [
  { id: 'charts', ru: 'Графики', en: 'Charts' },
  { id: 'exam', ru: 'Что умеет', en: 'Skills' },
  { id: 'brain', ru: 'Мозг', en: 'Brain' },
  { id: 'evo', ru: 'Эволюция', en: 'Evolution' },
  { id: 'help', ru: 'Как это работает', en: 'How it works' },
];

export class LabScreen extends Screen {
  mount() {
    this.ctrl = getLabController(this.app);
    this.fps = 60;
    this._subs = [];
    this._raf = 0;
    const t = local.get('lab.tab', 'charts');
    this.tab = TABS.some((x) => x.id === t) ? t : 'charts';
    this._buildStatus();
    this._build();
    this.app.on('settings', (s) => { if (this.arena) { this.arena.setSettings(s); this.evoArena.setSettings(s); } });
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this.el);
    }
  }

  // ---- window chrome (read once by the shell) ----------------------------------------------------

  title() { return tr('МУХА: Лаборатория', 'МУХА Lab'); }

  menubar() {
    const ctrl = this.ctrl;
    const self = this;
    return [
      {
        label: tr('Файл', 'File'),
        get items() {
          return [
            { label: tr('Сохранить мозг…', 'Save brain…'), icon: 'floppy', onClick: () => self._saveFile() },
            { label: tr('Скопировать мозг', 'Copy brain'), onClick: () => self._copyBrain() },
            { label: tr('Загрузить мозг…', 'Load brain…'), icon: 'folder', onClick: () => self._openLoad() },
            { separator: true },
            { label: tr('Сбросить мозг…', 'Reset brain…'), icon: 'bin', onClick: () => self._confirmReset() },
            { separator: true },
            { label: tr('Смотреть на карте…', 'Watch on a map…'), icon: 'watch', onClick: () => self._watch() },
          ];
        },
      },
      {
        label: tr('Обучение', 'Training'),
        get items() {
          return [
            { label: ctrl.running ? tr('Пауза', 'Pause') : tr('Старт', 'Start'), shortcut: tr('Пробел', 'Space'), onClick: () => ctrl.toggle() },
            { separator: true },
            ...Object.values(SPEEDS).map((sp) => ({ label: `${tr('Скорость', 'Speed')}: ${tr(sp.ru, sp.en)} (${threads(sp.workers(hardwareThreads()))})`, checked: ctrl.speed === sp.id, onClick: () => ctrl.setSpeed(sp.id) })),
            { separator: true },
            { label: tr('Учиться на моих картах', 'Learn on my maps'), checked: ctrl.useMyMaps, onClick: () => self._toggleMyMaps(!ctrl.useMyMaps) },
            { label: tr('Учиться в фоне', 'Keep learning in the background'), checked: ctrl.background, onClick: () => ctrl.setBackground(!ctrl.background) },
          ];
        },
      },
      {
        label: tr('Вид', 'View'),
        get items() {
          return [
            ...TABS.map((t) => ({ label: tr(t.ru, t.en), checked: self.tab === t.id, onClick: () => self._selectTab(t.id) })),
            { separator: true },
            ...[1, 2, 4].map((v) => ({ label: tr(`Показ ×${v}`, `Replay ×${v}`), checked: !!self.arena && self.arena.speed === v, onClick: () => self.arena.setSpeed(v) })),
          ];
        },
      },
      {
        label: tr('Справка', 'Help'),
        items: [{ label: tr('Как она учится', 'How she learns'), icon: 'help', onClick: () => this._selectTab('help') }],
      },
    ];
  }

  _buildStatus() {
    const f = (cls = '') => h(`div.status-field${cls}`, '');
    this.sb = { state: f('.lab-sb-state'), gen: f('.fit'), skill: f('.fit'), rate: f('.fit'), bg: f('.fit') };
  }

  statusbar() { const s = this.sb; return [s.state, s.gen, s.skill, s.rate, s.bg]; }

  // ---- DOM -------------------------------------------------------------------------------------

  _build() {
    clear(this.el);
    this._lang = getLang();
    const app = this.app;
    const ui = this.ui = {};
    const b98 = (label, fn, opts = {}) => button98(label, () => { sfx(app, 'ui', 0.5); fn(); }, opts);

    // ---- arenas
    this.arena = new Arena(this, 'train');
    this.arena.onStart = (run) => this._onRunStart(run);
    this.evoArena = new Arena(this, 'evolution');
    this.evoArena.onStart = (run) => this._buildLeader(run);

    // ---- rank group box
    ui.rankIcon = h('div.lab-rank-icon.sunken.black', icon('fly', 32));
    ui.rankEmoji = h('span.lab-rank-emoji', '');
    ui.rankTitle = h('span.display.lab-rank-title', '');
    ui.rankKicker = h('div.dim', '');
    ui.rankSkill = h('div.display.lab-rank-skill', '');
    ui.rankProg = progress98({ value: 0, segmented: true, label: false });
    ui.rankProgLabel = h('div.lab-rank-prog-label', '');
    ui.ladder = h('div.lab-ladder', TITLES.map((t, i) => h('span.lab-ladder-step', { title: `${t.emoji} ${titleName(t)} · ★${t.min}+`, dataset: { i } }, t.emoji)));
    ui.facts = { level: h('b.tnum', ''), exam: h('b.tnum', ''), best: h('b.tnum', '') };
    ui.rankBox = h('fieldset.groupbox.lab-rank', h('legend', tr('Ранг', 'Rank')),
      h('div.lab-rank-main', ui.rankIcon, h('div.lab-rank-info', ui.rankKicker, h('div.lab-rank-name', ui.rankEmoji, ui.rankTitle), ui.rankSkill)),
      ui.rankProgLabel, ui.rankProg.root, ui.ladder,
      h('div.lab-rows',
        h('div.lab-row', h('span', tr('Учится на картах', 'Training on')), ui.facts.level),
        h('div.lab-row', h('span', tr('Последний экзамен', 'Last exam')), ui.facts.exam),
        h('div.lab-row', h('span', tr('Лучший результат', 'Best ever')), ui.facts.best)));

    // ---- training group box
    ui.trainBtn = b98(tr('▶ Обучать', '▶ Train'), () => this.ctrl.start(), { primary: true, className: 'lab-train' });
    ui.pauseBtn = b98(tr('❚❚ Пауза', '❚❚ Pause'), () => this.ctrl.pause(), { className: 'lab-train' });
    ui.speed = radio98('lab-speed', Object.values(SPEEDS).map((sp) => ({ value: sp.id, label: tr(sp.ru, sp.en) })), this.ctrl.speed, (v) => this.ctrl.setSpeed(v));
    ui.speedNote = h('div.lab-note', '');
    ui.handSel = h('select.lab-hand', { 'aria-label': tr('Рука для нового мозга', 'Hand for a new brain'), onchange: () => this._changeHand(ui.handSel.value) },
      Object.values(HAND_PRESETS).map((hp) => h('option', { value: hp.id }, tr(hp.ru, hp.en))));
    ui.handNote = h('div.lab-note', '');
    ui.myMaps = checkbox98(tr('Учиться на моих картах', 'Learn on my maps'), this.ctrl.useMyMaps, (on) => this._toggleMyMaps(on));
    ui.myMapsNote = h('div.lab-note.lab-note-indent', '');
    ui.bg = checkbox98(tr('Учиться в фоне', 'Keep learning in the background'), this.ctrl.background, (on) => this.ctrl.setBackground(on));
    ui.bgNote = h('div.lab-note.lab-note-indent', tr('Продолжать в других окнах. Во время игры — всегда пауза.', 'Keep going in other windows. Always pauses during gameplay.'));
    ui.trainHint = h('div.lab-note', '');
    const trainBox = h('fieldset.groupbox.lab-train-box', h('legend', tr('Обучение', 'Training')),
      h('div.lab-train-row', ui.trainBtn, ui.pauseBtn),
      ui.trainHint,
      h('div.lab-field', h('span', tr('Скорость:', 'Speed:')), ui.speed), ui.speedNote,
      h('div.lab-field', h('label', tr('Рука (для нового мозга):', 'Hand (for a new brain):')), ui.handSel), ui.handNote,
      h('div.lab-checks', ui.myMaps, ui.myMapsNote, ui.bg, ui.bgNote),
      h('div.separator'),
      h('div.lab-file-row',
        b98(tr('Сохранить…', 'Save…'), () => this._saveFile(), { iconName: 'floppy' }),
        b98(tr('Копировать', 'Copy'), () => this._copyBrain()),
        b98(tr('Загрузить…', 'Load…'), () => this._openLoad(), { iconName: 'folder' }),
        b98(tr('Сбросить…', 'Reset…'), () => this._confirmReset(), { iconName: 'bin' })),
      b98(tr('Смотреть на карте…', 'Watch on a map…'), () => this._watch(), { iconName: 'watch', className: 'lab-watch' }));

    // ---- stats group box
    const row = (label) => { const v = h('b.tnum', '—'); return { el: h('div.lab-row', h('span', label), v), v }; };
    ui.st = {
      gen: row(tr('Поколений', 'Generations')),
      rate: row(tr('Поколений в минуту', 'Generations per minute')),
      time: row(tr('Сыграно (симуляция)', 'Played (simulated)')),
      notes: row(tr('Нот сыграно', 'Notes played')),
      workers: row(tr('Потоков', 'Threads')),
      pop: row(tr('Мутантов в поколении', 'Mutants per generation')),
    };
    const statsBox = h('fieldset.groupbox.lab-stats', h('legend', tr('Статистика', 'Statistics')), h('div.lab-rows', Object.values(ui.st).map((r) => r.el)));

    // ---- tab panels
    const legend = (items) => h('div.lab-legend', items.map(([color, label]) => h('span', h('i.lab-key', { style: { background: color } }), label)));
    const tableToggle = (box, host, fn) => checkbox98(tr('Таблица', 'Table'), false, (on) => {
      box.classList.toggle('show-table', on);
      clear(host);
      if (on) host.appendChild(h('div.listview98.lab-table', fn()));
      else requestAnimationFrame(() => this.resize());
    });
    // charts
    const hostA = h('div.sunken.black.lab-scope'), hostB = h('div.sunken.black.lab-scope');
    const tblHostCharts = h('div.lab-table-host');
    const pCharts = h('div.lab-panel-charts',
      h('div.lab-chart', h('div.lab-chart-title', h('b', tr('Точность по поколениям', 'Accuracy per generation')), legend([[TM[0], 'МУХА'], [TM[1], tr('лучший мутант', 'best mutant')]])), hostA),
      h('div.lab-chart', h('div.lab-chart-title', h('b', tr('Сила ★ и уровень карт', 'Skill ★ and map level')), legend([[TM[2], tr('сила (экзамен)', 'skill (exam)')], [TM[1], tr('рекорд', 'best')], [TM[3], tr('уровень карт', 'map level')]])), hostB));
    const chartsFoot = h('div.lab-panel-foot', h('span.dim', tr('Линия — тренд, полоса — разброс по поколениям. Наведи курсор, чтобы увидеть значения.', 'Line = trend, band = spread per generation. Hover to read values.')));
    const pChartsWrap = h('div.lab-charts-wrap', pCharts, tblHostCharts, chartsFoot);
    chartsFoot.appendChild(tableToggle(pChartsWrap, tblHostCharts, () => this._historyTable()));
    // exam
    const hostC = h('div.sunken.black.lab-scope.lab-scope-tall');
    const tblHostExam = h('div.lab-table-host');
    const examFoot = h('div.lab-panel-foot', h('span.dim', tr('Каждые 5 поколений МУХА сдаёт экзамен на одних и тех же картах. Её сила ★ — самая сложная карта, пройденная на 90%.', 'Every 5 generations МУХА takes the same exam. Her ★ skill is the hardest chart passed at 90%.')));
    const pExam = h('div.lab-panel-exam',
      h('div.lab-chart-title', h('b', tr('Экзамен: точность на картах ★0–★20', 'Exam: accuracy on ★0–★20 charts')), legend([[TM[0], tr('пройдено (≥ 90%)', 'passed (≥ 90%)')], ['#006a00', tr('пока нет', 'not yet')], ['#ff0000', tr('зачёт 90%', 'pass 90%')]])),
      hostC, tblHostExam, examFoot);
    examFoot.appendChild(tableToggle(pExam, tblHostExam, () => this._levelsTable()));
    // brain
    ui.nn = h('canvas.lab-nn');
    ui.nnTip = h('div.tooltip98.lab-tip');
    ui.nnMeta = h('div.dim.lab-nn-meta', '');
    ui.radar = h('canvas.lab-radar');
    const pBrain = h('div.lab-panel-brain',
      h('div.lab-nn-col',
        h('div.sunken.black.lab-nn-wrap', ui.nn, ui.nnTip),
        h('div.lab-legend',
          h('span', h('i.lab-key', { style: { background: '#00ff00' } }), tr('вес «+» (усиливает)', 'weight + (excites)')),
          h('span', h('i.lab-key', { style: { background: '#ff3030' } }), tr('вес «−» (гасит)', 'weight − (inhibits)')),
          h('span.dim', tr('яркость — сила сигнала сейчас · наведи на нейрон', 'brightness = signal now · hover a neuron'))),
        ui.nnMeta),
      h('fieldset.groupbox.lab-radar-box', h('legend', tr('Что она видит', 'What she sees')),
        h('div.sunken.black.lab-radar-wrap', ui.radar),
        h('p.lab-small', tr('Сетка 3×3 сверху. Цифры — 4 ближайшие ноты, которые подаются на входы сети (1 — самая срочная). Фиолетовая черта — скорость руки.', 'The 3×3 grid from above. Numbers = the 4 next notes fed into the net (1 = most urgent). Purple stroke = hand velocity.'))));
    // evolution
    ui.evoEmpty = h('div.tooltip98.lab-evo-empty', '');
    ui.leader = listview98([
      { key: 'dot', label: '', width: '18px', format: (v) => h('i.lab-key.lab-key-sq', { style: { background: v } }) },
      { key: 'label', label: tr('Версия', 'Version') },
      { key: 'skill', label: '★', align: 'right', format: (v) => fmtStars(v || 0) },
      { key: 'acc', label: tr('Точность', 'Accuracy'), align: 'right', format: (v) => (v < 0 ? '—' : pct(v, 0)) },
    ], []);
    ui.leader.root.classList.add('lab-leader');
    ui.journal = listview98([
      { key: 'gen', label: tr('Пок.', 'Gen'), align: 'right', width: '52px', format: (v) => fmtNum(v) },
      { key: 'text', label: tr('Событие', 'Event') },
    ], []);
    ui.journal.root.classList.add('lab-journal');
    const pEvo = h('div.lab-panel-evo',
      h('div.lab-evo-main', this.evoArena.root, ui.evoEmpty,
        h('p.lab-small', tr('Все сохранённые версии МУХИ играют одну и ту же карту одновременно: красные — старые, салатовая — сегодняшняя. Так видно, чему она научилась.', 'All saved versions of МУХА play the same chart at once: red = old, lime = today. That is what she has learned.'))),
      h('div.lab-evo-side',
        h('fieldset.groupbox', h('legend', tr('Кто точнее', 'Who aims better')), ui.leader.root),
        h('fieldset.groupbox', h('legend', tr('Дневник МУХИ', 'МУХА\'s diary')), ui.journal.root)));
    // help
    const pHelp = h('div.sunken.lab-help',
      h('p', h('b', tr('Как МУХА учится играть', 'How МУХА learns to play'))),
      h('p', tr('Коротко: много чуть-разных копий играют, лучшие тянут мозг за собой, а карты постепенно усложняются.', 'In short: many slightly different copies play, the better ones pull the brain along, and maps slowly get harder.')),
      explainer().map(([emoji, title, text]) => h('div.lab-help-item', h('span.lab-help-emoji', emoji), h('div', h('b', title), h('p', text)))));

    // ---- tab control (own switching so canvases stay mounted and keep their state)
    const panels = { charts: pChartsWrap, exam: pExam, brain: pBrain, evo: pEvo, help: pHelp };
    ui.tabBtns = {};
    ui.panels = {};
    const strip = h('div.tabs98', { role: 'tablist' }, TABS.map((t) => {
      const b = h('button', { type: 'button', role: 'tab', id: `lab-tab-${t.id}`, 'aria-controls': `lab-panel-${t.id}`, onclick: () => { sfx(app, 'ui', 0.4); this._selectTab(t.id); } }, tr(t.ru, t.en));
      ui.tabBtns[t.id] = b;
      return b;
    }));
    const panel = h('div.tabpanel98.lab-tabpanel', TABS.map((t) => {
      const p = h('div', { role: 'tabpanel', id: `lab-panel-${t.id}`, 'aria-labelledby': `lab-tab-${t.id}` }, panels[t.id]);
      ui.panels[t.id] = p;
      return p;
    }));
    ui.arenaCaption = h('div.lab-small.dim.lab-caption', '');

    this.el.append(
      h('div.lab-root',
        h('div.lab-top',
          h('div.lab-arena-col', this.arena.root, ui.arenaCaption),
          h('div.lab-side', ui.rankBox, trainBox, statsBox)),
        h('div.lab-tabs', strip, panel)));

    this.charts = {
      acc: new LineChart(hostA, {
        theme: 'taskmgr', trendWord: tr('тренд', 'trend'),
        series: [{ key: 'acc', label: 'МУХА', color: TM[0], band: true }, { key: 'best', label: tr('лучший мутант', 'best mutant'), color: TM[1], smooth: true }],
        yMin: 0, yMax: 1, yFormat: (v) => pct(v, 1), yTickFormat: (v) => Math.round(v * 100) + '%', xTitle: tr('поколение', 'generation'),
        ariaLabel: tr('График точности по поколениям', 'Accuracy per generation chart'), empty: tr('Нажми «Обучать» — здесь появится кривая обучения', 'Press «Train» — the learning curve appears here'),
      }),
      skill: new LineChart(hostB, {
        theme: 'taskmgr',
        series: [
          { key: 'skill', label: tr('сила', 'skill'), color: TM[2], step: true },
          { key: 'best', label: tr('рекорд', 'best'), color: TM[1], step: true, width: 1 },
          { key: 'level', label: tr('уровень карт', 'map level'), color: TM[3], step: true },
        ],
        yMin: 0, yMax: null, yFormat: (v) => '★' + v.toFixed(2), yTickFormat: (v) => '★' + (Math.round(v * 10) / 10), xTitle: tr('поколение', 'generation'),
        ariaLabel: tr('График силы и уровня карт', 'Skill and map level chart'), empty: tr('Пока нет данных', 'No data yet'),
      }),
      bars: new BarChart(hostC, {
        theme: 'taskmgr', threshold: PASS_ACC, thresholdLabel: tr('зачёт 90%', 'pass 90%'),
        xLabel: (i) => String(i), tipTitle: (i) => tr(`карта ★${i}`, `chart ★${i}`),
        tipText: (i, v) => (v >= PASS_ACC ? tr('✓ пройдено', '✓ passed') : tr('✗ пока нет', '✗ not yet')),
        markerLabel: (m) => tr(`она здесь ★${m.toFixed(2)}`, `she is here ★${m.toFixed(2)}`),
        ariaLabel: tr('Точность МУХИ на экзамене по уровням сложности', 'МУХА exam accuracy per difficulty'), empty: tr('Экзамен ещё не сдавался', 'No exam taken yet'),
      }),
    };
    this.nnviz = new NNViz(ui.nn, { tooltip: ui.nnTip, theme: 'win98' });
    this._selectTab(this.tab, true);
  }

  _selectTab(id, initial = false) {
    const ui = this.ui;
    if (!ui.panels[id]) id = 'charts';
    this.tab = id;
    local.set('lab.tab', id);
    for (const [k, b] of Object.entries(ui.tabBtns)) {
      b.setAttribute('aria-selected', String(k === id));
      b.tabIndex = k === id ? 0 : -1;
    }
    for (const [k, p] of Object.entries(ui.panels)) p.hidden = k !== id;
    if (id === 'evo') {
      const c = this.ctrl;
      const last = c.snapshots.length ? c.snapshots[c.snapshots.length - 1].gen : -1;
      const n = c.snapshots.length + (c.session && c.session.gen > last ? 1 : 0);
      ui.evoEmpty.textContent = n >= 2 ? '' : tr('Пока нечего сравнивать: обучи МУХУ хотя бы пару поколений — здесь появятся её прошлые версии.', 'Nothing to compare yet: train МУХА for a couple of generations — her past versions will appear here.');
      ui.evoEmpty.classList.toggle('show', n < 2);
      this.evoArena.restart();
    }
    if (!initial) requestAnimationFrame(() => this.resize());
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  show() {
    if (this._lang !== getLang()) this._build();
    const ctrl = this.ctrl;
    ctrl.ensureSession();
    this._subs.forEach((off) => off());
    this._subs = [
      ctrl.on('state', () => this._renderState()),
      ctrl.on('gen', (rec, info) => this._onGen(rec, info)),
      ctrl.on('session', () => { this.arena.restart(); this.evoArena.restart(); this._renderAll(); }),
      ctrl.on('journal', () => this._renderJournal()),
    ];
    this.ui.handSel.value = this.app.settings.aiHand in HAND_PRESETS ? this.app.settings.aiHand : 'pro';
    this.arena.setSettings(this.app.settings);
    this.evoArena.setSettings(this.app.settings);
    this._renderAll();
    this._startLoop();
    requestAnimationFrame(() => this.resize());
  }

  hide() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._subs.forEach((off) => off());
    this._subs = [];
    if (!this.ctrl.background) this.ctrl.pause();
    this.ctrl.save();
  }

  resize() {
    if (!this.arena) return;
    this.arena.resize();
    this.evoArena.resize();
    this.nnviz.resize();
    for (const c of Object.values(this.charts)) c.resize();
  }

  keydown(e) {
    if (this.app.modalLayer && this.app.modalLayer.childElementCount) return false;
    const tag = (e.target && e.target.tagName) || '';
    if (e.code === 'Space' && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(tag)) { this.ctrl.toggle(); return true; }
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && e.target && e.target.getAttribute && e.target.getAttribute('role') === 'tab') {
      const i = TABS.findIndex((t) => t.id === this.tab);
      const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length].id;
      this._selectTab(next);
      this.ui.tabBtns[next].focus();
      return true;
    }
    return false;
  }

  _startLoop() {
    cancelAnimationFrame(this._raf);
    let last = performance.now();
    let acc = 0, n = 0;
    const frame = (now) => {
      this._raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      acc += dt; n++;
      if (acc >= 0.5) { this.fps = n / acc; acc = 0; n = 0; }
      try {
        const tab = this.tab;
        this.arena.frame(dt, true);
        const run = this.arena.run;
        if (tab === 'brain' && run) {
          this.nnviz.draw(run.main.driver.activations);
          drawRadar(this.ui.radar, run);
        }
        if (tab === 'evo') {
          this.evoArena.frame(dt, true);
          this._updateLeader(now);
        }
        if (tab === 'charts') { this.charts.acc.tick(); this.charts.skill.tick(); }
        if (tab === 'exam') this.charts.bars.tick();
      } catch (err) {
        console.error(err);
      }
    };
    this._raf = requestAnimationFrame(frame);
  }

  // ---- arena callbacks -------------------------------------------------------------------------

  _onRunStart(run) {
    const ui = this.ui;
    this.nnviz.setBrain(run.arch, run.main.driver.net.params);
    ui.nnMeta.textContent = tr(`Сеть ${run.arch.join(' → ')} · ${fmtNum(run.main.driver.net.nParams)} весов · сейчас думает мозг поколения ${fmtNum(run.main.gen)}`,
      `Network ${run.arch.join(' → ')} · ${fmtNum(run.main.driver.net.nParams)} weights · thinking now: generation ${fmtNum(run.main.gen)} brain`);
    ui.arenaCaption.textContent = tr(`Играет мозг поколения ${fmtNum(run.gen)} на новой карте ★${fmtStars(run.level)} — это уровень, на котором она сейчас учится. Пунктир — ноты, на которые она смотрит.`,
      `Generation ${fmtNum(run.gen)} brain plays a fresh ★${fmtStars(run.level)} chart — the level she is training on. Dashed lines = the notes she is looking at.`);
  }

  _buildLeader(run) {
    this._leaderRun = run;
    this._leaderAt = 0;
    this._leaderSig = null;
    this._updateLeader(performance.now(), true);
  }

  _updateLeader(now, force = false) {
    const run = this._leaderRun;
    if (!run || run !== this.evoArena.run) return;
    if (!force && now - this._leaderAt < 250) return;
    this._leaderAt = now;
    const rows = run.racers.map((r) => {
      const d = r.judge.hits + r.judge.misses;
      return { dot: r.color, label: r.label + (r.now ? tr(' (сейчас)', ' (now)') : ''), skill: r.skill, acc: d ? r.judge.hits / d : -1, gen: r.gen };
    }).sort((a, b) => b.acc - a.acc || b.gen - a.gen);
    const sig = rows.map((r) => r.label + ':' + (r.acc < 0 ? '-' : Math.round(r.acc * 100))).join('|');
    if (sig === this._leaderSig) return;
    this._leaderSig = sig;
    this.ui.leader.setRows(rows);
  }

  // ---- rendering from controller state -----------------------------------------------------------

  _renderAll() {
    this._renderState();
    this._renderRank();
    this._renderStats();
    this._renderCharts(true);
    this._renderJournal();
  }

  _renderState() {
    const ctrl = this.ctrl, ui = this.ui;
    if (!ui) return;
    const running = ctrl.running;
    const s = ctrl.session;
    ui.trainBtn.disabled = running;
    ui.pauseBtn.disabled = !running;
    ui.trainBtn.lastChild.textContent = s && s.gen > 0 ? tr('▶ Продолжить', '▶ Resume') : tr('▶ Обучать', '▶ Train');
    const mode = ctrl.poolMode;
    const w = ctrl.workers;
    let st;
    if (running) st = mode === 'main' ? tr('Учится (основной поток)', 'Learning (main thread)') : mode === 'workers' ? tr(`Учится · ${threads(w)}`, `Learning · ${threads(w)}`) : tr('Запуск потоков…', 'Starting threads…');
    else st = ctrl._loopP ? tr('Доигрывает поколение…', 'Finishing the generation…') : tr('Пауза', 'Paused');
    this.sb.state.textContent = st;
    this.sb.state.classList.toggle('on', running);
    this.sb.bg.textContent = ctrl.background ? tr('Учится в фоне', 'Learns in background') : tr('Только в этом окне', 'Only in this window');
    ui.trainHint.textContent = running
      ? (ctrl.lastGenMs ? tr(`≈ ${(ctrl.lastGenMs / 1000).toFixed(2)} с на поколение`, `≈ ${(ctrl.lastGenMs / 1000).toFixed(2)} s per generation`) : tr('Первое поколение…', 'First generation…'))
      : tr('Пробел — старт/пауза. Прогресс сохраняется сам.', 'Space = start/pause. Progress saves itself.');
    for (const inp of ui.speed.querySelectorAll('input')) inp.checked = inp.value === ctrl.speed;
    const hc = hardwareThreads();
    ui.speedNote.textContent = mode === 'main'
      ? tr('Потоки недоступны — считает основной поток (медленнее).', 'No worker threads — the main thread computes (slower).')
      : tr(`${threads(ctrl.targetWorkers)} из ${hc} ядер процессора`, `${threads(ctrl.targetWorkers)} of ${hc} CPU threads`);
    const hand = ctrl.hand;
    ui.handNote.textContent = tr(`У этого мозга ${hand.ru.toLowerCase()}: до ${hand.maxSpeed} клеток/с, ускорение ${hand.maxAccel}. Смена руки = новый мозг.`, `This brain: ${hand.en.toLowerCase()}, up to ${hand.maxSpeed} cells/s, accel ${hand.maxAccel}. Changing it = a new brain.`);
    ui.bg.querySelector('input').checked = ctrl.background;
    ui.myMaps.querySelector('input').checked = ctrl.useMyMaps;
    const nUser = countUserMaps(this.app);
    ui.myMapsNote.textContent = ctrl.useMyMaps
      ? (ctrl.customCount ? tr(`${ctrl.customCount} ${plural(ctrl.customCount, 'карта', 'карты', 'карт')} · ~35% тренировок`, `${ctrl.customCount} map${ctrl.customCount === 1 ? '' : 's'} · ~35% of training`) : tr('Нет импортированных карт', 'No imported maps'))
      : (nUser ? tr(`Твоих карт: ${nUser}`, `Your maps: ${nUser}`) : tr('Импортируй .sspm / .txt / аудио', 'Import .sspm / .txt / audio'));
    this._renderStats();
  }

  _renderRank() {
    const s = this.ctrl.session, ui = this.ui;
    if (!s || !ui) return;
    const best = Math.max(0, s.bestSkill);
    const t = titleFor(best);
    if (ui.rankIcon.dataset.kind !== String(t.index >= 9)) {
      clear(ui.rankIcon);
      ui.rankIcon.appendChild(icon(t.index >= 9 ? 'trophy' : 'fly', 32));
      ui.rankIcon.dataset.kind = String(t.index >= 9);
    }
    ui.rankEmoji.textContent = t.emoji;
    ui.rankTitle.textContent = titleName(t);
    ui.rankKicker.textContent = tr(`Ранг ${t.index + 1} из ${TITLES.length}`, `Rank ${t.index + 1} of ${TITLES.length}`);
    ui.rankSkill.textContent = '★ ' + best.toFixed(2);
    const p = t.next ? t.progress : 1;
    ui.rankProg.set(p);
    ui.rankProg.root.setAttribute('role', 'progressbar');
    ui.rankProg.root.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    clear(ui.rankProgLabel);
    if (t.next) ui.rankProgLabel.append(tr('до ', 'to '), h('b', `«${titleName(t.next)}»`), `: ${Math.floor(t.progress * 100)}%`);
    else ui.rankProgLabel.append(tr('Максимальный ранг. Абсолют.', 'Max rank. Absolute.'));
    for (const step of ui.ladder.children) {
      const i = +step.dataset.i;
      step.classList.toggle('done', i < t.index);
      step.classList.toggle('cur', i === t.index);
    }
    ui.facts.level.textContent = '★' + fmtStars(s.curriculum.level);
    ui.facts.exam.textContent = s.bestSkill >= 0 ? '★' + Math.max(0, s.skill).toFixed(2) : '—';
    ui.facts.best.textContent = '★' + best.toFixed(2);
    this.sb.skill.textContent = `★ ${best.toFixed(2)} · ${titleName(t)}`;
  }

  _renderStats() {
    const s = this.ctrl.session, ui = this.ui;
    if (!s || !ui) return;
    const ctrl = this.ctrl;
    ui.st.gen.v.textContent = fmtNum(s.gen);
    const rate = ctrl.running ? ctrl.genRate() : 0;
    const rateText = rate ? (rate >= 10 ? fmtNum(rate) : rate.toFixed(1)) : '—';
    ui.st.rate.v.textContent = rateText;
    const mins = Math.floor(s.trainSeconds / 60);
    ui.st.time.v.textContent = tr(`${Math.floor(mins / 60)} ч ${String(mins % 60).padStart(2, '0')} мин`, `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')} min`);
    ui.st.notes.v.textContent = compact(s.notesPlayed);
    ui.st.workers.v.textContent = ctrl.poolMode === 'main' ? tr('1 (основной)', '1 (main)') : String(ctrl.poolMode === 'workers' ? ctrl.workers : ctrl.targetWorkers);
    ui.st.pop.v.textContent = String(s.es.popSize);
    this.sb.gen.textContent = tr(`Поколение ${fmtNum(s.gen)}`, `Generation ${fmtNum(s.gen)}`);
    this.sb.rate.textContent = tr(`Пок/мин: ${rateText}`, `Gen/min: ${rateText}`);
  }

  _renderCharts(force = false) {
    const s = this.ctrl.session;
    if (!s) return;
    const now = performance.now();
    if (!force && this._chartsAt && now - this._chartsAt < 250) {
      if (!this._chartsPending) this._chartsPending = setTimeout(() => { this._chartsPending = 0; this._renderCharts(true); }, 260);
      return;
    }
    this._chartsAt = now;
    const hist = s.history;
    const rowsA = new Array(hist.length);
    const rowsB = new Array(hist.length);
    for (let i = 0; i < hist.length; i++) {
      const r = hist[i];
      rowsA[i] = { x: r.gen, acc: r.acc, best: r.bestAcc };
      rowsB[i] = { x: r.gen, skill: Math.max(0, r.skill || 0), best: Math.max(0, r.bestSkill ?? 0), level: r.level };
    }
    this.charts.acc.setData(rowsA);
    this.charts.skill.setData(rowsB);
    this.charts.bars.setData(s.perLevel ? s.perLevel.map((p) => p.acc) : new Array(21).fill(null), { marker: s.perLevel ? Math.max(0, s.skill) : null });
  }

  _renderJournal() {
    const ui = this.ui;
    if (!ui) return;
    const rows = this.ctrl.journal.slice(0, 40).map((e) => {
      let text = '';
      if (e.kind === 'rank') { const t = TITLES[e.title] || TITLES[0]; text = tr(`${t.emoji} Новый ранг: «${t.ru}» (★${(+e.skill || 0).toFixed(2)})`, `${t.emoji} New rank: «${t.en}» (★${(+e.skill || 0).toFixed(2)})`); }
      else if (e.kind === 'level') text = tr(`📈 Карты сложнее: ★${fmtStars(e.from)} → ★${fmtStars(e.to)}`, `📈 Harder maps: ★${fmtStars(e.from)} → ★${fmtStars(e.to)}`);
      else if (e.kind === 'birth') { const hp = HAND_PRESETS[e.hand] || HAND_PRESETS.pro; text = tr(`🥚 Родилась. ${hp.ru}`, `🥚 Hatched. ${hp.en}`); }
      else if (e.kind === 'load') text = tr('📂 Мозг загружен', '📂 Brain loaded');
      return { gen: e.gen, text };
    });
    ui.journal.setRows(rows.length ? rows : [{ gen: 0, text: tr('Здесь будут новые ранги и уровни карт.', 'New ranks and map levels will appear here.') }]);
  }

  _onGen(rec, info) {
    // at 10+ generations per second, redraw the panels at most ~5×/s
    const now = performance.now();
    if (info.rankUp) this._celebrate();
    if (!info.rankUp && !info.levelUp && this._genAt && now - this._genAt < 200) {
      if (!this._genPending) this._genPending = setTimeout(() => { this._genPending = 0; this._genAt = performance.now(); this._renderRank(); this._renderState(); }, 210);
      this._renderCharts();
      return;
    }
    this._genAt = now;
    this._renderRank();
    this._renderState();
    this._renderCharts();
  }

  _celebrate() {
    const box = this.ui.rankBox;
    box.classList.remove('lab-blink');
    void box.offsetWidth;
    box.classList.add('lab-blink');
  }

  // ---- tables (chart twins) --------------------------------------------------------------------

  _historyTable() {
    const s = this.ctrl.session;
    const rows = s.history.filter((r) => r.bench).slice(-40).reverse()
      .map((r) => [fmtNum(r.gen), pct(r.acc), pct(r.bestAcc), '★' + Math.max(0, r.skill).toFixed(2), '★' + Math.max(0, r.bestSkill).toFixed(2), '★' + fmtStars(r.level)]);
    return tableView([tr('Пок.', 'Gen'), tr('Точность', 'Accuracy'), tr('Лучший мутант', 'Best mutant'), tr('Сила', 'Skill'), tr('Рекорд', 'Best'), tr('Уровень карт', 'Map level')], rows);
  }

  _levelsTable() {
    const s = this.ctrl.session;
    const rows = (s.perLevel || []).map((p) => ['★' + p.level, pct(p.acc), p.acc >= PASS_ACC ? tr('✓ пройдено', '✓ passed') : '—']);
    return tableView([tr('Карта', 'Chart'), tr('Точность', 'Accuracy'), tr('Зачёт', 'Pass')], rows);
  }

  // ---- actions ---------------------------------------------------------------------------------

  async _changeHand(handId) {
    const ctrl = this.ctrl;
    const cur = ctrl.hand.id;
    const hp = HAND_PRESETS[handId];
    if (!hp) return;
    if (handId === cur) {
      if (this.app.settings.aiHand !== handId) { this.app.settings.aiHand = handId; if (this.app.saveSettings) this.app.saveSettings(); }
      return;
    }
    if (ctrl.session && ctrl.session.gen === 0) {
      await ctrl.reset(handId);
      this.app.toast(tr(`Новая МУХА: ${hp.ru.toLowerCase()}`, `New МУХА: ${hp.en.toLowerCase()}`), 'success');
      return;
    }
    const ok = await this.app.confirm(
      tr(`Рука задаётся при рождении: МУХА учится двигать именно эту руку — с её скоростью и ускорением.\nЧтобы взять «${hp.ru}», придётся начать с нуля. Текущий мозг (${fmtNum(ctrl.session.gen)} поколений) будет удалён — сначала можешь сохранить его.`,
        `The hand is chosen at birth: МУХА learns to move exactly this hand, with its speed and acceleration.\nSwitching to the «${hp.en}» means starting from scratch. The current brain (${fmtNum(ctrl.session.gen)} generations) will be deleted — you may save it first.`),
      { title: tr('Сменить руку?', 'Change the hand?'), yes: tr('Начать заново', 'Start over'), no: tr('Оставить', 'Keep it') });
    if (!ok) { this.ui.handSel.value = cur; return; }
    await ctrl.reset(handId);
    this.app.toast(tr(`Новая МУХА: ${hp.ru.toLowerCase()}`, `New МУХА: ${hp.en.toLowerCase()}`), 'success');
  }

  async _confirmReset() {
    const ctrl = this.ctrl;
    const s = ctrl.session;
    const t = titleFor(Math.max(0, s.bestSkill));
    const ok = await this.app.confirm(
      tr(`МУХА забудет всё: ${fmtNum(s.gen)} поколений обучения и ранг «${t.ru}».\nОтменить нельзя — сначала можешь сохранить мозг.`, `МУХА will forget everything: ${fmtNum(s.gen)} generations of training and the «${t.en}» rank.\nThis cannot be undone — you may save the brain first.`),
      { title: tr('Сбросить мозг?', 'Reset the brain?'), yes: tr('Сбросить', 'Reset'), no: tr('Отмена', 'Cancel') });
    if (!ok) return;
    await ctrl.reset(this.app.settings.aiHand);
    this.app.toast(tr('Новая МУХА вылупилась 🥚', 'A new МУХА has hatched 🥚'), 'success');
  }

  _saveFile() {
    const s = this.ctrl.session;
    const json = JSON.stringify(this.ctrl.serialize());
    downloadFile(`muxa-gen${s.gen}-star${Math.max(0, s.bestSkill).toFixed(1)}.json`, json, 'application/json');
    this.ctrl.save({ force: true });
    this.app.toast(tr('Мозг сохранён в файл. Если скачивание не началось — «Файл → Скопировать мозг».', 'Brain saved to a file. If no download started, use «File → Copy brain».'), 'success', 4200);
  }

  _copyBrain() {
    const json = JSON.stringify(this.ctrl.serialize({ compact: true }));
    const kb = Math.round(json.length / 1024);
    const fallback = () => {
      const ta = h('textarea.lab-json', { readonly: true, spellcheck: false });
      ta.value = json;
      const body = h('div.lab-modal',
        h('p', tr(`Буфер обмена недоступен — выдели текст и скопируй вручную (Ctrl+C), ${kb} КБ. Его можно вставить в «Загрузить мозг…» на любом устройстве.`, `The clipboard is unavailable — select the text and copy it (Ctrl+C), ${kb} KB. Paste it into «Load brain…» on any device.`)),
        ta);
      this.app.modal(body, { title: tr('Мозг МУХИ (JSON)', 'МУХА brain (JSON)'), wide: true, iconName: 'notepad' });
      setTimeout(() => { ta.focus(); ta.select(); }, 60);
    };
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
      navigator.clipboard.writeText(json).then(
        () => this.app.toast(tr(`Мозг скопирован (${kb} КБ). Вставь его в «Загрузить мозг…» где угодно.`, `Brain copied (${kb} KB). Paste it into «Load brain…» anywhere.`), 'success', 4200),
        () => fallback());
    } catch {
      fallback();
    }
  }

  _openLoad() {
    let close = null;
    const ta = h('textarea.lab-json', { placeholder: '{"arch":[33,24,24,2],"theta":[…]}', spellcheck: false });
    const err = h('div.lab-load-err', { role: 'alert' });
    const apply = async (text) => {
      err.textContent = '';
      let data;
      try { data = JSON.parse(text); } catch { err.textContent = tr('Это не JSON. Скопируй мозг целиком.', 'That is not JSON. Copy the whole brain.'); return; }
      try {
        const s = await this.ctrl.load(data);
        if (close) close();
        const t = titleFor(Math.max(0, s.bestSkill));
        this.app.toast(tr(`Мозг загружен: поколение ${fmtNum(s.gen)}, «${t.ru}» ${t.emoji}`, `Brain loaded: generation ${fmtNum(s.gen)}, «${t.en}» ${t.emoji}`), 'success', 4200);
      } catch (e) {
        err.textContent = tr('Не получилось: ', 'Failed: ') + ((e && e.message) || e);
      }
    };
    const body = h('div.lab-modal',
      h('p', tr('Загрузи мозг, сохранённый раньше (.json), или вставь скопированный текст. Текущий мозг будет заменён — сначала можешь его сохранить.', 'Load a brain you saved before (.json) or paste copied text. The current brain will be replaced — you may save it first.')),
      h('div', button98(tr('Выбрать файл…', 'Choose a file…'), async () => {
        const files = await pickFiles('.json,application/json', false);
        if (files && files[0]) apply(await files[0].text());
      }, { iconName: 'folder' })),
      h('div', tr('…или вставь JSON:', '…or paste JSON:')),
      ta,
      err,
      h('div.lab-modal-actions',
        button98(tr('Загрузить', 'Load'), () => apply(ta.value.trim()), { primary: true }),
        button98(tr('Отмена', 'Cancel'), () => close && close())));
    close = this.app.modal(body, { title: tr('Загрузить мозг', 'Load a brain'), wide: true, iconName: 'folder' });
  }

  async _toggleMyMaps(on) {
    const n = await this.ctrl.setUseMyMaps(on);
    if (on && !n) this.app.toast(tr('Импортированных карт пока нет — перетащи .sspm/.txt или аудио в окно.', 'No imported maps yet — drop .sspm/.txt or audio files onto the window.'), 'info', 4500);
    else if (on) this.app.toast(tr(`МУХА будет тренироваться и на твоих картах (${n})`, `МУХА will also train on your maps (${n})`), 'success');
  }

  async _watch() {
    await this.ctrl.save({ force: true });
    if (this.app.brains) this.app.brains.select('live');
    this.app.go('select', { mode: 'watch' });
  }
}

// =================================================================================================
// small helpers
// =================================================================================================

function countUserMaps(app) {
  let n = 0;
  for (const set of (app.library && app.library.sets) || []) if (set && set.source !== 'builtin') n += (set.maps || []).length;
  return n;
}

function compact(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + tr(' млрд', 'B');
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + tr(' млн', 'M');
  if (n >= 1e4) return Math.round(n / 1e3) + tr(' тыс', 'K');
  return fmtNum(n);
}

function explainer() {
  return [
    ['🧬', tr('Эволюция, а не магия', 'Evolution, not magic'),
      tr('Каждое поколение МУХА создаёт ~48 мутантов своего мозга — копий с чуть-чуть изменёнными весами. Все они играют одни и те же короткие кусочки карт.',
        'Every generation МУХА makes ~48 mutants of her brain — copies with slightly nudged weights. They all play the same short chart snippets.')],
    ['🎯', tr('Кто попал — тот и прав', 'Whoever hits is right'),
      tr('Мутанты, которые попали по большему числу нот, тянут мозг в сторону своих изменений, а промахнувшиеся — в обратную. Сотни поколений — и из случайного шума получается аим. Метод называется «эволюционные стратегии».',
        'Mutants that hit more notes pull the brain toward their changes; the ones that missed push it away. Hundreds of generations later, random noise becomes aim. The method is called evolution strategies.')],
    ['📈', tr('Учебная программа', 'A curriculum'),
      tr('Сначала — медленные простые карты. Как только она стабильно их проходит, карты становятся быстрее и сложнее: стримы, прыжки, квантовые ноты. Лёгкие уровни иногда повторяются, чтобы ничего не забыть.',
        'First slow, simple maps. Once she passes them reliably, maps get faster and harder: streams, jumps, off-grid notes. Easy levels keep coming back so nothing is forgotten.')],
    ['✋', tr('Честная рука', 'An honest hand'),
      tr('МУХА не телепортирует курсор: у руки есть предел скорости и ускорения. Поэтому ей приходится предугадывать ноты и тормозить заранее — как живому игроку.',
        'МУХА can\'t teleport the cursor: her hand has a top speed and acceleration. So she must anticipate notes and brake early — like a human player.')],
    ['⭐', tr('Ранги и ★', 'Ranks and ★'),
      tr('Каждые 5 поколений — экзамен на одних и тех же картах ★0–★20. Её сила ★ — самая сложная карта, пройденная с точностью ≥ 90%. По рекорду даются ранги: от «Личинки» до «Абсолюта».',
        'Every 5 generations she takes an exam on the same ★0–★20 charts. Her ★ skill is the hardest chart passed with ≥ 90% accuracy. Ranks follow her best: from «Larva» to «Absolute».')],
    ['🧠', tr('Что у неё в голове', 'What\'s in her head'),
      tr('Маленькая нейросеть: на входе её скорость, позиция и 4 ближайшие ноты, на выходе — куда вести руку. На вкладке «Мозг» видно, какие нейроны горят прямо сейчас.',
        'A small neural net: in go her velocity, position and the next 4 notes; out comes where to move the hand. The «Brain» tab shows which neurons fire right now.')],
  ];
}
