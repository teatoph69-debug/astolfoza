// Main menu: animated grid-tunnel backdrop, the МУХА logo with a buzzing fly, navigation,
// "Your МУХА" status card, RU/EN switch and optional (quiet) menu music.
//
// Also exports small UI helpers shared by the other menu screens (select / results / settings):
// icons, the import + help modals, a confirm dialog and history-aware navigation.

import { Screen } from '../app.js';
import { h, clear } from '../dom.js';
import { tr, setLang, getLang, fmtNum } from '../i18n.js';
import { local, pickFiles } from '../store.js';
import { NeonBackdrop } from '../fx/background.js';
import { TITLES } from '../../ai/trainer.js';
import { DEFAULT_ARCH, OBS_NOTES } from '../../ai/agent.js';
import { version as PKG_VERSION } from '../../../package.json';

// =================================================================================================
// Shared helpers
// =================================================================================================

const F = 'fill="currentColor" stroke="none"';
const PATHS = {
  play: `<path ${F} d="M8 4.8c0-1 1.1-1.6 1.9-1.1l10.3 6.9c.8.5.8 1.7 0 2.2L9.9 19.7c-.8.5-1.9-.1-1.9-1.1z"/>`,
  back: '<path d="M15 5l-7 7 7 7"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.5 7.5 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 2.6-1.5l2.4 1 2-3.4z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.9.7c0 1.7-2.5 2.1-2.5 3.8"/><path d="M12 17.3v.2"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  swords: '<path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/><path d="M19 21l2-2"/><path d="M14.5 6.5L18 3h3v3l-3.5 3.5"/><path d="M5 14l4 4"/><path d="M7 17l-3 3"/><path d="M3 19l2 2"/>',
  flask: '<path d="M9 3h6"/><path d="M10 3v6.2L4.7 18.1A1.9 1.9 0 0 0 6.3 21h11.4a1.9 1.9 0 0 0 1.6-2.9L14 9.2V3"/><path d="M7.2 15h9.6"/>',
  import: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  export: '<path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>',
  music: '<path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  musicOff: '<path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/><path d="M3 3l18 18"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/>',
  star: `<path ${F} d="M12 2.8l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.3l-5.6 2.9 1.1-6.3L2.9 9.5l6.3-.9z"/>`,
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  bolt: `<path ${F} d="M13.5 2L4.5 13.5h6.5L10 22l9.5-12H13z"/>`,
  trophy: '<path d="M8 21h8M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
  retry: '<path d="M3.5 12a8.5 8.5 0 1 0 2.8-6.3"/><path d="M3.5 3.5v5h5"/>',
  volume: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  fly: '<ellipse cx="12" cy="14.5" rx="3.6" ry="5.5"/><circle cx="12" cy="6.8" r="2.2"/><path d="M8.6 11.5C5 9 2.5 10 3 12.5s3.8 2 5.6.8M15.4 11.5C19 9 21.5 10 21 12.5s-3.8 2-5.6.8"/>',
  db: '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13"/><path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
  mouse: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/>',
  gauge: '<path d="M4.2 18a9 9 0 1 1 15.6 0"/><path d="M12 14l4-5"/><circle cx="12" cy="14" r="1.2"/>',
  shield: '<path d="M12 3l7.5 3v6c0 4.8-3.3 7.8-7.5 9-4.2-1.2-7.5-4.2-7.5-9V6z"/>',
  flame: '<path d="M12 3c.8 3.8 5.5 5.6 5.5 10.2a5.5 5.5 0 0 1-11 0c0-2.6 1.4-3.8 2.1-5.3.9 1.4 1.5 2.1 2.6 2.2C11.4 7.8 11 5.6 12 3z"/>',
  mirror: '<path d="M12 3v18" stroke-dasharray="2 2.5"/><path d="M8.5 7L3.5 12l5 5z"/><path d="M15.5 7l5 5-5 5z"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M4.5 12.5l4.8 4.8L19.5 7"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  wave: '<path d="M3 12h1.5M7 8.5v7M10.5 5v14M14 8v8M17.5 10v4M21 12h-.5"/>',
  sparkles: '<path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z"/><path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  heart: '<path d="M12 20s-7.5-4.5-7.5-10.2A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 7.5 2.5C19.5 15.5 12 20 12 20z"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.8 1.8-1.7 0-1.3-1-1.6-1-2.7 0-1 .8-1.6 1.8-1.6H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10" cy="7.3" r="1.2"/><circle cx="14.5" cy="7.3" r="1.2"/>',
  lang: '<path d="M4 5h8M8 3v2M5.5 5c.8 3.4 3.3 6 6.5 7.3M10.5 5C9.6 9 7.2 11.7 4 13"/><path d="M13 21l4-9 4 9M14.5 18h5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c1.9.7 3.1 2.4 3.5 5.2"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3.5"/><path d="M12 8V4.5"/><circle cx="12" cy="3.8" r="1.2"/><circle cx="9" cy="13.5" r="1.4"/><circle cx="15" cy="13.5" r="1.4"/><path d="M9.5 17h5"/>',
  loader: '<path d="M12 3a9 9 0 1 0 9 9"/>',
};

