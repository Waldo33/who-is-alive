import { z } from 'zod';
import type {
  AwardCard,
  EntitySpawn,
  GameConfig,
  MatchSummary,
  Phase,
  PlayerInfo,
  RoundSummary,
  WorldEvent,
  WorldSnapshot,
} from '@kto/game-core';

/**
 * Сетевой протокол (раздел 13). По сети идут только события мира и состояние фаз —
 * не позиции каждый кадр. Ни одно сообщение в общем канале не связывает игрока с сущностью
 * до разоблачения: это знает только хост и каждый игрок про себя (личный канал).
 */

/** Хост → все (канал room). */
export type RoomMsg =
  | { t: 'match_start'; players: PlayerInfo[]; cfg: Partial<GameConfig>; seed: number; hostId: string }
  /** mod — «Условия съёмки» дубля (mods.ts); у старых хостов нет — значит 0. */
  | { t: 'round'; round: number; theme: number; mod?: number; t0: number; spawns: EntitySpawn[] }
  /** Пакет событий мира, применённых хостом к моменту wt (время мира хоста после шага). */
  | { t: 'ev'; wt: number; run: boolean; ev: WorldEvent[] }
  /** Ключевой кадр: позиции всех сущностей в момент wt (×100, целые). */
  | { t: 'snap'; wt: number; p: [number, number, number][] }
  /** Фаза, таймеры, счёт. tl — сколько мс осталось в фазе на момент отправки; ppe — плановый конец игры (время мира). */
  | { t: 'st'; phase: Phase; round: number; theme: number; mod?: number; tl: number; ppe: number; scores: Record<string, number>; played: number; wt?: number }
  | { t: 'reveal'; summary: RoundSummary; awards: AwardCard[][] }
  | { t: 'match_end'; match: MatchSummary }
  | { t: 'pong_all'; hostNow: number }
  /**
   * Состав матча изменился посреди матча (сервер): за ушедшего играет ИИ (ai: true) или место ИИ занял
   * новый игрок (pid, имя). Чья сущность — не сообщается. Старые клиенты сообщение пропускают.
   */
  | { t: 'players'; players: PlayerInfo[] };

/** Что игрок знает о себе (личный канал). */
export interface MeMsg {
  eid: number;
  alive: boolean;
  attacksLeft: number;
  stars: number;
  stunUntil: number;
  autopilot: boolean;
  crowdAnswered: number;
  accused: number | null;
  /** Звёзды остальных: обезличенно, по убыванию. */
  others: number[];
  kills: number;
  /** «Хлопушка» вырезанного: сколько осталось и с какого времени мира можно. */
  clapsLeft?: number;
  clapAt?: number;
  /** Рассудок (тема с рассудком), целое; только в такой теме — старые клиенты поле не знают. */
  sanity?: number;
  /** Свои провинности перед Лешим (тема с рассудком). Только себе. */
  sins?: number;
  /** Свои кикиморы: [id, x, y, 1 — ещё рябь на воде]. Только тому, чьи они. */
  km?: [number, number, number, number][];
  /**
   * «Казино»: своё вращение на последней «Крутке» — [warnAt, исход (SLOT_OUTCOMES), три символа (SLOT_SYMBOLS)].
   * Только себе; приходит сразу, как лампы замигали, — барабаны крутятся у игрока без ожидания.
   */
  sl?: [number, number, number, number, number];
  /**
   * «Казино», три вращения: [warnAt, затем по каждому вращению исход и три символа] — 1 + 4·n чисел
   * (n меньше трёх, если вырезал череп). sl — первое вращение для вкладок прошлой версии.
   */
  s3?: number[];
  /** «Казино», камера: [сущность живого соперника, до какого времени мира подсвечен]. Только себе. */
  pk?: [number, number];
}

/** Хост → один игрок (канал private). */
export type PrivateMsg =
  | { t: 'me'; me: MeMsg }
  | { t: 'denied'; reason: 'no_attacks' | 'out_of_range' | 'stunned' | 'autopilot' | 'not_now' }
  | { t: 'pong'; c: number; wt: number }
  /** Итог своего удара (только нападавшему): цель и кто она — ему это и так покажет «поф». */
  | { t: 'atk'; target: number; result: 'player' | 'bot'; at: number }
  /**
   * Полный снимок для переподключения. summary/awards — итоги дубля (если он уже кончился: обвинение,
   * разоблачение, итоги), match — итоги матча: без них вернувшийся посреди разоблачения застревал
   * на старом экране. Старые хосты их не шлют.
   */
  | {
      t: 'resync';
      world: WorldSnapshot;
      round: number;
      theme: number;
      t0: number;
      me: MeMsg;
      st: Extract<RoomMsg, { t: 'st' }>;
      players: PlayerInfo[];
      cfg: Partial<GameConfig>;
      hostId: string;
      summary?: RoundSummary;
      awards?: AwardCard[][];
      match?: MatchSummary;
    };

/** Игрок → хост (канал host). Хост проверяет каждое сообщение схемой. */
export const IntentMsg = z.discriminatedUnion('k', [
  z.object({ k: z.literal('move'), x: z.number().int().min(0).max(180), y: z.number().int().min(0).max(260) }),
  z.object({ k: z.literal('stop') }),
  z.object({ k: z.literal('emote'), kind: z.enum(['wave', 'dance', 'jump', 'jab']).optional() }),
  z.object({ k: z.literal('crowd'), kind: z.enum(['freeze', 'jump', 'dance']), wt: z.number().optional(), at: z.number().int().optional() }),
  z.object({ k: z.literal('attack'), eid: z.number().int(), wt: z.number().optional() }),
  z.object({ k: z.literal('clap'), kind: z.enum(['freeze', 'jump', 'dance']) }),
  z.object({ k: z.literal('autopilot'), on: z.boolean() }),
  z.object({ k: z.literal('accuse'), eid: z.number().int() }),
  z.object({ k: z.literal('slot'), pull: z.boolean() }),
  z.object({ k: z.literal('next') }),
  z.object({ k: z.literal('rematch') }),
]);
export type IntentMsg = z.infer<typeof IntentMsg>;

export const GuestMsg = z.discriminatedUnion('t', [
  z.object({ t: z.literal('i'), i: IntentMsg }),
  z.object({ t: z.literal('ping'), c: z.number() }),
  z.object({ t: z.literal('resync') }),
]);
export type GuestMsg = z.infer<typeof GuestMsg>;

/** Округление координат для ключевых кадров. */
export const SNAP_SCALE = 100;
