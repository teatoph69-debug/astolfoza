// Persistence helpers. Everything is wrapped in try/catch: storage can be unavailable
// (private mode, file:// quirks, sandboxed iframes) and the game must still work.

const PREFIX = 'muxa.';

export const local = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(PREFIX + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try { localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
  },
};

// ---- IndexedDB key/value store (large blobs: imported maps with audio, brain checkpoints) ------

const DB_NAME = 'muxa-rhythia';
const DB_VERSION = 1;
const STORES = ['maps', 'brains', 'kv'];
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then((db) => new Promise((resolve) => {
    if (!db) return resolve(undefined);
    try {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const req = fn(s);
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => resolve(undefined);
      t.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  }));
}

export const idb = {
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  set: (store, key, value) => tx(store, 'readwrite', (s) => s.put(value, key)),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  keys: (store) => tx(store, 'readonly', (s) => s.getAllKeys()).then((k) => k || []),
  all: (store) => tx(store, 'readonly', (s) => s.getAll()).then((v) => v || []),
  available: () => openDB().then((db) => !!db),
};

/** Trigger a download of text/binary data as a file. */
export function downloadFile(name, data, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Open a file picker; resolves with File[] */
export function pickFiles(accept = '', multiple = true) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    input.onchange = () => { resolve(Array.from(input.files || [])); input.remove(); };
    document.body.appendChild(input);
    input.click();
  });
}