/** Inline SVG icon (stroke = currentColor). */
export function icon(name, cls = '') {
  const svg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${PATHS[name] || ''}</svg>`;
  return h('span.ico' + (cls ? '.' + cls.split(' ').join('.') : ''), { html: svg, 'aria-hidden': 'true' });
}

/** Quiet UI click. */
export function uiSfx(app, name = 'ui', gain = 0.55) {
  try { app.audio.sfx(name, gain); } catch { /* audio not ready */ }
}

/** <button> that plays a click and runs `fn`. */
export function uiButton(app, sel, props, ...children) {
  const onclick = props && props.onclick;
  const p = { type: 'button', ...(props || {}) };
  p.onclick = (e) => { uiSfx(app); onclick && onclick(e); };
  return h('button' + sel, p, ...children);
}

/** Navigate to `name`, dropping it (and everything after it) from history so Esc never loops. */
export function goBackTo(app, name, params = {}) {
  const idx = app.history.map((e) => e.name).lastIndexOf(name);
  if (idx >= 0) app.history.length = idx;
  else app.history = app.history.filter((e) => e.name === 'menu').slice(0, 1);
  if (name === 'menu') app.history.length = 0;
  app.go(name, params, { replace: true });
}

export function isModalOpen(app) { return !!(app.modalLayer && app.modalLayer.childElementCount); }

export function brainName(b) { return b ? (getLang() === 'en' ? (b.en || b.name) : b.name) : ''; }
export function titleName(t) { return t ? (getLang() === 'en' ? t.en : t.ru) : ''; }

export function sourceLabel(source) {
  switch (source) {
    case 'builtin': return tr('встроенная', 'built-in');
    case 'sspm': return 'Rhythia .sspm';
    case 'txt': return tr('Sound Space .txt', 'Sound Space .txt');
    case 'auto': return tr('авто-карта', 'auto-map');
    default: return String(source || '—');
  }
}

/** Promise<boolean> confirm dialog in the app's modal layer. */
export function confirmDialog(app, { title, text, ok, cancel, danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); close(); };
    const body = h('div.menu-confirm',
      h('p.menu-confirm-text', text),
      h('div.menu-confirm-actions',
        uiButton(app, '.btn.btn-ghost', { onclick: () => finish(false) }, cancel || tr('Отмена', 'Cancel')),
        uiButton(app, `.btn${danger ? '.btn-danger.menu-btn-danger' : '.btn-primary'}`, { onclick: () => finish(true) }, ok || 'OK')));
    const close = app.modal(body, { title, onClose: () => { if (!done) { done = true; resolve(false); } } });
    setTimeout(() => body.querySelector('.btn-primary, .menu-btn-danger')?.focus(), 60);
  });
}

// ---- import modal ------------------------------------------------------------------------------

export function openImportModal(app) {
  let close = null;
  const choose = async () => {
    const files = await pickFiles('.sspm,.txt,audio/*,.mp3,.ogg,.wav,.flac,.m4a');
    if (files && files.length) {
      close && close();
      app.emit('files', files);
    }
  };
  const fmt = (ic, badge, title, text, color) => h('div.menu-imp-card', { style: `--c:${color}` },
    h('div.menu-imp-card-top', icon(ic), h('span.menu-imp-badge', badge)),
    h('div.menu-imp-card-title', title),
    h('div.menu-imp-card-text', text));
  const body = h('div.menu-imp',
    h('div.menu-imp-drop', { onclick: choose },
      h('div.menu-imp-drop-icon', icon('import')),
      h('div.menu-imp-drop-title', tr('Перетащи файлы прямо в окно игры', 'Drag files straight into the game window')),
      h('div.menu-imp-drop-sub', tr('или нажми, чтобы выбрать на компьютере', 'or click to pick them from your computer'))),
    h('div.menu-imp-grid',
      fmt('sparkles', '.sspm', tr('Карты Rhythia', 'Rhythia maps'),
        tr('Скачай карты на rhythia.com или из map-паков в Discord Rhythia. Музыка уже внутри файла — просто перетащи.', 'Grab maps from rhythia.com or the map packs on the Rhythia Discord. The music is inside the file — just drop it in.'), '#ff3d9a'),
      fmt('file', '.txt + audio', tr('Карты Sound Space', 'Sound Space maps'),
        tr('Старый формат .txt: выбери карту вместе с её mp3/ogg — файлы сопоставятся по имени.', 'Legacy .txt format: select the map together with its mp3/ogg — files are matched by name.'), '#8b5cf6'),
      fmt('wave', 'mp3 · ogg · wav', tr('Любая песня → авто-карта', 'Any song → auto-map'),
        tr('Кинь любой трек: МУХА найдёт ритм и сама расставит ноты по сетке в стиле Rhythia.', 'Drop any track: МУХА finds the beat and places Rhythia-style notes on the grid by itself.'), '#43e8ff')),
    h('div.menu-imp-foot',
      h('span.faint', tr('Карты хранятся только в этом браузере (IndexedDB) и работают офлайн.', 'Maps are stored only in this browser (IndexedDB) and work offline.')),
      uiButton(app, '.btn.btn-primary', { onclick: choose }, icon('import'), tr('Выбрать файлы', 'Choose files'))));
  close = app.modal(body, { title: tr('Импорт карт', 'Import maps'), wide: true });
  return close;
}

// ---- help modal ----------------------------------------------------------------------------------

export function openHelpModal(app) {
  const kbd = (...keys) => h('span.menu-keys', keys.map((k) => h('kbd.menu-kbd', k)));
  const row = (keys, text) => h('div.menu-help-row', h('div.menu-help-keys', keys), h('div.menu-help-text', text));
  const nIn = DEFAULT_ARCH[0], hidden = DEFAULT_ARCH.slice(1, -1).join('×');
  const body = h('div.menu-help',
    h('section.menu-help-sec',
      h('h3.menu-help-h', icon('mouse'), tr('Управление', 'Controls')),
      row(kbd(tr('Мышь', 'Mouse')), tr('Веди курсор по сетке 3×3. Нота засчитана, если в момент, когда она долетает до сетки, курсор внутри её квадрата.', 'Move the cursor over the 3×3 grid. A note counts as hit if the cursor is inside its square when it reaches the grid.')),
      row(kbd(tr('Клик', 'Click')), tr('Клик по полю захватывает курсор (pointer lock) — как в Rhythia. Чувствительность и режим — в настройках.', 'Clicking the playfield locks the pointer — just like Rhythia. Sensitivity and mode live in Settings.')),
      row(kbd('Esc'), tr('Пауза', 'Pause')),
      row(kbd('`', 'R'), tr('Мгновенный рестарт', 'Quick restart')),
      row(kbd('↑', '↓', '←', '→', 'Enter'), tr('В меню выбора: карта, сложность, старт', 'Song select: map, difficulty, start'))),
    h('section.menu-help-sec',
      h('h3.menu-help-h', icon('fly'), tr('Что такое МУХА', 'What is МУХА')),
      h('p', tr(
        `МУХА — настоящая нейросеть (перцептрон ${nIn} → ${hidden} → 2), которая играет прямо в браузере. Она видит ${OBS_NOTES} ближайшие ноты и свою скорость, а на выходе управляет «рукой» курсора. Рука подчиняется физике — ограничения скорости и ускорения, как у живого игрока (пресет выбирается в настройках).`,
        `МУХА is a real neural network (a ${nIn} → ${hidden} → 2 perceptron) that plays right in your browser. It sees the next ${OBS_NOTES} notes and its own velocity, and steers a cursor "hand". The hand obeys physics — speed and acceleration limits like a real player (pick the preset in Settings).`)),
      h('p', tr('Можно смотреть, как она играет любую карту, или сразиться с ней — кто точнее.', 'Watch it play any map, or go head-to-head — who aims better?'))),
    h('section.menu-help-sec',
      h('h3.menu-help-h', icon('flask'), tr('Как она учится', 'How it learns')),
      h('ul.menu-help-list',
        h('li', h('b', tr('Эволюционные стратегии. ', 'Evolution strategies. ')), tr('Каждое поколение — десятки случайных мутаций весов. Все они играют короткие отрезки карт, и веса сдвигаются в сторону тех мутаций, что попали лучше. Никаких подсказок — только счёт.', 'Every generation spawns dozens of random weight mutations. Each plays short map chunks, and the weights move toward the mutations that hit best. No hints — only the score.')),
        h('li', h('b', tr('Учебная программа. ', 'Curriculum. ')), tr('Сначала медленные простые карты. Когда точность стабильно высокая — уровень растёт, а старые уровни повторяются, чтобы ничего не забыть.', 'It starts on slow, simple maps. Once accuracy is consistently high the level rises, while old levels keep repeating so nothing is forgotten.')),
        h('li', h('b', tr('Навык ★. ', 'Skill ★. ')), tr('Регулярный экзамен на картах 0–20★: навык — самая сложная карта, которую МУХА проходит с точностью ≥ 90%.', 'A regular exam on 0–20★ maps: skill is the hardest map МУХА clears with ≥ 90% accuracy.'))),
      h('div.menu-help-ranks', TITLES.map((t) => h('div.menu-help-rank',
        h('span.menu-help-rank-emoji', t.emoji),
        h('span.menu-help-rank-name', getLang() === 'en' ? t.en : t.ru),
        h('span.menu-help-rank-min', '★ ' + t.min))))),
    h('section.menu-help-sec',
      h('h3.menu-help-h', icon('import'), tr('Свои карты', 'Your own maps')),
      h('p', tr('Перетащи в окно .sspm из Rhythia, старые .txt карты Sound Space или любую песню — МУХА сделает из неё карту.', 'Drop Rhythia .sspm files, legacy Sound Space .txt maps or any song into the window — МУХА will turn it into a map.'))));
  return app.modal(body, { title: tr('Как играть', 'How to play'), wide: true });
}

