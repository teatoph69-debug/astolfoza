// Settings: gameplay, graphics, sound (+ audio offset calibration), МУХА, language, data.
// Every control writes straight into app.settings and calls app.saveSettings() immediately.

import { Screen, DEFAULT_APP_SETTINGS, mergeDeep } from '../app.js';
import { h, clear } from '../dom.js';
import { tr, setLang, getLang } from '../i18n.js';
import { downloadFile, pickFiles } from '../store.js';
import { COLOR_SETS } from '../../core/constants.js';
import { packNotes } from '../../core/map.js';
import { HAND_PRESETS } from '../../ai/agent.js';
import { syntheticMap } from '../../maps/patterns.js';
import { Playfield } from '../../render/playfield.js';
import { icon, uiSfx, uiButton, confirmDialog, isModalOpen } from './menu.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const COLOR_SET_EN = { 'Неон': 'Neon', 'Радуга': 'Rainbow', 'Лёд': 'Ice', 'Закат': 'Sunset', 'Моно': 'Mono' };

const HAND_TEXT = {
  human: {
    ru: 'Двигается как живой игрок: ограниченные скорость и ускорение. Честный соперник — её можно обыграть.',
    en: 'Moves like a real player: limited speed and acceleration. A fair opponent — it can be beaten.',
  },
  pro: {
    ru: 'Как у топ-игрока Rhythia: резкие прыжки через всю сетку, но всё ещё физика руки.',
    en: 'Like a top Rhythia player: snappy full-grid jumps, but still bound by hand physics.',
  },
  cyber: {
    ru: 'Без человеческих ограничений — чистая реакция нейросети. Нечестно, зато красиво.',
    en: 'No human limits — pure neural-network reflexes. Unfair, but beautiful.',
  },
};

export class SettingsScreen extends Screen {
  mount() {
    this.root = h('div.set-wrap');
    this.el.appendChild(this.root);
    this.visible = false;
  }

  show() {
    this.visible = true;
    this.build();
    this._startPreview();
  }

  hide() {
    this.visible = false;
    this._stopPreview();
    this._calib?.stop();
  }

  resize() { if (this.pf) try { this.pf.resize(); } catch { /* ignore */ } }

  save(changedKey) {
    this.app.saveSettings();
    if (this.pf) try { this.pf.setSettings(this._pfSettings()); } catch { /* ignore */ }
    if (changedKey === 'approach') this._updateApproachReadout();
  }

  // ---- controls ----------------------------------------------------------------------------------

  _row(label, hint, ctrl, cls = '') {
    return h(`div.set-row${cls}`, h('div.set-row-text', h('div.set-row-label', label), hint ? h('div.set-row-hint', hint) : null), h('div.set-row-ctrl', ctrl));
  }

  _slider({ get, set, min, max, step, fmt, onchange, key }) {
    const val = h('output.set-val', fmt(get()));
    const input = h('input.set-range', {
      type: 'range', min, max, step, value: get(),
      oninput: () => { const v = Number(input.value); set(v); val.textContent = fmt(v); paint(); this.save(key); },
      onchange: () => onchange && onchange(Number(input.value)),
    });
    const paint = () => input.style.setProperty('--p', ((Number(input.value) - min) / (max - min) * 100).toFixed(1) + '%');
    paint();
    this._resetters.push(() => { input.value = get(); val.textContent = fmt(get()); paint(); });
    return h('div.set-slider', input, val);
  }

  _toggle({ get, set, key }) {
    const input = h('input', { type: 'checkbox', checked: !!get(), onchange: () => { uiSfx(this.app, 'ui', 0.4); set(input.checked); this.save(key); } });
    this._resetters.push(() => { input.checked = !!get(); });
    return h('label.toggle.set-toggle', input, h('span'));
  }

  _seg(options, { get, set, key, onchange }) {
    const wrap = h('div.set-seg', { role: 'radiogroup' });
    const render = () => {
      clear(wrap);
      for (const [v, label] of options) {
        wrap.appendChild(h(`button.set-seg-btn${get() === v ? '.on' : ''}`, {
          type: 'button', role: 'radio', 'aria-checked': String(get() === v),
          onclick: () => { if (get() === v) return; uiSfx(this.app, 'ui', 0.4); set(v); this.save(key); render(); onchange && onchange(v); },
        }, label));
      }
    };
    render();
    this._resetters.push(render);
    return wrap;
  }

