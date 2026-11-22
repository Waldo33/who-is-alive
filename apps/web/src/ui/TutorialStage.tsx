'use client';

import { useEffect, useRef } from 'react';
import type { Dict, GameConfig, Lang } from '@kto/game-core';
import type { RunningGame } from '@/game/boot';
import { track } from '@/lib/analytics';
import { loadChunk } from '@/lib/chunk';
import { playerName } from '@/lib/name';

/**
 * «Пробный дубль» поверх страницы: только сцена игры со сценарием обучения (game/tutorial.ts)
 * (пропустить — кнопка «Пропустить» внизу сцены) — без текстов и карточек. На /learn и в лобби, пока ждут режиссёра.
 */
export function TutorialStage({
  lang,
  t,
  onClose,
}: {
  lang: Lang;
  t: Dict;
  /** Пройдено или пропущено — назад (на главную или в лобби). */
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    let running: RunningGame | null = null;
    let cancelled = false;
    void loadChunk(() => Promise.all([import('@/game/boot'), import('@/game/tutorial'), import('@kto/game-core')])).then(
      async ([{ bootGame }, { TUTORIAL_CFG, markTutorialDone, tutorialDone }, core]) => {
        if (cancelled || !ref.current) return;
        // аналитика: где открыли (страница /learn или лобби), впервые ли, сколько секунд до конца или пропуска
        const where = location.pathname.startsWith('/r/') ? 'lobby' : 'learn';
        const first = !tutorialDone();
        const t0 = Date.now();
        const sec = () => Math.round((Date.now() - t0) / 1000);
        track('tutorial_start', { where, first });
        running = await bootGame(ref.current, {
          playerName: playerName(t),
          fontFamily: '"Press Start 2P", monospace',
          lang,
          cfg: TUTORIAL_CFG as Partial<GameConfig>,
          // ты и «актёр», без ИИ: всё, что происходит, вызывает сценарий
          createSession: (cfg, players, seed) =>
            new core.LocalSession(new core.MatchSim(cfg, players.slice(0, 2), seed, players[0].pid), players[0].pid, seed, { ai: false }),
          tutorial: {
            onDone: () => {
              track('tutorial_done', { where, first, sec: sec() });
              markTutorialDone();
              closeRef.current();
            },
            // кнопка «Пропустить»: больше не показывать сам
            onSkip: () => {
              track('tutorial_skip', { where, first, sec: sec() });
              markTutorialDone();
              closeRef.current();
            },
          },
        });
        if (cancelled) running.destroy();
        // ?dev — доступ из консоли и автотестов, как в песочнице
        else if (new URLSearchParams(location.search).has('dev')) (window as unknown as { __kto: RunningGame }).__kto = running;
      },
    );
    return () => {
      cancelled = true;
      running?.destroy();
    };
  }, [lang, t]);

  return (
    <div className="tut-wrap">
      <div ref={ref} className="game-stage" aria-label={t.tutorial.title} />
    </div>
  );
}
