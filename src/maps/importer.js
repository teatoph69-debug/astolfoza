// Import pipeline: files dropped on the game (or picked with an import button) → mapsets in the library.
//
//   .sspm              Rhythia / Sound Space Plus maps (v1, v2)               → source 'sspm'
//   .rhm               Steam Rhythia maps (ZIP: map JSON + audio + cover)     → source 'rhm'
//   .phxm              Rhythia "Rewrite" client maps (ZIP)                    → source 'phxm'
//   .zip               any archive with the files above / txt + audio inside  → unpacked and routed
//   .txt               legacy Sound Space text maps; paired with an audio file from the same drop
//                      (same base name, or the only audio file); without audio → silent map
//   mp3/ogg/wav/flac/m4a/…  any song → МУХА's auto-mapper builds 5 difficulties  → source 'auto'
//   png/jpg/webp       used as the cover of txt / auto-mapped sets from the same drop
//
// Maps of the same song (identical audio bytes; or same "Artist - Title" when a map carries no audio) are
// grouped into ONE mapset. Set ids come from a content hash, so re-importing a file replaces its map instead
// of duplicating it, and new difficulties of an already imported song are merged into the existing set.

import { tr } from '../ui/i18n.js';
import { parseSSPM, isSSPM, sniffAudioMime, sniffImageMime, splitArtistTitle } from './sspm.js';
import { readZip, isZip, parseRHM, parsePHXM, looksLikeRHM, looksLikePHXM, mimeFromName } from './rhm.js';
import { parseTxtMap, looksLikeTxtMap } from './txtmap.js';
import { autoMap, AUTO_DIFFICULTIES } from './automap.js';
import { computeStars } from '../core/map.js';
import { hashString } from '../core/rng.js';

/** SS+ difficulty tiers (byte 0..5 in .sspm / .rhm) and their colours. */
export const TIERS = [
  { name: 'N/A', color: '#9aa4b2' },
  { name: 'Easy', color: '#00ff00' },
  { name: 'Medium', color: '#ffb900' },
  { name: 'Hard', color: '#ff0000' },
  { name: 'Logic', color: '#d76aff' },
  { name: 'Tasukete', color: '#36304f' },
];
/** Auto-mapper difficulties → SS+ tier colours. */
export const AUTO_COLORS = { easy: TIERS[1].color, normal: TIERS[2].color, hard: TIERS[3].color, insane: TIERS[4].color, extreme: TIERS[5].color };

/** `accept` string for file pickers that feed importFiles(). */
export const IMPORT_ACCEPT = '.sspm,.rhm,.phxm,.zip,.txt,audio/*,.mp3,.ogg,.oga,.opus,.wav,.flac,.m4a,.aac,.webm,image/*';

const AUDIO_EXT = new Set(['mp3', 'ogg', 'oga', 'opus', 'wav', 'wave', 'flac', 'm4a', 'aac', 'mp4', 'webm', 'weba']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);
const MAP_EXT = new Set(['sspm', 'rhm', 'phxm', 'zip', 'txt']);
const MAX_ZIP_DEPTH = 2;

/**
 * @param {FileList|Array<File|{name:string, bytes?:ArrayBuffer|Uint8Array, arrayBuffer?:() => Promise<ArrayBuffer>}>} files
 * @param {object} app  — needs app.library.addSet(set) (+ getSet), app.audio.decode(ab), app.toast(text, kind, ms)
 * @param {{ autoMapOptions?: object }} [opts]
 * @returns {Promise<object[]>} imported mapsets
 */
