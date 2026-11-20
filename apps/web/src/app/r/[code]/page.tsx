import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { isBotUA } from '@/lib/bot';
import { ogLang, shareMetadata } from '@/lib/meta';
import { roomPreview } from '@/lib/preview';
import RoomClient from './RoomClient';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ l?: string }>;
}): Promise<Metadata> {
  const { code } = await params;
  const lang = ogLang((await searchParams).l);
  const p = await roomPreview(code);
  return {
    ...shareMetadata(lang, { code: code.toUpperCase(), host: p?.host_name }),
    // комнаты живут полчаса — поисковикам они не нужны
    robots: { index: false },
  };
}

export default async function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  // бот превью ссылки получает только метаданные и не входит в комнату (не занимает место)
  const bot = isBotUA((await headers()).get('user-agent'));
  return <RoomClient code={code.toUpperCase()} bot={bot} />;
}
