// Desktop (the 'menu' screen is not framed — it IS the desktop over the teal wallpaper):
// desktop icons, a small floating «Твоя МУХА» status window, the first-run «Добро пожаловать»
// dialog and a Win98-beta-style build watermark.
//
// Also exports small helpers shared by the other menu screens (select / results / settings).

import { Screen } from '../app.js';
import { h, clear } from '../dom.js';
import { tr, getLang, fmtNum } from '../i18n.js';
import { icon } from '../icons.js';
import { win98Window, desktopIcon, progress98, button98, checkbox98 } from '../win98.js';
import { TITLES } from '../../ai/trainer.js';
import { version as PKG_VERSION } from '../../../package.json';

// =================================================================================================
// Shared helpers
// =================================================================================================

/** Quiet UI click. */
export function uiSfx(app, name = 'ui', gain = 0.45) {
  try { app.audio.sfx(name, gain); } catch { /* audio not ready */ }
}

/** Navigate to `name`, dropping it (and everything after it) from history so Esc never loops. */
export function goBackTo(app, name, params = {}) {
  const idx = app.history.map((e) => e.name).lastIndexOf(name);
  if (idx >= 0) app.history.length = idx;
  else app.history = app.history.filter((e) => e.name === 'menu').slice(0, 1);
  if (name === 'menu') app.history.length = 0;
  app.go(name, params, { replace: true });
}

/** Close a program window: drop it from the taskbar and return to the desktop. */
export function closeProgram(app, name) {
  app.tasks = (app.tasks || []).filter((t) => t.name !== name);
  app.history.length = 0;
  app.go('menu', {}, { replace: true });
}

export function isModalOpen(app) { return !!(app.modalLayer && app.modalLayer.childElementCount); }

export function brainName(b) { return b ? (getLang() === 'en' ? (b.en || b.name) : b.name) : ''; }
export function titleName(t) { return t ? (getLang() === 'en' ? t.en : t.ru) : ''; }

export function sourceLabel(source) {
  switch (source) {
    case 'builtin': return tr('встроенная', 'built-in');
    case 'sspm': return 'Rhythia .sspm';
    case 'rhm': return 'Rhythia .rhm';
    case 'txt': return 'Sound Space .txt';
    case 'auto': return tr('авто-карта', 'auto-map');
    default: return String(source || '—');
  }
}

/** Win98 confirmation message box → Promise<boolean>. */
export async function confirmDialog(app, { title, text, ok, cancel, danger = false }) {
  const v = await app.dialog({
    title: title || 'МУХА 98', text, icon: danger ? 'warning' : 'help',
    buttons: [{ label: ok || 'OK', value: true, primary: true }, { label: cancel || tr('Отмена', 'Cancel'), value: false }],
  });
  return v === true;
}

/** Fade the music bus in to `target` over `secs` (after audio.play()). */
export function fadeMusicIn(app, target, secs = 1.5) {
  const a = app.audio;
  if (!a.ctx || !a.musicGain) return;
  const g = a.musicGain.gain, now = a.ctx.currentTime;
  try {
    g.cancelScheduledValues(now);
    g.setValueAtTime(0.0001, now);
    g.linearRampToValueAtTime(Math.max(0.0001, target), now + secs);
  } catch { g.value = target; }
}

/** Cancel any fades and put the music bus back to the user's volume. */
export function restoreMusicVolume(app) {
  const a = app.audio;
  if (a.ctx && a.musicGain) {
    try { a.musicGain.gain.cancelScheduledValues(a.ctx.currentTime); } catch { /* ignore */ }
  }
  a.setVolumes(app.settings.volumes);
}

/**
 * Subscribe to an emitter and remember the unsubscribe under `owner`, so a re-created screen
 * (a language switch rebuilds every screen) never leaves stale listeners behind.
 */
const subs = new Map();
export function listen(owner, emitter, ev, fn) {
  if (!emitter || !emitter.on) return;
  const off = emitter.on(ev, fn);
  if (!subs.has(owner)) subs.set(owner, []);
  subs.get(owner).push(off);
}
export function unlistenAll(owner) {
  for (const off of subs.get(owner) || []) { try { off(); } catch { /* ignore */ } }
  subs.delete(owner);
}

// =================================================================================================
// Desktop screen
// =================================================================================================

const BUILD = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : null; // eslint-disable-line no-undef
let welcomeDone = false;   // the welcome dialog shows once per page load
let flyWinClosed = false;  // «Твоя МУХА» window closed for this session

export class MenuScreen extends Screen {
  mount() {
    unlistenAll('menu');
    this.visible = false;
    listen('menu', this.app.brains, 'change', () => { if (this.visible) this._renderFlyWin(); });
    this.build();
  }

  show() {
    this.visible = true;
    if (this._builtLang !== getLang()) this.build();
    this._renderFlyWin();
    if (!welcomeDone) {
      welcomeDone = true;
      if (this.app.settings.showWelcome !== false) {
        setTimeout(() => { if (this.visible && !isModalOpen(this.app)) this.openWelcome(); }, 1700);
      }
    }
  }