export async function importFiles(files, app, opts = {}) {
  const list = Array.from(files || []);
  if (!list.length) throw new Error(tr('Нет файлов для импорта', 'No files to import'));
  const toast = (text, kind = 'info', ms) => { try { app?.toast?.(text, kind, ms); } catch { /* no UI */ } };
  const errors = [];
  const fail = (name, e) => errors.push({ name, message: errText(e) });

  // 1. read + classify (archives are unpacked)
  const items = [];
  for (const f of list) {
    const name = baseName(f.name || 'file');
    try {
      await collect(name, await readBytes(f), items, errors, 0);
    } catch (e) {
      fail(name, e);
    }
  }

  // 2. parse map files
  const records = [];
  for (const it of items) {
    if (!['sspm', 'rhm', 'phxm', 'txt'].includes(it.kind)) continue;
    try {
      if (it.kind === 'sspm') records.push(mapRecord(it, parseSSPM(it.bytes), 'sspm'));
      else if (it.kind === 'rhm') records.push(mapRecord(it, await parseRHM(it.bytes), 'rhm'));
      else if (it.kind === 'phxm') records.push(mapRecord(it, await parsePHXM(it.bytes), 'phxm'));
      else {
        const parsed = parseTxtMap(new TextDecoder('utf-8').decode(it.bytes));
        records.push(txtRecord(it, parsed));
      }
    } catch (e) {
      if (!(it.fromArchive && it.kind === 'txt')) fail(it.name, e); // readme.txt etc. inside archives
    }
  }

  // 3. pair .txt maps with an audio file (and covers) from the same drop
  const audioItems = items.filter((it) => it.kind === 'audio');
  const images = items.filter((it) => it.kind === 'image');
  for (const rec of records) {
    if (rec.source !== 'txt') continue;
    const audio = pairByName(rec.fileBase, audioItems) || (audioItems.length === 1 ? audioItems[0] : null);
    if (audio) {
      audio.consumed = true;
      rec.audio = audio.bytes.slice().buffer;
      rec.audioMime = audio.mime;
      const meta = audioMeta(audio);
      if (meta.title) { rec.title = meta.title; rec.artist = meta.artist; }
      if (!rec.cover && meta.cover) { rec.cover = meta.cover.bytes; rec.coverMime = meta.cover.mime; }
    } else {
      rec.warn = true;
    }
    const img = pairByName(rec.fileBase, images) || (images.length === 1 ? images[0] : null);
    if (img) { rec.cover = img.bytes; rec.coverMime = img.mime; }
  }

  // 4. group into mapsets and add them to the library
  const sets = [];
  for (const group of groupRecords(records)) {
    try {
      const set = await buildMapSet(group);
      sets.push(await addSet(app, set));
    } catch (e) {
      fail(group[0].fileName, e);
    }
  }

  // 5. remaining audio files → auto-mapping
  const pending = audioItems.filter((a) => !a.consumed);
  for (const a of pending) {
    const meta = audioMeta(a);
    toast(tr(`МУХА слушает «${meta.title}» и делает карту…`, `МУХА is listening to "${meta.title}" and mapping it…`), 'info', 6000);
    await nextFrame();
    try {
      const img = pairByName(a.base, images) || (images.length === 1 ? images[0] : null);
      const set = await buildAutoSet(a, meta, img, app, opts.autoMapOptions);
      sets.push(await addSet(app, set));
    } catch (e) {
      fail(a.name, e);
    }
  }

  const unpairedTxt = records.filter((r) => r.source === 'txt' && r.warn);
  if (unpairedTxt.length && sets.length) {
    toast(tr('Карта .txt без аудио — импортирована без музыки. Перетащи её вместе с mp3/ogg.',
      '.txt map without audio — imported silently. Drop it together with an mp3/ogg.'), 'info', 6000);
  }

  if (!sets.length) {
    if (!errors.length) throw new Error(tr('Не найдено ни одной карты или песни', 'No maps or songs found'));
    throw new Error(errors.map((e) => `${e.name}: ${e.message}`).join('; '));
  }
  if (errors.length) {
    toast(tr('Пропущено: ', 'Skipped: ') + errors.map((e) => `${e.name} — ${e.message}`).join('; '), 'error', 8000);
  }
  return sets;
}

// ---- reading / classification -----------------------------------------------------------------

async function readBytes(f) {
  if (f.bytes instanceof Uint8Array) return f.bytes;
  if (f.bytes instanceof ArrayBuffer) return new Uint8Array(f.bytes);
  if (typeof f.arrayBuffer === 'function') return new Uint8Array(await f.arrayBuffer());
  throw new Error(tr('Не удалось прочитать файл', 'Could not read the file'));
}

