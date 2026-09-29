// Minimal DOM helpers (no framework).

/**
 * h('div.card#main', { onclick, style: {...}, dataset: {...}, html: '...' }, child, [children], 'text')
 */
export function h(sel, props, ...children) {
  if (props == null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) {
    if (props != null) children.unshift(props);
    props = {};
  }
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(sel) || [];
  const el = document.createElement(m[1] || 'div');
  if (m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g) || []) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'class' || k === 'className') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

/** Escape text for innerHTML templates. */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Canvas sized to its CSS box with devicePixelRatio; returns {canvas, ctx, w, h, dpr, resize()} */
export function hiDPICanvas(canvas, maxDpr = 2) {
  const ctx = canvas.getContext('2d');
  const state = { canvas, ctx, w: 1, h: 1, dpr: 1 };
  state.resize = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(maxDpr, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width)), hh = Math.max(1, Math.round(r.height));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hh * dpr);
    }
    state.w = w; state.h = hh; state.dpr = dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return state;
  };
  state.resize();
  return state;
}

/** Simple event emitter */
export class Emitter {
  constructor() { this._l = new Map(); }
  on(ev, fn) {
    if (!this._l.has(ev)) this._l.set(ev, new Set());
    this._l.get(ev).add(fn);
    return () => this.off(ev, fn);
  }
  off(ev, fn) { this._l.get(ev)?.delete(fn); }
  emit(ev, ...args) { for (const fn of this._l.get(ev) || []) { try { fn(...args); } catch (e) { console.error(e); } } }
}