  hide() { this.visible = false; }

  // ---- DOM -----------------------------------------------------------------------------------

  build() {
    const app = this.app;
    this._builtLang = getLang();
    const I = (iconName, label, onOpen, title) => desktopIcon({ iconName, label, onOpen: () => { uiSfx(app); onOpen(); }, title });
    this.icons = [
      I('play', tr('Играть', 'Play'), () => app.go('select', { mode: 'play' }), tr('Выбрать карту и играть (Enter)', 'Pick a map and play (Enter)')),
      I('watch', tr('Смотреть МУХУ', 'Watch МУХА'), () => app.go('select', { mode: 'watch' })),
      I('versus', tr('Против МУХИ', 'Versus МУХА'), () => app.go('select', { mode: 'versus' })),
      I('lab', 'МУХА Lab', () => app.go('lab'), tr('Обучить нейросеть', 'Train the neural network')),
      I('folder', tr('Мои карты', 'My Maps'), () => app.go('select', { mode: 'play' })),
      I('floppy', tr('Импорт карт', 'Import maps'), () => app.emit('import-request'), '.sspm / .rhm / .txt / mp3 / ogg / wav'),
      I('settings', tr('Настройки', 'Settings'), () => app.go('settings')),
      I('notepad', tr('Справка.txt', 'Help.txt'), () => app.emit('help-request')),
      I('bin', tr('Корзина', 'Recycle Bin'), () => this._recycleBin()),
    ];
    this.grid = h('div.menu-icons', this.icons);
    this.flyWin = win98Window({
      title: tr('Твоя МУХА', 'Your МУХА'), iconName: 'fly', controls: ['close'], className: 'menu-flywin',
      onControl: () => { uiSfx(app); flyWinClosed = true; this.flyWin.root.remove(); },
    });
    let date = '';
    if (BUILD) {
      const d = new Date(BUILD);
      if (!isNaN(d)) date = d.toLocaleDateString(getLang() === 'en' ? 'en-GB' : 'ru-RU');
    }
    const mark = h('div.menu-watermark',
      h('div', 'МУХА 98 Rhythia Edition'),
      h('div', `${tr('Версия', 'Version')} ${PKG_VERSION}${date ? ` · ${tr('сборка', 'build')} ${date}` : ''}`));
    clear(this.el).append(this.grid, mark);
    this._renderFlyWin();
  }

  _renderFlyWin() {
    const app = this.app;
    const w = this.flyWin;
    if (!w) return;
    if (flyWinClosed) { w.root.remove(); return; }
    if (!w.root.isConnected) this.el.appendChild(w.root);
    const list = app.brains ? app.brains.list() : [];
    const live = list.find((b) => b.kind === 'live');
    const best = list.filter((b) => b.kind !== 'live').sort((a, b) => b.skill - a.skill)[0];
    const body = h('div.menu-fly');
    if (live) {
      const t = live.title;
      const p = t.next ? t.progress : 1;
      const bar = progress98({ value: p, label: Math.round(p * 100) + '%' });
      body.append(
        h('div.menu-fly-head',
          h('div.menu-fly-rank.sunken', h('span', t.emoji || '🪰')),
          h('div.menu-fly-info',
            h('div.menu-fly-title', titleName(t)),
            h('div.menu-fly-skill.display', '★ ' + (live.skill || 0).toFixed(2)),
            h('div.menu-fly-gen', tr(`Поколение ${fmtNum(live.gen || 0)} · ранг ${t.index + 1} из ${TITLES.length}`, `Generation ${fmtNum(live.gen || 0)} · rank ${t.index + 1} of ${TITLES.length}`)))),
        h('div.menu-fly-next', t.next
          ? tr(`До ранга «${t.next.emoji} ${titleName(t.next)}» (★${t.next.min}):`, `Next rank “${t.next.emoji} ${titleName(t.next)}” (★${t.next.min}):`)
          : tr('Максимальный ранг!', 'Maximum rank!')),
        bar.root,
        h('div.menu-fly-btns',
          button98(tr('Лаборатория', 'Lab'), () => { uiSfx(app); app.go('lab'); }, { iconName: 'lab', primary: true }),
          button98(tr('Смотреть', 'Watch'), () => { uiSfx(app); app.brains.select('live'); app.go('select', { mode: 'watch' }); }, { iconName: 'watch' })));
    } else {
      body.append(
        h('div.menu-fly-head',
          h('div.menu-fly-rank.sunken.egg', h('span', '🥚')),
          h('div.menu-fly-info',
            h('div.menu-fly-title', tr('МУХА ещё не родилась', 'МУХА hasn’t hatched yet')),
            h('div.menu-fly-text', tr('Начни обучение в Лаборатории — и смотри, как она растёт от личинки до бога ритма.', 'Start training in the Lab and watch her grow from a larva into a rhythm god.')))),
        h('div.menu-fly-btns',
          button98(tr('Начать обучение', 'Start training'), () => { uiSfx(app); app.go('lab'); }, { iconName: 'lab', primary: true })));
    }
    if (best) {
      body.append(h('div.menu-fly-best',
        tr('Сильнейшая готовая: ', 'Strongest pretrained: '),
        h('b', `${best.title?.emoji || ''} ${brainName(best)}`), ` ★${best.skill.toFixed(1)}`));
    }
    clear(w.body).append(body);
  }

