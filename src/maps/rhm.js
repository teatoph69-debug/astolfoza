// ZIP-based map formats:
//   * .rhm  — Steam Rhythia: ZIP with `map` (UTF-8 JSON: SongName, Title, Mappers, Difficulty,
//             CustomDifficultyName, StarRating, Duration (ms), Notes[{Time (ms), X, Y}], AudioFileName,
//             ImagePath…), `audio` (usually MP3) and `cover` (usually PNG). Coordinates: same 0..2 grid and
//             orientation as .sspm (x 0 = left, y 0 = top) → our grid space unchanged.
//   * .phxm — Rhythia "Rewrite" client / Phoenyx: ZIP with metadata.json, objects.phxmo (binary notes in the
//             client's centred space, +y up: x_ours = x + 1, y_ours = 1 − y), audio.<ext>, cover.png.
//
// Contains a minimal ZIP reader (central directory, ZIP64, stored + deflate). Deflate is decoded with the
// platform's DecompressionStream('deflate-raw') (browsers, Node ≥ 18) or an injected `inflateRaw(u8)`.

import { formatError, toU8, songArtistTitle, sniffAudioMime, sniffImageMime, SSPM_DIFFICULTY_NAMES } from './sspm.js';

const td = new TextDecoder('utf-8');

export function isZip(bytes) {
  const u8 = toU8(bytes);
  return u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 3 || u8[2] === 5) && (u8[3] === 4 || u8[3] === 6);
}

// ---- ZIP reader ------------------------------------------------------------------------------

/**
 * List the entries of a ZIP archive.
 * @returns {{ name:string, size:number, compressedSize:number, method:number, read:() => Promise<Uint8Array> }[]}
 */
export function readZip(input, { inflateRaw = null } = {}) {
  const u8 = toU8(input);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const len = u8.length;
  const u16 = (p) => dv.getUint16(p, true);
  const u32 = (p) => dv.getUint32(p, true);
  const u64 = (p) => dv.getUint32(p + 4, true) * 4294967296 + dv.getUint32(p, true);
  const inflate = inflateRaw || defaultInflateRaw;

  const makeEntry = (name, method, flags, csize, usize, localOff) => ({
    name,
    size: usize,
    compressedSize: csize,
    method,
    read: async () => {
      if (localOff + 30 > len || u32(localOff) !== 0x04034b50) {
        throw formatError(`Архив повреждён: запись «${name}» не найдена`, `Corrupted archive: entry "${name}" not found`);
      }
      const start = localOff + 30 + u16(localOff + 26) + u16(localOff + 28);
      if (start + csize > len) throw formatError('Архив обрезан (не докачан?)', 'Archive is truncated (incomplete download?)');
      if (flags & 1) throw formatError(`Запись «${name}» зашифрована`, `Entry "${name}" is encrypted`);
      const data = u8.subarray(start, start + csize);
      if (method === 0) return data.slice();
      if (method === 8) {
        const out = toU8(await inflate(data));
        return out;
      }
      throw formatError(`Неподдерживаемое сжатие в архиве (метод ${method})`, `Unsupported archive compression (method ${method})`);
    },
  });

  // End of central directory: scan backwards (comment can be up to 64 KB)
  let eocd = -1;
  for (let p = len - 22; p >= Math.max(0, len - 22 - 65535); p--) {
    if (u8[p] === 0x50 && u8[p + 1] === 0x4b && u8[p + 2] === 5 && u8[p + 3] === 6) { eocd = p; break; }
  }
  const entries = [];
  if (eocd >= 0) {
    let count = u16(eocd + 10);
    let cdOff = u32(eocd + 16);
    // ZIP64 locator right before the EOCD
    if ((count === 0xffff || cdOff === 0xffffffff) && eocd >= 20 && u32(eocd - 20) === 0x07064b50) {
      const z64 = u64(eocd - 12);
      if (z64 + 56 <= len && u32(z64) === 0x06064b50) {
        count = u64(z64 + 32);
        cdOff = u64(z64 + 48);
      }
    }
    let p = cdOff;
    for (let i = 0; i < count; i++) {
      if (p + 46 > len || u32(p) !== 0x02014b50) break;
      const flags = u16(p + 8);
      const method = u16(p + 10);
      let csize = u32(p + 20);
      let usize = u32(p + 24);
      const nlen = u16(p + 28), elen = u16(p + 30), clen = u16(p + 32);
      let localOff = u32(p + 42);
      const name = decodeName(u8.subarray(p + 46, p + 46 + nlen), flags);
      // ZIP64 extra field (id 1): the 0xffffffff fields, in order usize, csize, local offset
      let e = p + 46 + nlen;
      const eEnd = Math.min(len, e + elen);
      while (e + 4 <= eEnd) {
        const id = u16(e), sz = u16(e + 2);
        if (id === 1) {
          let q = e + 4;
          if (usize === 0xffffffff && q + 8 <= e + 4 + sz) { usize = u64(q); q += 8; }
          if (csize === 0xffffffff && q + 8 <= e + 4 + sz) { csize = u64(q); q += 8; }
          if (localOff === 0xffffffff && q + 8 <= e + 4 + sz) { localOff = u64(q); q += 8; }
        }
        e += 4 + sz;
      }
      if (!name.endsWith('/')) entries.push(makeEntry(name, method, flags, csize, usize, localOff));
      p += 46 + nlen + elen + clen;
    }
  }
  if (!entries.length) {
    // No / broken central directory (truncated download?): walk the local headers instead.
    let p = 0;
    while (p + 30 <= len && u32(p) === 0x04034b50) {
      const flags = u16(p + 6), method = u16(p + 8);
      const csize = u32(p + 18), usize = u32(p + 22);
      const nlen = u16(p + 26), elen = u16(p + 28);
      const name = decodeName(u8.subarray(p + 30, p + 30 + nlen), flags);
      if (flags & 8) break; // sizes live in a data descriptor after the data — cannot walk further
      if (!name.endsWith('/')) entries.push(makeEntry(name, method, flags, csize, usize, p));
      p += 30 + nlen + elen + csize;
    }
  }
  if (!entries.length) throw formatError('Архив пустой или повреждён', 'The archive is empty or corrupted');
  return entries;
}

