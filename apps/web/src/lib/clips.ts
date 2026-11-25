/**
 * Клип «Лучший момент» на игровом сервере (Москва, `apps/server/src/clips.ts`) — для Telegram:
 * внутри него файл из браузера не отдать, поэтому сторис, «Сохранить» и видео-карточка в чат
 * берут клип по ссылке.
 *
 * Одно видео — одна загрузка (обещание запоминается на сам файл): сколько ни нажимай, второй
 * загрузки и второго окна не будет. Грузить начинаем заранее — как только игрок захотел клип
 * и тот записан, — так что к нажатию «Отправить» ссылка обычно уже готова.
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

async function upload(file: Blob, thumb?: Promise<Blob | null>): Promise<SharedClip | null> {
  const type = file.type.split(';')[0];
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
