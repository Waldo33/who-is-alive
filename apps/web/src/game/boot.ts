import * as Phaser from 'phaser';
import { PAL } from '@kto/assets';
import type { GameConfig } from '@kto/game-core';
import { getAudio } from './audio';
import type { Audio } from './audio';
import { GameScene } from './scene';
import { loadAllThemes } from './themes';
import type { SceneInit } from './scene';

export const LOGICAL_W = 180;
export const LOGICAL_H = 320;

/**
 * Только целочисленный масштаб в физических пикселях экрана (раздел 9):
 * k = floor(min(ширина·dpr / 180, высота·dpr / 320)), CSS-размер = 180·k / dpr.
 */
export function integerZoom(el: HTMLElement): number {
  const dpr = window.devicePixelRatio || 1;
  const w = el.clientWidth * dpr;
  const h = el.clientHeight * dpr;
  const k = Math.max(1, Math.floor(Math.min(w / LOGICAL_W, h / LOGICAL_H)));
  return k / dpr;
}

export async function loadPixelFont(family: string): Promise<void> {
  try {
    await Promise.race([
      document.fonts.load(`8px ${family}`, 'Массовка ABC'),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
  } catch {
    /* без веб-шрифта будет системный моноширинный */
  }
}

export interface RunningGame {
  game: Phaser.Game;
  restart(patch: Partial<SceneInit>): void;
  destroy(): void;
}

export async function bootGame(
  parent: HTMLElement,
  init: Omit<SceneInit, 'audio'> & { audio?: Audio; cfg?: Partial<GameConfig> },
): Promise<RunningGame> {
  // шрифт и пакеты тем — параллельно: первый кадр сразу в теме дубля, без мелькания парка
  await Promise.all([loadPixelFont(init.fontFamily), loadAllThemes()]);
  const audio = init.audio ?? getAudio();
  const data: SceneInit = { ...init, audio };
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: LOGICAL_W,
    height: LOGICAL_H,
    pixelArt: true,
    roundPixels: true,
    antialias: false,
    backgroundColor: PAL.ink,
    banner: false,
    audio: { noAudio: true },
    disableContextMenu: true,
    scale: { mode: Phaser.Scale.NONE, zoom: integerZoom(parent) },
    input: { touch: { capture: true } },
  });
  game.scene.add('game', GameScene, true, data);
  const fit = () => {
    game.scale.setZoom(integerZoom(parent));
  };
  const ro = new ResizeObserver(fit);
  ro.observe(parent);
  window.addEventListener('orientationchange', fit);
  return {
    game,
    restart(patch) {
      Object.assign(data, patch);
      game.scene.getScene('game')?.scene.restart(data);
    },
    destroy() {
      ro.disconnect();
      window.removeEventListener('orientationchange', fit);
      audio.stopMusic();
      game.destroy(true);
    },
  };
}
