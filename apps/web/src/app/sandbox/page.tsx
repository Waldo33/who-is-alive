import type { Metadata } from 'next';
import SandboxClient from './SandboxClient';

export const metadata: Metadata = { title: 'Кто тут живой? · Who’s Alive?' };

export default function SandboxPage() {
  return <SandboxClient />;
}
