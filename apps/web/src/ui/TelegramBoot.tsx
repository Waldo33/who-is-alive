'use client';

import { useEffect } from 'react';
import { track } from '@/lib/analytics';
import { telegramReady, telegramStart, telegramStartTarget } from '@/lib/telegram';

/**
 * Запуск внутри Telegram (lib/telegram.ts): загрузить SDK, настроить приложение, взять имя и язык
 * из профиля (если свои не заданы) и один раз за запуск перейти туда, куда ведёт ссылка (?startapp):
 * `r_КОД` — в комнату, `daily` — в загадку дня (главная делает это сама ещё раньше — HomeClient).
 * Вне Telegram ничего не делает.
 */
export default function TelegramBoot() {
  useEffect(() => {
    void telegramReady().then((w) => {
      if (!w) return;
      track('tg_open', { platform: w.platform, version: w.version, start: telegramStart() });
      const target = telegramStartTarget();
      if (target && location.pathname === '/') location.replace(target);
    });
  }, []);
  return null;
}