async function collect(name, bytes, items, errors, depth) {
  const ext = extOf(name);
  const base = stripExt(name);
  const item = { name, base, ext, bytes, kind: 'unknown', fromArchive: depth > 0 };
  if (isSSPM(bytes)) item.kind = 'sspm';
  else if (isZip(bytes)) {
    const entries = readZip(bytes);
    if (looksLikeRHM(entries)) item.kind = 'rhm';
    else if (looksLikePHXM(entries)) item.kind = 'phxm';
    else {
      if (depth >= MAX_ZIP_DEPTH) throw new Error(tr('Слишком глубоко вложенный архив', 'Archive nested too deeply'));
      let found = 0;
      for (const e of entries) {
        const en = baseName(e.name);
        const ee = extOf(en);
        if (en.startsWith('.') || e.name.includes('__MACOSX')) continue;
        if (!MAP_EXT.has(ee) && !AUDIO_EXT.has(ee) && !IMAGE_EXT.has(ee)) continue;
        try {
          await collect(en, await e.read(), items, errors, depth + 1);
          found++;
        } catch (err) {
          if (ee !== 'txt') errors.push({ name: `${name}/${en}`, message: errText(err) });
        }
      }
      if (!found) throw new Error(tr('В архиве нет карт или музыки', 'The archive contains no maps or music'));
      return;
    }
  } else if (ext === 'txt' || (!AUDIO_EXT.has(ext) && !IMAGE_EXT.has(ext) && looksLikeTxtMap(latin(bytes, 400)))) {
    item.kind = 'txt';
  } else if (sniffImageMime(bytes) && (IMAGE_EXT.has(ext) || !AUDIO_EXT.has(ext))) {
    item.kind = 'image';
    item.mime = sniffImageMime(bytes);
  } else if (AUDIO_EXT.has(ext) || sniffAudioMime(bytes)) {
    item.kind = 'audio';
    item.mime = sniffAudioMime(bytes) || mimeFromName(name);
  } else if (ext === 'json') {
    throw new Error(tr('Карты в формате .json (Vulnus) пока не поддерживаются', '.json (Vulnus) maps are not supported yet'));
  } else {
    throw new Error(tr('Неизвестный формат файла', 'Unknown file format'));
  }
  items.push(item);
}

// ---- map records -----------------------------------------------------------------------------

function mapRecord(item, p, source) {
  return {
    source,
    fileName: item.name,
    fileBase: item.base,
    mapKey: `${p.id || p.name}|${p.difficulty}|${p.difficultyName}|${p.notes.length}`,
    title: p.title || item.base,
    artist: p.artist || '',
    mappers: p.mappers || [],
    tier: p.difficulty || 0,
    difficultyName: p.difficultyName || '',
    notes: p.notes,
    audio: p.audio,
    audioMime: p.audioMime,
    cover: p.cover ? new Uint8Array(p.cover) : null,
    coverMime: p.coverMime,
    requiresMod: !!p.requiresMod,
  };
}

function txtRecord(item, parsed) {
  const { artist, title } = titleFromFileName(item.base);
  return {
    source: 'txt',
    fileName: item.name,
    fileBase: item.base,
    mapKey: `txt|${item.base}`,
    title,
    artist,
    mappers: [],
    tier: 0,
    difficultyName: difficultyFromFileName(item.base),
    notes: parsed.notes,
    audio: null,
    audioMime: null,
    cover: null,
    coverMime: null,
    textHash: hashString(parsed.audioId + '|' + parsed.notes.length + '|' + parsed.notes[parsed.notes.length - 1].t),
  };
}

/** Union maps that share identical audio; audio-less maps join a set of the same song name. */
function groupRecords(records) {
  const groups = new Map();
  const byName = new Map();
  for (const r of records) {
    r.nameKey = normName(`${r.artist} ${r.title}`);
    if (r.audio) {
      r.audioKey = fingerprint(new Uint8Array(r.audio));
      const k = 'a' + r.audioKey;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
      if (!byName.has(r.nameKey)) byName.set(r.nameKey, k);
    }
  }
  for (const r of records) {
    if (r.audio) continue;
    const k = byName.get(r.nameKey) || (r.source === 'txt' ? 't' + r.textHash : 'n' + r.nameKey);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.values()];
}

