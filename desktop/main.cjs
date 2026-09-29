// МУХА 98 desktop app (Electron). Loads the single-file game build from ./app/index.html.
const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    title: 'МУХА 98',
    backgroundColor: '#008080',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // МУХА keeps training while the window is minimized
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // external links open in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); }
  });
  // F11 fullscreen, Ctrl+Shift+I devtools
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (input.key === 'I' && input.control && input.shift) win.webContents.toggleDevTools();
  });

  // automated smoke test: MUXA_SCREENSHOT=path.png → capture after boot and quit
  if (process.env.MUXA_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        require('fs').writeFileSync(process.env.MUXA_SCREENSHOT, img.toPNG());
        app.quit();
      }, +(process.env.MUXA_SCREENSHOT_DELAY || 4000));
    });
  }
}

ipcMain.on('muxa:quit', () => app.quit());
ipcMain.on('muxa:fullscreen', () => { if (win) win.setFullScreen(!win.isFullScreen()); });

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
