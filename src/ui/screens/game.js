// Gameplay screen: play / watch МУХА / versus МУХА.

import { Screen } from '../app.js';
import { h, clear } from '../dom.js';
import { tr, fmtNum } from '../i18n.js';
import { Playfield } from '../../render/playfield.js';
import { Judge } from '../../core/judge.js';
import { DEFAULT_SETTINGS, gradeFor } from '../../core/constants.js';
import { packNotes, formatTime } from '../../core/map.js';
import { AIDriver } from '../../ai/driver.js';
import { titleFor } from '../../ai/trainer.js';
import { icon } from '../icons.js';
import { win98Window } from '../win98.js';

const SENS_BASE = 0.009;          // grid units per mouse pixel at sensitivity 1 (SS+: px × 0.018 × 0.5)
const PLAYER_COLOR = '#ffffff';
const AI_COLOR = '#b6ff3b';
const LEAD_IN = 1.8;              // seconds of lead-in before the first note

export class GameScreen extends Screen {
  mount() {
    this.canvas = h('canvas.game-canvas');
    this.hud = buildHud();
    this.overlay = h('div.game-overlay');
    this.el.append(this.canvas, this.hud.root, this.overlay);
    this.pf = new Playfield(this.canvas, this.app.settings);
    this._raf = 0;
    this._onMove = (e) => this._pointerMove(e);
    this._onLockChange = () => this._lockChanged();
    this._onVis = () => { if (document.hidden && this.running && this.mode !== 'watch') this.pause(); };
    this.canvas.addEventListener('pointerdown', (e) => this._pointerDown(e));
    this.app.on('settings', (s) => this.pf.setSettings({ ...DEFAULT_SETTINGS, ...s }));
  }

  // --------------------------------------------------------------------------------------------
  show(params) {
    this.params = params;
    this.running = false;
    this.paused = false;
    this.finished = false;
    clear(this.overlay);
    const map = this.app.library.getMap(params.mapId);
    if (!map) { this.app.toast(tr('Карта не найдена', 'Map not found'), 'error'); this.app.back('select'); return; }
    this.map = map;
    this.mode = params.mode || 'play';
    const mods = { speed: 1, noFail: false, hardRock: false, mirror: false, ...(params.mods || {}) };
    this.mods = mods;
    const st = this.app.settings;
    this.pf.setSettings({ ...DEFAULT_SETTINGS, ...st });
    this.pf.particles.length = 0;
    this.pf.trails.clear();

    // notes (Mirror mod flips horizontally)
    const notes = map.notes.map((n) => ({ t: n.t, x: mods.mirror ? 2 - n.x : n.x, y: n.y }));
    this.packed = packNotes(notes);
    // Judgement settings: the hit window is 55 ms of REAL time → scale into song time by speed
    const js = {
      ...DEFAULT_SETTINGS,
      hitWindow: DEFAULT_SETTINGS.hitWindow * mods.speed * (mods.hardRock ? 0.8 : 1),
      hitbox: DEFAULT_SETTINGS.hitbox * (mods.hardRock ? 0.9 : 1),
      noFail: !!mods.noFail,
    };
    this.judgeSettings = js;
    this.pf.settings.hitWindow = js.hitWindow;
    this.player = this.mode !== 'watch' ? new Judge(this.packed, js, { recordEvents: true }) : null;
    this.ai = null;
    this.brain = null;
    if (this.mode !== 'play') {
      const brain = this.app.brains.get(params.brainId || this.app.brains.selected);
      if (!brain) {
        this.app.toast(tr('Нет доступного мозга МУХИ — обучи её в Лаборатории', 'No МУХА brain available — train her in the Lab'), 'error');
        this.app.back('select');
        return;
      }
      this.brain = brain;
      this.aiJudge = new Judge(this.packed, { ...js, noFail: true }, { recordEvents: true });
      this.ai = new AIDriver(brain, this.aiJudge, js);
    }
    this.cursor = { x: 1, y: 1 };
    this.prevJudgeT = null;
    this.healthLog = [];
    this.aiHealthLog = [];
    this.firstNote = this.packed.n ? this.packed.t[0] : 0;
    this.lastNote = this.packed.n ? this.packed.t[this.packed.n - 1] : 0;
    this.endTime = this.lastNote + 1.2;
    this.startAt = Math.min(0, this.firstNote - LEAD_IN);
    this._setupHud();
    this.setTitle(`rhythia.exe — ${map.artist ? map.artist + ' — ' : ''}${map.title} [${map.difficultyName || '?'}]${this.mode === 'watch' ? tr(' · смотрим МУХУ', ' · watching МУХА') : this.mode === 'versus' ? tr(' · против МУХИ', ' · vs МУХА') : ''}`);
    this.resize();

    // load audio, then wait for click (pointer lock needs a gesture) or start right away
    const loading = h('div.game-loading', h('div.spinner'), h('div', tr('Готовим трек…', 'Preparing the track…')));
    this.overlay.append(loading);
    this.buffer = null;
    const token = (this._token = {});
    this.app.library.getAudioBuffer(map).then((buf) => {
      if (this._token !== token) return;
      this.buffer = buf;
      loading.remove();
      if (this.mode === 'watch' || this.app.settings.cursorMode !== 'lock') this.start();
      else this._showClickToStart();
    });

    document.addEventListener('pointermove', this._onMove);
    document.addEventListener('pointerlockchange', this._onLockChange);
    document.addEventListener('visibilitychange', this._onVis);
    this._loop();
  }