  // ---- DOM -----------------------------------------------------------------------------------

  build() {
    const app = this.app;
    const S = app.settings;
    this._resetters = [];
    const sections = [
      ['gameplay', 'mouse', tr('Геймплей', 'Gameplay')],
      ['graphics', 'monitor', tr('Графика', 'Graphics')],
      ['sound', 'volume', tr('Звук', 'Sound')],
      ['fly', 'fly', tr('МУХА', 'МУХА')],
      ['lang', 'lang', tr('Язык', 'Language')],
      ['data', 'db', tr('Данные', 'Data')],
    ];
    const pct = (v) => Math.round(v * 100) + '%';
    const setK = (k) => (v) => { S[k] = v; };
    const getK = (k) => () => S[k];

    // --- gameplay
    this.approachOut = h('div.set-approach');
    const gameplay = [
      this._row(tr('Скорость подлёта (AR)', 'Approach rate (AR)'), tr('Как быстро ноты летят к сетке, клеток в секунду', 'How fast notes fly toward the grid, cells per second'),
        this._slider({ get: getK('approachRate'), set: setK('approachRate'), min: 10, max: 120, step: 1, fmt: (v) => String(v), key: 'approach' })),
      this._row(tr('Дистанция появления (AD)', 'Approach distance (AD)'), tr('Как далеко от сетки появляются ноты', 'How far from the grid notes spawn'),
        this._slider({ get: getK('approachDistance'), set: setK('approachDistance'), min: 5, max: 60, step: 1, fmt: (v) => String(v), key: 'approach' })),
      this.approachOut,
      this._row(tr('Параллакс камеры', 'Camera parallax'), tr('Насколько камера следует за курсором', 'How much the camera follows the cursor'),
        this._slider({ get: getK('parallax'), set: setK('parallax'), min: 0, max: 1, step: 0.0125, fmt: (v) => v.toFixed(3) })),
      this._row(tr('Spin-камера', 'Spin camera'), tr('Камера поворачивается за курсором, как в Spin-режиме Rhythia', 'The camera turns toward the cursor, like Rhythia’s spin mode'),
        this._toggle({ get: getK('spin'), set: setK('spin') })),
      this._row(tr('Режим курсора', 'Cursor mode'), tr('Захват — относительное движение, как в Rhythia (клик по полю). Абсолютный — курсор там же, где мышь.', 'Lock — relative movement like Rhythia (click the field). Absolute — the cursor is where your mouse is.'),
        this._seg([['lock', tr('Захват', 'Lock')], ['absolute', tr('Абсолютный', 'Absolute')]], { get: getK('cursorMode'), set: setK('cursorMode') })),
      this._row(tr('Чувствительность', 'Sensitivity'), tr('Скорость курсора в режиме захвата', 'Cursor speed in lock mode'),
        this._slider({ get: getK('sensitivity'), set: setK('sensitivity'), min: 0.1, max: 4, step: 0.05, fmt: (v) => v.toFixed(2) + '×' })),
      this._row(tr('Поле зрения (FOV)', 'Field of view (FOV)'), null,
        this._slider({ get: getK('fov'), set: setK('fov'), min: 50, max: 110, step: 1, fmt: (v) => v + '°' })),
    ];

    // --- graphics
    const swatches = h('div.set-swatches', { role: 'radiogroup' });
    const renderSwatches = () => {
      clear(swatches);
      for (const [name, colors] of Object.entries(COLOR_SETS)) {
        const on = S.colorSet === name;
        swatches.appendChild(h(`button.set-swatch${on ? '.on' : ''}`, {
          type: 'button', role: 'radio', 'aria-checked': String(on), title: name,
          onclick: () => { if (on) return; uiSfx(app, 'ui', 0.4); S.colorSet = name; this.save(); renderSwatches(); },
        },
        h('span.set-swatch-colors', colors.map((c) => h('i', { style: `--c:${c}` }))),
        h('span.set-swatch-name', getLang() === 'en' ? (COLOR_SET_EN[name] || name) : name)));
      }
    };
    renderSwatches();
    this._resetters.push(renderSwatches);
    const graphics = [
      this._row(tr('Цвета нот', 'Note colours'), tr('Ноты чередуют цвета набора', 'Notes cycle through the set’s colours'), swatches, '.set-row-wide'),
      this._row(tr('След курсора', 'Cursor trail'), null, this._toggle({ get: getK('cursorTrail'), set: setK('cursorTrail') })),
      this._row(tr('Качество', 'Quality'), tr('Низкое — без свечения и частиц, для слабых ПК и телефонов', 'Low — no glow or particles, for slow PCs and phones'),
        this._seg([['high', tr('Высокое', 'High')], ['low', tr('Низкое', 'Low')]], { get: getK('quality'), set: setK('quality') })),
      this._row(tr('Затемнение фона', 'Background dim'), null,
        this._slider({ get: getK('backgroundDim'), set: setK('backgroundDim'), min: 0, max: 1, step: 0.05, fmt: pct })),
      this._row(tr('Прозрачность нот', 'Note opacity'), null,
        this._slider({ get: getK('noteOpacity'), set: setK('noteOpacity'), min: 0.2, max: 1, step: 0.05, fmt: pct })),
      this._row(tr('Показывать FPS', 'Show FPS'), null, this._toggle({ get: getK('showFps'), set: setK('showFps') })),
    ];

    // --- sound
    const vol = (k) => ({ get: () => S.volumes[k], set: (v) => { S.volumes[k] = v; } });
    const ms = (v) => (v > 0 ? '+' : '') + Math.round(v) + tr(' мс', ' ms');
    const sound = [
      this._row(tr('Общая громкость', 'Master volume'), null, this._slider({ ...vol('master'), min: 0, max: 1, step: 0.01, fmt: pct, onchange: () => uiSfx(app, 'hit', 1) })),
      this._row(tr('Музыка', 'Music'), null, this._slider({ ...vol('music'), min: 0, max: 1, step: 0.01, fmt: pct })),
      this._row(tr('Эффекты', 'Effects'), null, this._slider({ ...vol('sfx'), min: 0, max: 1, step: 0.01, fmt: pct, onchange: () => uiSfx(app, 'hit', 1) })),
      this._row(tr('Звук попадания', 'Hit sounds'), null, this._toggle({ get: getK('hitSounds'), set: setK('hitSounds') })),
      this._row(tr('Звук промаха', 'Miss sounds'), null, this._toggle({ get: getK('missSounds'), set: setK('missSounds') })),
      this._row(tr('Смещение аудио', 'Audio offset'), tr('Плюс — ноты позже, минус — раньше. Не уверен? Жми «Калибровка».', 'Plus — notes later, minus — earlier. Not sure? Hit “Calibrate”.'),
        h('div.set-offset',
          this._slider({ get: getK('offsetMs'), set: setK('offsetMs'), min: -300, max: 300, step: 1, fmt: ms }),
          uiButton(app, '.btn.btn-sm.set-calib-open', { onclick: () => this._openCalibration() }, icon('target'), tr('Калибровка', 'Calibrate')))),
    ];

    // --- МУХА
    const hands = h('div.set-hands', { role: 'radiogroup' });
    const maxSpeed = Math.max(...Object.values(HAND_PRESETS).map((p) => p.maxSpeed));
    const maxAcc = Math.max(...Object.values(HAND_PRESETS).map((p) => p.maxAccel));
    const renderHands = () => {
      clear(hands);
      for (const p of Object.values(HAND_PRESETS)) {
        const on = S.aiHand === p.id;
        const text = HAND_TEXT[p.id] || { ru: '', en: '' };
        hands.appendChild(h(`button.set-hand${on ? '.on' : ''}`, {
          type: 'button', role: 'radio', 'aria-checked': String(on),
          onclick: () => { if (on) return; uiSfx(app, 'ui', 0.4); S.aiHand = p.id; this.save(); renderHands(); },
        },
        h('span.set-hand-name', getLang() === 'en' ? p.en : p.ru),
        h('span.set-hand-text', getLang() === 'en' ? text.en : text.ru),
        h('span.set-hand-bars',
          h('span.set-hand-bar', h('span', tr('скорость', 'speed')), h('i', h('b', { style: `width:${(p.maxSpeed / maxSpeed * 100).toFixed(0)}%` })), h('em', p.maxSpeed)),
          h('span.set-hand-bar', h('span', tr('ускорение', 'accel')), h('i', h('b', { style: `width:${(p.maxAccel / maxAcc * 100).toFixed(0)}%` })), h('em', p.maxAccel)))));
      }
    };
    renderHands();
    this._resetters.push(renderHands);
    const fly = [
      this._row(tr('Рука МУХИ', 'МУХА’s hand'), tr('Физика курсора, которым управляет нейросеть — и при игре, и при обучении', 'The physics of the cursor the network steers — both when playing and training'), hands, '.set-row-wide'),
      this._row(tr('Линии зрения МУХИ', 'МУХА’s vision lines'), tr('В режиме просмотра МУХА рисует пунктир к нотам, которые планирует поймать', 'In watch mode МУХА draws dashed lines to the notes she is planning to catch'),
        this._toggle({ get: () => S.aiVision !== false, set: (v) => { S.aiVision = v; } })),
    ];

    // --- language
    const langRow = [
      this._row(tr('Язык интерфейса', 'Interface language'), null,
        this._seg([['ru', 'Русский'], ['en', 'English']], {
          get: () => getLang(),
          set: (v) => { setLang(v); S.lang = v; },
          onchange: () => { this.build(); this._startPreview(true); },
        })),
    ];

    // --- data
    const data = [
      this._row(tr('Экспорт настроек', 'Export settings'), tr('Сохрани настройки в JSON, чтобы перенести на другой компьютер', 'Save your settings as JSON to move them to another computer'),
        h('div.set-btns',
          uiButton(app, '.btn.btn-sm', { onclick: () => this._exportDownload() }, icon('export'), tr('Скачать .json', 'Download .json')),
          uiButton(app, '.btn.btn-sm', { onclick: () => this._exportCopy() }, icon('file'), tr('Скопировать', 'Copy')))),
      this._row(tr('Импорт настроек', 'Import settings'), tr('Из файла .json или вставкой текста', 'From a .json file or by pasting text'),
        h('div.set-btns', uiButton(app, '.btn.btn-sm', { onclick: () => this._openImport() }, icon('import'), tr('Импорт…', 'Import…')))),
      this._row(tr('Сбросить настройки', 'Reset settings'), tr('Все параметры вернутся к стандартным (язык останется)', 'Everything returns to defaults (language is kept)'),
        h('div.set-btns', uiButton(app, '.btn.btn-sm.btn-danger', { onclick: () => this._reset() }, icon('retry'), tr('Сбросить', 'Reset')))),
      this._row(tr('Очистить рекорды', 'Clear records'), tr('Удалит лучшие результаты на всех картах', 'Deletes your best scores on every map'),
        h('div.set-btns', uiButton(app, '.btn.btn-sm.btn-danger', { onclick: () => this._clearRecords() }, icon('trash'), tr('Очистить', 'Clear')))),
    ];

    const bodies = { gameplay, graphics, sound, fly, lang: langRow, data };
    this.navBtns = new Map();
    const nav = h('nav.set-nav', sections.map(([id, ic, label]) => {
      const b = h('button.set-nav-btn', { type: 'button', dataset: { sec: id }, onclick: () => { uiSfx(app, 'ui', 0.4); this._scrollTo(id); } }, icon(ic), h('span', label));
      this.navBtns.set(id, b);
      return b;
    }));
    this.secEls = new Map();
    this.content = h('div.set-content.scroll', { onscroll: () => this._spy() },
      sections.map(([id, ic, label]) => {
        const sec = h('section.set-sec', { dataset: { sec: id } }, h('h2.set-sec-title', icon(ic), label), h('div.set-sec-body', bodies[id]));
        this.secEls.set(id, sec);
        return sec;
      }),
      h('div.set-foot', tr('Все изменения сохраняются сразу.', 'All changes are saved instantly.')));

    this.pfCanvas = h('canvas.set-pf-canvas');
    const preview = h('aside.set-preview',
      h('div.set-preview-head', icon('eye'), tr('Предпросмотр', 'Preview')),
      h('div.set-pf', this.pfCanvas),
      h('div.set-preview-hint', tr('Так будут выглядеть ноты с текущими настройками', 'This is how notes will look with the current settings')));

    clear(this.root).append(
      h('header.set-head',
        uiButton(app, '.set-back', { title: tr('Назад (Esc)', 'Back (Esc)'), onclick: () => app.back() }, icon('back')),
        h('h1.set-title', tr('Настройки', 'Settings')),
        uiButton(app, '.btn.btn-sm.btn-ghost.set-reset-all', { onclick: () => this._reset() }, icon('retry'), h('span', tr('По умолчанию', 'Defaults')))),
      h('div.set-body', nav, this.content, preview));
    this._updateApproachReadout();
    this._spy();
  }

