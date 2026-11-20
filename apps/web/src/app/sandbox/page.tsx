import type { Metadata } from 'next';
import { ogLang, shareMetadata } from '@/lib/meta';
import SandboxClient from './SandboxClient';

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ l?: string }> }): Promise<Metadata> {
  return shareMetadata(ogLang((await searchParams).l));
}

export default function SandboxPage() {
  return <SandboxClient />;
}
