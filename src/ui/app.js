// Application shell: screens, settings, toasts, modals, global drag & drop.

import { h, clear, Emitter } from './dom.js';
import { local } from './store.js';
import { tr, setLang } from './i18n.js';
import { audio } from '../audio/engine.js';

export const DEFAULT_APP_SETTINGS = {
  lang: 'ru',
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
}

export class App extends Emitter {
  constructor(root) {
    super();
    this.root = root;
    this.audio = audio;
    this.settings = mergeDeep(structuredCloneSafe(DEFAULT_APP_SETTINGS), local.get('settings', {}));
    setLang(this.settings.lang);
    this.audio.setVolumes(this.settings.volumes);
    this.audio.userOffsetMs = this.settings.offsetMs;
    this.screens = new Map();
    this.current = null;
    this.history = [];
    this.library = null;
    this.brains = null;

    this.stage = h('div.stage');
    this.toasts = h('div.toasts');
    this.modalLayer = h('div.modal-layer');
    this.dropHint = h('div.drop-hint', h('div.drop-hint-box',
      h('div.drop-hint-icon', '⬇'),
      h('div.drop-hint-title', tr('Отпусти, чтобы импортировать', 'Drop to import')),
      h('div.drop-hint-sub', tr('.sspm карты Rhythia · .txt карты · любые mp3/ogg/wav — МУХА сама сделает карту', '.sspm Rhythia maps · .txt maps · any mp3/ogg/wav — МУХА will auto-map it'))));
    clear(root).append(this.stage, this.toasts, this.modalLayer, this.dropHint);

    window.addEventListener('resize', () => this.current?.resize());
    window.addEventListener('keydown', (e) => this._onKey(e));
    this._setupDrop();
    // first user gesture unlocks audio
    const unlock = () => { this.audio.ensure(); window.removeEventListener('pointerdown', unlock, true); window.removeEventListener('keydown', unlock, true); };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }

  saveSettings() {
    local.set('settings', this.settings);
    this.audio.setVolumes(this.settings.volumes);
    this.audio.userOffsetMs = this.settings.offsetMs;
    this.emit('settings', this.settings);
  }

  register(name, ScreenClass) {
    this.screens.set(name, { Class: ScreenClass, instance: null });
  }

  screen(name) {
    const entry = this.screens.get(name);
    if (!entry) throw new Error('unknown screen ' + name);
    if (!entry.instance) entry.instance = new entry.Class(this, name);
    return entry.instance;
  }

  /** Navigate to a screen. `replace` = don't push history. */
  go(name, params = {}, { replace = false } = {}) {
    const next = this.screen(name);
    const prev = this.current;
    if (prev && !replace) this.history.push({ name: prev.name, params: prev._params });
    if (prev) {
      try { prev.hide(); } catch (e) { console.error(e); }
      prev.el.classList.remove('active');
      const el = prev.el;
      setTimeout(() => { if (this.current !== prev) el.remove(); }, 260);
    }
    if (!next.mounted) {
      next.mount();
      next.mounted = true;
    }
    next._params = params;
    this.stage.appendChild(next.el);
    // force reflow so the transition runs
    void next.el.offsetWidth;
    next.el.classList.add('active');
    this.current = next;
    try { next.show(params); } catch (e) { console.error(e); this.toast(String(e.message || e), 'error'); }
    next.resize();
    this.emit('screen', name);
  }

  back(fallback = 'menu') {
    const prev = this.history.pop();
    if (prev) this.go(prev.name, prev.params, { replace: true });
    else this.go(fallback, {}, { replace: true });
  }

  toast(text, kind = 'info', ms = 3200) {
    const el = h(`div.toast.toast-${kind}`, text);
    this.toasts.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, ms);
  }

  /** Show a modal; returns a close() function. */
  modal(content, { title = '', wide = false, onClose = null } = {}) {
    const close = () => {
      box.classList.remove('show');
      setTimeout(() => wrap.remove(), 200);
      onClose && onClose();
    };
    const box = h(`div.modal${wide ? '.modal-wide' : ''}`,
      h('div.modal-head', h('div.modal-title', title), h('button.icon-btn.modal-x', { onclick: close, title: tr('Закрыть', 'Close') }, '✕')),
      h('div.modal-body', content));
    const wrap = h('div.modal-wrap', { onclick: (e) => { if (e.target === wrap) close(); } }, box);
    this.modalLayer.appendChild(wrap);
    requestAnimationFrame(() => box.classList.add('show'));
    return close;
  }

  _onKey(e) {
    if (this.current && this.current.keydown(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape' && this.modalLayer.lastElementChild) {
      this.modalLayer.lastElementChild.querySelector('.modal-x')?.click();
    }
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

function structuredCloneSafe(o) { return JSON.parse(JSON.stringify(o)); }

export function mergeDeep(target, src) {
  if (!src || typeof src !== 'object') return target;
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') mergeDeep(target[k], v);
    else if (k in target) target[k] = v;
  }
  return target;
}
