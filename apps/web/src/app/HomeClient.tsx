'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { DICTS, dailyNumber, fmt, localDateKey } from '@kto/game-core';
import type { Lang } from '@kto/game-core';
import { getAudio } from '@/game/audio';
import { tutorialDone } from '@/game/tutorial';
import { detectLang } from '@/lib/lang';
import { TopBar } from '@/ui/TopBarView';
import type { TopBar as Bar } from '@/ui/topbar';
import { playerName } from '@/lib/name';
import { track } from '@/lib/analytics';
import { telegramStartTarget } from '@/lib/telegram';
import { Garland, Snow, useNewYear } from '@/ui/Festive';
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
  // кастинг дня: номер и пройден ли сегодня (localStorage — как на /daily)
  const [daily, setDaily] = useState({ n: 0, done: false });
  useEffect(() => {
    const n = dailyNumber(localDateKey(new Date()));
    let done = false;
    try {
      done = !!JSON.parse(localStorage.getItem('kto:daily') ?? '{}')?.days?.[String(n)];
    } catch {
      /* нет записей */
    }
    setDaily({ n, done });
  }, []);
  const bar = useRef<Bar | null>(null);
  const ny = useNewYear();
  const creating = useRef(false);
  // для автосоздания комнаты из эффекта (?create): самая свежая версия create
  const createRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    const l = detectLang();
    setLang(l);
    document.documentElement.lang = l;
    document.title = DICTS[l].meta.title;
    // открыли из Telegram по ссылке-приглашению (?startapp=r_КОД / daily) — сразу туда, без обучения
    const tgTarget = telegramStartTarget();
    if (tgTarget) {
      location.replace(tgTarget);
      return;
    }
    // музыка меню: заиграет после первого касания экрана (раньше браузер звук не пустит)
    // первый запуск — сразу обучение на практике, без описаний, потом матч с ИИ
    if (!tutorialDone()) {
      track('page_view', { page: 'home', first: true });
      // после обучения — сразу матч с ИИ: человеку из ролика без друзей не нужно искать, где играть
      router.replace(`/learn?next=${encodeURIComponent('/sandbox?go')}`);
      return;
    }
    track('page_view', { page: 'home' });
    getAudio().setMusic('menu');
    // «С друзьями» в конце матча с ИИ: сразу создать комнату и позвать
    if (new URLSearchParams(location.search).has('create')) {
      history.replaceState(null, '', '/');
      track('invite_create', { from: 'sandbox' });
      void createRef.current();
    }
  }, [router]);
  const t = DICTS[lang];

  const create = async () => {
    if (creating.current) return;
    creating.current = true;
    setBusy(true);
    setError('');
    try {
      await ensureAnonymousUser();
      const c = await createRoom(supabase(), playerName(t));
      track('room_create', { code: c });
      router.push(`/r/${c}`);
    } catch (e) {
      const key = e instanceof AuthError ? 'auth' : ((e as Error).message as keyof typeof t.lobby.errors);
      track('room_create_fail', { error: String(key) });
      creating.current = false;
      setError(t.lobby.errors[key] ?? t.lobby.errors.unknown);
      setBusy(false);
    }
  };

  createRef.current = create;

  /** Ссылка на игру — из PWA адресной строки нет, поэтому своя кнопка. Вызывать прямо из нажатия. */
  const shareGame = async () => {
    const r = await shareContent({ text: t.lobby.shareGameText, url: withLang(`${location.origin}/`, 'share') });
    track('share', { what: 'game', result: r });
    if (r === 'copied' || r === 'failed') {
      setToast(r === 'copied' ? t.lobby.copied : location.origin);
      setTimeout(() => setToast(''), 2000);
    }
  };

  const clean = code.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);

  return (
    <main className={ny ? 'home ny' : 'home'}>
      {ny && <Snow />}
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
      {ny && <Garland />}
      <div className="crowd" aria-hidden>
        {CROWD.map((i) => (
          <i key={i} className={i === 7 ? 'me' : undefined} style={{ animationDelay: `${(i * 137) % 900}ms` }} />
        ))}
      </div>
      <h1>{t.meta.title}</h1>
      <p className="tag">{t.meta.tagline}</p>
      {ny && <p className="ny-line">{t.start.newYear}</p>}
      {/* главное — сразу играть (с ИИ, без друзей и входа); комната для друзей — второй; кастинг дня — карточкой */}
      <div className="home-actions">
        <Link className="btn" href="/sandbox?go" onClick={() => track('quick_play_tap')}>
          {t.start.quickPlay}
        </Link>
        <button className="btn alt" onClick={create} disabled={busy}>
          {busy ? t.lobby.connecting : t.start.withFriends}
        </button>
        <Link className="daily-tile" href="/daily" onClick={() => track('daily_tap', { from: 'home' })}>
          <span className="daily-tile-title">
            {t.daily.title}
            {daily.n > 0 && ` ${fmt(t.daily.numShort, { n: daily.n })}`}
          </span>
          <span className="daily-tile-sub">{daily.done ? t.start.dailyDone : t.daily.task}</span>
        </Link>
      </div>
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
