import type { Metadata } from 'next';
import RoomClient from './RoomClient';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ code: string }> }): Promise<Metadata> {
  const { code } = await params;
  return {
    title: `${code.toUpperCase()} · Кто тут живой? · Who’s Alive?`,
    description: 'Тебя зовут в игру. Найди живых. Не выдай себя. · You’re invited. Find the living.',
  };
}

export default async function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <RoomClient code={code.toUpperCase()} />;
}
