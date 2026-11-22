import type { Metadata } from 'next';
import { DICTS, fmt } from '@kto/game-core';
import type { Lang } from '@kto/game-core';

/** Язык превью из параметра ссылки ?l= (его дописывает игра отправителя). По умолчанию — русский. */
export function ogLang(v: string | string[] | null | undefined): Lang {
  const s = Array.isArray(v) ? v[0] : v;
  return s === 'en' ? 'en' : 'ru';
}

/** Сколько тем (и локаций) у превью: кепки/парк, повара/кухня, пингвины/льдина, космонавты/луна. */
export const OG_THEMES = 7;

/** Тема превью из параметра ?t= картинки; без него — случайная. */
export function ogTheme(v: string | null | undefined): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n < OG_THEMES ? n : Math.floor(Math.random() * OG_THEMES);
}

/** Тема превью комнаты — по её коду: все, кому прислали ссылку, видят одну и ту же картинку. */
export function roomTheme(code: string): number {
  let h = 0;
  for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % OG_THEMES;
}

/**
 * Заголовок, описание и картинка превью ссылки на языке отправителя. Тема картинки — своя у комнаты,
 * у главной и песочницы — случайная на каждый запрос (theme не задан).
 */
export function shareMetadata(
  lang: Lang,
  room?: { code: string; host?: string | null },
  page: 'home' | 'sandbox' = 'home',
  theme?: number,
): Metadata {
  const T = DICTS[lang].og;
  const sandbox = !room && page === 'sandbox';
  const title = room
    ? room.host
      ? fmt(T.roomTitle, { name: room.host })
      : fmt(T.roomTitleAnon, { code: room.code })
    : sandbox
      ? T.sbTitle
      : T.siteTitle;
  const description = room ? fmt(T.roomDesc, { code: room.code }) : sandbox ? T.sbDesc : T.siteDesc;
  const t = room ? roomTheme(room.code) : (theme ?? Math.floor(Math.random() * OG_THEMES));
  // имя хоста — и в адресе картинки: если комната успеет закрыться, пока мессенджер дойдёт до картинки, имя не пропадёт
  const q = room
    ? `&code=${room.code}${room.host ? `&n=${encodeURIComponent(room.host)}` : ''}`
    : sandbox
      ? '&p=sandbox'
      : '';
  const image = { url: `/og?l=${lang}${q}&t=${t}`, width: 1200, height: 630, alt: T.alt, type: 'image/png' };
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: 'website',
      siteName: DICTS[lang].meta.title,
      locale: lang === 'en' ? 'en_US' : 'ru_RU',
      images: [image],
    },
    twitter: { card: 'summary_large_image', title, description, images: [image.url] },
  };
}
