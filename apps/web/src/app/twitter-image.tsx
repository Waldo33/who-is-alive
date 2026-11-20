import { SITE_URL } from '@/lib/env';
import { OG_SIZE, renderOg } from './og';

export const alt = 'Кто тут живой? — пиксельная игра для компании · Who’s Alive?';
export const size = OG_SIZE;
export const contentType = 'image/png';

export default async function Image() {
  return renderOg({ site: new URL(SITE_URL).host });
}