async function buildMapSet(group) {
  const withAudio = group.find((r) => r.audio);
  const lead = withAudio || group[0];
  const key = withAudio ? withAudio.audioKey : (lead.source === 'txt' ? 't' + lead.textHash.toString(36) : 'n' + hashString(lead.nameKey).toString(36));
  const setId = `map:${key}`;
  const sources = new Set(group.map((r) => r.source));
  const source = sources.size === 1 ? lead.source : 'sspm';

  const maps = group.map((r) => {
    const stars = computeStars(r.notes);
    const tier = r.tier || tierFromStars(stars);
    const last = r.notes.length ? r.notes[r.notes.length - 1].t : 0;
    return {
      id: `${setId}:m${hashString(r.source + '|' + r.mapKey).toString(36)}`,
      title: r.title,
      artist: r.artist,
      mapper: r.mappers.join(', ') || tr('неизвестно', 'unknown'),
      difficultyName: (r.difficultyName || TIERS[tier].name).trim(),
      tier,
      notes: r.notes,
      stars,
      duration: last + 2,
      source: r.source,
      color: TIERS[tier].color,
    };
  });
  // the same map dropped twice (e.g. loose + inside a zip): keep one
  for (let i = maps.length - 1; i >= 0; i--) {
    if (maps.findIndex((m) => m.id === maps[i].id) !== i) { maps.splice(i, 1); group = group.filter((_, j) => j !== i); }
  }
  dedupeNames(maps, group);
  maps.sort((a, b) => a.stars - b.stars);

  const coverRec = group.find((r) => r.cover);
  const cover = coverRec ? await coverDataURL(coverRec.cover, coverRec.coverMime) : undefined;
  const mappers = [...new Set(group.flatMap((r) => r.mappers))];
  return {
    id: setId,
    title: lead.title || lead.fileBase,
    artist: lead.artist || '',
    mapper: mappers.join(', ') || (source === 'txt' ? 'Sound Space' : tr('неизвестно', 'unknown')),
    source,
    color: maps[maps.length - 1].color,
    cover,
    audio: withAudio
      ? { kind: 'bytes', bytes: withAudio.audio, mime: withAudio.audioMime || 'audio/mpeg' }
      : { kind: 'none' },
    maps,
    importedAt: Date.now(),
  };
}

async function buildAutoSet(item, meta, img, app, autoOpts = {}) {
  if (!app?.audio?.decode) throw new Error(tr('Аудио-движок недоступен', 'Audio engine unavailable'));
  const bytes = item.bytes.slice().buffer;
  let buffer;
  try {
    buffer = await app.audio.decode(bytes);
  } catch {
    throw new Error(tr('Браузер не смог декодировать этот аудиофайл', 'The browser could not decode this audio file'));
  }
  const key = fingerprint(item.bytes);
  const setId = `auto:${key}`;
  const res = await autoMap(buffer, { seed: parseInt(key.slice(0, 8), 16) >>> 0, ...autoOpts });
  const duration = buffer.duration || res.duration;
  const maps = res.maps.filter((m) => m.notes.length).map((m) => ({
    id: `${setId}:${m.difficultyId}`,
    title: meta.title,
    artist: meta.artist,
    mapper: 'МУХА auto-mapper',
    difficultyName: m.difficultyName,
    difficultyId: m.difficultyId,
    notes: m.notes,
    stars: m.stars,
    duration,
    source: 'auto',
    color: AUTO_COLORS[m.difficultyId] || TIERS[tierFromStars(m.stars)].color,
  }));
  if (!maps.length) throw new Error(tr('В треке не нашлось ритма', 'No rhythm found in the track'));
  const coverSrc = img ? { bytes: img.bytes, mime: img.mime } : meta.cover;
  const set = {
    id: setId,
    title: meta.title,
    artist: meta.artist,
    mapper: 'МУХА auto-mapper',
    source: 'auto',
    color: AUTO_COLORS.hard,
    cover: coverSrc ? await coverDataURL(coverSrc.bytes, coverSrc.mime) : undefined,
    bpm: res.bpm,
    audio: { kind: 'bytes', bytes, mime: item.mime || 'audio/mpeg' },
    maps,
    importedAt: Date.now(),
    autoMap: { bpm: res.bpm, offset: res.offset, confidence: res.confidence, grid: res.grid },
  };
  // optional hook: lets the library skip decoding the same file a second time
  try { app.library?.primeAudioBuffer?.(setId, buffer); } catch { /* optional */ }
  return set;
}