// =================================================================================================
// Menu screen
// =================================================================================================

const BUILD = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : null; // eslint-disable-line no-undef

export class MenuScreen extends Screen {
  mount() {
    this.bg = new NeonBackdrop({ quality: this.app.settings.quality, focusX: 0.7, focusY: 0.46, intensity: 1 });
    this.bg.mount(this.el);
    this.el.appendChild(h('div.menu-scan'));
    this.root = h('div.menu-wrap.scroll');
    this.el.appendChild(this.root);
    this.flyEl = null;
    this.visible = false;
    this._musicToken = 0;
    this._typed = false;
    this.app.brains?.on('change', () => { if (this.visible) this._renderCard(); });
    this.app.library?.on('change', () => { if (this.visible) this._renderFoot(); });
    this.app.on('settings', (s) => {
      this.bg.set({ quality: s.quality });
      if (this._musicPlaying()) this._applyMusicVolume(false);
    });
  }

  show() {
    this.visible = true;
    if (this._builtLang !== getLang()) this.build();
    this.focusIdx = 0;
    this._updateFocus();
    this.bg.start();
    this._startFly();
    this._armMusic();
    this._renderCard();
  }

  hide() {
    this.visible = false;
    this.bg.stop();
    this._stopFly();
    this._stopMusic();
  }

