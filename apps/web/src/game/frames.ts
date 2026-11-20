import type { Entity } from '@kto/game-core';
import { F } from './sprites';
import type { Look } from './themes/types';

export interface CharFrame {
  frame: number;
  flip: boolean;
  yoff: number;
}

/**
 * Кадр персонажа по состоянию сущности — общий для игры, повтора и клипа.
 * acts — свои действия облика темы (themes/types.ts › Look.acts): поза F.COUNT + i.
 */
export function frameFor(e: Entity, t: number, acts?: Look['acts']): CharFrame {
  const base = e.dir === 0 ? F.D : e.dir === 1 ? F.U : F.S;
  const flip = e.dir === 2;
  if (e.act && t < e.actEnd) {
    const dt = t - e.actStart;
    const anim = acts?.[e.act];
    if (anim && anim.poses.length) {
      const n = Math.floor(dt / anim.ms);
      const i = n % anim.poses.length;
      return { frame: F.COUNT + anim.poses[i], flip: !!anim.flip && Math.floor(n / 4) % 2 === 1, yoff: anim.yoff?.[i] ?? 0 };
    }
    switch (e.act) {
      case 'freeze':
        return { frame: F.FREEZE, flip: false, yoff: 0 };
      case 'jump':
        return { frame: F.JUMP, flip: false, yoff: -Math.round(Math.sin(Math.PI * Math.min(1, dt / 600)) * 6) };
      case 'dance':
        return { frame: F.DANCE + (Math.floor(dt / 160) % 4), flip: false, yoff: 0 };
      case 'wave':
        return { frame: F.WAVE + [0, 1, 2, 1][Math.floor(dt / 110) % 4], flip: false, yoff: 0 };
      case 'startle':
        return { frame: F.STARTLE + (dt < 150 ? 0 : 1), flip: false, yoff: dt < 150 ? -2 : 0 };
      case 'stun':
        return { frame: F.STUN, flip: false, yoff: 0 };
      case 'jab': {
        // бой с тенью: стойка — удар, каждые две серии разворот
        const n = Math.floor(dt / 115);
        return { frame: n % 2 ? F.JAB : F.GUARD, flip: Math.floor(n / 4) % 2 === 1, yoff: 0 };
      }
    }
  }
  if (e.moving || e.pi < e.path.length) return { frame: base + 2 + (Math.floor(e.walk / 2.25) % 4), flip, yoff: 0 };
  const blink = (t + e.eid * 977) % 3400 < 130;
  return { frame: base + (blink ? 1 : 0), flip, yoff: 0 };
}