/** Add to the library, merging with an already imported set of the same song. */
async function addSet(app, set) {
  const lib = app?.library;
  if (!lib?.addSet) throw new Error(tr('Библиотека карт недоступна', 'Map library unavailable'));
  const old = lib.getSet ? lib.getSet(set.id) : null;
  if (old && old.source !== 'builtin' && Array.isArray(old.maps) && set.source !== 'auto') {
    const ids = new Set(set.maps.map((m) => m.id));
    const kept = old.maps.filter((m) => !ids.has(m.id)).map((m) => {
      const c = { ...m };
      delete c.setId; // the library re-assigns it
      return c;
    });
    set.maps = [...kept, ...set.maps].sort((a, b) => (a.stars ?? 0) - (b.stars ?? 0));
    if (set.audio.kind === 'none' && old.audio && old.audio.kind !== 'none') set.audio = old.audio;
    if (!set.cover && old.cover) set.cover = old.cover;
    dedupeNames(set.maps);
    set.color = set.maps[set.maps.length - 1].color || set.color;
  }
  await lib.addSet(set);
  return set;
}

// ---- helpers ---------------------------------------------------------------------------------

function tierFromStars(s) {
  return s < 2 ? 1 : s < 4 ? 2 : s < 6 ? 3 : s < 8 ? 4 : 5;
}

/** Make difficulty names unique inside a set: "Hard" ×2 → "Hard (mapper)" / "Hard #2". */
function dedupeNames(maps, group) {
  const count = new Map();
  for (const m of maps) count.set(m.difficultyName, (count.get(m.difficultyName) || 0) + 1);
  const used = new Set(maps.filter((m) => count.get(m.difficultyName) === 1).map((m) => m.difficultyName));
  maps.forEach((m, i) => {
    if (count.get(m.difficultyName) < 2) return;
    const who = group && group[i] && group[i].mappers[0];
    let name = who && !m.difficultyName.includes(who) ? `${m.difficultyName} (${who})` : '';
    for (let n = 2; !name || used.has(name); n++) name = `${m.difficultyName} #${n}`;
    used.add(name);
    m.difficultyName = name;
  });
}

/** Content fingerprint: FNV-1a over the length + head + tail + a sparse sample of the bytes (fast on big files). */
export function fingerprint(u8) {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ u8.length;
  const mix = (b) => {
    h1 ^= b; h1 = Math.imul(h1, 0x01000193);
    h2 ^= b; h2 = Math.imul(h2, 0x5bd1e995); h2 ^= h2 >>> 15;
  };
  const n = u8.length;
  for (let s = n, k = 0; k < 4; k++, s >>>= 8) mix(s & 0xff);
  const head = Math.min(n, 8192);
  for (let i = 0; i < head; i++) mix(u8[i]);
  for (let i = Math.max(head, n - 8192); i < n; i++) mix(u8[i]);
  const step = Math.max(1, Math.floor(n / 65536));
  for (let i = head; i < n - 8192; i += step) mix(u8[i]);
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

function normName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

function pairByName(base, candidates) {
  const a = normName(base);
  if (!a) return null;
  let best = null, bestLen = 0;
  for (const c of candidates) {
    const b = normName(c.base);
    if (!b) continue;
    if (a === b) return c;
    const shorter = a.length < b.length ? a : b, longer = a.length < b.length ? b : a;
    if (shorter.length >= 4 && longer.startsWith(shorter) && shorter.length > bestLen) { best = c; bestLen = shorter.length; }
  }
  return best;
}

function audioMeta(item) {
  if (item._meta) return item._meta;
  const tags = readID3(item.bytes);
  const fromFile = titleFromFileName(item.base);
  const meta = {
    title: (tags && tags.title) || fromFile.title || item.base,
    artist: (tags && tags.artist) || (tags && tags.title ? '' : fromFile.artist) || '',
    cover: tags && tags.cover,
  };
  item._meta = meta;
  return meta;
}

/** "01. Artist - Title (Official Video)" → { artist, title } */
export function titleFromFileName(base) {
  // track numbers: "01. ", "02_", "3) ", "07 " (but not "50 Cent" / "100 gecs")
  let s = String(base || '').trim().replace(/^(?:\d{1,3}\s*[._)-]+\s*|0\d\s+)(?=\D)/, '');
  s = s.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/\s*[([](official|lyrics?|lyric video|audio|video|hq|hd|4k|music video|visualizer|mv)[^)\]]*[)\]]/gi, '').trim();
  const { artist, title } = splitArtistTitle(s);
  return { artist, title: title || s };
}

function difficultyFromFileName(base) {
  const m = /[[(]([^\])]{1,24})[\])]\s*$/.exec(base) || /[\s_-](easy|normal|medium|hard|insane|expert|extreme|logic|tasukete)$/i.exec(base);
  return m ? m[1].trim() : '';
}

