// Tiny, safe bridge: lets the game know it runs as a desktop app and quit/toggle fullscreen.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('muxaDesktop', {
  platform: process.platform,
  quit: () => ipcRenderer.send('muxa:quit'),
  toggleFullscreen: () => ipcRenderer.send('muxa:fullscreen'),
});