  resize() {
    const narrow = window.innerWidth < 900;
    this.bg.set({ focusX: narrow ? 0.5 : 0.7, focusY: narrow ? 0.3 : 0.46, gridScale: narrow ? 0.85 : 1 });
    this.bg.resize();
  }

  // ---- DOM -----------------------------------------------------------------------------------

  build() {
    const app = this.app;
    this._builtLang = getLang();
    const items = [
      { id: 'play', ic: 'play', primary: true, label: tr('Играть', 'Play'), sub: tr('Выбери карту и лови ноты', 'Pick a map and catch the notes'), key: 'Enter', go: () => app.go('select', { mode: 'play' }) },
      { id: 'lab', ic: 'flask', label: tr('МУХА: Лаборатория', 'МУХА: The Lab'), sub: tr('Обучи нейросеть играть с нуля', 'Train the neural net from scratch'), go: () => app.go('lab') },
      { id: 'versus', ic: 'swords', label: tr('Против МУХИ', 'Versus МУХА'), sub: tr('Кто точнее — ты или нейросеть?', 'Who aims better — you or the AI?'), go: () => app.go('select', { mode: 'versus' }) },
      { id: 'watch', ic: 'eye', label: tr('Смотреть, как играет МУХА', 'Watch МУХА play'), sub: tr('Нейросеть проходит любую карту', 'The AI plays any map you pick'), go: () => app.go('select', { mode: 'watch' }) },
    ];
    const minor = [
      { id: 'import', ic: 'import', label: tr('Импорт карт', 'Import maps'), go: () => openImportModal(app) },
      { id: 'settings', ic: 'gear', label: tr('Настройки', 'Settings'), go: () => app.go('settings') },
      { id: 'help', ic: 'help', label: tr('Как играть', 'How to play'), go: () => openHelpModal(app) },
    ];
    this.items = [];
    const nav = h('nav.menu-nav');
    items.forEach((it, i) => {
      const b = h(`button.menu-item${it.primary ? '.menu-item-primary' : ''}`, {
        type: 'button', style: `--i:${i}`, dataset: { id: it.id },
        onclick: () => { uiSfx(app, 'ui', 0.6); it.go(); },
        onpointerenter: () => { this.focusIdx = this.items.indexOf(b); this._updateFocus(true); },
      },
      h('span.menu-item-ico', icon(it.ic)),
      h('span.menu-item-text', h('span.menu-item-label', it.label), h('span.menu-item-sub', it.sub)),
      it.key ? h('kbd.menu-kbd.menu-item-key', it.key) : icon('chevron', 'menu-item-arrow'));
      this.items.push(b);
      nav.appendChild(b);
    });
    const minorRow = h('div.menu-minor', { style: `--i:${items.length}` });
    minor.forEach((it) => {
      const b = h('button.menu-minor-btn', {
        type: 'button', dataset: { id: it.id },
        onclick: () => { uiSfx(app, 'ui', 0.6); it.go(); },
        onpointerenter: () => { this.focusIdx = this.items.indexOf(b); this._updateFocus(true); },
      }, icon(it.ic), h('span', it.label));
      this.items.push(b);
      minorRow.appendChild(b);
    });
    nav.appendChild(minorRow);

    this.flyEl = h('div.menu-fly', { html: FLY_SVG, 'aria-hidden': 'true' });
    this.taglineEl = h('p.menu-tagline');
    const tagline = tr('нейросеть, которая учится играть в ритм', 'a neural network that learns to play rhythm');
    if (this._typed) this.taglineEl.textContent = tagline;
    else this._typeTagline(tagline);

    const logo = h('div.menu-logo',
      h('div.menu-logo-kicker', h('span.menu-logo-dot'), tr('aim-ритм игра · нейросеть в браузере', 'aim rhythm game · neural net in your browser')),
      h('h1.menu-logo-title', { 'aria-label': 'МУХА' },
        h('span.menu-logo-main', 'МУХА'),
        h('span.menu-logo-glitch.g1', { 'aria-hidden': 'true' }, 'МУХА'),
        h('span.menu-logo-glitch.g2', { 'aria-hidden': 'true' }, 'МУХА')),
      h('div.menu-logo-sub', h('span.menu-logo-x', '×'), h('span.menu-logo-rhythia', 'RHYTHIA'), h('span.menu-logo-line')),
      this.taglineEl,
      this.flyEl);

    this.musicBtn = h('button.menu-top-btn', { type: 'button', title: tr('Музыка в меню', 'Menu music'), onclick: () => this._toggleMusic() });
    this._renderMusicBtn();
    const langSw = h('div.menu-lang', { role: 'group', 'aria-label': tr('Язык', 'Language') },
      ['ru', 'en'].map((l) => h(`button.menu-lang-btn${getLang() === l ? '.on' : ''}`, {
        type: 'button',
        onclick: () => {
          if (getLang() === l) return;
          uiSfx(app);
          setLang(l);
          app.settings.lang = l;
          app.saveSettings();
          this.build();
          this._renderCard();
          this._updateFocus();
        },
      }, l.toUpperCase())));

    this.cardEl = h('div.menu-card.panel');
    this.footEl = h('footer.menu-foot');

    clear(this.root).append(
      h('header.menu-top',
        h('div.menu-top-brand', h('span.menu-top-mark', icon('fly')), h('span', 'МУХА'), h('span.faint', '× Rhythia')),
        h('div.menu-top-right', this.musicBtn, langSw)),
      h('main.menu-main',
        h('div.menu-left', logo, nav),
        h('aside.menu-right', this.cardEl)),
      this.footEl);
    this._renderCard();
    this._renderFoot();
    this._flyReset = true;
  }

