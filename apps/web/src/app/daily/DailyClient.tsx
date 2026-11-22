'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { DICTS, fmt, tp } from '@kto/game-core';
import type { CrowdKind, DailyPuzzle, Lang } from '@kto/game-core';
import { dailyHint } from '@kto/game-core';
import { track } from '@/lib/analytics';
import { loadChunk } from '@/lib/chunk';
import { detectLang } from '@/lib/lang';
import { shareContent, withLang } from '@/lib/share';
import { inTelegram, telegramDailyBoard, telegramShareCard } from '@/lib/telegram';
import type { ChatScore } from '@/lib/telegram';
import { TopBar } from '@/ui/TopBarView';
import type { DailyView } from '@/game/daily-view';

type Phase = 'loading' | 'intro' | 'watch' | 'guess' | 'done';

interface Saved {
  days: Record<string, { tries: number; won: boolean }>;
}

const KEY = 'kto:daily';

function loadSaved(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '') as Saved;
    if (s && typeof s.days === 'object') return s;
  } catch {
    /* нет или испорчено */
  }
  return { days: {} };
}

function save(s: Saved): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* приватный режим */
  }
}

/** Серия: сколько дней подряд (до сегодняшнего включительно) загадка сыграна. */
function streakOf(s: Saved, n: number): number {
  let k = 0;
  while (s.days[String(n - k)]) k++;
  return k;
}

