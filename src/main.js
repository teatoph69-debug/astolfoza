// Entry point: boots МУХА 98 — splash, library, brains, screens, desktop.

import { App, showBootScreen } from './ui/app.js';
import { MapLibrary } from './maps/library.js';
import { BrainManager } from './ai/brains.js';
import { importFiles, IMPORT_ACCEPT } from './maps/importer.js';
import { tr } from './ui/i18n.js';
import { h } from './ui/dom.js';
import { pickFiles } from './ui/store.js';
import { MenuScreen } from './ui/screens/menu.js';
import { SelectScreen } from './ui/screens/select.js';
import { GameScreen } from './ui/screens/game.js';
import { ResultsScreen } from './ui/screens/results.js';
import { LabScreen } from './ui/screens/lab.js';
import { SettingsScreen } from './ui/screens/settings.js';

async function boot() {
  const root = document.getElementById('app');
  const app = new App(root);
  window.__muxa = app; // handy for debugging from the console
  const splash = showBootScreen(root);

  app.library = new MapLibrary(app.audio);
  app.brains = new BrainManager();
  splash.status(tr('Загрузка карт и мозгов МУХИ…', 'Loading maps and МУХА brains…'));
  await Promise.all([app.library.init(), app.brains.init()]);

  app.register('menu', MenuScreen);
  app.register('select', SelectScreen);
  app.register('game', GameScreen);
  app.register('results', ResultsScreen);
  app.register('lab', LabScreen);
  app.register('settings', SettingsScreen);

  // global drag & drop / "Import maps…" (works everywhere except during gameplay)
  const runImport = async (files) => {
    if (app.current?.name === 'game') return;
    try {
      const sets = await importFiles(files, app);
      if (sets.length) {
        app.toast(tr(`Импортировано: ${sets.map((s) => s.title).join(', ')}`, `Imported: ${sets.map((s) => s.title).join(', ')}`), 'success', 4500);
        app.go('select', { mode: 'play', focusSet: sets[0].id });
      }
    } catch (e) {
      console.error(e);
      app.dialog({ title: tr('Импорт карт', 'Import maps'), icon: 'error', text: tr('Не удалось импортировать:\n', 'Import failed:\n') + (e.message || e) });
    }
  };
  app.on('files', runImport);
  app.on('import-request', async () => {
    const files = await pickFiles(IMPORT_ACCEPT);
    if (files.length) runImport(files);
  });
  app.on('help-request', () => showHelp(app));

  app.go('menu', {}, { replace: true });
  await splash.done(1500);
}

/** Notepad-style "Справка.txt" window. */
export function showHelp(app) {
  const text = tr(
`МУХА 98 — Rhythia Edition
==========================

КАК ИГРАТЬ
  Ноты летят на тебя по сетке 3×3. Наведи курсор на ноту в момент,
  когда она долетает до сетки. Кликать не нужно — только целиться.
  • Мышь — вести курсор (клик по полю захватывает курсор, как в Rhythia)
  • Esc — пауза · R или \` — рестарт · Пробел — пропустить интро
  • На телефоне курсор идёт за пальцем.

КТО ТАКАЯ МУХА
  Нейросеть с «рукой»: у неё ограничены скорость и ускорение, поэтому
  телепортироваться она не может — ей приходится предугадывать ноты,
  тормозить вовремя и срезать углы через хитбоксы, как человеку.

КАК ОНА УЧИТСЯ (МУХА: Лаборатория)
  Каждое поколение ~48 мутантов её мозга играют одни и те же отрывки.
  Кто попал лучше — тянет мозг в сторону своей мутации (Evolution
  Strategies). Освоила уровень — получает карты сложнее (0…20★).
  ★ Навык = самая сложная карта, которую она проходит на ≥ 90 %.

СВОИ КАРТЫ
  rhythia.com/maps → скачай .sspm → перетащи в окно игры.
  Любой mp3/ogg/wav тоже можно перетащить — МУХА сама сделает карту.

ЧЕСТНАЯ ИГРА
  МУХА играет только внутри МУХА 98. Боты в настоящей Rhythia
  запрещены правилами — за них банят.`,
`МУХА 98 — Rhythia Edition
==========================

HOW TO PLAY
  Notes fly at you on a 3×3 grid. Put the cursor on a note when it
  reaches the grid. No clicking — just aim.
  • Mouse — move the cursor (click the field to lock it, like Rhythia)
  • Esc — pause · R or \` — restart · Space — skip intro
  • On phones the cursor follows your finger.

WHO IS МУХА
  A neural network with a "hand" limited in speed and acceleration, so
  she can't teleport — she has to anticipate notes, brake in time and
  cut corners through hitboxes, just like a human.

HOW SHE LEARNS (МУХА Lab)
  Every generation ~48 mutated copies of her brain play the same chart
  fragments. Better mutants pull the brain toward their mutation
  (Evolution Strategies). Master a level → harder maps (0…20★).
  ★ Skill = the hardest difficulty she passes with ≥ 90 %.

YOUR MAPS
  rhythia.com/maps → download .sspm → drop it into the game window.
  Any mp3/ogg/wav works too — МУХА will auto-map it.

FAIR PLAY
  МУХА only plays inside МУХА 98. Bots in the real Rhythia are against
  the rules and get you banned.`);
  const ta = h('textarea.notepad', { readonly: true, spellcheck: false, value: text });
  app.modal(h('div.notepad-wrap', ta), { title: tr('Справка.txt — Блокнот', 'Help.txt — Notepad'), iconName: 'notepad', wide: true });
}

boot().catch((e) => {
  console.error(e);
  document.getElementById('app').innerHTML = `<div style="padding:24px;font-family:Tahoma,sans-serif;color:#fff;background:#000080;position:fixed;inset:0">
  <p style="background:#c0c0c0;color:#000080;display:inline-block;padding:0 6px"><b>МУХА 98</b></p>
  <p>Произошла ошибка при запуске:</p><pre style="white-space:pre-wrap">${String((e && e.stack) || e).replace(/</g, '&lt;')}</pre>
  <p>Нажмите F5, чтобы перезапустить.</p></div>`;
});
