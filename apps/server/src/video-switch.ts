/**
 * Аварийный выключатель видео (клип выбывшего, «Фильм матча», клип из итогов): при большой нагрузке
 * его включает кнопка `video-switch.yml` — файл /var/lib/massovka-clips/video-off на сервере. Без выкладки и
 * перезапуска: оба экземпляра (синий и зелёный) смотрят на файл раз в несколько секунд, сервер перестаёт
 * монтировать и говорит телефонам (`{t:'flags', video:false}`, `GET /v1/flags`) спрятать кнопки — и
 * сами телефоны видео тоже не пишут. Файл убрали — всё возвращается.
 */
import { existsSync } from 'node:fs';

export class VideoSwitch {
  on = true;
  private lastCheck = -Infinity;

  constructor(
    private readonly file: string | null,
    private readonly everyMs = 5000,
  ) {
    this.check(0, true);
  }

  /** Перечитать файл (не чаще everyMs). true — состояние изменилось. */
  check(now: number, force = false): boolean {
    if (!force && now - this.lastCheck < this.everyMs) return false;
    this.lastCheck = now;
    const on = !this.file || !existsSync(this.file);
    if (on === this.on) return false;
    this.on = on;
    return true;
  }
}
