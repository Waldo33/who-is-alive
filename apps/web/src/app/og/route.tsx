import { SITE_URL } from '@/lib/env';
import { ogLang, ogTheme } from '@/lib/meta';
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
  const theme = ogTheme(q.get('t'));
  // имя — из базы; если комнаты уже нет (или база не ответила) — из ссылки, его туда положила страница
  const host = p?.host_name || q.get('n')?.trim().slice(0, 14) || null;
  const res = await renderOg({ lang, page, theme, code: valid, host, players: p?.players, site: new URL(SITE_URL).host });
  // комната меняется (кто хост, сколько игроков) — кешируем ненадолго; общее превью с темой — надолго, без темы — случайное
  const long = !valid && q.get('t') !== null;
  res.headers.set('Cache-Control', long ? 'public, max-age=86400, s-maxage=86400' : 'public, max-age=60, s-maxage=60');
  return res;
}
