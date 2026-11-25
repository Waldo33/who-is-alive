import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { OG_THEMES, ogLang, roomTheme, shareMetadata } from '@/lib/meta';
import PuzzleClient from './PuzzleClient';

/**
 * Загадка из «Фильма матча»: benobody.app/<код> (5 знаков без O/0, I/1 — набирают руками с экрана
 * TikTok). Статические страницы (/sandbox, /daily, /learn…) Next отдаёт раньше этого маршрута.
 */
const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/;

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ puzzle: string }>;
  searchParams: Promise<{ l?: string }>;
}): Promise<Metadata> {
  const code = (await params).puzzle.toUpperCase();
  if (!CODE.test(code)) return {};
  const lang = ogLang((await searchParams).l);
  return {
    ...shareMetadata(lang, undefined, 'puzzle', roomTheme(code) % OG_THEMES),
    // загадки живут 30 дней — поисковикам они не нужны
    robots: { index: false },
  };
}

export default async function PuzzlePage({ params, searchParams }: { params: Promise<{ puzzle: string }>; searchParams: Promise<Record<string, string>> }) {
  const raw = (await params).puzzle;
  const code = raw.toUpperCase();
  if (!CODE.test(code)) notFound();
  // набрали маленькими буквами — к каноническому адресу (метки ссылки сохраняются)
  if (raw !== code) {
    const q = new URLSearchParams(await searchParams).toString();
    redirect(`/${code}${q ? `?${q}` : ''}`);
  }
  return <PuzzleClient code={code} />;
}
