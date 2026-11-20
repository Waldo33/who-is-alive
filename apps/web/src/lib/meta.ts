import type { Metadata } from 'next';
import { DICTS, fmt } from '@kto/game-core';
import type { Lang } from '@kto/game-core';

/** Язык превью из параметра ссылки ?l= (его дописывает игра отправителя). По умолчанию — русский. */
export function ogLang(v: string | string[] | null | undefined): Lang {
  const s = Array.isArray(v) ? v[0] : v;
  return s === 'en' ? 'en' : 'ru';
}

/** Заголовок, описание и картинка превью ссылки на языке отправителя. */
export function shareMetadata(lang: Lang, room?: { code: string; host?: string | null }): Metadata {
  const T = DICTS[lang].og;
  const title = room
    ? room.host
      ? fmt(T.roomTitle, { name: room.host })
      : fmt(T.roomTitleAnon, { code: room.code })
    : T.siteTitle;
  const description = room ? fmt(T.roomDesc, { code: room.code }) : T.siteDesc;
  const image = { url: `/og?l=${lang}${room ? `&code=${room.code}` : ''}`, width: 1200, height: 630, alt: T.alt, type: 'image/png' };
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
