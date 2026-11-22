import type { Metadata } from 'next';
import { ogLang, shareMetadata } from '@/lib/meta';
import DailyClient from './DailyClient';

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ l?: string }> }): Promise<Metadata> {
  return shareMetadata(ogLang((await searchParams).l), undefined, 'daily');
}

export default function DailyPage() {
  return <DailyClient />;
}