  _typeTagline(text) {
    this._typed = true;
    const el = this.taglineEl;
    el.textContent = '';
    const caret = h('span.menu-caret');
    const span = h('span');
    el.append(span, caret);
    let i = 0;
    const step = () => {
      if (!el.isConnected && i > 0) { span.textContent = text; return; }
      span.textContent = text.slice(0, ++i);
      if (i < text.length) setTimeout(step, 22 + Math.random() * 40);
    };
    setTimeout(step, 650);
  }

  _renderCard() {
    const app = this.app, el = this.cardEl;
    if (!el) return;
    const list = app.brains ? app.brains.list() : [];
    const live = list.find((b) => b.kind === 'live');
    const best = list.filter((b) => b.kind === 'pretrained').sort((a, b) => b.skill - a.skill)[0];
    clear(el);
    el.classList.toggle('menu-card-empty', !live);
    const head = h('div.menu-card-head', h('span.menu-card-kicker', icon('fly'), tr('Твоя МУХА', 'Your МУХА')));
    if (live) {
      const t = live.title;
      head.appendChild(h('span.menu-card-gen', tr('поколение ', 'gen ') + fmtNum(live.gen || 0)));
      const pct = Math.round((t.progress || 0) * 100);
      el.append(head,
        h('div.menu-card-main',
          h('div.menu-rank', { style: `--p:${(t.next ? t.progress : 1).toFixed(3)}` }, h('span.menu-rank-emoji', t.emoji)),
          h('div.menu-card-info',
            h('div.menu-card-title', titleName(t)),
            h('div.menu-card-meta',
              h('span.menu-card-skill', icon('star'), (live.skill || 0).toFixed(2)),
              h('span.faint', tr(`ранг ${t.index + 1} из ${TITLES.length}`, `rank ${t.index + 1} of ${TITLES.length}`))))),
        t.next
          ? h('div.menu-card-prog',
            h('div.menu-card-prog-top', h('span', tr('до ', 'next: '), h('b', `${t.next.emoji} ${titleName(t.next)}`)), h('span.mono', pct + '%')),
            h('div.menu-bar', h('div.menu-bar-fill', { style: { width: pct + '%' } })))
          : h('div.menu-card-max', tr('Максимальный ранг. Абсолют.', 'Max rank reached. Absolute.')),
        uiButton(app, '.btn.menu-card-btn', { onclick: () => app.go('lab') }, icon('flask'), tr('В лабораторию', 'Open the Lab'), icon('chevron')));
    } else {
      el.append(head,
        h('div.menu-card-main',
          h('div.menu-rank.menu-rank-egg', { style: '--p:0' }, h('span.menu-rank-emoji', '🥚')),
          h('div.menu-card-info',
            h('div.menu-card-title', tr('ещё не родилась', 'not hatched yet')),
            h('div.menu-card-text', tr('МУХА ещё не родилась — начни обучение в Лаборатории и смотри, как она растёт от личинки до бога ритма.', 'МУХА hasn\'t hatched yet — start training in the Lab and watch it grow from a larva into a rhythm god.')))),
        uiButton(app, '.btn.btn-primary.menu-card-btn', { onclick: () => app.go('lab') }, icon('sparkles'), tr('Начать обучение', 'Start training')));
    }
    if (best) {
      el.appendChild(h('div.menu-card-best',
        h('span.faint', tr('Сильнейшая готовая: ', 'Strongest pretrained: ')),
        h('span', `${best.title.emoji} ${brainName(best)}`),
        h('span.menu-card-best-skill', '★ ' + best.skill.toFixed(1))));
    }
  }

