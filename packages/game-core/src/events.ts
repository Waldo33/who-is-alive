import type { Rect } from './arena';

/** Направление взгляда: вниз, вверх, влево, вправо. */
export type Dir = 0 | 1 | 2 | 3;

/** Эмоции и реакции. Боты и живые игроки используют одни и те же. */
/** jab — удар в воздух (бой с тенью): эмоция толпы в изнанке темы «Офис» (themes.ts). */
export type ActKind = 'wave' | 'dance' | 'jump' | 'freeze' | 'startle' | 'stun' | 'jab';
export type CrowdKind = 'freeze' | 'jump' | 'dance';
export type EmoteKind = 'wave' | 'dance' | 'jump' | 'jab';

/**
 * События мира. Всё, что видно на поле, выражается ими; позиции каждый кадр не передаются.
 * Хост рассылает их (пакеты cmds/hit/star/zone… в разделе 13), клиенты и повтор воспроизводят.
 * Ни одно событие не говорит, кто из сущностей живой, кроме star_taken и mark,
 * которые и на поле выдают игрока.
 */
export type WorldEvent =
  | { t: 'move'; eid: number; path: number[]; at: number }
  | { t: 'stop'; eid: number; at: number }
  | { t: 'face'; eid: number; dir: Dir; at: number }
  | { t: 'act'; eid: number; kind: ActKind; dur: number; at: number; dx?: number; dy?: number }
  | { t: 'remove'; eid: number; cause: 'player' | 'bot'; at: number }
  | { t: 'mark'; eid: number; until: number; at: number }
  | { t: 'hit'; target: number; result: 'player' | 'bot'; x: number; y: number; attacker?: number; at: number }
  | { t: 'star_spawn'; id: number; x: number; y: number; at: number }
  | { t: 'star_taken'; id: number; eid: number; at: number }
  | { t: 'zone'; startAt: number; endAt: number; from: Rect; to: Rect; at: number }
  /** showAt..resumeAt — стоп-кадр (мир стоит), resumeAt..windowEnd — ещё можно нажать, но с опозданием. */
  | { t: 'crowd'; kind: CrowdKind; showAt: number; resumeAt: number; windowEnd: number; at: number }
  /** Изнанка темы (themes.ts › twist): включилась или выключилась. Ничего не говорит об игроках. */
  | { t: 'twist'; on: boolean; at: number };

export interface EntitySpawn {
  eid: number;
  x: number;
  y: number;
  dir: Dir;
}
