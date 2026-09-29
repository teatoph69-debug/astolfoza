#!/usr/bin/env node
// Renders МУХА's 16×16 pixel-art icon (src/ui/icons.js) to PNGs for the desktop app
// (desktop/build/icon.png 256×256 — electron-builder converts it to .ico/.icns).
import fs from 'node:fs';
import zlib from 'node:zlib';

globalThis.document = { createElement: () => ({}) };
const src = fs.readFileSync(new URL('../src/ui/icons.js', import.meta.url), 'utf8');
const pal = eval('(' + /const PAL = (\{[\s\S]*?\});/.exec(src)[1] + ')');
const fly = eval('(' + /fly: (\[[\s\S]*?\]),/.exec(src)[1] + ')');

function png(size, rows, bg = null) {
  const scale = size / 16;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const ch = rows[Math.floor(y / scale)][Math.floor(x / scale)];
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const hex = ch !== '.' && pal[ch] ? pal[ch] : bg;
      if (!hex) continue;
      const n = parseInt(hex.slice(1), 16);
      raw[o] = (n >> 16) & 255; raw[o + 1] = (n >> 8) & 255; raw[o + 2] = n & 255; raw[o + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const TABLE = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const b of buf) c = TABLE[(c ^ b) & 255] ^ (c >>> 8); return c ^ -1; }

fs.mkdirSync('desktop/build', { recursive: true });
fs.writeFileSync('desktop/build/icon.png', png(256, fly));
fs.writeFileSync('desktop/build/icon-512.png', png(512, fly));
console.log('wrote desktop/build/icon.png (256) and icon-512.png');