  hide() {
    this._token = null;
    cancelAnimationFrame(this._raf);
    this.app.audio.stop();
    this.running = false;
    document.removeEventListener('pointermove', this._onMove);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    document.removeEventListener('visibilitychange', this._onVis);
    if (document.pointerLockElement) document.exitPointerLock?.();
  }

  resize() {
    this.pf.resize();
    const S = Math.min(this.pf.w, this.pf.h) * 0.62 / 3;
    this.el.style.setProperty('--grid', `${S * 3}px`);
  }

  // --------------------------------------------------------------------------------------------
  _showClickToStart() {
    clear(this.overlay);
    const w = win98Window({
      title: this.mode === 'versus' ? tr('Против МУХИ', 'Versus МУХА') : 'rhythia.exe',
      iconName: this.mode === 'versus' ? 'versus' : 'play',
      controls: [],
      className: 'game-start',
      body: h('div.game-start-body',
        h('div.game-start-head', icon('play', 32), h('div',
          h('div.game-start-title.display', this.map.title),
          h('div.game-start-sub', `${this.map.artist || ''} · ${this.map.difficultyName || ''} · ★${(this.map.stars || 0).toFixed(2)}`))),
        h('div.game-start-cta', tr('Кликни по полю, чтобы начать', 'Click the field to start')),
        h('div.game-start-hint', this.mode === 'versus'
          ? tr('Ты против МУХИ. Курсор захватывается — Esc для паузы.', 'You vs МУХА. The cursor gets locked — Esc to pause.')
          : tr('Курсор захватывается как в Rhythia · Esc — пауза · R — рестарт', 'The cursor is locked like in Rhythia · Esc — pause · R — restart'))),
    });
    const box = w.root;
    this.overlay.append(box);
    this._awaitingClick = true;
  }

  _pointerDown(e) {
    this.app.audio.ensure();
    if (this.app.settings.cursorMode === 'lock' && this.mode !== 'watch' && e.pointerType === 'mouse') {
      this._requestLock();
    }
    if (this._awaitingClick && this.buffer !== undefined) {
      this._awaitingClick = false;
      clear(this.overlay);
      if (this.paused) this.resume(); else this.start();
    }
  }