  // ---- dialogs -----------------------------------------------------------------------------------

  openWelcome() {
    const app = this.app;
    let close = null;
    const link = (iconName, label, sub, fn) => h('button.menu-wel-link', {
      type: 'button', onclick: () => { uiSfx(app); close && close(); fn(); },
    }, icon(iconName, 32), h('span.menu-wel-link-text', h('b', label), h('span', sub)));
    const links = h('div.menu-wel-links',
      link('play', tr('Играть', 'Play'), tr('выбери карту и лови ноты', 'pick a map and catch the notes'), () => app.go('select', { mode: 'play' })),
      link('lab', tr('Обучить МУХУ', 'Train МУХА'), tr('нейросеть учится с нуля', 'the network learns from scratch'), () => app.go('lab')),
      link('versus', tr('Против МУХИ', 'Versus МУХА'), tr('кто точнее — ты или она?', 'who aims better — you or her?'), () => app.go('select', { mode: 'versus' })),
      link('floppy', tr('Импорт карт', 'Import maps'), tr('.sspm из Rhythia или любая песня', 'Rhythia .sspm or any song'), () => app.emit('import-request')),
      link('notepad', tr('Справка', 'Help'), tr('управление и как учится МУХА', 'controls and how МУХА learns'), () => app.emit('help-request')));
    const showBox = checkbox98(tr('Показывать при запуске', 'Show this at startup'), app.settings.showWelcome !== false, (v) => { app.settings.showWelcome = v; app.saveSettings(); });
    const body = h('div.menu-wel',
      h('div.menu-wel-top',
        h('div.menu-wel-hello.display', tr('Добро пожаловать в ', 'Welcome to '), h('b', 'МУХА'), h('sup', '98')),
        icon('fly', 48, 'menu-wel-fly')),
      h('div.menu-wel-main',
        links,
        h('div.menu-wel-text.sunken',
          h('p', h('b', 'МУХА 98'), tr(' — aim-ритм игра в стиле Rhythia прямо в браузере.', ' is a Rhythia-style aim rhythm game right in your browser.')),
          h('p', tr('Ноты летят на тебя по сетке 3×3 — наведи курсор на ноту, когда она долетит до сетки. Кликать не нужно, только целиться.', 'Notes fly at you on a 3×3 grid — put the cursor on each note as it reaches the grid. No clicking, just aim.')),
          h('p', tr('А ещё здесь живёт МУХА — нейросеть, которая учится играть у тебя на глазах. Обучи её в Лаборатории, смотри, как она проходит карты, или сразись с ней.', 'And МУХА lives here — a neural network that learns to play right before your eyes. Train her in the Lab, watch her clear maps, or challenge her.')),
          h('p.dim', tr('Совет: перетащи в окно .sspm карту из Rhythia или любую песню.', 'Tip: drop a Rhythia .sspm map or any song into the window.')))),
      h('div.menu-wel-foot', showBox, button98(tr('Закрыть', 'Close'), () => close && close(), { primary: true })));
    close = app.modal(body, { title: tr('Добро пожаловать', 'Welcome'), iconName: 'fly', wide: true });
  }

  _recycleBin() {
    this.app.dialog({
      title: tr('Корзина', 'Recycle Bin'), icon: 'bin',
      text: tr('Корзина пуста.\nМУХА съела всё, что там было. Даже промахи.', 'The Recycle Bin is empty.\nМУХА ate everything that was in it. Even the misses.'),
      buttons: [{ label: tr('Бзз…', 'Bzz…'), value: true, primary: true }],
    });
  }

  // ---- keyboard ----------------------------------------------------------------------------------

  keydown(e) {
    if (isModalOpen(this.app)) return false;
    const onIcon = e.target && e.target.closest && e.target.closest('.desk-icon');
    if (e.key === 'Enter') {
      if (onIcon) return false;          // a focused icon opens itself
      uiSfx(this.app);
      this.app.go('select', { mode: 'play' });
      return true;
    }
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      const n = this.icons.length;
      let i = this.icons.indexOf(onIcon || this.el.querySelector('.desk-icon.selected'));
      const rows = Math.max(1, Math.floor((this.grid.clientHeight + 4) / 90));
      if (i < 0) i = 0;
      else if (e.key === 'ArrowDown') i = Math.min(n - 1, i + 1);
      else if (e.key === 'ArrowUp') i = Math.max(0, i - 1);
      else if (e.key === 'ArrowRight') i = Math.min(n - 1, i + rows);
      else i = Math.max(0, i - rows);
      this.icons.forEach((el, k) => el.classList.toggle('selected', k === i));
      this.icons[i].focus();
      return true;
    }
    return false;
  }
}