  _renderFoot() {
    const el = this.footEl;
    if (!el) return;
    const lib = this.app.library;
    const nSets = lib ? lib.sets.length : 0;
    const nMaps = lib ? lib.sets.reduce((a, s) => a + s.maps.length, 0) : 0;
    let date = '';
    if (BUILD) {
      const d = new Date(BUILD);
      if (!isNaN(d)) date = d.toLocaleDateString(getLang() === 'en' ? 'en-GB' : 'ru-RU');
    }
    clear(el).append(
      h('div.menu-foot-left',
        h('span.menu-foot-ver', 'v' + PKG_VERSION),
        date ? h('span', tr('сборка ', 'build ') + date) : null,
        h('span', tr(`${nSets} песен · ${nMaps} карт`, `${nSets} songs · ${nMaps} maps`))),
      h('div.menu-foot-right',
        h('span', h('kbd.menu-kbd', 'Enter'), tr(' играть', ' play')),
        h('span', h('kbd.menu-kbd', '↑↓'), tr(' меню', ' menu')),
        h('span.menu-foot-drop', icon('import'), tr('перетащи .sspm / mp3 в окно', 'drop .sspm / mp3 into the window'))));
  }

  // ---- keyboard ----------------------------------------------------------------------------------

  _updateFocus(fromPointer = false) {
    if (!this.items) return;
    this.items.forEach((b, i) => b.classList.toggle('focus', i === this.focusIdx));
    if (fromPointer && this._lastHover !== this.focusIdx) {
      this._lastHover = this.focusIdx;
      if (this.app.audio.ctx) uiSfx(this.app, 'ui', 0.12);
    }
  }

  keydown(e) {
    if (isModalOpen(this.app)) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const n = this.items.length;
      this.focusIdx = (this.focusIdx + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      this._updateFocus();
      uiSfx(this.app, 'ui', 0.2);
      return true;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      if (e.target && e.target.tagName === 'BUTTON' && !this.items.includes(e.target)) return false;
      this.items[this.focusIdx]?.click();
      return true;
    }
    return false;
  }

  // ---- the fly ------------------------------------------------------------------------------------
  // A tiny SVG fly buzzing around the logo: wanders on smooth noise, lands on letters now and then,
  // and dodges the mouse pointer.

