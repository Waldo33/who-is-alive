'use client';

import { useEffect, useRef } from 'react';
import type { Lang } from '@kto/game-core';
import { mountTopBar } from './topbar';
import type { TopBar as Bar, TopBarOptions } from './topbar';

/** Верхняя панель («← Назад» и шестерёнка настроек) для страниц React. */
export function TopBar(props: TopBarOptions & { lang: Lang; barRef?: React.MutableRefObject<Bar | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  const bar = useRef<Bar | null>(null);
  const { barRef, ...opts } = props;
  useEffect(() => {
    if (!ref.current) return;
    bar.current = mountTopBar(ref.current, opts);
    if (barRef) barRef.current = bar.current;
    return () => {
      bar.current?.destroy();
      bar.current = null;
      if (barRef) barRef.current = null;
    };
    // панель создаётся один раз; изменения приходят через update ниже
  }, []);
  useEffect(() => {
    bar.current?.update(opts);
  });
  return <div ref={ref} className="kto-topbar-host" />;
}