  _requestLock() {
    if (document.pointerLockElement === this.canvas) return;
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => { try { this.canvas.requestPointerLock(); } catch { /* ignore */ } });
    } catch {
      try { this.canvas.requestPointerLock(); } catch { /* ignore */ }
    }
  }

  _lockChanged() {
    if (!document.pointerLockElement && this.running && !this.paused && this.mode !== 'watch' && this.app.settings.cursorMode === 'lock') {
      this.pause();
    }
  }

  _pointerMove(e) {
    if (this.mode === 'watch') return;
    const st = this.app.settings;
    const b = this.judgeSettings.cursorBound ?? DEFAULT_SETTINGS.cursorBound;
    if (document.pointerLockElement === this.canvas) {
      const k = SENS_BASE * (st.sensitivity || 1);
      this.cursor.x += e.movementX * k;
      this.cursor.y += e.movementY * k;
    } else if (st.cursorMode !== 'lock' || e.pointerType !== 'mouse') {
      // absolute: map the pointer through the (previous frame's) camera onto the grid plane
      const r = this.canvas.getBoundingClientRect();
      const cam = this.pf._camera({ cursors: [{ x: this.cursor.x, y: this.cursor.y, main: true }] });
      this.cursor.x = cam.camX + (e.clientX - r.left - cam.cx) / cam.S;
      this.cursor.y = cam.camY + (e.clientY - r.top - cam.cy) / cam.S;
    } else {
      return;
    }
    this.cursor.x = Math.max(-b, Math.min(2 + b, this.cursor.x));
    this.cursor.y = Math.max(-b, Math.min(2 + b, this.cursor.y));
  }

  // --------------------------------------------------------------------------------------------
  start() {
    clear(this.overlay);
    this.running = true;
    this.paused = false;
    this.finished = false;
    this.app.audio.play(this.buffer, { startAt: this.startAt, rate: this.mods.speed });
    this.app.audio.onEnded = null;
    this.prevJudgeT = null;
    if (this.ai) this.ai.reset(this.startAt);
    if (this.firstNote - this.startAt > 7) this._showSkipHint();
  }

  _showSkipHint() {
    this.skipHint = h('div.game-skip', tr('Пробел — пропустить интро', 'Space — skip intro'));
    this.overlay.append(this.skipHint);
  }

  skipIntro() {
    const t = this.app.audio.songTime();
    const target = this.firstNote - LEAD_IN;
    if (target - t > 1) {
      this.app.audio.play(this.buffer, { startAt: target, rate: this.mods.speed });
      this.prevJudgeT = null;
      if (this.ai) this.ai.advanceTo(target);
    }
    this.skipHint?.remove();
    this.skipHint = null;
  }

  pause() {
    if (!this.running || this.paused || this.finished) return;
    this.paused = true;
    this.pausedAt = this.app.audio.pause();
    if (document.pointerLockElement) document.exitPointerLock?.();
    clear(this.overlay);
    const btn = (label, fn, primary = false) => h(`button.btn98${primary ? '.default' : ''}`, { onclick: (e) => { e.stopPropagation(); this.app.audio.sfx('ui'); fn(); } }, label);
    const w = win98Window({
      title: tr('Пауза', 'Paused'), iconName: 'play', controls: ['close'], className: 'game-pause',
      onControl: () => this.resume(),
      body: h('div.game-pause-body',
        h('div.game-pause-info', icon('info', 32), h('div', h('b', this.map.title), h('div', tr('Игра на паузе. Что делаем?', 'The game is paused. What next?')))),
        h('div.game-pause-buttons',
          btn(tr('Продолжить', 'Resume'), () => this.resume(), true),
          btn(tr('Заново', 'Restart'), () => this.restart()),
          btn(tr('Выйти', 'Quit'), () => this.app.go('select', { mode: this.mode, focusSet: this.map.setId }, { replace: true })))),
    });
    this.overlay.append(w.root);
  }

  resume() {
    if (!this.paused) return;
    if (this.app.settings.cursorMode === 'lock' && this.mode !== 'watch' && !document.pointerLockElement) {
      clear(this.overlay);
      this._showClickToStart();
      return;
    }
    clear(this.overlay);
    // rewind a little so the player can re-orient (already judged notes stay judged)
    const from = Math.max(this.startAt, this.pausedAt - 1.0 * this.mods.speed);
    this.paused = false;
    this.app.audio.play(this.buffer, { startAt: from, rate: this.mods.speed });
    this.prevJudgeT = null;
  }

  restart() {
    this.app.audio.stop();
    this.show(this.params);
  }

  keydown(e) {
    if (e.key === 'Escape') {
      if (this.paused) this.resume();
      else if (this.running && !this.finished) this.pause();
      else this.app.go('select', { mode: this.mode, focusSet: this.map?.setId }, { replace: true });
      return true;
    }
    if (e.key === '`' || e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') { this.restart(); return true; }
    if (e.key === ' ' && this.skipHint) { this.skipIntro(); return true; }
    return false;
  }

  // --------------------------------------------------------------------------------------------
  _loop() {
    let last = performance.now();
    let fpsAcc = 0, fpsN = 0;
    const frame = () => {
      this._raf = requestAnimationFrame(frame);
      const now = performance.now();
      const realDt = Math.min(0.1, (now - last) / 1000);
      last = now;
      fpsAcc += realDt; fpsN++;
      if (fpsAcc > 0.5) { this.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
      this._tick(realDt);
    };
    frame();
  }

  _tick(realDt) {
    const audio = this.app.audio;
    const t = this.running && !this.paused ? audio.songTime() : (this.paused ? this.pausedAt : this.startAt);
    const events = [];

    if (this.running && !this.paused && !this.finished) {
      // player judgement, sub-stepped with an interpolated cursor so low FPS stays fair
      if (this.player) {
        if (this.prevJudgeT == null) { this.prevJudgeT = t; this.prevCursor = { ...this.cursor }; }
        const t0 = this.prevJudgeT;
        const span = t - t0;
        const steps = Math.max(1, Math.min(32, Math.ceil(span / (1 / 240))));
        for (let k = 1; k <= steps; k++) {
          const a = k / steps;
          const cx = this.prevCursor.x + (this.cursor.x - this.prevCursor.x) * a;
          const cy = this.prevCursor.y + (this.cursor.y - this.prevCursor.y) * a;
          this.player.update(t0 + span * a, cx, cy);
        }
        this.prevJudgeT = t;
        this.prevCursor = { ...this.cursor };
        for (const ev of this.player.events) events.push(ev);
        this.player.events.length = 0;
        this._logHealth(this.healthLog, this.player, t);
      }
      if (this.ai) {
        this.ai.advanceTo(t);
        for (const ev of this.aiJudge.events) {
          if (this.mode === 'watch') events.push(ev);
          else if (ev.type === 'hit') events.push({ ...ev, color: AI_COLOR, silentFlash: true, ai: true });
        }
        this.aiJudge.events.length = 0;
        this._logHealth(this.aiHealthLog, this.aiJudge, t);
      }
      // sounds
      const st = this.app.settings;
      for (const ev of events) {
        if (ev.ai) continue;
        if (ev.type === 'hit' && st.hitSounds) audio.sfx('hit', 0.9, (this.packed.x[ev.index] - 1) * 0.35);
        else if (ev.type === 'miss' && st.missSounds) audio.sfx('miss', 0.8);
      }
      // end conditions
      const main = this.player || this.aiJudge;
      if (this.player && this.player.failed) this._fail(t);
      else if (t > this.endTime && main.finished && (!this.aiJudge || this.aiJudge.finished)) this._finish();
      if (this.skipHint && t > this.firstNote - LEAD_IN - 0.5) { this.skipHint.remove(); this.skipHint = null; }
    }

    // render
    const cursors = [];
    if (this.ai) cursors.push({ x: this.ai.x, y: this.ai.y, color: AI_COLOR, label: 'МУХА', fly: true, main: this.mode === 'watch', ghost: this.mode === 'versus' });
    if (this.player) cursors.push({ x: this.cursor.x, y: this.cursor.y, color: PLAYER_COLOR, main: true });
    this.pf.draw({
      time: t,
      realDt,
      notes: this.packed,
      state: (this.player || this.aiJudge)?.state,
      cursors,
      events,
      energy: this._energy(t),
      links: this.mode === 'watch' && this.app.settings.aiVision !== false ? this._visionLinks(t) : null,
    });
    this._updateHud(t);
  }

  /** Lines from МУХА's cursor through the upcoming notes she is looking at (her observation). */
  _visionLinks(t) {
    const j = this.aiJudge, p = this.packed;
    if (!j || !this.ai) return null;
    const links = [];
    let px = this.ai.x, py = this.ai.y, pz = 0, k = 0;
    const AR = this.app.settings.approachRate || 40;
    for (let i = j.head; i < p.n && k < 4; i++) {
      if (j.state[i] !== 0) continue;
      const z = Math.max(0, (p.t[i] - t) * AR);
      if (z > (this.app.settings.approachDistance || 36)) break;
      links.push({ x1: px, y1: py, z1: pz, x2: p.x[i], y2: p.y[i], z2: z, alpha: 0.55 - k * 0.12 });
      px = p.x[i]; py = p.y[i]; pz = z; k++;
    }
    return links;
  }

  _logHealth(log, judge, t) {
    const last = log[log.length - 1];
    const hp = judge.health / judge.s.healthMax;
    if (!last || t - last[0] > 0.25 || Math.abs(last[1] - hp) > 0.001) log.push([t, hp]);
  }

  _energy(t) {
    // local note density → background pulse
    const p = this.packed;
    if (!p || !p.n) return 0.4;
    let lo = 0, hi = p.n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (p.t[m] < t - 1) lo = m + 1; else hi = m; }
    let c = 0;
    for (let i = lo; i < p.n && p.t[i] < t + 1; i++) c++;
    return Math.max(0.15, Math.min(1, c / 14));
  }

  _fail(t) {
    if (this.finished) return;
    this.finished = true;
    this.running = false;
    const audio = this.app.audio;
    // slow-motion power-down
    try {
      if (audio.source) {
        const now = audio.ctx.currentTime;
        audio.source.playbackRate.cancelScheduledValues(now);
        audio.source.playbackRate.setValueAtTime(audio.source.playbackRate.value, now);
        audio.source.playbackRate.linearRampToValueAtTime(0.05, now + 1.2);
      }
    } catch { /* ignore */ }
    this.overlay.append(h('div.game-failed', 'FAILED'));
    if (document.pointerLockElement) document.exitPointerLock?.();
    setTimeout(() => { audio.stop(); this._goResults(); }, 1500);
  }

  _finish() {
    if (this.finished) return;
    this.finished = true;
    this.running = false;
    if (document.pointerLockElement) document.exitPointerLock?.();
    const fc = this.player ? this.player.misses === 0 : this.aiJudge.misses === 0;
    if (fc) this.overlay.append(h('div.game-fc', 'FULL COMBO'));
    setTimeout(() => {
      // let the music fade out
      const audio = this.app.audio;
      try { audio.musicGain.gain.setTargetAtTime(0, audio.ctx.currentTime, 0.4); } catch { /* ignore */ }
      setTimeout(() => { audio.stop(); audio.setVolumes(audio.volumes); this._goResults(); }, 900);
    }, fc ? 1400 : 500);
  }

  _goResults() {
    if (this.app.current !== this) return;
    const res = (judge, log) => judge ? runResult(judge, this.packed, log, this.map.duration) : null;
    this.app.go('results', {
      mapId: this.map.id,
      mode: this.mode,
      player: res(this.player, this.healthLog),
      ai: res(this.aiJudge, this.aiHealthLog),
      brainName: this.brain?.name,
      brainSkill: this.brain?.skill,
      replay: this.params,
    }, { replace: true });
  }

  // --------------------------------------------------------------------------------------------
  _setupHud() {
    const H = this.hud;
    H.title.textContent = `${this.map.artist ? this.map.artist + ' — ' : ''}${this.map.title}`;
    H.diff.textContent = `${this.map.difficultyName || ''} ★${(this.map.stars || 0).toFixed(2)}${this.mods.speed !== 1 ? ` · ${this.mods.speed}×` : ''}${this.mods.hardRock ? ' · HR' : ''}${this.mods.noFail ? ' · NF' : ''}${this.mods.mirror ? ' · MR' : ''}`;
    H.root.classList.toggle('mode-watch', this.mode === 'watch');
    H.root.classList.toggle('mode-versus', this.mode === 'versus');
    if (this.brain) {
      const tt = titleFor(this.brain.skill || 0);
      H.aiName.textContent = `${tt.emoji} ${this.brain.name}`;
      H.aiRank.textContent = `${tr(tt.ru, tt.en)} · ★${(this.brain.skill || 0).toFixed(2)}`;
    }
    this._hudCache = {};
  }

  _updateHud(t) {
    const H = this.hud;
    const c = this._hudCache || (this._hudCache = {});
    const set = (key, el, val) => { if (c[key] !== val) { c[key] = val; el.textContent = val; } };
    const main = this.player || this.aiJudge;
    if (!main) return;
    const dur = Math.max(1, this.endTime);
    const prog = Math.max(0, Math.min(1, t / dur));
    if (Math.abs((c.prog || 0) - prog) > 0.002) { c.prog = prog; H.progress.style.transform = `scaleX(${prog})`; }
    set('time', H.time, `${formatTime(t)} / ${formatTime(this.lastNote)}`);
    set('acc', H.acc, (main.accuracy * 100).toFixed(2) + '%');
    const g = gradeFor(main.accuracy);
    if (c.grade !== g.name) { c.grade = g.name; H.grade.textContent = g.name; H.grade.style.color = g.color; }
    set('combo', H.combo, main.combo ? String(main.combo) : '');
    set('mult', H.mult, `${main.multiplier}×`);
    const mp = main.multiplier >= main.s.maxMultiplier ? 1 : main.multProgress / main.s.hitsPerMultiplier;
    if (c.mp !== mp) { c.mp = mp; H.multRing.style.setProperty('--p', mp); }
    set('score', H.score, fmtNum(main.score));
    set('hits', H.hits, `${main.hits} / ${this.packed.n}`);
    set('miss', H.miss, String(main.misses));
    const hp = main.health / main.s.healthMax;
    if (c.hp !== hp) { c.hp = hp; H.health.style.transform = `scaleX(${hp})`; H.healthWrap.classList.toggle('low', hp <= 0.4); }
    set('fps', H.fps, this.app.settings.showFps ? `${Math.round(this.fps || 0)} FPS` : '');
    if (this.mode === 'versus' && this.aiJudge) {
      const a = this.aiJudge;
      set('aiAcc', H.aiAcc, (a.accuracy * 100).toFixed(2) + '%');
      set('aiScore', H.aiScore, fmtNum(a.score));
      set('aiCombo', H.aiCombo, `${a.combo}×`);
      const total = Math.max(1, main.score + a.score);
      const share = main.score / total;
      if (Math.abs((c.share ?? -1) - share) > 0.003) { c.share = share; H.tug.style.setProperty('--share', share); }
    } else if (this.mode === 'watch' && this.ai) {
      const v = Math.hypot(this.ai.pilot.vx, this.ai.pilot.vy);
      set('aiSpeed', H.aiSpeed, `${tr('скорость', 'speed')} ${v.toFixed(1)}`);
    }
  }
}

