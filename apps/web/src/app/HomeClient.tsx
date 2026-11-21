'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { DICTS } from '@kto/game-core';
import type { Lang } from '@kto/game-core';
import { getAudio } from '@/game/audio';
import { tutorialDone } from '@/game/tutorial';
import { detectLang } from '@/lib/lang';
import { TopBar } from '@/ui/TopBarView';
import type { TopBar as Bar } from '@/ui/topbar';
import { playerName } from '@/lib/name';
import { shareContent, withLang } from '@/lib/share';
import { AuthError, ensureAnonymousUser, supabase } from '@/lib/supabase';
import { createRoom } from '@/net/room';

const CROWD = Array.from({ length: 11 }, (_, i) => i);
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

export default function HomeClient() {
  const router = useRouter();
  const [lang, setLang] = useState<Lang>('ru');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [code, setCode] = useState('');
  const [toast, setToast] = useState('');
  /** Новичок (не проходил пробный дубль) — первым делом предложить его. */
  const [newbie, setNewbie] = useState(false);
  const bar = useRef<Bar | null>(null);
  useEffect(() => {
    const l = detectLang();
    setLang(l);
    document.documentElement.lang = l;
    document.title = DICTS[l].meta.title;
    // музыка меню: заиграет после первого касания экрана (раньше браузер звук не пустит)
    getAudio().setMusic('menu');
    setNewbie(!tutorialDone());
  }, []);
  const t = DICTS[lang];

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      await ensureAnonymousUser();
      const c = await createRoom(supabase(), playerName(t));
      router.push(`/r/${c}`);
    } catch (e) {
      const key = e instanceof AuthError ? 'auth' : ((e as Error).message as keyof typeof t.lobby.errors);
      setError(t.lobby.errors[key] ?? t.lobby.errors.unknown);
      setBusy(false);
    }
  };

  /** Ссылка на игру — из PWA адресной строки нет, поэтому своя кнопка. Вызывать прямо из нажатия. */
  const shareGame = async () => {
    const r = await shareContent({ text: t.lobby.shareGameText, url: withLang(`${location.origin}/`) });
    if (r === 'copied' || r === 'failed') {
      setToast(r === 'copied' ? t.lobby.copied : location.origin);
      setTimeout(() => setToast(''), 2000);
    }
  };

  const clean = code.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);

  return (
    <main className="home">
      <TopBar
        lang={lang}
        barRef={bar}
        onShare={() => void shareGame()}
        onLang={(l) => {
          setLang(l);
          document.documentElement.lang = l;
          document.title = DICTS[l].meta.title;
        }}
      />
      <div className="crowd" aria-hidden>
        {CROWD.map((i) => (
          <i key={i} className={i === 7 ? 'me' : undefined} style={{ animationDelay: `${(i * 137) % 900}ms` }} />
        ))}
      </div>
      <h1>{t.meta.title}</h1>
      <p className="tag">{t.meta.tagline}</p>
      {newbie && (
        <div className="newbie">
          <p>{t.tutorial.newbie}</p>
          <Link className="btn alt" href="/learn">
            {t.tutorial.cta}
          </Link>
        </div>
      )}
      <button className="btn" onClick={create} disabled={busy}>
        {busy ? t.lobby.connecting : t.lobby.createGame}
      </button>
      {showCode ? (
        <form
          className="code-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (CODE_RE.test(clean)) router.push(`/r/${clean}`);
          }}
        >
          <input
            className="code-input"
            value={clean}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t.lobby.codePlaceholder}
            autoCapitalize="characters"
            autoComplete="off"
            autoFocus
            inputMode="text"
            aria-label={t.lobby.codeLabel}
          />
          <button className="btn small" disabled={!CODE_RE.test(clean)}>
            {t.lobby.join}
          </button>
        </form>
      ) : (
        <button className="link" onClick={() => setShowCode(true)}>
          {t.lobby.haveCode}
        </button>
      )}
      <Link className="link" href="/sandbox">
        {t.start.play}
      </Link>
      {!newbie && (
        <Link className="link" href="/learn">
          {t.tutorial.title}
        </Link>
      )}
      <button className="link" onClick={() => bar.current?.openSettings('rules')}>
        {t.ui.howTo}
      </button>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
