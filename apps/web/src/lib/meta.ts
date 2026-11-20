import type { Metadata } from 'next';
import { DICTS, fmt } from '@kto/game-core';
import type { Lang } from '@kto/game-core';

/** Язык превью из параметра ссылки ?l= (его дописывает игра отправителя). По умолчанию — русский. */
export function ogLang(v: string | string[] | null | undefined): Lang {
  const s = Array.isArray(v) ? v[0] : v;
  return s === 'en' ? 'en' : 'ru';
}

/** Заголовок, описание и картинка превью ссылки на языке отправителя. */
export function shareMetadata(lang: Lang, room?: { code: string; host?: string | null }, page: 'home' | 'sandbox' = 'home'): Metadata {
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
  const q = room ? `&code=${room.code}` : sandbox ? '&p=sandbox' : '';
  const image = { url: `/og?l=${lang}${q}`, width: 1200, height: 630, alt: T.alt, type: 'image/png' };
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
