'use client';

import { useEffect, useRef, useState } from 'react';
import type { Dict, GameConfig, Lang } from '@kto/game-core';
import type { RunningGame } from '@/game/boot';
import { loadChunk } from '@/lib/chunk';
import { playerName } from '@/lib/name';

/**
 * «Пробный дубль» поверх страницы: сцена игры со сценарием обучения (game/tutorial.ts),
 * кнопка «Пропустить» и итоговая карточка. Используется на /learn и в лобби, пока ждут режиссёра.
 */
export function TutorialStage({
  lang,
  t,
  inLobby = false,
  onClose,
}: {
  lang: Lang;
  t: Dict;
  inLobby?: boolean;
  /** bots — сыграть с ботами; close — назад (на главную или в лобби). */
  onClose: (action: 'bots' | 'close') => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    let running: RunningGame | null = null;
    let cancelled = false;
    void loadChunk(() => Promise.all([import('@/game/boot'), import('@/game/tutorial'), import('@kto/game-core')])).then(
      async ([{ bootGame }, { TUTORIAL_CFG, markTutorialDone }, core]) => {
        if (cancelled || !ref.current) return;
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
              markTutorialDone();
              setDone(true);
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

  const skip = () => {
    void import('@/game/tutorial').then(({ markTutorialDone }) => markTutorialDone());
    onClose('close');
  };

  return (
    <div className="tut-wrap">
      <div ref={ref} className="game-stage" aria-label={t.tutorial.title} />
      {!done && (
        <button className="tut-skip" onClick={skip}>
          {t.tutorial.skip}
        </button>
      )}
      {done && (
        <div className="tut-done" role="dialog" aria-modal="true" aria-label={t.tutorial.doneTitle}>
          <div className="tut-done-box">
            <h2>{t.tutorial.doneTitle}</h2>
            <p>{t.tutorial.doneText}</p>
            {inLobby ? (
              <button className="btn" onClick={() => onClose('close')}>
                {t.tutorial.backLobby}
              </button>
            ) : (
              <>
                <button className="btn" onClick={() => onClose('bots')}>
                  {t.tutorial.playBots}
                </button>
                <button className="link" onClick={() => onClose('close')}>
                  {t.tutorial.back}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