async function coverDataURL(bytes, mime) {
  if (!bytes || !bytes.length) return undefined;
  const type = mime || sniffImageMime(bytes) || 'image/png';
  // Browser: downscale to ≤ 512 px JPEG (covers inside maps are often multi-megabyte PNGs)
  try {
    if (typeof createImageBitmap === 'function' && typeof Blob !== 'undefined') {
      const bmp = await createImageBitmap(new Blob([bytes], { type }));
      const k = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
      let url;
      if (typeof OffscreenCanvas !== 'undefined') {
        const c = new OffscreenCanvas(w, h);
        c.getContext('2d').drawImage(bmp, 0, 0, w, h);
        const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
        url = 'data:image/jpeg;base64,' + base64(new Uint8Array(await blob.arrayBuffer()));
      } else if (typeof document !== 'undefined') {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(bmp, 0, 0, w, h);
        url = c.toDataURL('image/jpeg', 0.86);
      }
      bmp.close && bmp.close();
      if (url) return url;
    }
  } catch { /* fall through */ }
  if (bytes.length > 1.5 * 1024 * 1024) return undefined;
  return `data:${type};base64,${base64(bytes)}`;
}

function base64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Minimal ID3v2.3/2.4 reader: title, artist, embedded cover. */
export function readID3(u8) {
  if (!u8 || u8.length < 10 || u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return null;
  const ver = u8[3];
  if (ver < 3 || ver > 4) return null;
  const syncsafe = (p) => ((u8[p] & 0x7f) << 21) | ((u8[p + 1] & 0x7f) << 14) | ((u8[p + 2] & 0x7f) << 7) | (u8[p + 3] & 0x7f);
  const be32 = (p) => ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
  const end = Math.min(u8.length, 10 + syncsafe(6));
  let p = 10;
  if (u8[5] & 0x40) p += ver === 4 ? syncsafe(10) : be32(10) + 4;
  const out = {};
  while (p + 10 <= end) {
    const id = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = ver === 4 ? syncsafe(p + 4) : be32(p + 4);
    const body = u8.subarray(p + 10, Math.min(end, p + 10 + size));
    try {
      if (id === 'TIT2') out.title = id3Text(body);
      else if (id === 'TPE1') out.artist = id3Text(body);
      else if (id === 'APIC' && !out.cover) out.cover = id3Picture(body);
    } catch { /* ignore a broken frame */ }
    p += 10 + size;
  }
  return out;
}

function id3Decode(enc, bytes) {
  if (enc === 0) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return s; }
  if (enc === 3) return new TextDecoder('utf-8').decode(bytes);
  if (enc === 1) {
    const le = !(bytes[0] === 0xfe && bytes[1] === 0xff);
    const bom = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
    return new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(bom ? bytes.subarray(2) : bytes);
  }
  return new TextDecoder('utf-16be').decode(bytes);
}

function id3Text(body) {
  return id3Decode(body[0], body.subarray(1)).split('\0')[0].trim();
}

function id3Picture(body) {
  const enc = body[0];
  let p = 1;
  while (p < body.length && body[p] !== 0) p++; // MIME type (latin-1)
  p += 2; // terminator + picture type
  if (enc === 1 || enc === 2) { while (p + 1 < body.length && (body[p] !== 0 || body[p + 1] !== 0)) p += 2; p += 2; } else { while (p < body.length && body[p] !== 0) p++; p += 1; }
  const data = body.subarray(p);
  const mime = sniffImageMime(data);
  return mime ? { bytes: data.slice(), mime } : null;
}

function errText(e) {
  if (!e) return '?';
  return e.en ? tr(e.message, e.en) : String(e.message || e);
}

function latin(u8, n) {
  let s = '';
  for (let i = 0; i < Math.min(n, u8.length); i++) s += String.fromCharCode(u8[i]);
  return s;
}

function baseName(p) { return String(p).split(/[\\/]/).pop(); }
function extOf(name) { const m = /\.([^.]+)$/.exec(name); return m ? m[1].toLowerCase() : ''; }
function stripExt(name) { return name.replace(/\.[^.]+$/, ''); }
/** Let the UI paint (the toast) before a long synchronous step; never stalls in background tabs. */
function nextFrame() {
  return new Promise((r) => {
    setTimeout(r, 60);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(r, 0));
  });
}

export { AUTO_DIFFICULTIES };