  _updateApproachReadout() {
    const S = this.app.settings;
    if (!this.approachOut) return;
    const ms = Math.round((S.approachDistance / Math.max(1, S.approachRate)) * 1000);
    clear(this.approachOut).append(icon('clock'), tr('Нота видна ', 'A note is visible for '), h('b', ms + tr(' мс', ' ms')), tr(' до сетки', ' before the grid'));
  }

  _scrollTo(id) {
    const sec = this.secEls.get(id);
    if (!sec) return;
    this.content.scrollTo({ top: sec.offsetTop - this.content.offsetTop - 8, behavior: 'smooth' });
    this._activeSec = id;
    for (const [k, b] of this.navBtns) b.classList.toggle('on', k === id);
  }

  _spy() {
    if (!this.secEls) return;
    const top = this.content.scrollTop + 40;
    let cur = null;
    for (const [id, sec] of this.secEls) if (sec.offsetTop - this.content.offsetTop <= top) cur = id;
    if (this.content.scrollTop + this.content.clientHeight >= this.content.scrollHeight - 4) cur = [...this.secEls.keys()].pop();
    cur = cur || 'gameplay';
    for (const [k, b] of this.navBtns) b.classList.toggle('on', k === cur);
  }

  // ---- preview -------------------------------------------------------------------------------------