  _startFly() {
    if (this._flyRaf) return;
    const st = this._fly || (this._fly = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, mode: 'fly', until: 0, t: 0, ang: 0, px: -999, py: -999 });
    this._onFlyPointer = (e) => { st.px = e.clientX; st.py = e.clientY; };
    window.addEventListener('pointermove', this._onFlyPointer, { passive: true });
    let last = performance.now();
    const loop = (now) => {
      this._flyRaf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this._stepFly(dt);
    };
    this._flyRaf = requestAnimationFrame(loop);
  }

  _stopFly() {
    cancelAnimationFrame(this._flyRaf);
    this._flyRaf = 0;
    window.removeEventListener('pointermove', this._onFlyPointer);
  }

  _stepFly(dt) {
    const el = this.flyEl;
    const logo = el && el.parentElement;
    if (!logo) return;
    const title = logo.querySelector('.menu-logo-main');
    const W = logo.clientWidth, H = logo.clientHeight;
    const tw = title ? title.offsetWidth : W, th = title ? title.offsetHeight : H * 0.5, tl = title ? title.offsetLeft : 0, tt = title ? title.offsetTop : 0;
    const st = this._fly;
    st.t += dt;
    if (this._flyReset) {
      this._flyReset = false;
      st.x = tl + tw + 20; st.y = tt + 10; st.vx = 0; st.vy = 0; st.mode = 'fly'; st.until = st.t + 2.5;
      this._pickFlyTarget(tl, tt, tw, th);
    }
    // flee from the pointer
    const r = logo.getBoundingClientRect();
    const dx = st.x - (st.px - r.left), dy = st.y - (st.py - r.top);
    const dist = Math.hypot(dx, dy);
    if (dist < 90) {
      if (st.mode === 'land') { st.mode = 'fly'; st.until = st.t + 1.2; }
      const k = (90 - dist) / 90;
      st.vx += (dx / (dist || 1)) * 2600 * k * dt;
      st.vy += (dy / (dist || 1)) * 2600 * k * dt;
      if (Math.random() < dt * 3) this._pickFlyTarget(tl, tt, tw, th);
    }
    if (st.mode === 'fly') {
      if (st.t > st.until) {
        // time to land on a letter or pick a new waypoint
        if (Math.random() < 0.3) {
          st.mode = 'approach';
          const spots = [0.13, 0.38, 0.63, 0.87];
          st.tx = tl + tw * spots[(Math.random() * spots.length) | 0];
          st.ty = tt + th * 0.14;
        } else this._pickFlyTarget(tl, tt, tw, th);
        st.until = st.t + 1 + Math.random() * 1.6;
      }
      const ax = (st.tx - st.x) * 9 + Math.sin(st.t * 23) * 900 + Math.sin(st.t * 7.3) * 400;
      const ay = (st.ty - st.y) * 9 + Math.cos(st.t * 19) * 900 + Math.cos(st.t * 5.1) * 400;
      st.vx = (st.vx + ax * dt) * (1 - dt * 3.2);
      st.vy = (st.vy + ay * dt) * (1 - dt * 3.2);
    } else if (st.mode === 'approach') {
      st.vx = (st.vx + (st.tx - st.x) * 30 * dt) * (1 - dt * 7);
      st.vy = (st.vy + (st.ty - st.y) * 30 * dt) * (1 - dt * 7);
      if (Math.hypot(st.tx - st.x, st.ty - st.y) < 3 && Math.hypot(st.vx, st.vy) < 60) {
        st.mode = 'land';
        st.until = st.t + 1.6 + Math.random() * 2.2;
        st.vx = 0; st.vy = 0;
      }
    } else if (st.mode === 'land') {
      st.x += (st.tx - st.x) * Math.min(1, dt * 10);
      st.y += (st.ty - st.y) * Math.min(1, dt * 10);
      if (st.t > st.until) { st.mode = 'fly'; st.vy = -260; st.until = st.t + 1.5 + Math.random() * 2; this._pickFlyTarget(tl, tt, tw, th); }
    }
    if (st.mode !== 'land') { st.x += st.vx * dt; st.y += st.vy * dt; }
    st.x = Math.max(-30, Math.min(W + 30, st.x));
    st.y = Math.max(-30, Math.min(H + 20, st.y));
    const sp = Math.hypot(st.vx, st.vy);
    if (sp > 30) {
      const target = Math.atan2(st.vy, st.vx) + Math.PI / 2;
      let d = target - st.ang;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      st.ang += d * Math.min(1, dt * 10);
    } else if (st.mode === 'land') {
      let d = -st.ang;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      st.ang += d * Math.min(1, dt * 6);
    }
    el.classList.toggle('landed', st.mode === 'land');
    el.style.transform = `translate(${st.x.toFixed(1)}px, ${st.y.toFixed(1)}px) translate(-50%, -50%) rotate(${st.ang.toFixed(3)}rad)`;
  }

  _pickFlyTarget(tl, tt, tw, th) {
    const st = this._fly;
    const side = Math.random();
    if (side < 0.4) { st.tx = tl + tw * (0.75 + Math.random() * 0.4); st.ty = tt + th * (Math.random() * 0.6 - 0.25); }
    else if (side < 0.7) { st.tx = tl + tw * Math.random(); st.ty = tt - 30 - Math.random() * 30; }
    else { st.tx = tl + tw * (0.2 + Math.random() * 0.8); st.ty = tt + th + 10 + Math.random() * 40; }
  }

  // ---- menu music ----------------------------------------------------------------------------------
  // Only after a user gesture, never blocks: the song renders in the background, then fades in quietly.

  _musicWanted() { return local.get('menu.music', true) !== false; }

  _armMusic() {
    if (this._gestureSeen) { if (this._musicWanted()) setTimeout(() => this._startMusic(), 400); return; }
    if (this._armed) return;
    this._armed = true;
    const onGesture = () => {
      window.removeEventListener('pointerdown', onGesture, true);
      window.removeEventListener('keydown', onGesture, true);
      this._gestureSeen = true;
      this._armed = false;
      // let the click do its thing first (it may navigate away)
      setTimeout(() => { if (this.visible && this._musicWanted()) this._startMusic(); }, 500);
    };
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
  }

  async _startMusic() {
    const app = this.app;
    if (!this.visible || this._musicPlaying() || !app.library) return;
    const set = app.library.sets.find((s) => s.source === 'builtin') || app.library.sets[0];
    if (!set) return;
    const token = ++this._musicToken;
    this._musicState = 'loading';
    this._renderMusicBtn();
    let buf = null;
    try { buf = await app.library.getAudioBuffer(set); } catch (e) { console.warn('menu music', e); }
    if (token !== this._musicToken || !this.visible) return;
    if (!buf) { this._musicState = 'off'; this._renderMusicBtn(); return; }
    const a = app.audio;
    try {
      a.ensure();
      const startAt = 0;
      a.play(buf, { startAt });
      this._musicBuf = buf;
      this._musicSrc = a.source;
      this._onMusicEnd = () => { if (this.visible && this._musicSrc === a.source) { a.play(buf, { startAt: 0 }); this._musicSrc = a.source; } };
      a.onEnded = this._onMusicEnd;
      this._applyMusicVolume(true);
      this.bg.setClock(() => (a.playing && a.buffer === buf ? a.songTime() : null), set.bpm || 120);
      this._musicState = 'on';
    } catch (e) {
      console.warn('menu music failed', e);
      this._musicState = 'off';
    }
    this._renderMusicBtn();
  }

  _musicPlaying() {
    const a = this.app.audio;
    return !!(this._musicBuf && a.playing && a.buffer === this._musicBuf && a.source === this._musicSrc);
  }

  _applyMusicVolume(fade) {
    const a = this.app.audio;
    if (!a.ctx || !a.musicGain) return;
    const target = (this.app.settings.volumes?.music ?? 0.75) * 0.38;
    const g = a.musicGain.gain, now = a.ctx.currentTime;
    try {
      g.cancelScheduledValues(now);
      if (fade) { g.setValueAtTime(0.0001, now); g.linearRampToValueAtTime(target, now + 2.5); }
      else g.setValueAtTime(target, now);
    } catch { g.value = target; }
  }

  _stopMusic() {
    this._musicToken++;
    const a = this.app.audio;
    if (this._musicPlaying()) a.stop();
    if (a.onEnded === this._onMusicEnd) a.onEnded = null;
    if (a.ctx && a.musicGain) {
      try { a.musicGain.gain.cancelScheduledValues(a.ctx.currentTime); } catch { /* ignore */ }
    }
    a.setVolumes(this.app.settings.volumes);
    this._musicBuf = null;
    this._musicSrc = null;
    this.bg.setClock(null);
    if (this._musicState !== 'off') { this._musicState = 'idle'; this._renderMusicBtn(); }
  }

  _toggleMusic() {
    uiSfx(this.app);
    const on = !this._musicWanted();
    local.set('menu.music', on);
    this._gestureSeen = true;
    if (on) this._startMusic();
    else { this._stopMusic(); }
    this._renderMusicBtn();
  }

  _renderMusicBtn() {
    const b = this.musicBtn;
    if (!b) return;
    const wanted = this._musicWanted();
    const state = !wanted ? 'off' : this._musicState === 'loading' ? 'loading' : this._musicPlaying() ? 'on' : 'idle';
    b.className = 'menu-top-btn menu-music ' + state;
    clear(b).append(
      state === 'off' ? icon('musicOff') : h('span.menu-eq', h('i'), h('i'), h('i'), h('i')),
      h('span.menu-music-label', state === 'off' ? tr('Музыка выкл.', 'Music off') : state === 'loading' ? tr('Загрузка…', 'Loading…') : tr('Музыка', 'Music')));
  }
}