function untilMidnight(): string {
  const now = new Date();
  const mid = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const m = Math.max(0, Math.round((mid.getTime() - now.getTime()) / 60000));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** «Кастинг дня» (/daily): найди актёра в массовке. */
export default function DailyClient() {
  const router = useRouter();
  const [lang, setLang] = useState<Lang>('ru');
  const t = DICTS[lang];
  const [phase, setPhase] = useState<Phase>('loading');
  const [n, setN] = useState(0);
  const [tries, setTries] = useState(0);
  const [won, setWon] = useState(false);
  const [rewatched, setRewatched] = useState(false);
  const [flash, setFlash] = useState('');
  const [crowd, setCrowd] = useState<{ kind: CrowdKind; vote: boolean } | null>(null);
  const [streak, setStreak] = useState(0);
  const [scale, setScale] = useState(2);
  const [board, setBoard] = useState<ChatScore[] | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<DailyView | null>(null);
  const puzzleRef = useRef<DailyPuzzle | null>(null);
  const audioRef = useRef<import('@/game/audio').Audio | null>(null);
  const modRef = useRef<{ squares: (tries: number, won: boolean) => string; tries: number } | null>(null);
  const [hinted, setHinted] = useState(false);

  useEffect(() => {
    const l = detectLang();
    setLang(l);
    document.documentElement.lang = l;
    document.title = `${DICTS[l].daily.title} · ${DICTS[l].meta.title}`;
    let cancelled = false;
    void loadChunk(() => Promise.all([import('@kto/game-core'), import('@/game/themes'), import('@/game/audio')])).then(async ([core, themes, audio]) => {
      const num = core.dailyNumber(core.localDateKey(new Date()));
      const p = core.buildDaily(num);
      await themes.loadTheme(p.theme);
      if (cancelled) return;
      puzzleRef.current = p;
      audioRef.current = audio.getAudio();
      modRef.current = { squares: core.dailySquares, tries: core.DAILY_TRIES };
      setN(num);
      const s = loadSaved();
      setStreak(streakOf(s, num));
      const done = s.days[String(num)];
      track('daily_view', { n: num, done: !!done });
      if (done) {
        setTries(done.tries);
        setWon(done.won);
        setPhase('done');
      } else setPhase('intro');
    });
    return () => {
      cancelled = true;
      viewRef.current?.dispose();
    };
  }, []);

  // поле занимает всё место между заголовком и кнопками — экран без прокрутки;
  // масштаб целый в пикселях экрана (как integerZoom у игры): пиксели не размываются
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = slot.clientWidth * dpr;
      const h = slot.clientHeight * dpr;
      // совсем нет места (маленький экран + рейтинг чата под ответом) — поле прячем, а не листаем
      const k = Math.floor(Math.min(w / 180, h / 260));
      setScale(k / dpr >= 0.5 ? k / dpr : 0);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(slot);
    return () => ro.disconnect();
  }, []);

  // canvas появляется после загрузки: тогда и создаём вид
  useEffect(() => {
    const p = puzzleRef.current;
    const c = canvasRef.current;
    if (!p || !c || viewRef.current) return;
    void import('@/game/daily-view').then(({ DailyView: V }) => {
      if (viewRef.current) return;
      viewRef.current = new V({ canvas: c, arena: p.sim.arena, world: p.world, theme: p.theme, from: p.from, to: p.to, onCrowd: setCrowd });
      // уже сыграно сегодня — показать ответ на последнем кадре
      if (phase === 'done') {
        viewRef.current.answer = p.answer;
        viewRef.current.play(() => undefined);
      }
    });
  }, [phase]);

  const watch = (again = false) => {
    const v = viewRef.current;
    const p = puzzleRef.current;
    if (!v || !p) return;
    const a = audioRef.current;
    a?.unlock();
    a?.setMusic('play', p.theme, true);
    setPhase('watch');
    track(again ? 'daily_rewatch' : 'daily_start', { n });
    v.play(() => {
      a?.setMusic('accuse');
      setCrowd(null);
      setPhase('guess');
    });
  };

  const finish = (usedTries: number, isWon: boolean) => {
    const s = loadSaved();
    s.days[String(n)] = { tries: usedTries, won: isWon };
    save(s);
    setStreak(streakOf(s, n));
    setWon(isWon);
    setPhase('done');
    audioRef.current?.setMusic('menu');
    audioRef.current?.play(isWon ? 'fanfare' : 'sad');
    track('daily_done', { n, tries: usedTries, won: isWon });
  };

  const onTap = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const v = viewRef.current;
    const p = puzzleRef.current;
    const m = modRef.current;
    if (phase !== 'guess' || !v || !p || !m) return;
    const eid = v.pick(e.clientX, e.clientY);
    if (eid === null || v.wrong.has(eid)) return;
    const used = tries + 1;
    setTries(used);
    track('daily_guess', { n, try: used, right: eid === p.answer });
    if (eid === p.answer) {
      v.hint = null;
      v.answer = eid;
      v.redraw();
      audioRef.current?.play('accuseRight');
      finish(used, true);
      return;
    }
    v.wrong.add(eid);
    audioRef.current?.play('accuseWrong');
    setFlash(t.daily.wrong);
    setTimeout(() => setFlash(''), 900);
    if (used >= m.tries) {
      v.hint = null;
      v.answer = p.answer;
      v.redraw();
      finish(used, false);
    } else {
      // промах — подсказка: часть поля, где живой (половина, потом четверть)
      const pos = v.posOf(p.answer);
      if (pos) v.hint = dailyHint(p.sim.arena, pos.x, pos.y, used);
      setHinted(true);
      v.redraw();
    }
  };

  // в Telegram, открытом из чата: свой результат — в рейтинг этого чата, и сам рейтинг
  useEffect(() => {
    if (phase !== 'done' || n <= 0 || tries <= 0 || !inTelegram()) return;
    let off = false;
    void telegramDailyBoard(n, { tries, won }).then((b) => {
      if (!off && b) setBoard(b);
    });
    return () => {
      off = true;
    };
  }, [phase, n, tries, won]);

  const share = async () => {
    const m = modRef.current;
    if (!m) return;
    // в Telegram — карточкой с кнопкой «Решить загадку»
    if (inTelegram() && (await telegramShareCard({ kind: 'daily', squares: m.squares(tries, won) }))) {
      track('share', { what: 'daily', result: 'telegram_card', n });
      return;
    }
    const text = fmt(t.daily.shareText, { n, squares: m.squares(tries, won) });
    // в Telegram shareContent сама заменит ссылку на ссылку внутрь Telegram
    const url = withLang(`${location.origin}/daily`, 'daily');
    const result = await shareContent({ text, url });
    track('share', { what: 'daily', result, n });
  };

  const crowdName = crowd ? (crowd.vote ? t.game.crowdVote : t.game.crowd[crowd.kind]) : '';
  const left = (modRef.current?.tries ?? 3) - tries;

  return (
    <main className="daily">
      <TopBar lang={lang} onBack={() => router.push('/')} />
      <header className="daily-head">
        <h1 className="daily-title">
          {t.daily.title}
          {n > 0 && <span> {fmt(t.daily.numShort, { n })}</span>}
        </h1>
        <p className="daily-task">{t.daily.task}</p>
      </header>
      <div className="daily-slot" ref={slotRef}>
        {phase === 'loading' ? (
          <p className="muted">{t.daily.loading}</p>
        ) : (
          <div className="daily-stage" style={{ width: 180 * scale, height: 260 * scale, visibility: scale ? 'visible' : 'hidden' }}>
            <canvas
              ref={canvasRef}
              className="daily-canvas"
              style={{ width: 180 * scale, height: 260 * scale }}
              onPointerUp={onTap}
              aria-label={t.daily.task}
            />
            {phase === 'intro' && (
              <div className="daily-cover">
                <p>{t.daily.intro}</p>
                <button className="btn" onClick={() => watch()}>
                  {t.daily.start}
                </button>
              </div>
            )}
            {phase === 'watch' && <div className="daily-badge">{crowdName || t.daily.watch}</div>}
            {phase === 'guess' && <div className="daily-badge">{flash || (hinted ? t.daily.hint : t.daily.guess)}</div>}
          </div>
        )}
      </div>
      {phase === 'guess' && (
        <div className="daily-actions">
          <p className="muted">{tp(lang, t.daily.tries, left)}</p>
          {!rewatched && tries === 0 && (
            <button
              className="link"
              onClick={() => {
                setRewatched(true);
                watch(true);
              }}
            >
              {t.daily.rewatch}
            </button>
          )}
        </div>
      )}
      {phase === 'done' && (
        <div className="daily-actions">
          <p className="daily-result">{won ? fmt(t.daily.won, { n: tries }) : t.daily.lost}</p>
          <p className="daily-line">
            <span className="daily-squares">{modRef.current?.squares(tries, won)}</span>
            <span className="muted">{fmt(t.daily.streak, { n: streak })}</span>
          </p>
          {board && board.length > 0 && (
            <div className="daily-board">
              <p className="daily-board-title">{t.daily.chatTitle}</p>
              <ol>
                {board.slice(0, 5).map((r, i) => (
                  <li key={i} className={r.me ? 'me' : undefined}>
                    <span className="daily-board-name">{r.name}</span>
                    <span>{modRef.current?.squares(r.tries, r.won)}</span>
                  </li>
                ))}
              </ol>
              {board.length === 1 && <p className="muted">{t.daily.chatAlone}</p>}
            </div>
          )}
          <div className="daily-buttons">
            <button className="btn small" onClick={() => void share()}>
              {t.daily.share}
            </button>
            <Link className="btn small" href="/?create=1" onClick={() => track('invite_tap', { from: 'daily' })}>
              {t.daily.play}
            </Link>
          </div>
          <p className="muted">{fmt(t.daily.next, { t: untilMidnight() })}</p>
        </div>
      )}
    </main>
  );
}