function decodeName(bytes, flags) {
  // bit 11 = UTF-8; otherwise CP437 — ASCII names are identical in both, good enough here
  if (flags & 0x800) return td.decode(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

async function defaultInflateRaw(u8) {
  if (typeof DecompressionStream === 'undefined') {
    throw formatError('Этот браузер не умеет распаковывать ZIP (нет DecompressionStream). Обнови браузер.',
      'This browser cannot unpack ZIP files (no DecompressionStream). Please update it.');
  }
  try {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (e) {
    throw formatError('Архив повреждён (ошибка распаковки)', 'Corrupted archive (inflate failed)');
  }
}

/** Case-insensitive lookup of a zip entry by exact name, then by basename. */
function findEntry(entries, ...names) {
  for (const n of names) {
    if (!n) continue;
    const want = String(n).toLowerCase();
    const hit = entries.find((e) => e.name.toLowerCase() === want) ||
      entries.find((e) => e.name.toLowerCase().split('/').pop() === want.split('/').pop());
    if (hit) return hit;
  }
  return null;
}

const AUDIO_EXT = /\.(mp3|ogg|oga|opus|wav|flac|m4a|aac|webm)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;

// ---- .rhm --------------------------------------------------------------------------------------

/** True if a ZIP's entry list looks like an .rhm (has a `map` entry). */
export function looksLikeRHM(entries) {
  return !!findEntry(entries, 'map');
}

/** True if a ZIP's entry list looks like a .phxm. */
export function looksLikePHXM(entries) {
  return !!findEntry(entries, 'objects.phxmo') && !!findEntry(entries, 'metadata.json');
}

/**
 * Parse a Steam Rhythia .rhm file.
 * @returns same shape as parseSSPM (version: 'rhm')
 */
export async function parseRHM(input, opts = {}) {
  const entries = readZip(input, opts);
  const mapEntry = findEntry(entries, 'map', 'map.json');
  if (!mapEntry) throw formatError('Это не карта .rhm: в архиве нет файла «map»', 'Not an .rhm map: the archive has no "map" entry');
  let json;
  try {
    json = JSON.parse(td.decode(await mapEntry.read()).replace(/^﻿/, ''));
  } catch (e) {
    if (e.code === 'MAP_FORMAT') throw e;
    throw formatError('Карта .rhm повреждена: неверный JSON', 'Corrupted .rhm map: invalid JSON');
  }
  if (!json || typeof json !== 'object') throw formatError('Карта .rhm повреждена', 'Corrupted .rhm map');
  const get = ci(json);

  const rawNotes = get('Notes') || get('HitObjects') || [];
  if (!Array.isArray(rawNotes)) throw formatError('Карта .rhm повреждена: нет списка нот', 'Corrupted .rhm map: no note list');
  const notes = [];
  for (const n of rawNotes) {
    let t, x, y;
    if (Array.isArray(n)) {
      [x, y, t] = n; // tolerate [x, y, ms] tuples
    } else if (n && typeof n === 'object') {
      const g = ci(n);
      t = g('Time') ?? g('Ms') ?? g('Millisecond') ?? g('T');
      x = g('X');
      y = g('Y');
    }
    t = Number(t); x = Number(x); y = Number(y);
    if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    notes.push({ t: t / 1000, x: round6(x), y: round6(y) });
  }
  notes.sort((a, b) => a.t - b.t || a.y - b.y || a.x - b.x);
  if (!notes.length) throw formatError('В карте .rhm нет ни одной ноты', 'The .rhm map contains no notes');

  const songName = str(get('SongName'));
  const name = str(get('Title')) || songName;
  const { artist, title } = songArtistTitle(songName, name);
  const difficulty = clampDifficulty(Number(get('Difficulty')) || 0);
  const customName = str(get('CustomDifficultyName'));
  let mappers = get('Mappers');
  if (typeof mappers === 'string') mappers = mappers.split(/\s*(?:&|,)\s*/);
  mappers = Array.isArray(mappers) ? mappers.map(str).map((s) => s.trim()).filter(Boolean) : [];

  const audioEntry = findEntry(entries, 'audio', str(get('AudioFileName'))) ||
    entries.find((e) => AUDIO_EXT.test(e.name) || /^audio(\.|$)/i.test(e.name.split('/').pop()));
  const imagePath = str(get('ImagePath'));
  const coverEntry = findEntry(entries, imagePath, 'cover', 'cover.png', 'cover.jpg') ||
    entries.find((e) => IMAGE_EXT.test(e.name));

  const warnings = [];
  const audio = audioEntry ? await readOptional(audioEntry, warnings) : null;
  const cover = coverEntry ? await readOptional(coverEntry, warnings) : null;
  const coverMime = cover ? sniffImageMime(cover) : null;

  return {
    version: 'rhm',
    id: str(get('LegacyId')) || str(get('OnlineId')) || '',
    name,
    songName: songName || name,
    artist,
    title,
    mappers,
    difficulty,
    difficultyName: customName.trim() || SSPM_DIFFICULTY_NAMES[difficulty] || '',
    rating: Number(get('StarRating')) || 0,
    requiresMod: false,
    lastMs: Math.round(notes[notes.length - 1].t * 1000),
    durationMs: Number(get('Duration')) || 0,
    notes,
    audio: audio ? audio.slice().buffer : null,
    audioMime: audio ? (sniffAudioMime(audio) || mimeFromName(audioEntry.name)) : null,
    cover: cover && coverMime ? cover.slice().buffer : null,
    coverMime: cover && coverMime ? coverMime : null,
    customData: {},
    warnings,
  };
}

// ---- .phxm -------------------------------------------------------------------------------------

/** Parse a Rhythia "Rewrite" client / Phoenyx .phxm map (same result shape as parseSSPM). */
export async function parsePHXM(input, opts = {}) {
  const entries = readZip(input, opts);
  const metaEntry = findEntry(entries, 'metadata.json');
  const objEntry = findEntry(entries, 'objects.phxmo');
  if (!metaEntry || !objEntry) throw formatError('Это не карта .phxm', 'Not a .phxm map');
  let meta;
  try {
    meta = JSON.parse(td.decode(await metaEntry.read()).replace(/^﻿/, ''));
  } catch (e) {
    if (e.code === 'MAP_FORMAT') throw e;
    throw formatError('Карта .phxm повреждена: неверный metadata.json', 'Corrupted .phxm map: invalid metadata.json');
  }
  const get = ci(meta || {});
  const obj = await objEntry.read();
  const dv = new DataView(obj.buffer, obj.byteOffset, obj.byteLength);
  const notes = [];
  const warnings = [];
  if (obj.length >= 8) {
    const count = dv.getUint32(4, true);
    let p = 8;
    for (let i = 0; i < count; i++) {
      if (p + 5 > obj.length) { warnings.push('objects.phxmo is truncated'); break; }
      const ms = dv.getUint32(p, true);
      const quantum = obj[p + 4] !== 0;
      p += 5;
      let x, y;
      if (quantum) {
        if (p + 8 > obj.length) { warnings.push('objects.phxmo is truncated'); break; }
        x = dv.getFloat32(p, true) + 1;
        y = 1 - dv.getFloat32(p + 4, true);
        p += 8;
      } else {
        if (p + 2 > obj.length) { warnings.push('objects.phxmo is truncated'); break; }
        x = obj[p]; // stored as x + 1 (x ∈ −1..1)
        y = 2 - obj[p + 1]; // stored as y + 1, +y up → flip
        p += 2;
      }
      if (Number.isFinite(x) && Number.isFinite(y)) notes.push({ t: ms / 1000, x: round6(x), y: round6(y) });
    }
  }
  notes.sort((a, b) => a.t - b.t || a.y - b.y || a.x - b.x);
  if (!notes.length) throw formatError('В карте .phxm нет ни одной ноты', 'The .phxm map contains no notes');

  const ext = str(get('AudioExt')) || 'mp3';
  const audioEntry = get('HasAudio') === false ? null
    : findEntry(entries, `audio.${ext}`) || entries.find((e) => /^audio\./i.test(e.name.split('/').pop()));
  const coverEntry = get('HasCover') === false ? null : findEntry(entries, 'cover.png', 'cover.jpg');
  const audio = audioEntry ? await readOptional(audioEntry, warnings) : null;
  const cover = coverEntry ? await readOptional(coverEntry, warnings) : null;
  const coverMime = cover ? sniffImageMime(cover) : null;
  const artist = str(get('Artist')).trim();
  const title = str(get('Title')).trim();
  const difficulty = clampDifficulty(Number(get('Difficulty')) || 0);
  let mappers = get('Mappers');
  mappers = Array.isArray(mappers) ? mappers.map(str).map((s) => s.trim()).filter(Boolean) : [];
  const name = artist ? `${artist} - ${title}` : title;
  return {
    version: 'phxm',
    id: str(get('ID')),
    name,
    songName: name,
    artist,
    title: title || str(get('ID')),
    mappers,
    difficulty,
    difficultyName: str(get('DifficultyName')).trim() || PHXM_DIFFICULTY_NAMES[difficulty] || '',
    rating: Number(get('Rating')) || 0,
    requiresMod: false,
    lastMs: Math.round(notes[notes.length - 1].t * 1000),
    durationMs: Number(get('Length')) || 0,
    notes,
    audio: audio ? audio.slice().buffer : null,
    audioMime: audio ? (sniffAudioMime(audio) || mimeFromName(audioEntry.name)) : null,
    cover: cover && coverMime ? cover.slice().buffer : null,
    coverMime: cover && coverMime ? coverMime : null,
    customData: {},
    warnings,
  };
}

// The Rewrite client renames the top tiers.
const PHXM_DIFFICULTY_NAMES = ['', 'Easy', 'Medium', 'Hard', 'Insane', 'Illogical'];

// ---- helpers -----------------------------------------------------------------------------------

async function readOptional(entry, warnings) {
  try {
    return await entry.read();
  } catch (e) {
    warnings.push(`${entry.name}: ${e.message}`);
    return null;
  }
}

/** Case-insensitive property getter for defensive JSON reading. */
function ci(obj) {
  const keys = new Map();
  for (const k of Object.keys(obj)) keys.set(k.toLowerCase().replace(/[_\s]/g, ''), k);
  return (name) => {
    const k = keys.get(name.toLowerCase().replace(/[_\s]/g, ''));
    return k === undefined ? undefined : obj[k];
  };
}

function str(v) { return v == null ? '' : String(v); }
function clampDifficulty(d) { return d >= 0 && d <= 5 ? Math.floor(d) : 0; }
function round6(v) { return Math.round(v * 1e6) / 1e6 + 0; }

export function mimeFromName(name) {
  const ext = String(name).toLowerCase().split('.').pop();
  return {
    mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
    m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm',
  }[ext] || 'audio/mpeg';
}
