'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { DICTS } from '@kto/game-core';
import type { Lang } from '@kto/game-core';
import { detectLang } from '@/lib/lang';
import { TutorialStage } from '@/ui/TutorialStage';

/** «Пробный дубль» отдельной страницей: с главной и из «Как играть». */
export default function LearnClient() {
  const router = useRouter();
  const [lang, setLang] = useState<Lang | null>(null);
  useEffect(() => {
    const l = detectLang();
    setLang(l);
    document.documentElement.lang = l;
    document.title = `${DICTS[l].tutorial.title} · ${DICTS[l].meta.title}`;
  }, []);
  if (!lang) return null;
  return <TutorialStage lang={lang} t={DICTS[lang]} onClose={(a) => router.push(a === 'bots' ? '/sandbox' : '/')} />;
}
