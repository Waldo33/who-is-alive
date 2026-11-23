'use client';

import { useEffect } from 'react';
import { installErrorReporting } from '../lib/errors';
import { scheduleNetProbe } from '../lib/netprobe';

/**
 * Регистрирует сервис-воркер (только в продакшене: в разработке он мешал бы горячей перезагрузке)
 * и ловит ошибки JS на всех страницах (lib/errors.ts); раз в сутки — замер доступности серверов (lib/netprobe.ts).
 */
export default function PwaRegister() {
  useEffect(() => {
    installErrorReporting();
    scheduleNetProbe();
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    const reg = () => void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
    if (document.readyState === 'complete') reg();
    else window.addEventListener('load', reg, { once: true });
  }, []);
  return null;
}
