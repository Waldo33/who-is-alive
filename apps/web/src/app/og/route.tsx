import { SITE_URL } from '@/lib/env';
import { ogLang } from '@/lib/meta';
import { roomPreview } from '@/lib/preview';
import { renderOg } from '../og';

/**
 * Картинка превью ссылки: /og?l=ru|en[&code=ABCD | &p=sandbox]. Язык — отправителя (его игра дописывает ?l= к ссылке),
 * поэтому это маршрут с параметрами, а не файл opengraph-image (тот не видит параметров адреса).
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const lang = ogLang(q.get('l'));
  const code = q.get('code')?.toUpperCase();
  const valid = code && /^[A-Z]{4}$/.test(code) ? code : undefined;
  const p = valid ? await roomPreview(valid) : null;
  const page = q.get('p') === 'sandbox' ? 'sandbox' : 'home';
  const res = await renderOg({ lang, page, code: valid, host: p?.host_name, players: p?.players, site: new URL(SITE_URL).host });
  // комната меняется (кто хост, сколько игроков) — кешируем ненадолго; общее превью — надолго
  res.headers.set('Cache-Control', valid ? 'public, max-age=60, s-maxage=60' : 'public, max-age=86400, s-maxage=86400');
  return res;
}
