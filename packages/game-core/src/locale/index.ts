import { en } from './en';
import { ru } from './ru';
import type { Dict, Plural } from './ru';

export type { AwardId, Dict, Plural, ThemeText } from './ru';
export { ru, en };

export type Lang = 'ru' | 'en';
export const LANGS: Lang[] = ['ru', 'en'];
export const DICTS: Record<Lang, Dict> = { ru, en };

export function fmt(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

const rulesCache = new Map<Lang, Intl.PluralRules>();

/** Строка или форма множественного числа для n, с подстановкой {n} и других переменных. */
export function tp(lang: Lang, entry: string | Plural, n: number, vars: Record<string, string | number> = {}): string {
  let tpl: string;
  if (typeof entry === 'string') tpl = entry;
  else {
    let rules = rulesCache.get(lang);
    if (!rules) rulesCache.set(lang, (rules = new Intl.PluralRules(lang)));
    const cat = rules.select(n) as keyof Plural;
    tpl = entry[cat] ?? entry.other;
  }
  return fmt(tpl, { n, ...vars });
}

/** Язык по списку языков устройства: русский для ru/uk/be/kk, иначе английский. */
export function pickLang(preferred: readonly string[]): Lang {
  for (const l of preferred) {
    const base = l.toLowerCase().split('-')[0];
    if (base === 'ru' || base === 'uk' || base === 'be' || base === 'kk') return 'ru';
    if (base === 'en') return 'en';
  }
  return 'en';
}
