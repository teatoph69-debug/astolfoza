import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importFiles, fingerprint, titleFromFileName, readID3, AUTO_COLORS, TIERS } from '../src/maps/importer.js';
import { mulberry32 } from '../src/core/rng.js';

const fx = (f) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', f));
const file = (name, data) => new File([data], name);

function mockApp({ decode } = {}) {
  const sets = new Map();
  const toasts = [];
  return {
    sets,
    toasts,
    toast: (text, kind) => toasts.push(`${kind}: ${text}`),
    audio: { decode: decode || (async () => { throw new Error('cannot decode in tests'); }) },
    library: {
      getSet: (id) => sets.get(id) || null,
      async addSet(s) { for (const m of s.maps) m.setId = s.id; sets.set(s.id, s); return s; },
    },
  };
}

/** Stored-only ZIP writer (enough for importer routing tests). */
function zipStored(entries) {
  const parts = [], central = [];
  let off = 0;
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  for (const [name, data] of entries) {
    const n = Buffer.from(name), d = Buffer.from(data);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0x800), u16(0), u16(0), u16(0), u32(0), u32(d.length), u32(d.length), u16(n.length), u16(0), n]);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x800), u16(0), u16(0), u16(0), u32(0), u32(d.length), u32(d.length),
      u16(n.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off), n]));
    parts.push(local, d);
    off += local.length + d.length;
  }
  const cd = Buffer.concat(central);
  return Buffer.concat([...parts, cd, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(off), u16(0)]);
}

/** Fake MP3 with an ID3v2.3 tag (title / artist). */
function fakeMp3(title, artist, salt = 0) {
  const frame = (id, text) => {
    const body = Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]);
    const h = Buffer.alloc(10); h.write(id, 0, 'latin1'); h.writeUInt32BE(body.length, 4);
    return Buffer.concat([h, body]);
  };
  const frames = Buffer.concat([frame('TIT2', title), frame('TPE1', artist)]);
  const size = frames.length;
  const hdr = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127]);
  return Buffer.concat([hdr, frames, Buffer.from([0xff, 0xfb, 0x90, 0x64, salt, 1, 2, 3])]);
}

/** AudioBuffer-like drum loop for the auto-mapper path. */
function drumBuffer(bpm = 120, dur = 30, sr = 22050) {
  const x = new Float32Array(dur * sr), rnd = mulberry32(3), beat = 60 / bpm;
  for (let b = 0; 0.5 + b * beat < dur - 0.5; b++) {
    const i0 = Math.round((0.5 + b * beat) * sr);
    for (let i = 0; i < 0.15 * sr; i++) {
      const t = i / sr;
      x[i0 + i] += b % 2 ? (rnd() * 2 - 1) * 0.5 * Math.exp(-t * 25) : Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-t * 30)) * t) * Math.exp(-t * 10);
    }
  }
  return { sampleRate: sr, numberOfChannels: 1, length: x.length, duration: dur, getChannelData: () => x };
}

test('.sspm files of the same song (same audio) become ONE mapset with several difficulties', async () => {
  const app = mockApp();
  const sets = await importFiles([
    file('v1.sspm', fx('sspm_v1.sspm')), file('v2.sspm', fx('sspm_v2_ssp.sspm')), file('py.sspm', fx('sspm_v2_pysspm.sspm')),
  ], app);
  assert.equal(sets.length, 1);
  const s = sets[0];
  assert.match(s.id, /^map:[0-9a-f]{16}$/);
  assert.equal(s.source, 'sspm');
  assert.equal(s.title, 'Title');
  assert.equal(s.artist, 'Artist');
  assert.equal(s.audio.kind, 'bytes');
  assert.equal(s.audio.mime, 'audio/mpeg');
  assert.ok(s.audio.bytes instanceof ArrayBuffer);
  assert.match(s.cover, /^data:image\/png;base64,/);
  assert.equal(s.maps.length, 3);
  const names = s.maps.map((m) => m.difficultyName).sort();
  assert.deepEqual(names, ['Hard (MapperA)', 'Hard (whip)', 'Insane-ish']);
  for (const m of s.maps) {
    assert.equal(m.notes.length, 135);
    assert.ok(m.stars > 0 && m.duration > m.notes[134].t);
    assert.equal(m.color, m.difficultyName.startsWith('Hard') ? TIERS[3].color : TIERS[5].color);
  }
  assert.equal(new Set(s.maps.map((m) => m.id)).size, 3);

  // re-importing a file replaces its map instead of duplicating it
  const again = await importFiles([file('v2 copy.sspm', fx('sspm_v2_ssp.sspm'))], app);
  assert.equal(again[0].id, s.id);
  assert.equal(app.sets.get(s.id).maps.length, 3);
});

