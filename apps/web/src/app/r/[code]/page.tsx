import type { Metadata } from 'next';
import { roomPreview } from '@/lib/preview';
import RoomClient from './RoomClient';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ code: string }> }): Promise<Metadata> {
  const { code } = await params;
  const p = await roomPreview(code);
  const host = p?.host_name;
  const title = host ? `${host} зовёт тебя в «Кто тут живой?»` : `Тебя зовут в «Кто тут живой?» · ${code.toUpperCase()}`;
  const description = `Комната ${code.toUpperCase()}. Найди живых среди 32 одинаковых человечков и не выдай себя. · You’re invited to Who’s Alive?`;
  return {
    title,
    description,
    openGraph: { title, description, type: 'website', siteName: 'Кто тут живой? · Who’s Alive?' },
    twitter: { card: 'summary_large_image', title, description },
    // комнаты живут полчаса — поисковикам они не нужны
    robots: { index: false },
  };
}

export default async function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <RoomClient code={code.toUpperCase()} />;
}
