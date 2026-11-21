import type { Metadata } from 'next';
import { ogLang, shareMetadata } from '@/lib/meta';
import LearnClient from './LearnClient';

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ l?: string }> }): Promise<Metadata> {
  return shareMetadata(ogLang((await searchParams).l), undefined, 'sandbox');
}

export default function LearnPage() {
  return <LearnClient />;
}
