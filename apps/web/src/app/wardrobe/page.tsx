import type { Metadata } from 'next';
import { ogLang, shareMetadata } from '@/lib/meta';
import WardrobeClient from './WardrobeClient';

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ l?: string }> }): Promise<Metadata> {
  return shareMetadata(ogLang((await searchParams).l), undefined, 'sandbox');
}

export default function WardrobePage() {
  return <WardrobeClient />;
}
