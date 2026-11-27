/**
 * Фичи за флагом: сырое прячем от игроков, но оставляем рабочим для проверки.
 *
 * Включить для всех — переменная сборки `NEXT_PUBLIC_FEATURES=casting` (через запятую) в Vercel.
 * Включить у себя — открыть любую страницу с `?ff=casting` (запоминается в этом браузере),
 * выключить — `?ff=-casting`.
 *
 * Сейчас за флагом:
 * - `casting` — «Кастинг дня» (/daily): карточка на главной, ссылки `startapp=daily`, страница /daily.
 *   Бот прячет кастинг своим флагом — переменная `FEATURES=casting` сервера бота (apps/server/src/bot.ts).
 * - `orchestra` — «Оркестр из телефонов» в лобби (план звука, вариант Б): у режиссёра в шестерёнке
 *   лобби строка «Оркестр»; гостям флаг не нужен — играют, раз режиссёр включил. Ждёт плейтеста.
 */
export type Feature = 'casting' | 'orchestra';

const KEY = 'kto:ff';
const BUILD = new Set((process.env.NEXT_PUBLIC_FEATURES ?? '').split(',').map((s) => s.trim()).filter(Boolean));

function local(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  let set: Set<string>;
  try {
    set = new Set((localStorage.getItem(KEY) ?? '').split(',').filter(Boolean));
  } catch {
    return new Set();
  }
  // ?ff=casting — включить у себя, ?ff=-casting — выключить
  const q = new URLSearchParams(location.search).get('ff');
  if (q) {
    for (const f of q.split(',')) {
      if (f.startsWith('-')) set.delete(f.slice(1));
      else if (f) set.add(f);
    }
    try {
      localStorage.setItem(KEY, [...set].join(','));
    } catch {
      /* приватный режим — только на эту страницу */
    }
  }
  return set;
}

/** Включена ли фича (вызывать на клиенте: в браузере учитываются ещё и личные флаги). */
export function featureOn(f: Feature): boolean {
  return BUILD.has(f) || local().has(f);
}
