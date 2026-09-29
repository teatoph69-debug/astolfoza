// Entry point: wires the app shell, library, brains and screens together.

import { App } from './ui/app.js';
import { MapLibrary } from './maps/library.js';
import { BrainManager } from './ai/brains.js';
import { importFiles } from './maps/importer.js';
import { tr } from './ui/i18n.js';
import { MenuScreen } from './ui/screens/menu.js';
import { SelectScreen } from './ui/screens/select.js';
import { GameScreen } from './ui/screens/game.js';
import { ResultsScreen } from './ui/screens/results.js';
import { LabScreen } from './ui/screens/lab.js';
import { SettingsScreen } from './ui/screens/settings.js';

async function boot() {
  const app = new App(document.getElementById('app'));
  window.__muxa = app; // handy for debugging from the console

  app.library = new MapLibrary(app.audio);
  app.brains = new BrainManager();
  await Promise.all([app.library.init(), app.brains.init()]);

  app.register('menu', MenuScreen);
  app.register('select', SelectScreen);
  app.register('game', GameScreen);
  app.register('results', ResultsScreen);
  app.register('lab', LabScreen);
  app.register('settings', SettingsScreen);

  // global drag & drop import (works on every screen except during gameplay)
  app.on('files', async (files) => {
    if (app.current?.name === 'game') return;
    try {
      const sets = await importFiles(files, app);
      if (sets.length) {
        app.toast(tr(`Импортировано: ${sets.map((s) => s.title).join(', ')}`, `Imported: ${sets.map((s) => s.title).join(', ')}`), 'success', 4500);
        app.go('select', { focusSet: sets[0].id });
      }
    } catch (e) {
      console.error(e);
      app.toast(tr('Не удалось импортировать: ', 'Import failed: ') + (e.message || e), 'error', 6000);
    }
  });

  app.go('menu', {}, { replace: true });
}

boot().catch((e) => {
  console.error(e);
  document.getElementById('app').innerHTML = `<div style="padding:24px;font-family:system-ui;color:#fff">Ошибка запуска: ${String(e && e.message || e)}</div>`;
});
