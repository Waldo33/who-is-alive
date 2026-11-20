import { pickLang } from '@kto/game-core';
import type { Lang } from '@kto/game-core';

export const LANG_KEY = 'kto:lang';

/** Язык: ?lang= → сохранённый выбор → язык устройства (русский для ru/uk/be/kk, иначе английский). */
export function detectLang(): Lang {
  const q = new URLSearchParams(location.search).get('lang');
  if (q === 'ru' || q === 'en') return q;
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'ru' || saved === 'en') return saved;
  } catch {
    /* приватный режим */
  }
  return pickLang(navigator.languages?.length ? navigator.languages : [navigator.language]);
}