  _pfSettings() {
    const s = this.app.settings;
    return { approachRate: s.approachRate, approachDistance: s.approachDistance, parallax: s.parallax, colorSet: s.colorSet, cursorTrail: s.cursorTrail, quality: s.quality, spin: s.spin, fov: s.fov, noteOpacity: s.noteOpacity, backgroundDim: s.backgroundDim };
  }

  _startPreview(rebuilt = false) {
    if (rebuilt) this._stopPreview();
    if (this._raf) return;
    try {
      this.pf = new Playfield(this.pfCanvas, this._pfSettings());
    } catch (e) {
      console.warn('preview renderer unavailable', e);
      this.pf = null;
      return;
    }
    if (!this._pvNotes) this._pvNotes = packNotes(syntheticMap(4.5, 777, 40));
    const p = this._pvNotes;
    const state = new Uint8Array(p.n);
    let time = p.t[0] - 1.2, head = 0, last = performance.now();
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (document.hidden || !this.pfCanvas.isConnected) return;
      time += dt;
      if (time > p.t[p.n - 1] + 1) { time = p.t[0] - 1.2; head = 0; state.fill(0); }
      const events = [];
      while (head < p.n && p.t[head] <= time) { state[head] = 1; events.push({ type: 'hit', index: head, time }); head++; }
      const px = head > 0 ? p.x[head - 1] : 1, py = head > 0 ? p.y[head - 1] : 1, pt = head > 0 ? p.t[head - 1] : time - 1;
      let cx = px, cy = py;
      if (head < p.n) {
        const u = clamp((time - pt) / (Math.max(0.03, p.t[head] - pt) * 0.85), 0, 1);
        const e = u * u * (3 - 2 * u);
        cx = px + (p.x[head] - px) * e;
        cy = py + (p.y[head] - py) * e;
      }
      try {
        this.pf.resize();
        this.pf.draw({ time, notes: p, state, cursors: [{ x: cx, y: cy, color: '#ffffff', main: true }], events, energy: 0.5, realDt: dt });
      } catch (e) {
        console.warn('preview draw failed', e);
        this._stopPreview();
      }
    };
    this._raf = requestAnimationFrame(loop);
  }

  _stopPreview() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  // ---- calibration ---------------------------------------------------------------------------------
  // A 120 BPM metronome on the audio clock; the player taps Space (or the pad) along. Each tap's error
  // against the nearest click is measured on the same clock the game uses (output latency included),
  // so the robust mean of the errors is exactly the offset to apply.

  _openCalibration() {
    const app = this.app;
    const actx = app.audio.ensure();
    const BPM = 120, SPB = 60 / BPM;
    const RANGE = 200; // ms shown on the scale
    const st = { running: false, t0: 0, next: 0, beat: 0, errs: [], timer: 0, raf: 0 };
    const beatDot = h('div.set-cal-beat');
    const pad = h('button.set-cal-pad', { type: 'button', onpointerdown: (e) => { e.preventDefault(); tap(e); } },
      beatDot, h('span.set-cal-pad-text', tr('Тапай в такт', 'Tap to the beat')), h('span.set-cal-pad-sub', tr('или жми Пробел', 'or press Space')));
    const scale = h('div.set-cal-scale', h('i.set-cal-zero'), h('span.set-cal-lbl.l', `−${RANGE}`), h('span.set-cal-lbl.r', `+${RANGE}`));
    const marker = h('i.set-cal-mean');
    scale.appendChild(marker);
    const out = h('div.set-cal-out');
    const startBtn = uiButton(app, '.btn.btn-primary', { onclick: () => (st.running ? stop() : start()) });
    const applyBtn = uiButton(app, '.btn', { onclick: () => apply() }, icon('check'), tr('Применить', 'Apply'));
    const robust = () => {
      const e = st.errs.slice(-32);
      if (e.length < 4) return null;
      const s = e.slice().sort((a, b) => a - b);
      const med = s[s.length >> 1];
      const keep = e.filter((x) => Math.abs(x - med) < 70);
      const mean = keep.reduce((a, b) => a + b, 0) / Math.max(1, keep.length);
      const sd = Math.sqrt(keep.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, keep.length));
      return { mean, sd, n: e.length };
    };
    const render = () => {
      clear(startBtn).append(icon(st.running ? 'x' : 'play'), st.running ? tr('Стоп', 'Stop') : tr('Старт', 'Start'));
      const r = robust();
      applyBtn.disabled = !r;
      marker.style.opacity = r ? '1' : '0';
      if (r) marker.style.left = `${clamp(50 + (r.mean / RANGE) * 50, 0, 100)}%`;
      clear(out).append(
        h('div.set-cal-stat', h('span', tr('Тапов', 'Taps')), h('b', String(st.errs.length))),
        h('div.set-cal-stat', h('span', tr('Среднее', 'Average')), h('b', r ? `${r.mean > 0 ? '+' : ''}${Math.round(r.mean)} ${tr('мс', 'ms')}` : '—')),
        h('div.set-cal-stat', h('span', tr('Разброс', 'Spread')), h('b', r ? `±${Math.round(r.sd)} ${tr('мс', 'ms')}` : '—')),
        h('div.set-cal-stat', h('span', tr('Сейчас', 'Current')), h('b', `${app.settings.offsetMs > 0 ? '+' : ''}${Math.round(app.settings.offsetMs)} ${tr('мс', 'ms')}`)));
    };
    const click = (time, accent) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = accent ? 1560 : 1040;
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.7, time + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
      o.connect(g).connect(app.audio.sfxGain || actx.destination);
      o.start(time);
      o.stop(time + 0.06);
    };
    const schedule = () => {
      while (st.next < actx.currentTime + 0.3) {
        click(st.next, st.beat % 4 === 0);
        st.next += SPB;
        st.beat++;
      }
    };
    const anim = () => {
      st.raf = requestAnimationFrame(anim);
      const heard = actx.currentTime - (app.audio.latency || 0);
      const ph = ((heard - st.t0) / SPB) % 1;
      const k = ph < 0 ? 0 : Math.exp(-ph * 7);
      beatDot.style.transform = `scale(${1 + k * 0.6})`;
      beatDot.style.opacity = String(0.25 + k * 0.75);
    };
    const start = () => {
      actx.resume?.();
      st.running = true;
      st.errs = [];
      clear(scale).append(h('i.set-cal-zero'), h('span.set-cal-lbl.l', `−${RANGE}`), h('span.set-cal-lbl.r', `+${RANGE}`), marker);
      st.t0 = actx.currentTime + 0.4;
      st.next = st.t0;
      st.beat = 0;
      schedule();
      st.timer = setInterval(schedule, 50);
      cancelAnimationFrame(st.raf);
      anim();
      render();
    };
    const stop = () => {
      st.running = false;
      clearInterval(st.timer);
      cancelAnimationFrame(st.raf);
      beatDot.style.opacity = '0.25';
      beatDot.style.transform = '';
      render();
    };
    const tap = (e) => {
      if (!st.running) { start(); return; }
      const lag = e && e.timeStamp ? Math.max(0, (performance.now() - e.timeStamp) / 1000) : 0;
      const heard = actx.currentTime - lag - (app.audio.latency || 0);
      const k = Math.round((heard - st.t0) / SPB);
      if (k < 2) return;                            // ignore the first couple of beats
      const err = (heard - (st.t0 + k * SPB)) * 1000;
      if (Math.abs(err) > 220) return;
      st.errs.push(err);
      const tick = h('i.set-cal-tick', { style: `left:${clamp(50 + (err / RANGE) * 50, 0, 100)}%` });
      scale.appendChild(tick);
      pad.classList.remove('hit');
      void pad.offsetWidth;
      pad.classList.add('hit');
      render();
    };
    const apply = () => {
      const r = robust();
      if (!r) return;
      app.settings.offsetMs = Math.round(clamp(r.mean, -300, 300));
      this.save();
      for (const f of this._resetters) f();
      app.toast(tr(`Смещение: ${app.settings.offsetMs > 0 ? '+' : ''}${app.settings.offsetMs} мс`, `Offset: ${app.settings.offsetMs > 0 ? '+' : ''}${app.settings.offsetMs} ms`), 'success');
      close();
    };
    const body = h('div.set-cal',
      h('p.set-cal-text', tr('Метроном играет 120 BPM. Нажимай Пробел (или тапай по кнопке) точно на щелчки — по звуку, не глядя на экран. После 10–20 тапов нажми «Применить».',
        'The metronome plays at 120 BPM. Press Space (or tap the pad) exactly on the clicks — by ear, not by watching. After 10–20 taps hit “Apply”.')),
      pad, scale, out,
      h('div.set-cal-actions', startBtn, applyBtn));
    this._calib = { tap, stop, get running() { return st.running; } };
    const close = app.modal(body, { title: tr('Калибровка смещения', 'Offset calibration'), onClose: () => { stop(); this._calib = null; } });
    render();
    start();
  }

  // ---- data --------------------------------------------------------------------------------------------

  _json() { return JSON.stringify(this.app.settings, null, 2); }

  _exportDownload() {
    try { downloadFile('muxa-settings.json', this._json(), 'application/json'); } catch (e) { console.warn(e); }
    this.app.toast(tr('Если загрузка не началась — используй «Скопировать».', 'If the download didn’t start, use “Copy”.'), 'info', 4000);
  }

  _exportCopy() {
    const text = this._json();
    const fallback = () => {
      const ta = h('textarea.set-json', { readonly: true, spellcheck: false });
      ta.value = text;
      this.app.modal(h('div.set-json-wrap', h('p.set-json-text', tr('Не удалось скопировать автоматически — выдели текст и скопируй вручную (Ctrl+C).', 'Couldn’t copy automatically — select the text and copy it manually (Ctrl+C).')), ta), { title: tr('Настройки (JSON)', 'Settings (JSON)'), wide: true });
      setTimeout(() => { ta.focus(); ta.select(); }, 60);
    };
    try {
      const p = navigator.clipboard && navigator.clipboard.writeText(text);
      if (!p) { fallback(); return; }
      p.then(() => this.app.toast(tr('Настройки скопированы в буфер обмена', 'Settings copied to the clipboard'), 'success'), fallback);
    } catch { fallback(); }
  }

  _applyImported(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(tr('это не объект настроек', 'not a settings object'));
    const lang = this.app.settings.lang;
    const fresh = mergeDeep(clone(DEFAULT_APP_SETTINGS), this.app.settings);
    mergeDeep(fresh, obj);
    for (const k of Object.keys(fresh)) this.app.settings[k] = fresh[k];
    if (this.app.settings.lang !== lang) setLang(this.app.settings.lang);
    this.save();
    this.build();
    this._startPreview(true);
    this.app.toast(tr('Настройки импортированы', 'Settings imported'), 'success');
  }

  _openImport() {
    const app = this.app;
    const ta = h('textarea.set-json', { spellcheck: false, placeholder: '{ "approachRate": 40, … }' });
    let close = null;
    const applyText = () => {
      try { this._applyImported(JSON.parse(ta.value)); close && close(); } catch (e) { app.toast(tr('Ошибка JSON: ', 'JSON error: ') + (e.message || e), 'error', 5000); }
    };
    const fromFile = async () => {
      const files = await pickFiles('.json,application/json', false);
      if (!files.length) return;
      try { ta.value = await files[0].text(); applyText(); } catch (e) { app.toast(String(e.message || e), 'error'); }
    };
    close = app.modal(h('div.set-json-wrap',
      h('p.set-json-text', tr('Вставь JSON настроек или выбери файл.', 'Paste settings JSON or pick a file.')),
      ta,
      h('div.set-cal-actions',
        uiButton(app, '.btn', { onclick: fromFile }, icon('file'), tr('Из файла…', 'From file…')),
        uiButton(app, '.btn.btn-primary', { onclick: applyText }, icon('check'), tr('Применить', 'Apply')))),
    { title: tr('Импорт настроек', 'Import settings'), wide: true });
    setTimeout(() => ta.focus(), 60);
  }

  async _reset() {
    const app = this.app;
    const ok = await confirmDialog(app, {
      title: tr('Сбросить настройки?', 'Reset settings?'),
      text: tr('Все параметры вернутся к стандартным. Язык, карты, рекорды и МУХА не пострадают.', 'All options return to their defaults. Language, maps, records and МУХА are untouched.'),
      ok: tr('Сбросить', 'Reset'), cancel: tr('Отмена', 'Cancel'), danger: true,
    });
    if (!ok) return;
    const lang = app.settings.lang;
    const def = clone(DEFAULT_APP_SETTINGS);
    for (const k of Object.keys(def)) app.settings[k] = def[k];
    app.settings.lang = lang;
    this.save();
    this.build();
    this._startPreview(true);
    app.toast(tr('Настройки сброшены', 'Settings reset'), 'success');
  }

  async _clearRecords() {
    const app = this.app;
    const ok = await confirmDialog(app, {
      title: tr('Очистить рекорды?', 'Clear records?'),
      text: tr('Лучшие результаты на всех картах будут удалены. Это нельзя отменить.', 'Best scores on every map will be deleted. This can’t be undone.'),
      ok: tr('Удалить', 'Delete'), cancel: tr('Отмена', 'Cancel'), danger: true,
    });
    if (!ok) return;
    let n = 0;
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('muxa.best.')) keys.push(k); }
      for (const k of keys) { localStorage.removeItem(k); n++; }
    } catch { /* storage unavailable */ }
    app.toast(tr(`Удалено рекордов: ${n}`, `Records deleted: ${n}`), 'success');
  }

  // ---- keyboard --------------------------------------------------------------------------------------

  keydown(e) {
    if (this._calib && this._calib.running !== undefined && isModalOpen(this.app)) {
      if (e.key === ' ' || e.code === 'Space') { if (!e.repeat) this._calib.tap(e); return true; }
      return false;
    }
    if (isModalOpen(this.app)) return false;
    if (e.key === 'Escape') { this.app.back(); return true; }
    return false;
  }
}
