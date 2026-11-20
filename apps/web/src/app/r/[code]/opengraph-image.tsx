import { SITE_URL } from '@/lib/env';
import { roomPreview } from '@/lib/preview';
import { OG_SIZE, renderOg } from '../../og';

export const alt = 'Приглашение в игру «Кто тут живой?» · Who’s Alive? invite';
export const size = OG_SIZE;
export const contentType = 'image/png';

export default async function Image({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const p = await roomPreview(code);
  return renderOg({ code: code.toUpperCase(), host: p?.host_name, players: p?.players, site: new URL(SITE_URL).host });
}