test('.txt maps pair with the audio file of the same name; the other audio file is auto-mapped', async () => {
  const app = mockApp({ decode: async () => drumBuffer(120) });
  const txt = '6359218227,2|2|1000,0|0|1500,1|1|2000,2|0|2500';
  const sets = await importFiles([
    file('My Song [Hard].txt', txt),
    file('My Song.mp3', fakeMp3('Real Title', 'Real Artist')),
    file('02_Some Band - Other Tune (Official Video).ogg', Buffer.from('OggS fake ogg bytes')),
  ], app);
  assert.equal(sets.length, 2);
  const txtSet = sets.find((s) => s.source === 'txt');
  assert.equal(txtSet.title, 'Real Title');
  assert.equal(txtSet.artist, 'Real Artist');
  assert.equal(txtSet.audio.kind, 'bytes');
  assert.equal(txtSet.maps[0].difficultyName, 'Hard');
  assert.deepEqual(txtSet.maps[0].notes[0], { t: 1, x: 0, y: 0 }); // (2|2) → top-left

  const auto = sets.find((s) => s.source === 'auto');
  assert.match(auto.id, /^auto:/);
  assert.equal(auto.title, 'Other Tune');
  assert.equal(auto.artist, 'Some Band');
  assert.equal(auto.audio.mime, 'audio/ogg');
  assert.ok(Math.abs(auto.bpm - 120) <= 2, `bpm ${auto.bpm}`);
  assert.deepEqual(auto.maps.map((m) => m.difficultyId), ['easy', 'normal', 'hard', 'insane', 'extreme']);
  assert.deepEqual(auto.maps.map((m) => m.color), Object.values(AUTO_COLORS));
  assert.ok(auto.maps.every((m) => m.duration === 30 && m.notes.length > 5));
  assert.ok(app.toasts.some((t) => t.includes('МУХА')));
});

test('.txt without audio → silent map; archives are unpacked (non-map .txt inside is ignored)', async () => {
  const app = mockApp();
  const zip = zipStored([['pack/a.sspm', fx('sspm_v1.sspm')], ['pack/readme.txt', 'thanks for downloading!'], ['__MACOSX/._a.sspm', 'junk']]);
  const sets = await importFiles([file('silent.txt', '1,1|1|500,0|2|900'), file('pack.zip', zip)], app);
  assert.equal(sets.length, 2);
  const silent = sets.find((s) => s.source === 'txt');
  assert.deepEqual(silent.audio, { kind: 'none' });
  assert.deepEqual(silent.maps[0].notes, [{ t: 0.5, x: 1, y: 1 }, { t: 0.9, x: 2, y: 0 }]);
  assert.ok(sets.find((s) => s.source === 'sspm'));
  assert.ok(app.toasts.some((t) => t.includes('без музыки')));
  assert.ok(!app.toasts.some((t) => t.startsWith('error')));
});

test('nothing importable → one Error naming the files (Russian)', async () => {
  await assert.rejects(importFiles([file('notes.docx', Buffer.from('PK\u0003\u0004garbage'))], mockApp()), /notes\.docx/);
  await assert.rejects(importFiles([file('x.bin', Buffer.from([1, 2, 3]))], mockApp()), /Неизвестный формат/);
  await assert.rejects(importFiles([file('song.mp3', Buffer.from('ID3 not really'))], mockApp()), /декодировать/);
  await assert.rejects(importFiles([], mockApp()), /Нет файлов/);
});

test('helpers: fingerprint, file-name titles, ID3 tags', () => {
  const a = new Uint8Array(100000).map((_, i) => i * 7);
  const b = a.slice(); b[50000] ^= 1;
  assert.equal(fingerprint(a), fingerprint(a.slice()));
  assert.notEqual(fingerprint(a), fingerprint(a.subarray(0, 99999)));
  assert.match(fingerprint(a), /^[0-9a-f]{16}$/);
  assert.deepEqual(titleFromFileName('01. Camellia - Ghost (Official Audio)'), { artist: 'Camellia', title: 'Ghost' });
  assert.deepEqual(titleFromFileName('my_cool_song'), { artist: '', title: 'my cool song' });
  const tags = readID3(new Uint8Array(fakeMp3('Титул', 'Артист')));
  assert.equal(tags.title, 'Титул');
  assert.equal(tags.artist, 'Артист');
  assert.equal(readID3(new Uint8Array([1, 2, 3])), null);
});
