import type { Metadata } from 'next';
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
  return <RoomClient code={code.toUpperCase()} />;
}
