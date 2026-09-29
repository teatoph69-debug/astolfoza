// Copies the single-file web build into the Electron app folder.
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'dist', 'index.html');
const dst = path.join(__dirname, 'app', 'index.html');
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);
console.log('copied', src, '→', dst);
