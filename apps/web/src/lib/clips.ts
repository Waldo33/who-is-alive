/**
 * Клип «Лучший момент» на игровом сервере (Москва, `apps/server/src/clips.ts`) — для Telegram:
 * внутри него файл из браузера не отдать, поэтому сторис, «Сохранить» и видео-карточка в чат
 * берут клип по ссылке.
 *
 * Одно видео — одна загрузка (обещание запоминается на сам файл): сколько ни нажимай, второй
 * загрузки и второго окна не будет. Грузить начинаем заранее — как только игрок захотел клип
 * и тот записан, — так что к нажатию «Отправить» ссылка обычно уже готова.
 *
 * Файл идёт прямо в хранилище S3 (сервер выдаёт только подписанную ссылку на загрузку — `/v1/clips/direct`);
 * не вышло (у сервера нет S3, хранилище не ответило) — по-старому, через сам сервер.
 */
import { ensureGameUser } from './game-server';
import { GAME_API } from './env';

export interface SharedClip {
  id: string;
  ext: string;
  /** Ссылка на файл (её открывают Telegram на телефоне и сервер Telegram). */
  url: string;
  /** Обложка загружена — у карточки в чате будет кадр клипа. */
  thumb: boolean;
}

const pending = new WeakMap<Blob, Promise<SharedClip | null>>();

async function post(path: string, body: Blob, type: string, ms: number): Promise<Response | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const u = await ensureGameUser();
    return await fetch(`${GAME_API}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${u.token}`, 'Content-Type': type },
      body,
      signal: ctl.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** PUT файла по подписанной ссылке S3 (тип — ровно тот, что в подписи). */
async function putSigned(url: string, body: Blob, type: string, ms: number): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return (await fetch(url, { method: 'PUT', headers: { 'Content-Type': type }, body, signal: ctl.signal })).ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const json = (o: unknown) => new Blob([JSON.stringify(o)], { type: 'application/json' });

/** Прямо в S3: null — этот путь не сработал (тогда грузим через сервер). */
async function uploadDirect(file: Blob, ext: string, thumb?: Promise<Blob | null>): Promise<SharedClip | null> {
  const r = await post('/v1/clips/direct', json({ ext, size: file.size }), 'application/json', 15_000);
  if (!r?.ok) return null;
  const d = (await r.json().catch(() => null)) as { id: string; ext: string; put: string; type: string } | null;
  if (!d?.put) return null;
  // одна повторная попытка: мобильная сеть рвётся
  if (!(await putSigned(d.put, file, d.type, 45_000)) && !(await putSigned(d.put, file, d.type, 45_000))) return null;
  const th = thumb ? await thumb.catch(() => null) : null;
  let ok = false;
  if (th) {
    const t = await post(`/v1/clips/${d.id}/thumb-url`, json({ size: th.size }), 'application/json', 15_000);
    const u = t?.ok ? ((await t.json().catch(() => null)) as { put: string; type: string } | null) : null;
    ok = !!u?.put && (await putSigned(u.put, th, u.type, 15_000));
  }
  return { id: d.id, ext: d.ext, url: `${GAME_API}/v1/clips/${d.id}.${d.ext}`, thumb: ok };
}

async function upload(file: Blob, thumb?: Promise<Blob | null>): Promise<SharedClip | null> {
  const type = file.type.split(';')[0];
  const kind = type === 'video/mp4' ? 'mp4' : type === 'video/webm' ? 'webm' : null;
  if (kind) {
    const d = await uploadDirect(file, kind, thumb);
    if (d) return d;
  }
  // одна повторная попытка: мобильная сеть рвётся
  let r = await post('/v1/clips', file, type, 45_000);
  if (!r || r.status >= 500) r = await post('/v1/clips', file, type, 45_000);
  if (!r?.ok) return null;
  const { id, ext } = (await r.json()) as { id: string; ext: string };
  const th = thumb ? await thumb.catch(() => null) : null;
  const ok = !!th && !!(await post(`/v1/clips/${id}/thumb`, th, 'image/jpeg', 15_000))?.ok;
  return { id, ext, url: `${GAME_API}/v1/clips/${id}.${ext}`, thumb: ok };
}

/** Загрузить клип (если ещё не грузится) — то же обещание на тот же файл. */
export function shareableClip(file: Blob, thumb?: Promise<Blob | null>): Promise<SharedClip | null> {
  let p = pending.get(file);
  if (!p) {
    p = upload(file, thumb);
    pending.set(file, p);
    // не вышло — следующее нажатие попробует снова
    void p.then((c) => {
      if (!c) pending.delete(file);
    });
  }
  return p;
}

/**
 * Клип, который смонтировал сам игровой сервер (клип выбывшего): он уже в хранилище — загружать
 * с телефона не нужно. Скачать файл (для системного «Поделиться») и запомнить его ссылку.
 */
export async function serverClipFile(c: { id: string; ext: string; thumb: boolean }, name: string): Promise<File | null> {
  const url = `${GAME_API}/v1/clips/${c.id}.${c.ext}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const file = new File([await r.blob()], name, { type: 'video/mp4' });
    pending.set(file, Promise.resolve({ id: c.id, ext: c.ext, url, thumb: c.thumb }));
    return file;
  } catch {
    return null;
  }
}
