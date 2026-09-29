// Tiny i18n: every UI string is written inline as tr('Русский', 'English').
// Russian is the default language.

import { local } from './store.js';

let lang = local.get('lang', 'ru');

export function tr(ru, en) {
  return lang === 'en' && en != null ? en : ru;
}

export function getLang() { return lang; }

export function setLang(l) {
  lang = l === 'en' ? 'en' : 'ru';
  local.set('lang', lang);
  document.documentElement.lang = lang;
}

/** Russian plural helper: plural(5, 'нота', 'ноты', 'нот') */
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function fmtNum(n) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function fmtPct(x, digits = 2) {
  return (x * 100).toFixed(digits) + '%';
}