function runResult(judge, packed, healthLog, duration) {
  const s = judge.summary();
  const notes = [];
  for (let i = 0; i < packed.n; i++) {
    const st = judge.state[i];
    if (st === 0) continue;
    notes.push({ t: packed.t[i], hit: st === 1, dx: judge.hitDx[i], dy: judge.hitDy[i] });
  }
  return { ...s, grade: gradeFor(s.accuracy, s.failed), notes, health: healthLog, duration: duration || (packed.n ? packed.t[packed.n - 1] + 2 : 0) };
}

function buildHud() {
  const title = h('div.hud-title');
  const diff = h('div.hud-diff');
  const time = h('div.hud-time.mono');
  const progress = h('div.hud-progress-fill');
  const acc = h('div.hud-acc.mono');
  const grade = h('div.hud-grade');
  const combo = h('div.hud-combo-big');
  const mult = h('div.hud-mult');
  const multRing = h('div.hud-mult-ring', mult);
  const score = h('div.hud-score.mono');
  const hits = h('div.hud-hits.mono');
  const miss = h('div.hud-miss.mono');
  const health = h('div.hud-health-fill');
  const healthWrap = h('div.hud-health', health);
  const fps = h('div.hud-fps.mono');
  const aiName = h('div.hud-ai-name');
  const aiRank = h('div.hud-ai-rank');
  const aiAcc = h('div.hud-ai-acc.mono');
  const aiScore = h('div.hud-ai-score.mono');
  const aiCombo = h('div.hud-ai-combo.mono');
  const aiSpeed = h('div.hud-ai-speed.mono');
  const tug = h('div.hud-tug', h('div.hud-tug-you', tr('ТЫ', 'YOU')), h('div.hud-tug-bar', h('div.hud-tug-fill')), h('div.hud-tug-ai', 'МУХА'));
  const root = h('div.hud',
    h('div.hud-top', h('div.hud-progress', progress), h('div.hud-top-row', h('div.hud-song', title, diff), time)),
    combo,
    h('div.hud-left', h('div.hud-label', tr('ТОЧНОСТЬ', 'ACCURACY')), acc, grade, multRing),
    h('div.hud-right', h('div.hud-label', tr('ОЧКИ', 'SCORE')), score,
      h('div.hud-label', tr('НОТЫ', 'NOTES')), hits,
      h('div.hud-label', tr('ПРОМАХИ', 'MISSES')), miss),
    h('div.hud-bottom', healthWrap),
    h('div.hud-ai.win', h('div.win-title', icon('fly', 16, 'win-title-icon'), h('div.win-title-text', 'МУХА.exe')), h('div.hud-ai-body', aiName, aiRank, h('div.hud-ai-stats', aiAcc, aiScore, aiCombo, aiSpeed))),
    tug,
    fps);
  return { root, title, diff, time, progress, acc, grade, combo, mult, multRing, score, hits, miss, health, healthWrap, fps, aiName, aiRank, aiAcc, aiScore, aiCombo, aiSpeed, tug };
}
