/**
 * Аварийный выключатель видео (сервер, apps/server/src/video-switch.ts): при большой нагрузке выключает
 * клипы и «Фильм матча» целиком — кнопки прячутся, телефон тоже ничего не монтирует. Состояние приходит
 * по связи комнаты (`{t:'flags'}`) и запросом `GET /v1/flags` при запуске игры. Нет связи с сервером
 * (песочница без сети) — видео включено.
 */
import { GAME_API } from '../lib/env';

let off = false;
let synced: Promise<void> | null = null;

/** Видео выключено аварийно. */
export function videoOff(): boolean {
  return off;
}

export function setVideoOff(v: boolean): void {
  off = v;
}

/** Спросить сервер (раз за жизнь вкладки; связь комнаты потом сообщает о смене сама). */
export function syncVideoSwitch(): Promise<void> {
  synced ??= (async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    try {
      const r = await fetch(`${GAME_API}/v1/flags`, { signal: ctl.signal });
      if (r.ok) off = ((await r.json()) as { video?: boolean }).video === false;
    } catch {
      // нет сети или старый сервер — видео включено
    } finally {
      clearTimeout(timer);
    }
  })();
  return synced;
}
