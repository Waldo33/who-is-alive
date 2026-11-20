'use client';

import { useEffect, useRef } from 'react';
import { loadChunk } from '@/lib/chunk';

export default function SandboxClient() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let unmount: (() => void) | undefined;
    let cancelled = false;
    // Phaser работает только в браузере, поэтому грузим его динамически
    void loadChunk(() => import('@/game/shell')).then(({ mountSandbox }) => {
      if (cancelled || !ref.current) return;
      unmount = mountSandbox(ref.current, { fontFamily: '"Press Start 2P", monospace' });
    });
    return () => {
      cancelled = true;
      unmount?.();
    };
  }, []);
  return <div ref={ref} />;
}
