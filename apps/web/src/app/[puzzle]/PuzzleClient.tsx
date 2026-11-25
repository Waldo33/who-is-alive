'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { DICTS, dailySquares, fmt, tp } from '@kto/game-core';
import type { CrowdKind, FilmPuzzlePublic, HintRect, Lang } from '@kto/game-core';
import { deviceId, inAppBrowser, track } from '@/lib/analytics';
import { loadChunk } from '@/lib/chunk';
import { GAME_API } from '@/lib/env';
import { detectLang } from '@/lib/lang';
import { shareContent, withLang } from '@/lib/share';
import { TopBar } from '@/ui/TopBarView';
import type { DailyView } from '@/game/daily-view';

/**
 * Загадка из «Фильма матча» (/<код>): 20 секунд настоящего матча, стоп-кадр, найди любого актёра
 * (настоящего игрока) за 30 секунд и три попытки. Ответ знает только сервер (`/v1/puzzles/<код>/tap`):
 * страница присылает сущность под пальцем и номер попытки, сервер — попал ли и подсказку.
 * Потом — «Играть»: матч с ИИ на той же площадке, оттуда — «С друзьями».
 */

type Phase = 'loading' | 'gone' | 'offline' | 'intro' | 'watch' | 'guess' | 'done';

interface Result {
  tries: number;
  won: boolean;
  answer: number[];
  stats?: { played: number; found: number };
}

const KEY = 'kto:puzzles';
const TRIES = 3;
const PICK_SEC = 30;

function loadSaved(): Record<string, Result> {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '') as Record<string, Result>;
    if (s && typeof s === 'object') return s;
  } catch {
    /* нет или испорчено */
  }
  return {};
}

function saveResult(code: string, r: Result): void {
  try {
    const s = loadSaved();
    s[code] = r;
    // хранить не больше 50 загадок: старые уходят первыми
    const keys = Object.keys(s);
    for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete s[k];
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* приватный режим */
  }
}

interface TapAnswer {
  hit: boolean;
  done: boolean;
  hint?: HintRect;
  answer?: number[];
  stats?: { played: number; found: number };
}

async function sendTap(code: string, eid: number, n: number): Promise<TapAnswer | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${GAME_API}/v1/puzzles/${code}/tap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eid, n, d: deviceId() }),
      });
      if (r.ok) return (await r.json()) as TapAnswer;
      if (r.status < 500 && r.status !== 429) return null;
    } catch {
      /* сеть моргнула — ещё раз */
    }
    await new Promise((ok) => setTimeout(ok, 600 * (attempt + 1)));
  }
  return null;
}

