// МУХА 98 — application shell styled as a Windows 98 desktop:
// boot splash, desktop, taskbar with Start menu / tray / clock, every screen in a window,
// Win98 message boxes, tray balloons, global drag & drop.

import { h, clear, Emitter } from './dom.js';
import { local } from './store.js';
import { tr, setLang, getLang } from './i18n.js';
import { audio } from '../audio/engine.js';
import { icon } from './icons.js';
import { win98Window, contextMenu, button98 } from './win98.js';

export const DEFAULT_APP_SETTINGS = {
  lang: 'ru',
  playerName: '',
  showWelcome: true,
  volumes: { master: 0.8, music: 0.75, sfx: 0.45 },
  offsetMs: 0,               // audio/visual offset (positive → notes later)
  sensitivity: 1.0,          // cursor sensitivity in pointer-lock mode
  cursorMode: 'lock',        // 'lock' (relative, like Rhythia) | 'absolute'
  approachRate: 40,          // grid units / s (SS+ default)
  approachDistance: 36,      // grid units
  parallax: 0.1625,
  colorSet: 'Rhythia',
  cursorTrail: true,
  hitSounds: true,
  missSounds: true,
  systemSounds: true,        // Win98-style startup / dialog sounds
  showFps: false,
  quality: 'high',           // 'high' | 'low'
  spin: false,               // spin camera mode
  fov: 70,
  noteOpacity: 1,
  backgroundDim: 0.35,
  aiHand: 'pro',             // hand preset used by МУХА
  aiVision: true,            // watch mode: draw МУХА's "vision lines" to the notes she plans
  mods: { speed: 1, noFail: false, hardRock: false, ghost: false, mirror: false },
};

/** Default window titles / icons for each program (screen). */
export const PROGRAMS = {
  menu: { icon: 'computer', ru: 'Рабочий стол', en: 'Desktop' },
  select: { icon: 'folder', ru: 'Мои карты', en: 'My Maps' },
  game: { icon: 'play', ru: 'rhythia.exe', en: 'rhythia.exe' },
  results: { icon: 'trophy', ru: 'Результаты', en: 'Results' },
  lab: { icon: 'lab', ru: 'МУХА: Лаборатория', en: 'МУХА Lab' },
  settings: { icon: 'settings', ru: 'Панель управления', en: 'Control Panel' },
};

export class Screen {
  constructor(app, name) {
    this.app = app;
    this.name = name;
    this.el = h(`section.screen.screen-${name}`);
    this.mounted = false;
  }
  /** Build DOM once (lazily on first show). */
  mount() {}
  /** Called every time the screen becomes visible. */
  show(_params) {}
  /** Called when the screen is hidden. */
  hide() {}
  resize() {}
  /** Return true if the key was handled. */
  keydown(_e) { return false; }
  /** Optional window title (string) — or call this.setTitle(). */
  title() { return null; }
  /** Optional menubar: [{label, items:[{label, onClick, shortcut}]}] */
  menubar() { return null; }
  /** Optional status bar fields: array of Nodes/strings. */
  statusbar() { return null; }
  /** Update the window title (and taskbar button). */
  setTitle(text) { this.app._setTitle(this, text); }
}

