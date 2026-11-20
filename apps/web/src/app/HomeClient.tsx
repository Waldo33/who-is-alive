'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { DICTS } from '@kto/game-core';
import type { Lang } from '@kto/game-core';
import { detectLang } from '@/lib/lang';

const CROWD = Array.from({ length: 11 }, (_, i) => i);

export default function HomeClient() {
  const [lang, setLang] = useState<Lang>('ru');
  useEffect(() => {
    const l = detectLang();
    setLang(l);
    document.documentElement.lang = l;
    document.title = DICTS[l].meta.title;
  }, []);
  const t = DICTS[lang];
  return (
    <main className="home">
      <div className="crowd" aria-hidden>
        {CROWD.map((i) => (
          <i key={i} className={i === 7 ? 'me' : undefined} style={{ animationDelay: `${(i * 137) % 900}ms` }} />
        ))}
      </div>
      <h1>{t.meta.title}</h1>
      <p className="tag">{t.meta.tagline}</p>
      <Link className="btn" href="/sandbox">
        {t.start.play}
      </Link>
      <span className="btn" aria-disabled="true">
        {t.start.createGame}
      </span>
      <p>{t.start.note}</p>
    </main>
  );
}