export default function PuzzleClient({ code }: { code: string }) {
  const router = useRouter();
  const [lang, setLang] = useState<Lang>('ru');
  const t = DICTS[lang];
  const T = t.puzzle;
  const [phase, setPhase] = useState<Phase>('loading');
  const [tries, setTries] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(PICK_SEC);
  const [hinted, setHinted] = useState(false);
  const [crowd, setCrowd] = useState<{ kind: CrowdKind; vote: boolean } | null>(null);
  const [scale, setScale] = useState(2);
  const [size, setSize] = useState({ w: 180, h: 260 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<DailyView | null>(null);
  const pubRef = useRef<FilmPuzzlePublic | null>(null);
  const worldRef = useRef<import('@kto/game-core').World | null>(null);
  const audioRef = useRef<import('@/game/audio').Audio | null>(null);
  const triesRef = useRef(0);
  const [attempt, setAttempt] = useState(0);

  // загрузка загадки
  useEffect(() => {
    const l = detectLang();
    setLang(l);
    document.documentElement.lang = l;
    document.title = `${DICTS[l].puzzle.title} · ${DICTS[l].meta.title}`;
    let cancelled = false;
    const src = new URLSearchParams(location.search).get('src');
    void (async () => {
      let res: Response | null = null;
      try {
        res = await fetch(`${GAME_API}/v1/puzzles/${code}`);
      } catch {
        res = null;
      }
      if (cancelled) return;
      if (!res || (!res.ok && res.status !== 404)) {
        setPhase('offline');
        track('puzzle_open', { code, ok: false, src: src ?? '', app: inAppBrowser() ?? '' });
        return;
      }
      if (res.status === 404) {
        setPhase('gone');
        track('puzzle_open', { code, gone: true, src: src ?? '', app: inAppBrowser() ?? '' });
        return;
      }
      const body = (await res.json()) as { puzzle: FilmPuzzlePublic };
      const [core, themes, audio] = await loadChunk(() => Promise.all([import('@kto/game-core'), import('@/game/themes'), import('@/game/audio')]));
      await themes.loadTheme(body.puzzle.theme);
      if (cancelled) return;
      pubRef.current = body.puzzle;
      worldRef.current = core.puzzleWorld(body.puzzle);
      audioRef.current = audio.getAudio();
      setSize({ w: body.puzzle.arena.width, h: body.puzzle.arena.height });
      const done = loadSaved()[code];
      track('puzzle_open', { code, src: src ?? '', app: inAppBrowser() ?? '', again: !!done, theme: body.puzzle.theme });
      if (done) {
        setResult(done);
        setTries(done.tries);
        setPhase('done');
      } else setPhase('intro');
    })();
    return () => {
      cancelled = true;
      viewRef.current?.dispose();
    };
  }, [code, attempt]);

  // поле занимает всё место между заголовком и кнопками — без прокрутки, масштаб целый в пикселях экрана
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const k = Math.floor(Math.min((slot.clientWidth * dpr) / size.w, (slot.clientHeight * dpr) / size.h));
      setScale(k / dpr >= 0.5 ? k / dpr : 0);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(slot);
    return () => ro.disconnect();
  }, [size]);

  // canvas появляется после загрузки: тогда и создаём вид
  useEffect(() => {
    const p = pubRef.current;
    const w = worldRef.current;
    const c = canvasRef.current;
    if (!p || !w || !c || viewRef.current) return;
    void import('@/game/daily-view').then(({ DailyView: V }) => {
      if (viewRef.current) return;
      viewRef.current = new V({ canvas: c, arena: p.arena, world: w, theme: p.theme, from: p.from, to: p.to, onCrowd: setCrowd });
      // уже сыграна с этого телефона — ответ на последнем кадре
      const r = loadSaved()[code];
      if (phase === 'done' && r) {
        for (const eid of r.answer) viewRef.current.answers.add(eid);
        viewRef.current.play(() => undefined);
      }
    });
  }, [phase, code]);

  // 30 секунд на выбор
  useEffect(() => {
    if (phase !== 'guess') return;
    setLeft(PICK_SEC);
    const started = Date.now();
    const id = setInterval(() => {
      const s = PICK_SEC - Math.floor((Date.now() - started) / 1000);
      setLeft(Math.max(0, s));
      if (s <= 0) {
        clearInterval(id);
        void timeout();
      }
    }, 250);
    return () => clearInterval(id);
    // таймер — на весь стоп-кадр, промахи его не сбрасывают
  }, [phase]);

  const watch = () => {
    const v = viewRef.current;
    const p = pubRef.current;
    if (!v || !p) return;
    const a = audioRef.current;
    a?.unlock();
    a?.setMusic('play', p.theme, true);
    setPhase('watch');
    track('puzzle_watch', { code });
    v.play(() => {
      a?.setMusic('accuse');
      setCrowd(null);
      setPhase('guess');
    });
  };

  const finish = (r: Result) => {
    const v = viewRef.current;
    if (v) {
      v.hint = null;
      for (const eid of r.answer) v.answers.add(eid);
      v.redraw();
    }
    saveResult(code, r);
    setResult(r);
    setPhase('done');
    audioRef.current?.setMusic('menu');
    audioRef.current?.play(r.won ? 'fanfare' : 'sad');
    track('puzzle_done', { code, tries: r.tries, won: r.won });
  };

  const timeout = async () => {
    if (busy) return;
    setBusy(true);
    setFlash(T.timeout);
    const a = await sendTap(code, -1, TRIES);
    setBusy(false);
    finish({ tries: TRIES, won: false, answer: a?.answer ?? [], stats: a?.stats });
  };

  const onTap = async (e: React.PointerEvent<HTMLCanvasElement>) => {
    const v = viewRef.current;
    if (phase !== 'guess' || !v || busy) return;
    const eid = v.pick(e.clientX, e.clientY);
    if (eid === null || v.wrong.has(eid)) return;
    const n = triesRef.current + 1;
    setBusy(true);
    const a = await sendTap(code, eid, n);
    setBusy(false);
    if (!a) {
      setFlash(T.offline);
      setTimeout(() => setFlash(''), 1500);
      return;
    }
    triesRef.current = n;
    setTries(n);
    track('puzzle_tap', { code, try: n, right: a.hit });
    if (a.hit) {
      audioRef.current?.play('accuseRight');
      finish({ tries: n, won: true, answer: a.answer ?? [eid], stats: a.stats });
      return;
    }
    v.wrong.add(eid);
    audioRef.current?.play('accuseWrong');
    if (a.done) {
      finish({ tries: n, won: false, answer: a.answer ?? [], stats: a.stats });
      return;
    }
    setFlash(T.wrong);
    setTimeout(() => setFlash(''), 900);
    v.hint = a.hint ?? null;
    setHinted(!!a.hint);
    v.redraw();
  };

  const share = async () => {
    const r = result;
    const text = fmt(T.shareText, { squares: r ? dailySquares(r.tries, r.won) : '' });
    const res = await shareContent({ text, url: withLang(`${location.origin}/${code}`, 'puzzle') });
    track('puzzle_reshare', { code, result: res });
  };

  const play = () => {
    const p = pubRef.current;
    track('puzzle_play', { code, won: !!result?.won });
    // матч с ИИ на той же площадке, что в загадке (первый дубль), дальше — как обычно
    router.push(`/sandbox?go&src=puzzle${p ? `&theme=${p.theme}` : ''}`);
  };

  const crowdName = crowd ? (crowd.vote ? t.game.crowdVote : t.game.crowd[crowd.kind]) : '';
  const stats = result?.stats;
  const pct = stats && stats.played > 1 ? Math.round((stats.found / stats.played) * 100) : null;

  return (
    <main className="daily">
      <TopBar lang={lang} onBack={() => router.push('/')} />
      <header className="daily-head">
        <h1 className="daily-title">{T.title}</h1>
        <p className="daily-task">{T.task}</p>
      </header>
      <div className="daily-slot" ref={slotRef}>
        {phase === 'loading' && <p className="muted">{T.loading}</p>}
        {(phase === 'gone' || phase === 'offline') && (
          <div className="daily-actions">
            <p className="muted">{phase === 'gone' ? T.gone : T.offline}</p>
            <div className="daily-buttons">
              {phase === 'offline' && (
                <button className="btn small" onClick={() => setAttempt((x) => x + 1)}>
                  {T.retry}
                </button>
              )}
              <button className="btn small" onClick={play}>
                {T.play}
              </button>
            </div>
          </div>
        )}
        {phase !== 'loading' && phase !== 'gone' && phase !== 'offline' && (
          <div className="daily-stage" style={{ width: size.w * scale, height: size.h * scale, visibility: scale ? 'visible' : 'hidden' }}>
            <canvas
              ref={canvasRef}
              className="daily-canvas"
              style={{ width: size.w * scale, height: size.h * scale }}
              onPointerUp={(e) => void onTap(e)}
              aria-label={T.guess}
            />
            {phase === 'intro' && (
              <div className="daily-cover">
                <p>{T.intro}</p>
                <button className="btn" onClick={watch}>
                  {T.start}
                </button>
              </div>
            )}
            {phase === 'watch' && <div className="daily-badge">{crowdName || T.watch}</div>}
            {phase === 'guess' && <div className="daily-badge">{flash || (hinted ? T.hint : T.guess)}</div>}
          </div>
        )}
      </div>
      {phase === 'guess' && (
        <div className="daily-actions">
          <p className="muted">
            {tp(lang, t.daily.tries, TRIES - tries)} · {fmt(T.timer, { n: left })}
          </p>
        </div>
      )}
      {phase === 'done' && result && (
        <div className="daily-actions">
          <p className="daily-result">{result.won ? fmt(T.won, { n: result.tries }) : T.lost}</p>
          <p className="daily-line">
            <span className="daily-squares">{dailySquares(result.tries, result.won)}</span>
          </p>
          <p className="muted">{pct !== null ? fmt(T.stats, { p: pct }) : T.statsFirst}</p>
          <p className="daily-task">{T.nowYou}</p>
          <div className="daily-buttons">
            <button className="btn small" onClick={play}>
              {T.play}
            </button>
            <button className="btn small" onClick={() => void share()}>
              {T.share}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
