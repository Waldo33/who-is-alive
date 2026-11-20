'use client';

import { useEffect } from 'react';

/** Регистрирует сервис-воркер (только в продакшене: в разработке он мешал бы горячей перезагрузке). */
export default function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    const reg = () => void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
    if (document.readyState === 'complete') reg();
    else window.addEventListener('load', reg, { once: true });
  }, []);
  return null;
}
