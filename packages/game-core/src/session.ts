import type { ArenaDef } from './arena';
import type { AwardCard } from './awards';
import type { GameConfig } from './config';
import { AiPlayer } from './ai';
import { MatchSim as MatchSimCtor } from './match';
import type { Intent, MatchSim, MatchSummary, Notice, Phase, PlayerInfo, RoundSummary } from './match';
import type { World } from './world';

/** Что клиент знает о себе. О других игроках клиент не знает ничего, кроме видимого на поле. */
export interface MeView {
  eid: number;
  alive: boolean;
  attacksLeft: number;
  stars: number;
  stunUntil: number;
  autopilot: boolean;
  /** warnAt команды «Море волнуется», на которую уже ответил (-1 — ни на какую). */
  crowdAnswered: number;
  accused: number | null;
  /** «Хлопушка» вырезанного: сколько осталось и с какого времени мира можно. */
  clapsLeft: number;
  clapAt: number;
}

/**
 * Можно ли сейчас начать команду «Море волнуется» — по тому, что видно клиенту
 * (хост дополнительно ждёт тишины после смены облика темы и может отказать).
 */
export function crowdCanStartView(world: World, cfg: GameConfig, plannedPlayEnd: number, t = world.time): boolean {
  const c = world.crowd;
  if (c && t <= c.windowEnd + 2000) return false;
  return !world.zone && t < plannedPlayEnd - cfg.zoneStartBeforeEndSec * 1000 - 3000;
}

/**
 * Всё, что нужно экрану игры. Одинаково для песочницы (поверх локальной симуляции),
 * хоста и гостя (только из событий хоста). Здесь нет сопоставления «игрок → сущность»:
 * оно появляется только в `summary.reveal` после обвинения.
 */
export interface ClientView {
  readonly selfPid: string;
  readonly hostPid: string;
  readonly cfg: GameConfig;
  readonly arena: ArenaDef;
  readonly world: World;
  readonly players: readonly PlayerInfo[];
  readonly phase: Phase;
  readonly round: number;
  readonly theme: number;
  /** «Условия съёмки» дубля (индекс в ROUND_MODS, 0 — обычный). */
  readonly mod: number;
  /** Монотонное время клиента, мс (для анимаций фаз). */
  readonly now: number;
  readonly scores: Readonly<Record<string, number>>;
  /** Итоги раунда: появляются в фазе reveal. */
  readonly summary: RoundSummary | null;
  readonly match: MatchSummary | null;
  /** Сколько раундов сыграно в этом матче (для текста «Поделиться»). */
  readonly roundsPlayed: number;
  /** Свои выбивания за матч. */
  readonly myMatchKills: number;
  readonly roundAwards: readonly AwardCard[][];
  me(): MeView | undefined;
  /** Звёзды других игроков, обезличенные, по убыванию. */
  otherStars(): number[];
  info(pid: string): PlayerInfo | undefined;
  timeLeft(): number;
  crowdWindowOpen(t?: number): boolean;
  /** Можно ли подать «Хлопушку» сейчас (если она есть у вырезанного). */
  crowdCanStart(t?: number): boolean;
}

export interface ClientSession extends ClientView {
  intent(it: Intent): void;
  /** Один фиксированный шаг 50 мс. */
  tick(): void;
  /** Забрать накопившиеся уведомления (фазы, очки, отказы — только свои). */
  drainNotices(): Notice[];
  /** Подписка на события мира (звуки, эффекты). */
  onWorldEvent(fn: Parameters<World['listeners']['push']>[0]): void;
  dispose(): void;
}

/** Песочница: вся симуляция на этом устройстве, остальные игроки — ИИ. */
export class LocalSession implements ClientSession {
  constructor(
    readonly sim: MatchSim,
    readonly selfPid: string,
    aiSeed: number,
    opts: { ai?: boolean } = {},
  ) {
    if (opts.ai !== false) {
      sim.players
        .filter((p) => p.pid !== selfPid)
        .forEach((p, i) => sim.addAgent(new AiPlayer(p.pid, aiSeed + i * 7919 + 1)));
    }
  }

  get hostPid() { return this.sim.hostPid; }
  get cfg() { return this.sim.cfg; }
  get arena() { return this.sim.arena; }
  get world() { return this.sim.world; }
  get players() { return this.sim.players; }
  get phase() { return this.sim.phase; }
  get round() { return this.sim.round; }
  get theme() { return this.sim.theme; }
  get mod() { return this.sim.mod; }
  get now() { return this.sim.now; }
  get scores() { return this.sim.scores; }
  get summary() { return this.sim.phase === 'accuse' ? null : this.sim.summary; }
  get match() { return this.sim.match; }
  get roundsPlayed() { return this.sim.roundAwards.length; }
  get myMatchKills() { return this.sim.matchKills[this.selfPid] ?? 0; }
  get roundAwards() { return this.sim.roundAwards; }

  me(): MeView | undefined {
    const p = this.sim.playerRound(this.selfPid);
    if (!p) return undefined;
    return {
      eid: p.eid,
      alive: p.alive,
      attacksLeft: p.attacksLeft,
      stars: p.stars,
      stunUntil: p.stunUntil,
      autopilot: p.autopilot,
      crowdAnswered: p.crowdAnswered,
      accused: p.accused,
      clapsLeft: p.clapsLeft,
      clapAt: p.clapAt,
    };
  }

  otherStars(): number[] {
    return this.sim.pr.filter((p) => p.pid !== this.selfPid).map((p) => p.stars).sort((a, b) => b - a);
  }

  info(pid: string) { return this.sim.info(pid); }
  timeLeft() { return this.sim.timeLeft(); }
  crowdWindowOpen(t?: number) { return this.sim.crowdWindowOpen(t); }
  crowdCanStart(t?: number) { return this.sim.crowdCanStart(t); }

  intent(it: Intent): void {
    this.sim.intent(this.selfPid, it);
  }

  tick(): void {
    this.sim.tick();
  }

  drainNotices(): Notice[] {
    const list = this.sim.notices;
    this.sim.notices = [];
    return list.filter((n) => (n.t !== 'denied' && n.t !== 'attack') || n.pid === this.selfPid);
  }

  onWorldEvent(fn: Parameters<World['listeners']['push']>[0]): void {
    this.sim.world.listeners.push(fn);
  }

  dispose(): void {
    this.sim.world.listeners.length = 0;
  }
}

/** Песочница одной строкой: игрок `selfPid` и ИИ на остальных местах. */
export function createLocalSession(cfg: GameConfig, players: PlayerInfo[], seed: number, selfPid: string): LocalSession {
  return new LocalSession(new MatchSimCtor(cfg, players, seed, selfPid), selfPid, seed);
}