export class App extends Emitter {
  constructor(root) {
    super();
    this.root = root;
    this.audio = audio;
    this.settings = mergeDeep(clone(DEFAULT_APP_SETTINGS), local.get('settings', {}));
    setLang(this.settings.lang);
    this.audio.setVolumes(this.settings.volumes);
    this.audio.userOffsetMs = this.settings.offsetMs;
    this.screens = new Map();
    this.current = null;
    this.history = [];
    this.library = null;
    this.brains = null;
    this.tasks = [];              // open programs shown on the taskbar: {name, params, title}
    this.windowState = local.get('windows', {}); // per-program {max, x, y, w, h}
    this.tray = { training: null };

    this._buildDom();
    window.addEventListener('resize', () => { this._fitWindow(this.current); this.current?.resize(); });
    window.addEventListener('keydown', (e) => this._onKey(e));
    this._setupDrop();
    // first user gesture unlocks audio (and plays the startup chime once)
    const unlock = () => {
      this.audio.ensure();
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      if (!this._startupPlayed && this.settings.systemSounds) { this._startupPlayed = true; this.audio.sfx('startup', 0.8); }
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }

  // ---------------------------------------------------------------------------------------------
  // DOM skeleton

  _buildDom() {
    this.stage = h('div.stage');
    this.desktop = h('div.desktop',
      h('div.wallpaper', icon('fly', 128, 'wallpaper-fly'), h('div.wallpaper-text', 'МУХА', h('span', '98'))),
      this.stage);
    this.startBtn = h('button.start-btn', { onclick: (e) => { e.stopPropagation(); this.toggleStart(); } }, icon('fly', 16), h('b', tr('Пуск', 'Start')));
    this.taskButtons = h('div.task-buttons');
    this.clock = h('div.tray-clock.tnum');
    this.trayMuxa = h('button.tray-icon.tray-muxa', { title: 'МУХА', onclick: () => this.go('lab') }, icon('fly', 16));
    this.traySpeaker = h('button.tray-icon', { title: tr('Громкость', 'Volume'), onclick: (e) => { e.stopPropagation(); this._toggleVolume(); } }, icon('speaker', 16));
    const quick = h('div.quick-launch',
      this._quick('play', tr('Играть', 'Play'), () => this.go('select', { mode: 'play' })),
      this._quick('lab', tr('МУХА: Лаборатория', 'МУХА Lab'), () => this.go('lab')),
      this._quick('versus', tr('Против МУХИ', 'Versus МУХА'), () => this.go('select', { mode: 'versus' })));
    this.taskbar = h('div.taskbar', this.startBtn, h('div.vseparator'), quick, h('div.vseparator'), this.taskButtons,
      h('div.tray', this.trayMuxa, this.traySpeaker, this.clock));
    this.startMenu = this._buildStartMenu();
    this.toasts = h('div.balloons');
    this.modalLayer = h('div.modal-layer');
    this.dropHint = h('div.drop-hint', h('div.win.drop-hint-box',
      h('div.win-title', icon('floppy', 16, 'win-title-icon'), h('div.win-title-text', tr('Копирование…', 'Copying…'))),
      h('div.drop-hint-body',
        h('div.drop-anim', icon('folder', 32), h('span.drop-paper', icon('mapfile', 32)), icon('fly', 32)),
        h('div', h('b', tr('Отпусти файлы, чтобы импортировать', 'Drop the files to import'))),
        h('div.dim', tr('.sspm карты Rhythia · .rhm · .txt карты · любые mp3/ogg/wav (МУХА сама сделает карту)', '.sspm Rhythia maps · .rhm · .txt maps · any mp3/ogg/wav (МУХА will auto-map it)')))));
    this.os = h('div.os', this.desktop, this.taskbar);
    clear(this.root).append(this.os, this.startMenu, this.toasts, this.modalLayer, this.dropHint);
    document.addEventListener('pointerdown', (e) => {
      if (this.startMenu.classList.contains('open') && !this.startMenu.contains(e.target) && !this.startBtn.contains(e.target) && !e.target.closest('.start-sub')) this.toggleStart(false);
      if (this._volume && !this._volume.contains(e.target) && !this.traySpeaker.contains(e.target)) { this._volume.remove(); this._volume = null; }
    });
    this.desktop.addEventListener('pointerdown', (e) => {
      if (e.target === this.desktop || e.target === this.stage || e.target.classList?.contains('screen-menu')) {
        document.querySelectorAll('.desk-icon.selected').forEach((x) => x.classList.remove('selected'));
      }
    });
    this._tickClock();
    setInterval(() => this._tickClock(), 5000);
  }

  _quick(iconName, title, fn) {
    return h('button.quick-btn', { title, onclick: () => { this.audio.sfx('ui', 0.5); fn(); } }, icon(iconName, 16));
  }

  _tickClock() {
    const d = new Date();
    this.clock.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    try {
      this.clock.title = d.toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ru-RU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    } catch { /* ignore */ }
  }

  _buildStartMenu() {
    const item = (iconName, label, fn) => h('button.start-item', {
      onclick: () => { this.toggleStart(false); this.audio.sfx('ui', 0.5); fn(); },
    }, icon(iconName, 32), h('span', label));
    const langItem = h('button.start-item', {
      onclick: (e) => {
        e.stopPropagation();
        document.querySelectorAll('.start-sub').forEach((x) => x.remove());
        const m = contextMenu([
          { label: 'Русский', checked: getLang() === 'ru', onClick: () => this.setLanguage('ru') },
          { label: 'English', checked: getLang() === 'en', onClick: () => this.setLanguage('en') },
        ], () => m.remove());
        const r = e.currentTarget.getBoundingClientRect();
        m.style.left = `${r.right - 4}px`;
        m.style.top = `${r.top}px`;
        m.classList.add('start-sub');
        document.body.appendChild(m);
      },
    }, icon('computer', 32), h('span', tr('Язык / Language', 'Language / Язык')), h('span.start-arrow', '▸'));
    const items = h('div.start-items',
      item('play', tr('Играть', 'Play'), () => this.go('select', { mode: 'play' })),
      item('watch', tr('Смотреть, как играет МУХА', 'Watch МУХА play'), () => this.go('select', { mode: 'watch' })),
      item('versus', tr('Против МУХИ', 'Versus МУХА'), () => this.go('select', { mode: 'versus' })),
      item('lab', tr('МУХА: Лаборатория', 'МУХА Lab'), () => this.go('lab')),
      h('div.menu98-sep'),
      item('folder', tr('Мои карты', 'My Maps'), () => this.go('select', { mode: 'play' })),
      item('floppy', tr('Импорт карт…', 'Import maps…'), () => this.emit('import-request')),
      item('settings', tr('Настройки', 'Settings'), () => this.go('settings')),
      item('help', tr('Справка', 'Help'), () => this.emit('help-request')),
      h('div.menu98-sep'),
      langItem,
      item('power', tr('Завершение работы…', 'Shut Down…'), () => this.shutdown()));
    const banner = h('div.start-banner', h('span', h('b', 'МУХА'), ' 98'));
    return h('div.start-menu', banner, items);
  }

  toggleStart(force) {
    const open = force ?? !this.startMenu.classList.contains('open');
    this.startMenu.classList.toggle('open', open);
    this.startBtn.classList.toggle('pressed', open);
    if (!open) document.querySelectorAll('.start-sub').forEach((x) => x.remove());
  }

  _toggleVolume() {
    if (this._volume) { this._volume.remove(); this._volume = null; return; }
    const v = this.settings.volumes;
    const slider = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: v.master, oninput: (e) => { v.master = +e.target.value; mute.checked = v.master === 0; this.saveSettings(); } });
    const mute = h('input', { type: 'checkbox', checked: v.master === 0, onchange: (e) => { v.master = e.target.checked ? 0 : 0.8; slider.value = v.master; this.saveSettings(); } });
    this._volume = h('div.win.volume-pop', h('div', tr('Громкость', 'Volume')), h('div.volume-slider', slider), h('label.check', mute, h('span', tr('Выкл.', 'Mute'))));
    this.root.appendChild(this._volume);
  }

  /** Called by the AI Lab (or anyone) to show training status in the tray. */
  setTrayStatus({ training = false, text = '' } = {}) {
    this.tray.training = training;
    this.trayMuxa.classList.toggle('busy', !!training);
    this.trayMuxa.title = text || 'МУХА';
  }

  setLanguage(lang) {
    this.settings.lang = lang;
    this.saveSettings();
    setLang(lang);
    const cur = this.current?.name || 'menu';
    const params = this.current?._params || {};
    // rebuild every mounted screen so all strings switch language
    for (const entry of this.screens.values()) {
      if (entry.instance) {
        try { entry.instance.hide(); } catch { /* ignore */ }
        entry.instance.el.remove();
        entry.frame?.root.remove();
        entry.instance = null;
        entry.frame = null;
      }
    }
    this.current = null;
    this.tasks = [];
    this.startMenu.remove();
    this.startMenu = this._buildStartMenu();
    this.root.insertBefore(this.startMenu, this.toasts);
    this.startBtn.querySelector('b').textContent = tr('Пуск', 'Start');
    this.emit('lang', lang);
    this.go(cur, params, { replace: true });
  }

  saveSettings() {
    local.set('settings', this.settings);
    this.audio.setVolumes(this.settings.volumes);
    this.audio.userOffsetMs = this.settings.offsetMs;
    this.emit('settings', this.settings);
  }

  // ---------------------------------------------------------------------------------------------
  // screens as windows

  register(name, ScreenClass) {
    this.screens.set(name, { Class: ScreenClass, instance: null, frame: null });
  }

  screen(name) {
    const entry = this.screens.get(name);
    if (!entry) throw new Error('unknown screen ' + name);
    if (!entry.instance) entry.instance = new entry.Class(this, name);
    return entry.instance;
  }

  _frameFor(screen) {
    if (screen.name === 'menu') return null; // the desktop itself
    const entry = this.screens.get(screen.name);
    if (entry.frame) return entry.frame;
    const prog = PROGRAMS[screen.name] || { icon: 'computer', ru: screen.name, en: screen.name };
    const st = this.windowState[screen.name] || { max: true };
    const frame = win98Window({
      title: tr(prog.ru, prog.en),
      iconName: prog.icon,
      controls: ['min', st.max ? 'restore' : 'max', 'close'],
      menubar: screen.menubar(),
      body: screen.el,
      status: screen.statusbar(),
      className: 'app-window',
      onControl: (c) => this._windowControl(screen, c),
    });
    frame.state = st;
    frame.root.classList.toggle('maximized', !!st.max);
    frame.titleBar.addEventListener('dblclick', (e) => { if (!e.target.closest('.win-controls')) this._windowControl(screen, frame.state.max ? 'restore' : 'max'); });
    this._makeDraggable(frame, screen);
    entry.frame = frame;
    return frame;
  }

  _windowControl(screen, c) {
    const frame = this.screens.get(screen.name)?.frame;
    if (!frame) return;
    this.audio.sfx('ui', 0.4);
    if (c === 'close') {
      this.tasks = this.tasks.filter((t) => t.name !== screen.name);
      this.go('menu', {}, { replace: true });
    } else if (c === 'min') {
      this.go('menu', {}, { replace: true });
    } else if (c === 'max' || c === 'restore') {
      frame.state.max = c === 'max';
      this.windowState[screen.name] = frame.state;
      local.set('windows', this.windowState);
      frame.root.classList.toggle('maximized', frame.state.max);
      const btn = frame.root.querySelector('.win-controls .b-max, .win-controls .b-restore');
      if (btn) btn.className = frame.state.max ? 'b-restore' : 'b-max';
      this._fitWindow(screen);
      screen.resize();
    }
  }

  _fitWindow(screen) {
    const frame = screen && this.screens.get(screen.name)?.frame;
    if (!frame) return;
    const st = frame.state;
    const W = this.desktop.clientWidth, H = this.desktop.clientHeight;
    if (st.max || W < 760) {
      Object.assign(frame.root.style, { left: '0px', top: '0px', width: `${W}px`, height: `${H}px` });
      return;
    }
    const w = Math.min(W - 20, st.w || Math.round(W * 0.84));
    const hgt = Math.min(H - 20, st.h || Math.round(H * 0.86));
    const x = Math.max(0, Math.min(W - 80, st.x ?? Math.round((W - w) / 2)));
    const y = Math.max(0, Math.min(H - 40, st.y ?? Math.round((H - hgt) / 2)));
    Object.assign(frame.root.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hgt}px` });
  }

  _makeDraggable(frame, screen) {
    let drag = null;
    frame.titleBar.addEventListener('pointerdown', (e) => {
      if (frame.state.max || e.button !== 0 || e.target.closest('.win-controls')) return;
      const r = frame.root.getBoundingClientRect();
      const d = this.desktop.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, ox: d.left, oy: d.top };
      frame.titleBar.setPointerCapture(e.pointerId);
    });
    frame.titleBar.addEventListener('pointermove', (e) => {
      if (!drag) return;
      frame.state.x = Math.round(e.clientX - drag.ox - drag.dx);
      frame.state.y = Math.max(0, Math.round(e.clientY - drag.oy - drag.dy));
      frame.root.style.left = `${frame.state.x}px`;
      frame.root.style.top = `${frame.state.y}px`;
    });
    frame.titleBar.addEventListener('pointerup', () => {
      if (!drag) return;
      drag = null;
      this.windowState[screen.name] = frame.state;
      local.set('windows', this.windowState);
    });
  }

  _setTitle(screen, text) {
    const frame = this.screens.get(screen.name)?.frame;
    if (frame) frame.setTitle(text);
    const task = this.tasks.find((t) => t.name === screen.name);
    if (task) { task.title = text; this._renderTasks(); }
  }

  _renderTasks() {
    clear(this.taskButtons);
    for (const t of this.tasks) {
      const prog = PROGRAMS[t.name] || { icon: 'computer' };
      const active = this.current?.name === t.name;
      const b = h(`button.task-btn${active ? '.pressed' : ''}`, {
        title: t.title,
        onclick: () => {
          if (active) this._windowControl(this.current, 'min');
          else this.go(t.name, t.params, { replace: true });
        },
      }, icon(prog.icon, 16), h('span', t.title));
      this.taskButtons.append(b);
    }
  }

  /** Navigate to a screen (program). `replace` = don't push history. */
  go(name, params = {}, { replace = false } = {}) {
    const next = this.screen(name);
    const prev = this.current;
    this.toggleStart(false);
    if (prev && prev !== next) {
      if (!replace) this.history.push({ name: prev.name, params: prev._params });
      try { prev.hide(); } catch (e) { console.error(e); }
      const pf = this.screens.get(prev.name)?.frame;
      (pf ? pf.root : prev.el).remove();
    } else if (prev === next) {
      try { prev.hide(); } catch (e) { console.error(e); }
    }
    if (!next.mounted) {
      next.mount();
      next.mounted = true;
    }
    next._params = params;
    const frame = this._frameFor(next);
    if (frame) {
      if (frame.root.parentNode !== this.stage) {
        this.stage.appendChild(frame.root);
        frame.root.classList.remove('opening');
        void frame.root.offsetWidth;
        frame.root.classList.add('opening');
      }
      next.el.classList.add('active');
      this._fitWindow(next);
    } else if (next.el.parentNode !== this.stage) {
      this.stage.appendChild(next.el);
      next.el.classList.add('active');
    }
    this.current = next;
    // taskbar bookkeeping
    if (name !== 'menu') {
      const prog = PROGRAMS[name] || { ru: name, en: name };
      let task = this.tasks.find((t) => t.name === name);
      if (!task) { task = { name, params, title: tr(prog.ru, prog.en) }; this.tasks.push(task); }
      task.params = params;
      const custom = next.title();
      if (custom) { task.title = custom; frame?.setTitle(custom); }
    }
    this._renderTasks();
    try { next.show(params); } catch (e) { console.error(e); this.toast(String(e.message || e), 'error'); }
    next.resize();
    this.emit('screen', name);
  }

  back(fallback = 'menu') {
    const prev = this.history.pop();
    if (prev) this.go(prev.name, prev.params, { replace: true });
    else this.go(fallback, {}, { replace: true });
  }

  // ---------------------------------------------------------------------------------------------
  // dialogs & notifications

  /** Tray balloon notification. kind: info | success | error | level */
  toast(text, kind = 'info', ms = 3800) {
    const iconName = kind === 'error' ? 'error' : kind === 'level' ? 'trophy' : 'info';
    const el = h(`div.balloon.balloon-${kind}`, icon(iconName, 16), h('div.balloon-text', text));
    el.addEventListener('click', () => el.remove());
    this.toasts.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    if (kind === 'error' && this.settings.systemSounds) this.audio.sfx('chord', 0.5);
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
  }

  /** Show a modal Win98 dialog window with arbitrary content; returns close(). */
  modal(content, { title = '', wide = false, onClose = null, iconName = null } = {}) {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      wrap.remove();
      onClose && onClose();
    };
    const w = win98Window({ title, iconName, controls: ['close'], onControl: close, body: h('div.modal-body', content), className: `dialog98${wide ? ' dialog98-wide' : ''}` });
    w.buttons.close?.classList.add('modal-x');
    const wrap = h('div.modal-wrap', w.root);
    let drag = null;
    w.titleBar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.win-controls')) return;
      const r = w.root.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      Object.assign(w.root.style, { position: 'fixed', margin: '0', left: `${r.left}px`, top: `${r.top}px` });
      w.titleBar.setPointerCapture(e.pointerId);
    });
    w.titleBar.addEventListener('pointermove', (e) => {
      if (!drag) return;
      w.root.style.left = `${e.clientX - drag.dx}px`;
      w.root.style.top = `${Math.max(0, e.clientY - drag.dy)}px`;
    });
    w.titleBar.addEventListener('pointerup', () => { drag = null; });
    this.modalLayer.appendChild(wrap);
    setTimeout(() => w.root.querySelector('.btn98.default, .btn-primary')?.focus(), 30);
    return close;
  }

  /**
   * Win98 message box. Resolves with the value of the clicked button (or null when closed).
   * dialog({ title, text, icon: 'info'|'warning'|'error'|'help'|'power', buttons: [{label, value, primary}] })
   */
  dialog({ title = 'МУХА 98', text = '', icon: iconName = 'info', buttons = [{ label: 'OK', value: true, primary: true }], details = null } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; close(); resolve(v); };
      const lines = typeof text === 'string' ? text.split('\n').map((l) => h('p', l)) : text;
      const body = h('div.msgbox',
        h('div.msgbox-main', icon(iconName, 32), h('div.msgbox-text', lines)),
        details,
        h('div.msgbox-buttons', buttons.map((b) => button98(b.label, () => finish(b.value), { primary: !!b.primary }))));
      const close = this.modal(body, { title, onClose: () => finish(null) });
      if (this.settings.systemSounds) this.audio.sfx(iconName === 'error' ? 'chord' : 'ding', 0.5);
    });
  }

  /** Yes/No confirmation → Promise<boolean> */
  async confirm(text, { title = 'МУХА 98', yes = tr('Да', 'Yes'), no = tr('Нет', 'No'), icon: iconName = 'warning' } = {}) {
    const v = await this.dialog({ title, text, icon: iconName, buttons: [{ label: yes, value: true, primary: true }, { label: no, value: false }] });
    return v === true;
  }

  async shutdown() {
    const v = await this.dialog({
      title: tr('Завершение работы', 'Shut Down'),
      icon: 'power',
      text: tr('Что вы хотите сделать?\nМУХА сохранит свой прогресс обучения.', 'What do you want to do?\nМУХА will save her training progress.'),
      buttons: [{ label: tr('Выключить', 'Shut down'), value: 'off', primary: true }, { label: tr('Перезагрузить', 'Restart'), value: 'restart' }, { label: tr('Отмена', 'Cancel'), value: null }],
    });
    if (v === 'restart') { location.reload(); return; }
    if (v !== 'off') return;
    this.emit('shutdown');
    try { this.current?.hide(); } catch { /* ignore */ }
    this.audio.stop();
    const screen = h('div.shutdown-screen',
      h('div', tr('Теперь компьютер можно выключить.', 'It is now safe to turn off your computer.')),
      h('div.shutdown-hint', tr('(кликни, чтобы включить снова)', '(click to power on again)')));
    screen.addEventListener('click', () => location.reload());
    this.root.appendChild(screen);
    // desktop build: really quit after the classic message has been seen
    if (window.muxaDesktop?.quit) setTimeout(() => window.muxaDesktop.quit(), 1800);
  }

  // ---------------------------------------------------------------------------------------------

  _onKey(e) {
    if ((e.key === 'Escape' && e.ctrlKey) || e.key === 'Meta' || e.key === 'OS') { this.toggleStart(); e.preventDefault(); return; }
    if (e.key === 'Escape' && this.startMenu.classList.contains('open')) { this.toggleStart(false); e.preventDefault(); return; }
    if (e.key === 'Escape' && this.modalLayer.lastElementChild) {
      this.modalLayer.lastElementChild.querySelector('.modal-x')?.click();
      e.preventDefault();
      return;
    }
    if (this.modalLayer.lastElementChild) return; // dialogs own the keyboard
    if (this.current && this.current.keydown(e)) e.preventDefault();
  }

  _setupDrop() {
    let depth = 0;
    const isFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
    window.addEventListener('dragenter', (e) => { if (!isFiles(e)) return; depth++; this.dropHint.classList.add('show'); e.preventDefault(); });
    window.addEventListener('dragover', (e) => { if (isFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) this.dropHint.classList.remove('show'); });
    window.addEventListener('drop', (e) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      depth = 0;
      this.dropHint.classList.remove('show');
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) this.emit('files', files);
    });
  }
}

// ---- boot splash -----------------------------------------------------------------------------

/** Show the "МУХА 98" boot screen; returns {status(text), done(minMs)}. */
export function showBootScreen(root) {
  const status = h('div.boot-status', tr('Запуск МУХА 98…', 'Starting МУХА 98…'));
  const el = h('div.boot',
    h('canvas.boot-clouds'),
    h('div.boot-logo', icon('fly', 96, 'boot-fly'), h('div.boot-word', 'МУХА', h('sup', '98')), h('div.boot-sub', 'Rhythia Edition')),
    status,
    h('div.boot-bar'));
  root.appendChild(el);
  drawClouds(el.querySelector('canvas'));
  const t0 = performance.now();
  return {
    status(text) { status.textContent = text; },
    async done(minMs = 1600) {
      const wait = Math.max(0, minMs - (performance.now() - t0));
      await new Promise((r) => setTimeout(r, wait));
      el.classList.add('hide');
      setTimeout(() => el.remove(), 450);
    },
  };
}

function drawClouds(canvas) {
  const w = (canvas.width = 320), hgt = (canvas.height = 200);
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, hgt);
  g.addColorStop(0, '#1f5fc8');
  g.addColorStop(1, '#8fc4ff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, hgt);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const cx = rnd() * w, cy = rnd() * hgt, r = 8 + rnd() * 22;
    for (let k = 0; k < 7; k++) {
      ctx.fillStyle = `rgba(255,255,255,${0.3 + rnd() * 0.35})`;
      ctx.beginPath();
      ctx.arc(cx + (rnd() - 0.5) * r * 2.4, cy + (rnd() - 0.5) * r * 0.8, r * (0.5 + rnd() * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

export function mergeDeep(target, src) {
  if (!src || typeof src !== 'object') return target;
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') mergeDeep(target[k], v);
    else if (k in target) target[k] = v;
  }
  return target;
}
