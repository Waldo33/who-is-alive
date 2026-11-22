'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { DICTS } from '@kto/game-core';
import type { Lang } from '@kto/game-core';
import { setTrackContext, track } from '@/lib/analytics';
import { detectLang } from '@/lib/lang';
import { TutorialStage } from '@/ui/TutorialStage';

/** «Пробный дубль» отдельной страницей: при первом запуске и из «Как играть». */
export default function LearnClient() {
  const router = useRouter();
  const [lang, setLang] = useState<Lang | null>(null);
  useEffect(() => {
    const l = detectLang();
    setLang(l);
    document.documentElement.lang = l;
    document.title = `${DICTS[l].tutorial.title} · ${DICTS[l].meta.title}`;
    setTrackContext({ mode: 'tutorial' });
    track('page_view', { page: 'learn' });
  }, []);
  if (!lang) return null;
  // куда вернуться: ?next=/sandbox и т. п. (только свои пути)
  const back = () => {
    const next = new URLSearchParams(location.search).get('next') ?? '/';
    router.replace(next.startsWith('/') && !next.startsWith('//') ? next : '/');
  };
  return <TutorialStage lang={lang} t={DICTS[lang]} onClose={back} />;
}