const FLY_SVG = `<svg viewBox="0 0 40 40" width="40" height="40">
  <defs>
    <radialGradient id="mflyBody" cx="50%" cy="35%" r="70%"><stop offset="0" stop-color="#5a4a8a"/><stop offset="1" stop-color="#140f26"/></radialGradient>
  </defs>
  <g class="mfly-wings">
    <ellipse class="mfly-wing l" cx="13" cy="17" rx="8.5" ry="4.2" transform="rotate(-28 13 17)"/>
    <ellipse class="mfly-wing r" cx="27" cy="17" rx="8.5" ry="4.2" transform="rotate(28 27 17)"/>
  </g>
  <ellipse cx="20" cy="24" rx="5" ry="7.5" fill="url(#mflyBody)" stroke="#ff3d9a" stroke-width="1.2"/>
  <path d="M16.5 22.5h7M16.2 25.8h7.6M17 29h6" stroke="#43e8ff" stroke-width="0.9" opacity="0.7"/>
  <circle cx="20" cy="14.5" r="4" fill="#1c1533" stroke="#ff3d9a" stroke-width="1.2"/>
  <circle cx="17.8" cy="13.6" r="1.9" fill="#ff3d9a"/><circle cx="22.2" cy="13.6" r="1.9" fill="#ff3d9a"/>
  <circle cx="17.3" cy="13.1" r="0.6" fill="#fff"/><circle cx="21.7" cy="13.1" r="0.6" fill="#fff"/>
</svg>`;
