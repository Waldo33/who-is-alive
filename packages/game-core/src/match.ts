import type { ArenaDef, Rect } from './arena';
import { clampToRect, plazaArena, rectContains, shrinkRect } from './arena';
import type { AwardCard, RoundStats } from './awards';
import { pickMatchAwards, pickRoundAwards } from './awards';
import { BotBrain, CROWD_ACT, crowdActDur, crowdHoldDur, crowdJitter, emoteDur, planPath } from './bots';
import type { GameConfig } from './config';
import { TICK_MS, crowdPauseMs, revealMs } from './config';
import type { ActKind, CrowdKind, Dir, EmoteKind, EntitySpawn, WorldEvent } from './events';

import { NavGrid } from './nav';
import { Rng } from './rng';
import { LESHY_HUNT_SEC, fireLevel, leshySpot, leshyVisits, nightLevel, playLenSec, sanityDrain } from './sanity';
import { ROTATION_THEMES, THEME_COUNT, THEME_RULES, canFight, fightAttacks, hasBoss, hasSanity, killerExposed, themeRules, twistEmote } from './themes';
import { ROUND_MODS, roundMod } from './mods';
import { World } from './world';
import { BOSS_SPEED_MUL, bossDoor, bossFightLeft, bossLooking, bossWatching, inBossCone, pathInBossCone } from './boss';

/** «Купальская ночь» — тема-финал при матч-боле (nightFinale). */
const NIGHT_THEME = THEME_RULES.findIndex((r) => r.id === 'kupala');
const EMOTES: EmoteKind[] = ['wave', 'dance', 'jump'];

export interface PlayerInfo {
  pid: string;
  name: string;
  /** 0 красный, 1 синий, 2 жёлтый, 3 зелёный */
  color: number;
  /**
   * ИИ-актёр: место в онлайн-комнате, которое добрал режиссёр (за него играет AiPlayer у хоста).
   * Что игрок — ИИ, видно по имени и в итогах; какая сущность его — так же скрыто, как у людей.
   */
  ai?: boolean;
}

export type Phase = 'countdown' | 'play' | 'accuse' | 'reveal' | 'results' | 'match_end';

export type Intent =
  | { k: 'move'; x: number; y: number }
  | { k: 'stop' }
  /** kind выбирает сам игрок (гость показывает эмоцию сразу, не дожидаясь хоста); без него — случайно. */
  | { k: 'emote'; kind?: EmoteKind }
  /** wt — время мира на экране игрока в момент нажатия (компенсация задержки сети). */
  /**
   * at — когда начать жест, нажатый в стоп-кадре («вместе с толпой»): гость выбирает момент сам,
   * в том же разбросе, что у ботов, и показывает жест у себя ровно тогда же. Иначе персонаж у гостя
   * останавливался бы раньше или позже, чем у хоста, и потом съезжал бы на место посреди жеста.
   */
  | { k: 'crowd'; kind: CrowdKind; wt?: number; at?: number }
  /** «Хлопушка»: вырезанный игрок подаёт команду толпе. */
  | { k: 'clap'; kind: CrowdKind }
  | { k: 'attack'; eid: number; wt?: number }
  | { k: 'autopilot'; on: boolean }
  | { k: 'accuse'; eid: number }
  | { k: 'next' }
  | { k: 'rematch' };

export interface PlayerRound {
  pid: string;
  eid: number;
  alive: boolean;
  attacksLeft: number;
  stars: number;
  stunUntil: number;
  autopilot: boolean;
  diedAt: number | null;
  kills: number;
  killTimes: number[];
  botHits: number;
  accused: number | null;
  accusedAsGhost: boolean;
  crowdAnswered: number;
  /** warnAt прихода Лешего, при котором игрок шевельнулся, пока тот смотрел (leshySees). */
  leshyMoved: number;
  /** Выговоров от шефа за дубль (офис): каждый — минус cfg.bossPenalty ударов на подвал. */
  reprimands: number;
  /** Нажал во время стоп-кадра: команда выполнится в этот момент вместе с толпой. */
  crowdQueued: { kind: CrowdKind; at: number } | null;
  /** Какой жест выбрал на последнюю команду (для «Жёсткого дубля» и «Толпа решает»). */
  crowdPick: CrowdKind | null;
  /** Нажал уже после стоп-кадра — опоздал (это видно на поле). */
  crowdLate: boolean;
  /** «Хлопушка» вырезанного: сколько осталось и когда можно снова (время мира). */
  clapsLeft: number;
  clapAt: number;
  /** Рассудок (sanity.ts), 0–100; в теме без рассудка не меняется. */
  sanity: number;
  /** Самый низкий рассудок за дубль (награды). */
  sanityMin: number;
  /** Свои кикиморы (рассудок ниже порога «Кошмар»): видит только сам игрок, id отрицательные. */
  kiki: Kiki[];
  /** Раньше этого времени мира новая кикимора не появится. */
  kikiNextAt: number;
  /** «Факел!» вовремя: до этого времени мира в руке горит факел (рассудок растёт, кикиморы не подходят). */
  torchUntil: number;
  /** Провинности «Купальской ночи»: сколько раз не повторил жест — Леший помнит (знает только сам игрок). */
  sins: number;
}

/** Кикимора — кошмар одного игрока: появляется из воды (`at` — когда вылезет), идёт к нему, касание — вырезан. */
export interface Kiki {
  id: number;
  x: number;
  y: number;
  /** С какого времени мира ходит (до — рябь на воде). */
  at: number;
  /** Сколько ударов ещё выдержит. */
  hp: number;
}

export interface PointsLine {
  kill: number;
  survive: number;
  stars: number;
  accuse: number;
  /** Сколько очков украли угадавшие тебя (≤ 0). Старые записи — без поля. */
  stolen?: number;
  /** «Награда за голову»: прибавка за выбитого или угаданного лидера матча. */
  bounty?: number;
  total: number;
}

export interface RoundSummary {
  round: number;
  endReason: 'time' | 'stars' | 'last_alive';
  starWinner: string | null;
  reveal: { pid: string; eid: number; alive: boolean; x: number; y: number }[];
  accusations: { pid: string; eid: number; correct: boolean }[];
  points: Record<string, PointsLine>;
  awards: AwardCard[];
  replayFrom: number;
  replayTo: number;
  /** Кто кого выбил (сущности). После разоблачения это уже не секрет — для повтора и клипа. */
  kills?: { by: number; victim: number; at: number }[];
}

export interface MatchSummary {
  winners: string[];
  tooAlive: boolean;
  scores: Record<string, number>;
  awards: AwardCard[];
}

export type Notice =
  /** mod — «Условия съёмки» дубля (mods.ts), 0 — обычный. */
  | { t: 'round_start'; round: number; theme: number; mod: number }
  | { t: 'phase'; phase: Phase; at: number }
  | { t: 'score'; pid: string; delta: number; reason: keyof Omit<PointsLine, 'total'> }
  | { t: 'denied'; pid: string; reason: 'no_attacks' | 'out_of_range' | 'stunned' | 'autopilot' | 'not_now' }
  /** Итог удара — только для того, кто бил (по сети уходит ему лично, чтобы показать результат без задержки показа мира). */
  | { t: 'attack'; pid: string; target: number; result: 'player' | 'bot'; at: number };

/**
 * «Награда за голову»: лидер матча на начало дубля — единственный, у кого больше всех очков (не 0).
 * Имя лидера видят все, какой он человечек — нет. Считается из счёта, поэтому одинаково у хоста и гостей.
 */
export function bountyLeader(scores: Record<string, number>): string | null {
  const list = Object.entries(scores);
  if (!list.length) return null;
  const top = Math.max(...list.map(([, v]) => v));
  const leaders = list.filter(([, v]) => v === top);
  return top > 0 && leaders.length === 1 ? leaders[0][0] : null;
}

/** Наблюдатель-ИИ (песочница и безголовая симуляция) получает только то, что видно на поле. */
export interface AiAgent {
  pid: string;
  onRound(sim: MatchSim, eid: number): void;
  update(sim: MatchSim): void;
}

/**
 * Копия значения, где pid `from` заменён на `to` — и в строках, и в ключах объектов
 * (итоги дублей, награды, записи для фильма). pid уникальны и ни с чем не совпадают.
 */
export function renamePid<T>(v: T, from: string, to: string): T {
  const walk = (x: unknown): unknown => {
    if (x === from) return to;
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(x)) o[k === from ? to : k] = walk(val);
      return o;
    }
    return x;
  };
  return walk(v) as T;
}

/** Насколько поздно может прийти по сети нажатие, чтобы его засчитали по времени экрана игрока. */
export const LAG_GRACE_MS = 600;

/**
 * Авторитетная симуляция матча. Работает у хоста; в песочнице — на единственном устройстве.
 * Все решения (боты, удары, звёзды, фазы) принимаются здесь, наружу уходят только события мира.
 */
export class MatchSim {
  readonly arena: ArenaDef;
  readonly nav: NavGrid;
  readonly world: World;
  readonly rng: Rng;
  bots!: BotBrain;

  now = 0;
  phase: Phase = 'countdown';
  phaseEndsAt = 0;
  round = 0;
  theme = 0;
  /** «Условия съёмки» текущего дубля (индекс в ROUND_MODS). */
  mod = 0;
  /** Порядок тем в матче — свой в каждом матче и реванше. */
  themeOrder: number[] = [];
  /** В этом матче (реванше) ночь станет финалом при матч-боле — решается при тасовке тем. */
  nightFinale = false;
  /** Свой генератор для решения о финале: основной `rng` не трогаем, чтобы матчи по зерну не менялись. */
  private readonly finaleRng: Rng;
  scores: Record<string, number> = {};
  matchKills: Record<string, number> = {};
  roundAwards: AwardCard[][] = [];
  pr: PlayerRound[] = [];
  summary: RoundSummary | null = null;
  match: MatchSummary | null = null;
  notices: Notice[] = [];
  /**
   * Где были сущности последние ~0,7 с (по шагам мира). Игрок по сети видит мир с опозданием,
   * поэтому удар проверяется и по тому месту, где цель была на его экране («перемотка», как в шутерах).
   */
  private posHist: { t: number; pos: Map<number, [number, number]> }[] = [];
  /** Выбивания раунда: кто кого (сущности) — уходят в итоги раунда. */
  private roundKills: { by: number; victim: number; at: number }[] = [];
  /** Лидер, за голову которого в этом дубле награда (bountyLeader на начало дубля). */
  bountyPid: string | null = null;
  agents: AiAgent[] = [];

  playStart = 0;
  private nextTwistAt = Infinity;
  private lastTwistAt = -Infinity;
  private twistLeft = 0;
  /** Тема-драка: запас ударов на дубль уже выдан (первое включение изнанки). */
  private fightArmed = false;
  /** Шеф в офисе (boss.ts): своё зерно — обход не сдвигает остальной матч. */
  private bossRng: Rng | null = null;
  /** Раньше этого времени шеф ничего нового не начинает. */
  private bossNextAt = 0;
  /** Следующий шаг обхода — взгляд (иначе — пройтись). */
  private bossLookNext = false;
  /** Кого шеф уже поймал за этот взгляд. */
  private bossCaught = new Set<number>();
  /** Когда решить про ложную тревогу (конец взгляда), 0 — не надо. */
  private bossPointAt = 0;
  /** Шеф идёт за спину кому-то — дойдёт и постоит. */
  private bossLinger = false;
  plannedPlayEnd = 0;
  playEnd = 0;
  endReason: RoundSummary['endReason'] = 'time';
  starWinner: string | null = null;
  nextCrowdAt = 0;
  /** Следующая команда — «Толпа решает» (жест большинства известен заранее: толпа «разогревается»). */
  private nextVote: CrowdKind | null = null;
  /** Следующий «не названный» жест загадал вырезанный («Хлопушка»). */
  private nextGhost = false;
  /** Жест следующей обычной команды задан сценарием (обучение), иначе — случайный. */
  private forcedKind: CrowdKind | null = null;
  private moodOn = false;
  private crowdCount = 0;
  /** Леший в этом дубле уже прошёл (тема с рассудком). */
  /** Какой приход Лешего следующий (sanity.ts › leshyVisits). */
  private leshyIdx = 0;
  /** warnAt команды Лешего: кто на ней шевельнулся — того он забирает (в детском режиме — нет). */
  private leshyWarn = -1;
  private hardChecked = -1;
  crowdShowTimes: number[] = [];
  zoneStarted = false;
  starSpawnQueue: number[] = [];
  starSeq = 1;
  neighbors = new Map<string, { a: string; b: string; cur: number; max: number; hit: boolean }>();
  private intents: { pid: string; it: Intent }[] = [];

  constructor(
    readonly cfg: GameConfig,
    readonly players: PlayerInfo[],
    seed: number,
    /** Режиссёр: только он жмёт «Дальше» и «Ещё дубль». На сервере меняется, если режиссёр ушёл. */
    public hostPid: string = players[0]?.pid ?? '',
  ) {
    this.arena = plazaArena(cfg.arenaWidth, cfg.arenaHeight);
    this.nav = new NavGrid(this.arena, cfg.navCellSize);
    this.world = new World(this.nav, cfg.entitySpeed);
    this.rng = new Rng(seed);
    this.finaleRng = new Rng(seed ^ 0x4b55504c);
    this.shuffleThemes();
    for (const p of players) {
      this.scores[p.pid] = 0;
      this.matchKills[p.pid] = 0;
    }
    this.startRound();
  }

  // ───────────── публичный API ─────────────

  intent(pid: string, it: Intent): void {
    this.intents.push({ pid, it });
  }

  playerRound(pid: string): PlayerRound | undefined {
    return this.pr.find((p) => p.pid === pid);
  }

  playerByEid(eid: number): PlayerRound | undefined {
    return this.pr.find((p) => p.eid === eid);
  }

  info(pid: string): PlayerInfo | undefined {
    return this.players.find((p) => p.pid === pid);
  }

  zoneFinal(): Rect | null {
    return this.world.zone ? this.world.zone.to : null;
  }

  crowdWindowOpen(t = this.world.time): boolean {
    const c = this.world.crowd;
    return !!c && t >= c.showAt && t <= c.windowEnd;
  }

  /** Сколько мс осталось в текущей фазе (для таймера в шапке). */
  timeLeft(): number {
    if (this.phase === 'play') {
      const c = this.world.crowd;
      const pause = c && this.world.isFrozen() ? c.resumeAt - this.world.time : 0;
      return Math.max(0, this.plannedPlayEnd - this.world.time - pause);
    }
    return Math.max(0, this.phaseEndsAt - this.now);
  }

  tick(): void {
    this.now += TICK_MS;
    this.processIntents();
    switch (this.phase) {
      case 'countdown':
        if (this.now >= this.phaseEndsAt) this.beginPlay();
        else {
          this.bots.update(this.world.time, null, null, false);
          this.world.step();
        }
        break;
      case 'play':
        this.playTick();
        break;
      case 'accuse':
        // «Кто ещё живой?»: мир стоит, живые ставят свою метку (вырезанные свою уже поставили по ходу дубля)
        for (const a of this.agents) a.update(this);
        if (this.now >= this.phaseEndsAt) this.finishRound();
        break;
      case 'reveal':
        if (this.now >= this.phaseEndsAt) this.setPhase('results', this.cfg.autoNextSec * 1000);
        break;
      case 'results':
        if (this.now >= this.phaseEndsAt) this.advanceAfterResults();
        break;
      case 'match_end':
        break;
    }
  }

  // ───────────── раунд ─────────────

  private setPhase(p: Phase, dur: number): void {
    this.phase = p;
    this.phaseEndsAt = this.now + dur;
    this.notices.push({ t: 'phase', phase: p, at: this.now });
  }

  private startRound(): void {
    this.round++;
    this.theme = this.themeOrder[(this.round - 1) % this.themeOrder.length];
    if (this.nightFinale && this.round > 1 && Math.max(...Object.values(this.scores)) >= this.cfg.nightFinaleScore) this.theme = NIGHT_THEME;
    this.pickMod();
    this.bountyPid = bountyLeader(this.scores);
    this.summary = null;
    const rng = this.rng;
    // случайные id, новые каждый раунд
    const ids = new Set<number>();
    while (ids.size < this.cfg.entitiesTotal) ids.add(rng.int(100, 9999));
    const eids = rng.shuffle([...ids]);
    const spawns: EntitySpawn[] = [];
    const taken: { x: number; y: number }[] = [];
    let guard = 0;
    while (spawns.length < eids.length && guard++ < 10000) {
      const c = rng.int(0, this.nav.cols - 1);
      const r = rng.int(0, this.nav.rows - 1);
      const i = this.nav.idx(c, r);
      if (!this.nav.walkable(i)) continue;
      const x = this.nav.cx(i);
      const y = this.nav.cy(i);
      if (taken.some((t) => Math.abs(t.x - x) < 10 && Math.abs(t.y - y) < 10)) continue;
      taken.push({ x, y });
      spawns.push({ eid: eids[spawns.length], x, y, dir: rng.int(0, 3) as Dir });
    }
    const t0 = Math.ceil(this.world.time / 1000) * 1000 + 1000;
    this.world.init(spawns, t0);
    this.posHist = [];
    this.roundKills = [];
    const playerEids = rng.shuffle(spawns.map((s) => s.eid)).slice(0, this.players.length);
    this.pr = this.players.map((p, i) => ({
      pid: p.pid,
      eid: playerEids[i],
      alive: true,
      // в теме-драке (офис) ударов нет до первого подвала — там выдаётся запас на весь дубль
      attacksLeft: fightAttacks(this.theme) ? 0 : roundMod(this.mod) === 'onehit' ? 1 : this.cfg.attacksPerRound,
      stars: 0,
      stunUntil: 0,
      autopilot: false,
      diedAt: null,
      kills: 0,
      killTimes: [],
      botHits: 0,
      accused: null,
      accusedAsGhost: false,
      crowdAnswered: -1,
      leshyMoved: -1,
      reprimands: 0,
      crowdQueued: null,
      crowdPick: null,
      crowdLate: false,
      clapsLeft: this.cfg.ghostClaps,
      clapAt: 0,
      sanity: this.cfg.sanityStart,
      sanityMin: this.cfg.sanityStart,
      kiki: [],
      kikiNextAt: 0,
      torchUntil: 0,
      sins: 0,
    }));
    this.bots = new BotBrain(this.world, this.cfg, new Rng(rng.fork()), (ev) => this.emit(ev), themeRules(this.theme).twist);
    const pset = new Set(playerEids);
    // с «Условиями съёмки» отсчёт на 2 с дольше — успеть прочитать правило дубля
    const countdownMs = (this.cfg.countdownSec + (this.mod ? 2 : 0)) * 1000;
    for (const s of spawns) if (!pset.has(s.eid)) this.bots.add(s.eid, t0 + countdownMs);
    this.crowdShowTimes = [];
    this.zoneStarted = false;
    this.starSpawnQueue = [];
    this.starTouched.clear();
    this.neighbors.clear();
    this.endReason = 'time';
    this.starWinner = null;
    this.notices.push({ t: 'round_start', round: this.round, theme: this.theme, mod: this.mod });
    this.setPhase('countdown', countdownMs);
    for (const a of this.agents) a.onRound(this, this.playerRound(a.pid)!.eid);
  }

  /** «Условия съёмки»: первый дубль матча обычный, дальше — случайное правило (не два одинаковых подряд). */
  private pickMod(): void {
    const prev = this.mod;
    this.mod = 0;
    if (this.round <= 1 || !this.cfg.roundMods || !this.rng.chance(this.cfg.roundModChance)) return;
    // «Купальская ночь» — свой режим: условий съёмки в ней нет (случайность берём всё равно — ход матча тот же)
    if (hasSanity(this.theme)) return;
    // «Один удар» в офисе не к месту: там удары и так выдаёт только подвал
    const pool = ROUND_MODS.map((_, i) => i).filter((i) => i > 0 && i !== prev && !(fightAttacks(this.theme) && ROUND_MODS[i] === 'onehit'));
    this.mod = this.rng.pick(pool);
  }

  /** Подключить ИИ-агентов (песочница/симуляция; на сервере — и посреди матча, вместо ушедшего игрока). */
  addAgent(a: AiAgent): void {
    if (this.agents.some((x) => x.pid === a.pid)) return;
    this.agents.push(a);
    const p = this.playerRound(a.pid);
    if (!p) return;
    // игрок ушёл на автопилоте — дальше ведёт ИИ (на автопилоте намерения не принимаются)
    if (p.autopilot) {
      p.autopilot = false;
      this.bots.remove(p.eid);
      if (p.alive) this.emit({ t: 'stop', eid: p.eid, at: this.world.time });
    }
    a.onRound(this, p.eid);
  }

  /** Убрать ИИ с места (вернулся игрок или место занял новый). */
  removeAgent(pid: string): void {
    this.agents = this.agents.filter((a) => a.pid !== pid);
    this.intents = this.intents.filter((x) => x.pid !== pid);
  }

  /**
   * Место в матче переходит к другому (сервер: новый игрок занял место ИИ посреди матча).
   * Очки, выбивания, персонаж дубля (живой или вырезанный) и история дублей остаются за местом —
   * меняется только, чьё оно: pid, имя, ИИ ли. Цвет — тот же (по нему игрока узнают в итогах).
   */
  replacePlayer(oldPid: string, info: PlayerInfo): boolean {
    const i = this.players.findIndex((p) => p.pid === oldPid);
    if (i < 0 || (info.pid !== oldPid && this.info(info.pid))) return false;
    this.removeAgent(oldPid);
    this.players[i] = { ...info, color: this.players[i].color };
    const to = info.pid;
    if (to === oldPid) return true;
    for (const r of [this.scores, this.matchKills]) {
      r[to] = r[oldPid] ?? 0;
      delete r[oldPid];
    }
    for (const p of this.pr) if (p.pid === oldPid) p.pid = to;
    if (this.bountyPid === oldPid) this.bountyPid = to;
    if (this.starWinner === oldPid) this.starWinner = to;
    if (this.hostPid === oldPid) this.hostPid = to;
    const nb = [...this.neighbors.values()];
    this.neighbors.clear();
    for (const n of nb) {
      if (n.a === oldPid) n.a = to;
      if (n.b === oldPid) n.b = to;
      this.neighbors.set([n.a, n.b].sort().join('|'), n);
    }
    if (this.summary) this.summary = renamePid(this.summary, oldPid, to);
    this.roundAwards = renamePid(this.roundAwards, oldPid, to);
    if (this.match) this.match = renamePid(this.match, oldPid, to);
    return true;
  }

  private beginPlay(): void {
    this.setPhase('play', playLenSec(this.cfg, this.theme) * 1000);
    this.playStart = this.world.time;
    this.plannedPlayEnd = this.playStart + playLenSec(this.cfg, this.theme) * 1000;
    this.crowdCount = 0;
    this.leshyIdx = 0;
    this.leshyWarn = -1;
    this.hardChecked = -1;
    this.scheduleCrowd(this.playStart);
    // звёзды выходят по одной: сначала starsAtStart, остальные — с шагом появления
    const first = Math.min(this.maxStars(), this.cfg.starsAtStart + (roundMod(this.mod) === 'stars' ? 1 : 0));
    for (let i = 0; i < first; i++) this.spawnStar();
    for (let i = 1; i <= this.maxStars() - first; i++) this.queueStar(this.playStart + i * this.starRespawnMs());
    // изнанка темы: расписание на дубль (зерно — общее, поэтому повтор совпадает)
    const tw = themeRules(this.theme).twist;
    this.twistLeft = tw ? tw.max : 0;
    this.fightArmed = false;
    // шеф: выходит на «Мотор!», обход — через секунду-другую
    this.bossRng = hasBoss(this.theme) ? new Rng(this.rng.fork()) : null;
    this.bossCaught.clear();
    this.bossLookNext = false;
    this.bossPointAt = 0;
    this.bossLinger = false;
    if (this.bossRng) {
      const p0 = this.bossRng.pick(this.arena.interest);
      this.emit({ t: 'boss', act: 'in', x: p0.x, y: p0.y, at: this.world.time });
      this.bossNextAt = this.playStart + this.bossRng.range(800, 2000);
    }
    this.lastTwistAt = -Infinity;
    this.nextTwistAt = tw ? this.playStart + this.rng.range(tw.firstSec[0], tw.firstSec[1]) * 1000 : Infinity;
  }

  /**
   * Толпа выполняет команду «Море волнуется»: от стоп-кадра до конца последней позы
   * (опоздавшие жмут до windowEnd, поза длится crowdActDur). Ограничено сверху на случай
   * совпавших с командой эмоций того же вида.
   */
  crowdBusy(t = this.world.time): boolean {
    const c = this.world.crowd;
    if (!c || t < c.showAt) return false;
    if (t <= c.windowEnd) return true;
    if (t > Math.max(c.windowEnd, c.watchUntil ?? 0) + crowdActDur(this.cfg, c.kind) + 1500) return false;
    const act = CROWD_ACT[c.kind];
    return this.world.entities.some((e) => e.alive && e.act === act && e.actEnd > t);
  }

  /**
   * Включить или выключить изнанку темы, когда подошло время: не в стоп-кадре и не посреди
   * позы команды (тогда — сразу после неё), новых включений нет во время сужения.
   */
  private twistTick(t: number): void {
    const tw = themeRules(this.theme).twist;
    if (!tw || t < this.nextTwistAt || this.crowdBusy(t)) return;
    const on = !this.world.twist;
    if (on && (this.twistLeft <= 0 || this.zoneStarted)) {
      this.nextTwistAt = Infinity;
      return;
    }
    // офис: подвал начинается, только когда шеф дошёл до двери (bossTick ведёт его туда заранее)
    if (on && this.bossRng && !this.bossAtDoor()) return;
    const [a, b] = on ? tw.onSec : tw.gapSec;
    const next = t + this.rng.range(a, b) * 1000;
    this.emit({ t: 'twist', on, at: t });
    if (this.bossRng) {
      if (on) this.emit({ t: 'boss', act: 'out', back: Math.round(next), at: t });
      else this.bossBack(t);
    }
    this.lastTwistAt = t;
    if (on) this.twistLeft--;
    // подвал: драться можно — запас ударов на весь дубль выдаётся один раз (и вырезанным — не важно, они не бьют)
    const fight = fightAttacks(this.theme);
    if (on && fight && !this.fightArmed) {
      this.fightArmed = true;
      for (const p of this.pr) p.attacksLeft = p.reprimands >= this.cfg.bossZeroAt ? 0 : Math.max(0, fight - p.reprimands * this.cfg.bossPenalty);
    }
    this.nextTwistAt = next;
  }

  /**
   * Интервал до следующей команды: сжимается по ходу дубля (нарастание) от crowdCmdIntervalSec
   * к crowdCmdIntervalEndSec к началу сужения; «Шквал команд» — вдвое чаще.
   */
  private crowdInterval(from: number): number {
    const cfg = this.cfg;
    const span = (cfg.roundSec - cfg.zoneStartBeforeEndSec) * 1000;
    const k = Math.min(1, Math.max(0, (from - this.playStart) / span));
    const [a0, b0] = cfg.crowdCmdIntervalSec;
    const [a1, b1] = cfg.crowdCmdIntervalEndSec;
    // «Купальская ночь»: обычные команды реже — главное в ночи Леший, жесты не должны его заслонять
    const mul = (roundMod(this.mod) === 'rush' ? 0.5 : 1) * (hasSanity(this.theme) ? cfg.nightCrowdMul : 1);
    const sec = this.rng.range(a0 + (a1 - a0) * k, b0 + (b1 - b0) * k) * mul;
    return Math.round(Math.max(3, sec) * 20) * 50;
  }

  /** Назначить следующую команду и решить, будет ли она «Толпа решает» (со 2-го дубля, не первой в дубле). */
  private scheduleCrowd(from: number): void {
    this.nextCrowdAt = from + this.crowdInterval(from);
    this.moodOn = false;
    this.nextVote = null;
    this.nextGhost = false;
    const chance = this.cfg.crowdVoteChance * (roundMod(this.mod) === 'rush' ? 1.5 : 1);
    if (this.round >= 2 && this.crowdCount > 0 && this.rng.chance(chance)) this.nextVote = this.rng.pick<CrowdKind>(['freeze', 'jump', 'dance']);
  }

  /**
   * Когда станет командой «Хлопушка», поданная в момент t: не раньше полного разогрева толпы
   * (crowdMoodLeadMs — подсказка живым) и не во время чужой команды или тишины после смены облика.
   * Раньше «Хлопушку» принимали только в редкие окна между командами (к концу дубля они идут
   * каждые 5–7 с и занимают по 4,5 с) — кнопки у вырезанного почти всегда были серыми. Теперь жест
   * встаёт в очередь и заменяет ближайшую команду. null — команд в этом дубле больше не будет (сужение).
   */
  ghostCrowdAt(t = this.world.time): number | null {
    const cfg = this.cfg;
    const c = this.world.crowd;
    const quiet = (themeRules(this.theme).twist?.quietSec ?? 0) * 1000;
    const free = Math.max(t, c ? c.windowEnd + 2000 + TICK_MS : t, this.lastTwistAt + quiet);
    const at = Math.max(t + cfg.crowdMoodLeadMs + 400, free + cfg.crowdMoodLeadMs);
    if (this.zoneStarted || at >= this.plannedPlayEnd - cfg.zoneStartBeforeEndSec * 1000 - 3000) return null;
    return at;
  }

  /** Можно ли сейчас начать команду (общие условия для расписания и «Хлопушки»). */
  crowdCanStart(t = this.world.time): boolean {
    const c = this.world.crowd;
    if (c && t <= c.windowEnd + 2000) return false;
    const quiet = (themeRules(this.theme).twist?.quietSec ?? 0) * 1000;
    // не во время сужения: зона зависит от времени, а в стоп-кадре никто не может уйти
    return t >= this.lastTwistAt + quiet && !this.zoneStarted && t < this.plannedPlayEnd - this.cfg.zoneStartBeforeEndSec * 1000 - 3000;
  }

  private fireCrowd(kind: CrowdKind, vote: boolean, ghost = false, pauseMs?: number, watchMs?: number): void {
    const t = this.world.time;
    const cfg = this.cfg;
    const pause = pauseMs ?? crowdPauseMs(cfg);
    const resumeAt = t + pause;
    const windowEnd = resumeAt + cfg.crowdLateMs;
    // Леший смотрит и после окна ответа: приговор — в watchUntil (judgeTick)
    const watch = watchMs !== undefined ? { watchUntil: windowEnd + LAG_GRACE_MS + watchMs } : {};
    this.emit({ t: 'crowd', kind, at: t, showAt: t, resumeAt, windowEnd, ...(vote ? { vote: true } : {}), ...(ghost ? { ghost: true } : {}), ...watch });
    this.nextGhost = false;
    this.crowdShowTimes.push(resumeAt);
    this.crowdCount++;
    this.plannedPlayEnd += pause; // пауза не съедает время раунда
    // игроки на автопилоте — это тоже игроки: за них команду никто не выполнит
    this.bots.onCrowd(kind, resumeAt, { skip: new Set(this.pr.map((p) => p.eid)), ...(vote ? { vote: cfg.crowdVoteMajority } : {}) });
    this.forcedKind = null;
    this.scheduleCrowd(resumeAt);
  }

  // ───────────── сценарий (пробный дубль) ─────────────

  /** Назначить команду через inMs: с названным жестом или «Толпа решает» (с разогревом толпы). */
  planCrowd(kind: CrowdKind, inMs: number, vote = false): void {
    this.nextCrowdAt = this.world.time + inMs;
    this.nextVote = vote ? kind : null;
    this.forcedKind = vote ? null : kind;
    this.moodOn = false;
  }

  /** Положить звезду в точку (ближайшая проходимая клетка). */
  spawnStarAt(x: number, y: number): void {
    const i = this.nav.nearestWalkable(this.nav.cellAt(x, y), null);
    if (i < 0) return;
    this.emit({ t: 'star_spawn', id: this.starSeq++, x: this.nav.cx(i), y: this.nav.cy(i), at: this.world.time });
  }

  private maxStars(): number {
    return this.cfg.maxStars + (roundMod(this.mod) === 'stars' ? 2 : 0);
  }

  /**
   * Режиссёр следит за жестами: когда окно ответа (с запасом на сеть) закрылось, над каждым,
   * кто не повторил названный жест (не нажал, не тот, опоздал), загорается прожектор — круг
   * со смещённым центром. Зазевавшихся ботов он ловит так же. В «Жёстком дубле» не повторивший
   * (не нажал или не тот жест) вырезан, опоздавший — только подсвечен. «Толпа решает» не судится: там угадывают, меньшинство видно и так.
   * Жест от вырезанного («Хлопушка») судится: не угадавших подсвечивают так же, но не вырезают даже в «Жёстком дубле»
   * (решение владельца, 23.11.2026).
   */
  private judgeTick(t: number): void {
    const c = this.world.crowd;
    if (!c || (c.vote && !c.ghost) || this.hardChecked === c.warnAt || t <= (c.watchUntil ?? c.windowEnd + LAG_GRACE_MS)) return;
    this.hardChecked = c.warnAt;
    const cfg = this.cfg;
    // Леший: из не замерших вовремя забирает одного — ближайшего к себе (дети — только подсвечены)
    const leshy = c.warnAt === this.leshyWarn && !cfg.kidsMode;
    // «Купальская ночь»: за жест вырезает только Леший — уровень «сложно» и «Жёсткий дубль» здесь не режут
    const hard = !c.vote && !hasSanity(this.theme) && (roundMod(this.mod) === 'hard' || cfg.strictCrowd);
    // Леший идёт к самому виноватому: кто не замер сейчас или накопил leshyDoomSins провинностей (тому и
    // замереть не поможет). Больше провинностей — раньше; поровну — ближайший к нему.
    // На охоте (глубокая ночь, sanity.ts › LESHY_HUNT_SEC) замереть не спасает: забирает ближайшего.
    let prey: PlayerRound | null = null;
    if (leshy) {
      const spot = leshySpot(c.warnAt, this.arena.width);
      const hunt = this.playClock(c.warnAt) >= LESHY_HUNT_SEC * 1000;
      let best = -Infinity;
      for (const p of this.pr) {
        // замер, но шевельнулся, пока он смотрел, — как не замерший
        const froze = p.crowdAnswered === c.warnAt && p.crowdPick === c.kind && p.leshyMoved !== c.warnAt;
        if (!p.alive || (froze && p.sins < cfg.leshyDoomSins && !hunt)) continue;
        const e = this.world.get(p.eid)!;
        const score = (froze ? p.sins : p.sins + 1) * 1000 - Math.hypot(e.x - spot.x, e.y - spot.y);
        if (score > best) [best, prey] = [score, p];
      }
    }
    const sinful = hasSanity(this.theme) && c.warnAt !== this.leshyWarn;
    const slips: number[] = [];
    for (const p of this.pr) {
      if (!p.alive) continue;
      if (p === prey) {
        // забран Лешим (даже если замер — провинностей слишком много)
        const e = this.world.get(p.eid)!;
        p.alive = false;
        p.diedAt = t;
        p.kiki = [];
        if (p.autopilot) this.bots.remove(p.eid);
        this.emit({ t: 'hit', target: p.eid, result: 'player', x: e.x, y: e.y, at: t });
        this.emit({ t: 'remove', eid: p.eid, cause: 'player', at: t });
        continue;
      }
      if (p.crowdAnswered === c.warnAt && p.crowdPick === c.kind && !p.crowdLate) {
        this.addSanity(p, cfg.sanityGesture); // толпа успокаивает (только в теме с рассудком)
        if (hasSanity(this.theme) && !c.vote) {
          // купальские обряды: факел в руке; хоровод рядом с другими танцующими лечит сильнее
          if (c.kind === 'jump') p.torchUntil = c.windowEnd + cfg.torchMs;
          else if (c.kind === 'dance' && this.danceNear(p.eid, c.showAt, c.windowEnd) >= cfg.danceRingMin) this.addSanity(p, cfg.danceRing);
        }
        continue;
      }
      this.addSanity(p, -cfg.sanitySlip);
      if (sinful && !(p.crowdAnswered === c.warnAt && p.crowdPick === c.kind)) p.sins++; // опоздавшему не в счёт
      const e = this.world.get(p.eid)!;
      // опоздавший всё же повторил жест — его только подсвечивают, вырезают не повторивших
      if (hard && !(p.crowdAnswered === c.warnAt && p.crowdPick === c.kind)) {
        p.alive = false;
        p.diedAt = t;
        if (p.autopilot) this.bots.remove(p.eid);
        this.emit({ t: 'hit', target: p.eid, result: 'player', x: e.x, y: e.y, at: t });
        this.emit({ t: 'remove', eid: p.eid, cause: 'player', at: t });
      } else slips.push(p.eid);
    }
    // забрал — остальным одна провинность прощается, иначе к концу ночи обречены все
    if (prey) for (const p of this.pr) if (p.alive && p.sins > 0) p.sins--;
    // «Купальская ночь»: прожектора нет — сбившихся никто не подсвечивает, их помнит только Леший
    if (hasSanity(this.theme)) return;
    for (const eid of this.bots.lastSlips) if (this.world.get(eid)?.alive) slips.push(eid);
    for (const eid of this.rng.shuffle(slips)) {
      const e = this.world.get(eid)!;
      const a = this.rng.range(0, Math.PI * 2);
      const d = this.rng.range(0, cfg.spotJitter);
      const x = Math.round(Math.min(this.arena.walk.x + this.arena.walk.w, Math.max(this.arena.walk.x, e.x + Math.cos(a) * d)));
      const y = Math.round(Math.min(this.arena.walk.y + this.arena.walk.h, Math.max(this.arena.walk.y, e.y + Math.sin(a) * d)));
      this.emit({ t: 'spot', x, y, r: cfg.spotRadius, until: t + cfg.spotSec * 1000, at: t });
    }
  }

  /**
   * Леший рядом: от «Ау» перед его шагами (scene.ts › renderLeshy, за leshyLeadSec + 3 с) до его ухода
   * после стоп-кадра. Время — из номера дубля и часов дубля, у всех одинаковое.
   */
  private leshyHides(t: number): boolean {
    if (!hasSanity(this.theme) || this.phase !== 'play') return false;
    const cfg = this.cfg;
    if (this.leshyWarn >= 0 && t < this.leshyWarn + cfg.leshyPauseMs + cfg.crowdLateMs + LAG_GRACE_MS + cfg.leshyWatchMs + 3000) return true;
    const v = leshyVisits(this.round)[this.leshyIdx];
    if (!v) return false;
    const clock = this.playClock(t);
    return clock >= (v.sec - cfg.leshyLeadSec - 3) * 1000;
  }

  /** «Часы дубля», мс: сколько прошло от начала игры без пауз стоп-кадров (у клиента — scene.ts › playSec). */
  private playClock(t: number): number {
    return playLenSec(this.cfg, this.theme) * 1000 - (this.plannedPlayEnd - t);
  }

  /** Сколько фигур рядом станцевали «Хоровод» в окне команды (по событиям `act`, у всех одинаково). */
  private danceNear(eid: number, from: number, to: number): number {
    const me = this.world.get(eid);
    if (!me) return 0;
    const dancers = new Set<number>();
    const log = this.world.log;
    for (let i = log.length - 1; i >= 0 && log[i].at >= from - 5000; i--) {
      const ev = log[i];
      if (ev.t === 'act' && ev.kind === 'dance' && ev.at >= from && ev.at <= to && ev.eid !== eid) dancers.add(ev.eid);
    }
    let n = 0;
    for (const id of dancers) {
      const o = this.world.get(id);
      if (o?.alive && Math.hypot(o.x - me.x, o.y - me.y) <= this.cfg.sanityCrowdRadius) n++;
    }
    return n;
  }

  // ───────────── шеф в офисе (boss.ts) ─────────────

  private bossAtDoor(): boolean {
    const b = this.world.boss;
    const d = bossDoor(this.arena.width);
    return !!b && !b.out && b.pi >= b.path.length && Math.hypot(b.x - d.x, b.y - d.y) <= 4;
  }

  /** Шеф вернулся из-за двери — и сразу смотрит в офис: кто ещё дерётся, тот попался. */
  private bossBack(t: number): void {
    const d = bossDoor(this.arena.width);
    this.emit({ t: 'boss', act: 'in', x: d.x, y: d.y, at: t });
    this.bossLookNext = true;
    this.bossNextAt = t + 300;
  }

  /**
   * Обход шефа: прошёлся — посмотрел — прошёлся. Пока смотрит, шевельнувшийся в конусе получает
   * выговор. Перед подвалом идёт к двери (с запасом по времени), из-за двери возвращает twistTick.
   */
  private bossTick(t: number): void {
    const b = this.world.boss;
    const rng = this.bossRng;
    if (!b || !rng || b.out) return;
    const cfg = this.cfg;
    if (bossWatching(b, t) && !this.world.isFrozen(t)) {
      for (const e of this.world.entities) {
        // шагнул за последний шаг мира (флаг moving после стоп-кадра бывает несвежим; испуг и жесты — не в счёт)
        const stepped = !e.act && Math.hypot(e.x - e.px, e.y - e.py) > 0.01;
        if (!e.alive || !stepped || this.bossCaught.has(e.eid) || !inBossCone(b, b.look.dir, e.x, e.y)) continue;
        // живому игроку — запас на задержку сети: он мог замереть у себя чуть раньше, чем это дошло
        const p = this.pr.find((q) => q.eid === e.eid && q.alive && !q.autopilot);
        if (p && t < b.look.from + 250) continue;
        this.bossCatch(e.eid, t);
      }
    }
    // взгляд кончился без выговора — иногда шеф всё равно тычет рукавом в кого-то из попавших в конус
    // (кого угодно: бота или живого — ложная тревога, на счёт не влияет)
    if (this.bossPointAt && t >= this.bossPointAt) {
      const look = b.look;
      this.bossPointAt = 0;
      if (look && !this.bossCaught.size && rng.chance(cfg.bossFalseAlarm)) {
        const seen = this.world.alive().filter((e) => inBossCone(b, look.dir, e.x, e.y));
        if (seen.length) this.emit({ t: 'boss', act: 'point', eid: rng.pick(seen).eid, at: t });
      }
    }
    if (bossLooking(b, t) || b.pi < b.path.length || t < this.bossNextAt) return;
    // дошёл до кого-то за спину — постоять молча, потом посмотреть
    if (this.bossLinger) {
      this.bossLinger = false;
      this.bossNextAt = t + cfg.bossLingerMs;
      return;
    }
    // перед подвалом — к двери, заранее (подвал дождётся, пока он дойдёт)
    const door = bossDoor(this.arena.width);
    const leaving = this.twistLeft > 0 && !this.zoneStarted && this.nextTwistAt < Infinity;
    const far = Math.hypot(door.x - b.x, door.y - b.y);
    if (leaving && t + (far * 1.5 * 1000) / (cfg.entitySpeed * BOSS_SPEED_MUL) + 1500 >= this.nextTwistAt) {
      if (far > 4) this.bossWalk(door.x, door.y, t);
      this.bossNextAt = t + 500;
      return;
    }
    if (this.bossLookNext) {
      this.bossLook(t);
      this.bossLookNext = false;
      return;
    }
    // пройтись к точке интереса (не к той, где стоит)
    // недалеко: обход — короткими переходами, взглядов за дубль побольше
    // иногда смотрит ещё раз с того же места — офис не успевает расслабиться
    if (rng.chance(cfg.bossStayLook)) {
      this.bossLook(t);
      return;
    }
    // иногда — не к точке, а за спину кому-то из толпы (кто угодно: бот или живой)
    if (rng.chance(cfg.bossLingerChance)) {
      const alive = this.world.alive();
      const e = alive.length ? rng.pick(alive) : null;
      if (e && Math.hypot(e.x - b.x, e.y - b.y) < 90) {
        this.bossWalk(e.x, e.y - 7, t);
        this.bossLinger = true;
        this.bossLookNext = true;
        this.bossNextAt = t + 200;
        return;
      }
    }
    const pts = this.arena.interest.filter((q) => Math.hypot(q.x - b.x, q.y - b.y) > 24 && Math.hypot(q.x - b.x, q.y - b.y) < 80);
    const q = rng.pick(pts.length ? pts : this.arena.interest);
    this.bossWalk(q.x + rng.range(-6, 6), q.y + rng.range(-4, 4), t);
    this.bossLookNext = true;
    this.bossNextAt = t + 200;
  }

  private bossWalk(x: number, y: number, t: number): void {
    const b = this.world.boss!;
    const nav = this.nav;
    const goal = nav.nearestWalkable(nav.cellAt(x, y), null);
    if (goal < 0) return;
    const path = nav.findPath(nav.cellAt(b.x, b.y), goal, null);
    if (path && path.length) this.emit({ t: 'boss', act: 'walk', path, at: t });
  }

  /** Посмотреть туда, где больше народу; боты в конусе «заработались» — замирают (почти все). */
  private bossLook(t: number): void {
    const b = this.world.boss!;
    const rng = this.bossRng!;
    const cfg = this.cfg;
    const alive = this.world.alive();
    const dirs: Dir[] = rng.shuffle([0, 1, 2, 3] as Dir[]);
    let dir = dirs[0];
    let best = -1;
    for (const d of dirs) {
      const n = alive.filter((e) => inBossCone(b, d, e.x, e.y)).length;
      if (n > best) {
        best = n;
        dir = d;
      }
    }
    const warn = cfg.kidsMode ? cfg.kidsBossWarnMs : cfg.bossWarnMs;
    const from = t + warn;
    const until = from + cfg.bossLookMs;
    this.emit({ t: 'boss', act: 'look', dir, from, until, at: t });
    // взгляд виден ботам уже в этом шаге (событие мир применит в конце шага): иначе кто-то успеет зашагать в конус
    b.look = { dir, from, until };
    this.bossCaught.clear();
    this.bossPointAt = until;
    this.bossNextAt = until + rng.range(cfg.bossRestMs[0], cfg.bossRestMs[1]);
    for (const e of alive) {
      // в конусе стоит или через него пройдёт по своему пути
      const nav = this.nav;
      const seen = pathInBossCone(b, dir, e.x, e.y, e.path.slice(e.pi).map((c) => ({ x: nav.cx(c), y: nav.cy(c) })));
      if (!seen || this.pr.some((p) => p.eid === e.eid && !p.autopilot)) continue;
      // зазевавшийся бот так и идёт — попадётся, как живой
      if (rng.chance(cfg.bossBotSlip)) continue;
      if (e.pi < e.path.length) this.emit({ t: 'stop', eid: e.eid, at: t + Math.round(rng.range(150, warn - 100)) });
      this.bots.interrupt(e.eid, until);
    }
  }

  private bossCatch(eid: number, t: number): void {
    const cfg = this.cfg;
    this.bossCaught.add(eid);
    this.emit({ t: 'boss', act: 'catch', eid, at: t });
    this.emit({ t: 'mark', eid, until: t + cfg.bossMarkSec * 1000, at: t });
    const p = this.pr.find((q) => q.eid === eid && q.alive);
    if (p) {
      p.reprimands++;
      if (this.fightArmed) p.attacksLeft = bossFightLeft(p.attacksLeft, p.reprimands, cfg.bossPenalty, cfg.bossZeroAt);
    }
    // пойманный бот дальше не затевает новых прогулок (событий для него не шлём — иначе отличался бы от живого)
    if (!p || p.autopilot) this.bots.interrupt(eid, t + 1200);
  }

  private emit(ev: WorldEvent): void {
    this.world.push(ev);
  }

  private playTick(): void {
    const t = this.world.time;
    const cfg = this.cfg;
    this.bossTick(t);
    this.twistTick(t);

    // «Море волнуется»; перед «Толпа решает» толпа заранее «разогревается» жестом большинства
    if (this.nextVote && !this.moodOn && t >= this.nextCrowdAt - cfg.crowdMoodLeadMs && this.crowdCanStart(t)) {
      this.moodOn = true;
      this.bots.setMood(this.nextVote, t, this.nextCrowdAt);
    }
    // Леший: в секунду настоящего прихода — его «Тсс!»; ложный приход просто проходит. Вокруг прихода
    // обычных команд нет, чтобы он пришёл вовремя (sanity.ts › leshyVisits)
    const clock = this.playClock(t);
    const visit = hasSanity(this.theme) ? leshyVisits(this.round)[this.leshyIdx] : undefined;
    if (visit && clock >= visit.sec * 1000) {
      if (!visit.real) {
        if (clock >= (visit.sec + 4) * 1000) this.leshyIdx++;
      } else if (this.crowdCanStart(t)) {
        this.leshyIdx++;
        this.fireCrowd('freeze', false, false, cfg.leshyPauseMs, cfg.kidsMode ? undefined : cfg.leshyWatchMs);
        this.leshyWarn = t; // warnAt команды = время её запуска
      }
    }
    // до прихода (с запасом на «Ау» и шаги) и после него — тишина без обычных команд
    const prev = hasSanity(this.theme) ? leshyVisits(this.round)[this.leshyIdx - 1] : undefined;
    const leshyNear = (!!visit && clock >= (visit.sec - cfg.leshyLeadSec - 6) * 1000) || (!!prev && clock < (prev.sec + cfg.leshyQuietSec) * 1000);
    if (!leshyNear && t >= this.nextCrowdAt && this.crowdCanStart(t)) {
      if (this.nextVote) this.fireCrowd(this.nextVote, true, this.nextGhost);
      else this.fireCrowd(this.forcedKind ?? this.rng.pick<CrowdKind>(['freeze', 'jump', 'dance']), false);
    }
    this.judgeTick(t);
    // нажавшие во время стоп-кадра выполняют команду вместе с толпой, с тем же разбросом, что у ботов
    for (const p of this.pr) {
      if (p.crowdQueued && t >= p.crowdQueued.at) {
        const k = p.crowdQueued.kind;
        p.crowdQueued = null;
        if (p.alive) this.emit({ t: 'act', eid: p.eid, kind: CROWD_ACT[k], dur: crowdHoldDur(cfg, k, t, this.world.crowd?.watchUntil), at: t });
      }
    }

    // сужение
    if (!this.zoneStarted && t >= this.plannedPlayEnd - cfg.zoneStartBeforeEndSec * 1000) {
      this.zoneStarted = true;
      this.emit({
        t: 'zone',
        at: t,
        startAt: t,
        endAt: t + cfg.zoneShrinkSec * 1000,
        from: { ...this.arena.walk },
        to: shrinkRect(this.arena.walk, cfg.zoneFinalAreaRatio),
      });
    }

    // звёзды
    while (this.starSpawnQueue.length && this.starSpawnQueue[0] <= t) {
      this.starSpawnQueue.shift();
      this.spawnStar();
    }

    const zoneNow = this.world.zoneRect(t);
    const zoneFinal = this.zoneFinal();
    this.bots.update(t, zoneNow, zoneFinal, true);
    for (const a of this.agents) a.update(this);
    this.processIntents();

    // игроков, оставшихся в изгороди, выталкивает к центру
    if (zoneNow) {
      for (const p of this.pr) {
        if (!p.alive) continue;
        const e = this.world.get(p.eid)!;
        if (rectContains(zoneNow, e.x, e.y)) continue;
        const d = this.world.destination(e);
        if (zoneFinal && rectContains(zoneFinal, d.x, d.y)) continue;
        const z = zoneFinal ?? zoneNow;
        const target = clampToRect(z, e.x, e.y, 6);
        const path = planPath(this.world, p.eid, target.x, target.y, z, true);
        if (path && path.length) this.emit({ t: 'move', eid: p.eid, path, at: t });
      }
    }

    // сбор звёзд (боты проходят сквозь звёзды, не собирая)
    const takenNow = new Set<number>();
    for (const p of this.pr) {
      if (!p.alive || p.autopilot || t < p.stunUntil) continue;
      const e = this.world.get(p.eid)!;
      for (const st of this.world.stars.values()) {
        if (takenNow.has(st.id)) continue;
        if (Math.hypot(st.x - e.x, st.y - e.y) <= cfg.starPickupRadius) {
          this.emit({ t: 'star_taken', id: st.id, eid: p.eid, at: t });
          takenNow.add(st.id); // чтобы второй игрок не взял ту же звезду в этом же тике
          p.stars++;
          this.addSanity(p, cfg.sanityFlower);
          // цветок отгоняет ближайшую кикимору обратно в воду
          if (p.kiki.length) {
            const near = p.kiki.reduce((a, b) => (Math.hypot(a.x - e.x, a.y - e.y) <= Math.hypot(b.x - e.x, b.y - e.y) ? a : b));
            p.kiki = p.kiki.filter((k) => k !== near);
          }
          this.queueStar(t + this.starRespawnMs());
          // с рассудком цветы только лечат: побеждает последний выживший (finishRound)
          if (!hasSanity(this.theme) && p.stars >= cfg.starsToWin && !this.starWinner) {
            this.starWinner = p.pid;
            this.endReason = 'stars';
          }
          break;
        }
      }
    }

    // статисты тоже хватают звёзды (не каждый раз): подбор звезды — уже не доказательство.
    // Решение — один раз на пару «бот × звезда», когда бот до неё дотянулся.
    if (this.world.stars.size) {
      const playerEids = new Set(this.pr.map((p) => p.eid));
      for (const e of this.world.alive()) {
        if (playerEids.has(e.eid) || !this.bots.has(e.eid)) continue;
        for (const st of this.world.stars.values()) {
          if (takenNow.has(st.id) || Math.hypot(st.x - e.x, st.y - e.y) > cfg.starPickupRadius) continue;
          const key = e.eid * 100000 + st.id;
          if (this.starTouched.has(key)) continue;
          this.starTouched.add(key);
          if (!this.rng.chance(cfg.botStarTakeChance)) continue;
          this.emit({ t: 'star_taken', id: st.id, eid: e.eid, at: t });
          takenNow.add(st.id);
          this.queueStar(t + this.starRespawnMs());
          break;
        }
      }
    }

    // «слепые соседи»
    const alive = this.pr.filter((p) => p.alive);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        const key = [a.pid, b.pid].sort().join('|');
        let n = this.neighbors.get(key);
        if (!n) this.neighbors.set(key, (n = { a: a.pid, b: b.pid, cur: 0, max: 0, hit: false }));
        const ea = this.world.get(a.eid)!;
        const eb = this.world.get(b.eid)!;
        if (Math.hypot(ea.x - eb.x, ea.y - eb.y) <= 20) {
          n.cur += TICK_MS;
          n.max = Math.max(n.max, n.cur);
        } else n.cur = 0;
      }
    }

    this.sanityTick(t);

    this.world.step();
    this.recordPositions();

    const aliveCount = this.pr.filter((p) => p.alive).length;
    // «Купальская ночь» — до последнего: ночь кончается, только когда сгинули все
    const lastAlive = cfg.endWhenLastAlive && this.players.length >= 2 && aliveCount <= (hasSanity(this.theme) ? 0 : 1);
    if (lastAlive && this.endReason === 'time') this.endReason = 'last_alive';
    if (this.starWinner || lastAlive || this.world.time >= this.plannedPlayEnd) this.endPlay();
  }

  private starTouched = new Set<number>();

  /** Рассудок меняется только в теме с рассудком (themes.ts › sanity) и только у живых. */
  private addSanity(p: PlayerRound, d: number): void {
    if (!hasSanity(this.theme) || !p.alive || this.phase !== 'play') return;
    p.sanity = Math.max(0, Math.min(100, p.sanity + d));
    p.sanityMin = Math.min(p.sanityMin, p.sanity);
  }

  /**
   * Рассудок тает сам: быстрее к ночи, вдвое медленнее в толпе, у горящего костра растёт, у углей держится, каждый цветок
   * в венке замедляет падение. В стоп-кадре время стоит. На нуле — вырезан, как в «Жёстком дубле»: удар
   * без нападавшего (в детском режиме не вырезает). Автопилот (игрок отвалился) рассудок не теряет.
   */
  private sanityTick(t: number): void {
    if (!hasSanity(this.theme) || this.world.isFrozen(t)) return;
    const cfg = this.cfg;
    const sec = (t - this.playStart) / 1000;
    const fire = fireLevel(cfg, sec);
    const fx = this.arena.width / 2;
    const fy = 132;
    this.bots.panicPerMin = cfg.botPanicPerMin * nightLevel(cfg, sec);
    for (const p of this.pr) {
      if (!p.alive || p.autopilot) continue;
      const e = this.world.get(p.eid)!;
      let rate: number;
      const dFire = Math.hypot(e.x - fx, e.y - fy);
      if (fire > 0 && dFire <= cfg.sanityFireRadius) rate = cfg.sanityFireGain * fire;
      else if (t < p.torchUntil) rate = cfg.sanityFireGain;
      // костёр прогорел, но угли тлеют: у них рассудок держится (не растёт) — только Леший встаёт рядом
      else if (fire < 1 && dFire <= cfg.sanityEmberRadius) rate = 0;
      else {
        rate = -sanityDrain(cfg, sec) * Math.max(0.4, 1 - cfg.sanityFlowerSlow * p.stars);
        let near = 0;
        for (const o of this.world.entities) {
          if (o.alive && o.eid !== p.eid && Math.hypot(o.x - e.x, o.y - e.y) <= cfg.sanityCrowdRadius) near++;
        }
        if (near >= cfg.sanityCrowdMin) rate *= cfg.sanityCrowdMul;
        // рядом с кикиморой рассудок тает быстрее — долго бегать не выйдет, надо отбиваться
        if (p.kiki.some((k) => t >= k.at && Math.hypot(k.x - e.x, k.y - e.y) <= cfg.kikiDreadRadius)) rate *= cfg.kikiDreadMul;
      }
      this.addSanity(p, (rate * TICK_MS) / 1000);
      if (this.kikiTick(p, t)) continue;
      if (p.sanity > 0 || cfg.kidsMode) continue;
      this.madCut(p, t);
    }
  }

  /** Вырезан рассудком или кикиморой: удар без нападавшего, как у режиссёра в «Жёстком дубле». */
  private madCut(p: PlayerRound, t: number): void {
    const e = this.world.get(p.eid)!;
    p.alive = false;
    p.diedAt = t;
    p.kiki = [];
    this.emit({ t: 'hit', target: p.eid, result: 'player', x: e.x, y: e.y, at: t });
    this.emit({ t: 'remove', eid: p.eid, cause: 'player', at: t });
  }

  /**
   * Кикиморы игрока: ниже порога «Кошмар» вылезают из воды у края поля (с рябью за kikiWarnMs), чем ниже
   * рассудок — тем их больше и тем они быстрее, но медленнее человечка: убежать можно, только бегом.
   * Касание — вырезан (в детском режиме — оглушён, кикимора уходит). Рассудок выше порога — все тают.
   * Знает о них только сам игрок (личное сообщение). true — игрок вырезан.
   */
  private kikiTick(p: PlayerRound, t: number): boolean {
    const cfg = this.cfg;
    const limit = cfg.sanityStages[2];
    // пока идёт Леший — хозяин леса — кикиморы прячутся в воду: двух чудищ разом не бывает
    if (this.leshyHides(t)) {
      p.kiki = [];
      p.kikiNextAt = Math.max(p.kikiNextAt, t + cfg.kikiWarnMs);
      return false;
    }
    if (p.sanity >= limit) {
      p.kiki = [];
      return false;
    }
    const e = this.world.get(p.eid)!;
    const want = p.sanity < cfg.kikiMoreAt[1] ? 3 : p.sanity < cfg.kikiMoreAt[0] ? 2 : 1;
    if (p.kiki.length < want && t >= p.kikiNextAt) {
      const w = this.arena.walk;
      for (let k = 0; k < 20; k++) {
        const side = this.rng.int(0, 3);
        const x = side === 0 ? w.x + 2 : side === 1 ? w.x + w.w - 2 : this.rng.range(w.x + 4, w.x + w.w - 4);
        const y = side === 2 ? w.y + 2 : side === 3 ? w.y + w.h - 2 : this.rng.range(w.y + 4, w.y + w.h - 4);
        if (Math.hypot(x - e.x, y - e.y) < cfg.kikiSpawnMinDist && k < 19) continue;
        p.kiki.push({ id: this.kikiSeq--, x: Math.round(x), y: Math.round(y), at: t + cfg.kikiWarnMs, hp: cfg.kikiHp });
        break;
      }
      p.kikiNextAt = t + cfg.kikiGapMs;
    }
    const depth = 1 - p.sanity / limit; // 0 у порога, 1 на нуле
    const speed = cfg.kikiSpeed[0] + (cfg.kikiSpeed[1] - cfg.kikiSpeed[0]) * depth;
    for (const k of p.kiki) {
      if (t < k.at) continue;
      const dx = e.x - k.x;
      const dy = e.y - k.y;
      const d = Math.hypot(dx, dy);
      const step = (speed * TICK_MS) / 1000;
      // факел в руке: кикимора не подходит ближе света и пятится
      if (t < p.torchUntil && d < cfg.torchRadius) {
        k.x -= (dx / (d || 1)) * step;
        k.y -= (dy / (d || 1)) * step;
        continue;
      }
      if (t < p.torchUntil && d - step < cfg.torchRadius) continue;
      if (d > step) {
        k.x += (dx / d) * step;
        k.y += (dy / d) * step;
      }
      if (Math.hypot(e.x - k.x, e.y - k.y) > cfg.kikiTouch) continue;
      if (cfg.kidsMode) {
        p.kiki = p.kiki.filter((o) => o !== k);
        p.stunUntil = t + cfg.missStunSec * 1000;
        this.emit({ t: 'act', eid: p.eid, kind: 'stun', dur: cfg.missStunSec * 1000, at: t });
        return false;
      }
      this.madCut(p, t);
      return true;
    }
    return false;
  }

  /**
   * Удар по своей кикиморе: ударов дубля не тратит, два удара — отбита (+рассудок). Для остальных игроков
   * это взмах по пустому месту (эмоция «удар»), а значит — улика.
   */
  private hitKiki(p: PlayerRound, id: number, ax: number, ay: number): void {
    const cfg = this.cfg;
    const t = this.world.time;
    const k = p.kiki.find((o) => o.id === id);
    if (!k) return;
    if (Math.hypot(k.x - ax, k.y - ay) > cfg.attackRange + 4) {
      this.notices.push({ t: 'denied', pid: p.pid, reason: 'out_of_range' });
      return;
    }
    const dx = k.x - ax;
    const dy = k.y - ay;
    const d = Math.hypot(dx, dy) || 1;
    this.emit({ t: 'act', eid: p.eid, kind: 'jab', dur: emoteDur('jab'), at: t });
    // отшатнулась
    k.x -= (dx / d) * 8;
    k.y -= (dy / d) * 8;
    k.at = Math.max(k.at, t + 400);
    if (--k.hp > 0) return;
    p.kiki = p.kiki.filter((o) => o !== k);
    this.addSanity(p, cfg.kikiBanish);
  }

  private kikiSeq = -1;

  /** Очередь появления звёзд держим по времени: ранняя замена взятой звезды не ждёт позднюю. */
  private queueStar(at: number): void {
    const q = this.starSpawnQueue;
    let i = q.length;
    while (i > 0 && q[i - 1] > at) i--;
    q.splice(i, 0, at);
  }

  private starRespawnMs(): number {
    return this.cfg.starRespawnSec * 1000 * (roundMod(this.mod) === 'stars' ? 0.5 : 1);
  }

  private spawnStar(): void {
    const zone = this.world.zoneRect() ?? this.arena.walk;
    for (let k = 0; k < 200; k++) {
      const i = this.nav.idx(this.rng.int(0, this.nav.cols - 1), this.rng.int(0, this.nav.rows - 1));
      if (!this.nav.walkable(i, zone)) continue;
      const x = this.nav.cx(i);
      const y = this.nav.cy(i);
      if (this.world.alive().some((e) => Math.hypot(e.x - x, e.y - y) < 10)) continue;
      if ([...this.world.stars.values()].some((s) => Math.hypot(s.x - x, s.y - y) < 40)) continue;
      this.emit({ t: 'star_spawn', id: this.starSeq++, x, y, at: this.world.time });
      return;
    }
  }

  /** Конец дубля: все замирают, свет обратно — и сразу разоблачение (обвинения вырезанные сделали по ходу дубля). */
  private endPlay(): void {
    this.playEnd = this.world.time;
    for (const e of this.world.alive()) this.world.push({ t: 'stop', eid: e.eid, at: this.world.time });
    // свет обратно: разоблачение — в обычном облике темы
    if (this.world.twist) {
      this.emit({ t: 'twist', on: false, at: this.world.time });
      if (this.bossRng) this.bossBack(this.world.time);
    }
    this.world.step(); // применить остановку
    // живые тоже угадывают: короткий стоп-кадр «Кто ещё живой?» (в «Купальской ночи» — нет: там свой финал)
    if (!hasSanity(this.theme) && this.pr.length >= 2 && this.pr.some((p) => p.alive)) {
      this.setPhase('accuse', (this.cfg.kidsMode ? this.cfg.kidsAccuseSec : this.cfg.accuseSec) * 1000);
    } else this.finishRound();
  }

  private finishRound(): void {
    const cfg = this.cfg;
    const pts: Record<string, PointsLine> = {};
    for (const p of this.pr) pts[p.pid] = { kill: p.kills * cfg.points.kill, survive: 0, stars: 0, accuse: 0, stolen: 0, bounty: 0, total: 0 };
    const aliveEids = new Set(this.pr.filter((p) => p.alive).map((p) => p.eid));
    // в «Купальской ночи» гибнут все: метка вырезанного на игрока верна, даже если ночь потом забрала и его
    // (он продержался дольше обвинителя); в обычных дублях — только на живого
    const night = hasSanity(this.theme);
    const caughtEids = night ? new Set(this.pr.map((p) => p.eid)) : aliveEids;
    // с рассудком: дубль выигрывает последний выживший — один живой; все сгинули — кто продержался дольше;
    // плёнка кончилась при нескольких живых — у кого голова яснее
    if (hasSanity(this.theme) && this.pr.length >= 2) this.starWinner = this.lastSurvivor();
    const accusations: RoundSummary['accusations'] = [];
    const accusedCount = new Map<number, number>();
    for (const p of this.pr) {
      // метка на того, кого потом вырезали, не считается: он уже ничего не получит
      if (p.accused !== null && !this.world.get(p.accused)?.alive && !(night && caughtEids.has(p.accused))) p.accused = null;
      if (p.accused === null) continue;
      const correct = caughtEids.has(p.accused);
      accusations.push({ pid: p.pid, eid: p.accused, correct });
      if (correct) accusedCount.set(p.accused, (accusedCount.get(p.accused) ?? 0) + 1);
    }
    // выжил и три звезды — засчитываются всегда, ничего не сгорает
    for (const p of this.pr) {
      if (p.alive) this.addScore(p.pid, cfg.points.survive, 'survive', pts);
      // в «Купальской ночи» победитель ночи и так получает больше всех за место — без второго бонуса
      if (this.starWinner === p.pid && !night) this.addScore(p.pid, cfg.points.stars, 'stars', pts);
    }
    // «Кража»: угадал живого — забрал у него очко из счёта матча. Угадавшему +1 всегда,
    // у вычисленного −1 за каждого угадавшего, но счёт не уходит ниже нуля. Отстающие догоняют лидера.
    // «Награда за голову»: угадал или выбил лидера — вместо +1 получаешь +2, у лидера уходит 2.
    const leader = this.bountyPid ? this.pr.find((q) => q.pid === this.bountyPid) : undefined;
    const steal = (from: PlayerRound, n: number) => {
      const take = Math.min(n, this.scores[from.pid]);
      if (take > 0) this.addScore(from.pid, -take, 'stolen', pts);
    };
    for (const a of accusations) {
      if (!a.correct) continue;
      const victim = this.pr.find((q) => q.eid === a.eid)!;
      const head = victim === leader;
      this.addScore(a.pid, cfg.points.accuse, 'accuse', pts);
      if (head) this.addScore(a.pid, cfg.points.bounty - cfg.points.accuse, 'bounty', pts);
      steal(victim, head ? cfg.points.bounty : cfg.points.accuse);
    }
    if (leader) {
      for (const k of this.roundKills) {
        if (k.victim !== leader.eid) continue;
        const hunter = this.pr.find((q) => q.eid === k.by);
        if (!hunter || hunter === leader) continue;
        // +1 за выбитого уже начислено при ударе — добавляем до награды
        this.addScore(hunter.pid, cfg.points.bounty - cfg.points.kill, 'bounty', pts);
        steal(leader, cfg.points.bounty);
      }
    }
    // «Купальская ночь»: место — по тому, кто продержался дольше: очко за каждого, кто сгинул раньше
    if (hasSanity(this.theme)) {
      const died = (p: PlayerRound) => p.diedAt ?? Infinity;
      for (const p of this.pr) this.addScore(p.pid, this.pr.filter((q) => died(q) < died(p)).length, 'survive', pts);
    }
    for (const p of this.pr) pts[p.pid].total = pts[p.pid].kill + pts[p.pid].survive + pts[p.pid].stars + pts[p.pid].accuse + (pts[p.pid].stolen ?? 0) + (pts[p.pid].bounty ?? 0);

    const stats: RoundStats[] = this.pr.map((p) => ({
      pid: p.pid,
      alive: p.alive,
      diedAtFromStart: p.diedAt === null ? null : p.diedAt - this.playStart,
      kills: p.kills,
      killTimes: p.killTimes,
      botHits: p.botHits,
      stars: p.stars,
      accused: p.accused,
      accuseCorrect: p.accused !== null && caughtEids.has(p.accused),
      accusedAsGhost: p.accusedAsGhost,
      timesAccused: accusedCount.get(p.eid) ?? 0,
      reprimands: p.reprimands,
    }));
    const awards = pickRoundAwards({
      stats,
      neighbors: [...this.neighbors.values()].map((n) => ({ a: n.a, b: n.b, ms: n.max, hit: n.hit })),
      crowdShowTimes: this.crowdShowTimes,
      plannedPlayEnd: this.plannedPlayEnd,
    });
    this.roundAwards.push(awards);

    const replayTo = this.playEnd;
    const replayFrom = Math.max(this.playStart, replayTo - cfg.revealReplaySec * 1000);
    this.summary = {
      round: this.round,
      endReason: this.endReason,
      starWinner: this.starWinner,
      reveal: this.pr.map((p) => {
        const e = this.world.get(p.eid)!;
        return { pid: p.pid, eid: p.eid, alive: p.alive, x: e.x, y: e.y };
      }),
      accusations,
      points: pts,
      awards,
      replayFrom,
      replayTo,
      kills: [...this.roundKills],
    };
    this.setPhase('reveal', revealMs(cfg));
  }

  private lastSurvivor(): string | null {
    const alive = this.pr.filter((p) => p.alive);
    if (alive.length === 1) return alive[0].pid;
    if (alive.length > 1) {
      const top = alive.reduce((a, b) => (b.sanity > a.sanity ? b : a));
      return alive.filter((p) => p.sanity === top.sanity).length === 1 ? top.pid : null;
    }
    const dead = this.pr.filter((p) => p.diedAt !== null);
    if (!dead.length) return null;
    const last = dead.reduce((a, b) => (b.diedAt! > a.diedAt! ? b : a));
    return dead.filter((p) => p.diedAt === last.diedAt).length === 1 ? last.pid : null;
  }

  private addScore(pid: string, delta: number, reason: keyof Omit<PointsLine, 'total'>, pts?: Record<string, PointsLine>): void {
    if (!delta) return;
    this.scores[pid] += delta;
    if (pts) pts[pid][reason] = (pts[pid][reason] ?? 0) + delta;
    this.notices.push({ t: 'score', pid, delta, reason });
  }

  /**
   * Этот дубль — последний в матче. Очки начисляются в конце дубля, поэтому уже на разоблачении
   * известно, чем кончится матч (сервер по этому заранее монтирует «Фильм матча»).
   */
  get lastRound(): boolean {
    const top = Math.max(...Object.values(this.scores));
    // «Купальская ночь» — матч в одну ночь: до смерти всех, без повторов между дублями
    return top >= this.cfg.scoreToWin || this.round >= this.cfg.maxRounds || hasSanity(this.theme);
  }

  /** Итоги матча по уже начисленным очкам — те же, что будут на match_end. */
  outcome(): MatchSummary {
    const top = Math.max(...Object.values(this.scores));
    const leaders = this.players.filter((p) => this.scores[p.pid] === top).map((p) => p.pid);
    let winners = leaders;
    let tooAlive = false;
    if (leaders.length > 1) {
      const k = Math.max(...leaders.map((pid) => this.matchKills[pid]));
      winners = leaders.filter((pid) => this.matchKills[pid] === k);
      tooAlive = winners.length > 1;
    }
    return {
      winners,
      tooAlive,
      scores: { ...this.scores },
      awards: pickMatchAwards(this.roundAwards, this.matchKills),
    };
  }

  private advanceAfterResults(): void {
    if (this.lastRound) {
      this.match = this.outcome();
      this.setPhase('match_end', 0);
    } else {
      this.startRound();
    }
  }

  private shuffleThemes(): void {
    const last = this.theme;
    const fixed = this.cfg.fixedTheme;
    // решаем всегда (и при fixedTheme), чтобы последовательность finaleRng не зависела от настроек
    const finale = this.finaleRng.next() < this.cfg.nightFinaleChance;
    this.nightFinale = finale && !(fixed >= 0 && fixed < THEME_COUNT) && ROTATION_THEMES.includes(NIGHT_THEME);
    if (fixed >= 0 && fixed < THEME_COUNT) {
      this.themeOrder = Array.from({ length: THEME_COUNT }, () => fixed);
      return;
    }
    // скрытые темы (themes.ts › hidden) в очередь не попадают — порядок остальных при этом прежний
    const order = this.rng.shuffle([...ROTATION_THEMES]);
    // реванш не начинается с той же темы, которой закончился прошлый матч
    if (this.round > 0 && order[0] === last) order.push(order.shift()!);
    // сезонная тема (под Новый год — «Корпоратив») открывает матч; кончился ею прошлый — идёт второй
    const lead = this.cfg.leadTheme;
    if (lead >= 0 && lead < THEME_COUNT && order.includes(lead)) {
      order.splice(order.indexOf(lead), 1);
      order.splice(this.round > 0 && last === lead ? 1 : 0, 0, lead);
    }
    this.themeOrder = order;
  }

  /**
   * Продолжить матч после смены хоста: счёт известен всем, текущий раунд начинается заново (раздел 13).
   */
  resumeMatch(state: { scores: Record<string, number>; round: number; matchKills?: Record<string, number> }): void {
    for (const p of this.players) {
      this.scores[p.pid] = state.scores[p.pid] ?? 0;
      this.matchKills[p.pid] = state.matchKills?.[p.pid] ?? 0;
    }
    this.round = Math.max(0, state.round - 1);
    this.roundAwards = Array.from({ length: this.round }, () => []);
    this.notices = [];
    this.startRound();
  }

  private rematch(): void {
    this.shuffleThemes();
    for (const p of this.players) {
      this.scores[p.pid] = 0;
      this.matchKills[p.pid] = 0;
    }
    this.round = 0;
    this.roundAwards = [];
    this.match = null;
    this.startRound();
  }

  // ───────────── намерения игроков ─────────────

  private processIntents(): void {
    const list = this.intents;
    this.intents = [];
    for (const { pid, it } of list) this.handle(pid, it);
  }

  private handle(pid: string, it: Intent): void {
    const p = this.playerRound(pid);
    if (!p) return;
    const t = this.world.time;
    const cfg = this.cfg;

    if (it.k === 'next') {
      if (pid === this.hostPid && this.phase === 'results') this.advanceAfterResults();
      return;
    }
    if (it.k === 'rematch') {
      if (pid === this.hostPid && this.phase === 'match_end') this.rematch();
      return;
    }
    if (it.k === 'accuse') {
      // обвинение — одна метка «?»: вырезанный ставит по ходу дубля, живой — в стоп-кадре «Кто ещё живой?»;
      // можно перенести или снять (eid -1)
      if (this.phase === 'play' ? p.alive : this.phase !== 'accuse') return;
      if (it.eid < 0) {
        p.accused = null;
        return;
      }
      const e = this.world.get(it.eid);
      if (!e || !e.alive || it.eid === p.eid) return;
      p.accused = it.eid;
      p.accusedAsGhost = !p.alive;
      return;
    }
    if (it.k === 'clap') {
      // «Хлопушка»: вырезанный тайно загадывает жест — он не назван (vote), толпа заранее «разогревается»
      // им, живые угадывают по толпе. Только вырезанный, с перезарядкой; вырезанные и так известны всем.
      if (this.phase !== 'play' || p.alive) return;
      const at = this.ghostCrowdAt(t);
      if (p.clapsLeft <= 0 || t < p.clapAt || this.nextGhost || at === null) {
        this.notices.push({ t: 'denied', pid, reason: 'not_now' });
        return;
      }
      p.clapsLeft--;
      p.clapAt = t + cfg.ghostClapCooldownSec * 1000;
      this.bots.setMood(null, t);
      // жест встаёт в очередь: заменяет ближайшую команду (разогрев толпы начнётся сам, когда можно)
      this.planCrowd(it.kind, at - t, true);
      this.nextGhost = true;
      return;
    }
    if (this.phase !== 'play' || !p.alive) return;
    const e = this.world.get(p.eid)!;

    switch (it.k) {
      case 'autopilot': {
        if (it.on === p.autopilot) return;
        p.autopilot = it.on;
        if (it.on) this.bots.add(p.eid, t, { quirky: false });
        else {
          this.bots.remove(p.eid);
          this.emit({ t: 'stop', eid: p.eid, at: t });
        }
        return;
      }
      case 'crowd': {
        const c = this.world.crowd;
        if (!c || p.crowdAnswered === c.warnAt) return;
        // игрок по сети видит мир с опозданием: судим по тому, что было на его экране
        const wt = Math.max(t - LAG_GRACE_MS, Math.min(t, it.wt ?? t));
        if (wt < c.showAt || wt > c.windowEnd || t > c.windowEnd + LAG_GRACE_MS) return;
        p.crowdAnswered = c.warnAt;
        p.crowdPick = it.kind;
        p.crowdLate = wt >= c.resumeAt;
        if (wt < c.resumeAt) {
          const [a, b] = cfg.botCrowdReactMs;
          // нажал в стоп-кадре — выполнит вместе с толпой (или сразу, если пакет пришёл уже после паузы);
          // момент, выбранный на экране игрока, — если он в разбросе ботов (случайное число берём всё равно:
          // последовательность случайностей матча не зависит от того, по сети игрок или нет)
          const jitter = crowdJitter(this.rng, a, b);
          const own = it.at !== undefined && it.at >= c.resumeAt + a && it.at <= c.resumeAt + b && it.at % TICK_MS === 0 ? it.at : undefined;
          p.crowdQueued = { kind: it.kind, at: Math.max(t, own ?? c.resumeAt + jitter) };
        } else {
          this.emit({ t: 'act', eid: p.eid, kind: CROWD_ACT[it.kind], dur: crowdHoldDur(cfg, it.kind, t, c.watchUntil), at: t });
        }
        return;
      }
    }
    if (t < p.stunUntil) {
      if (it.k === 'attack') this.notices.push({ t: 'denied', pid, reason: 'stunned' });
      return;
    }
    if (p.autopilot && it.k !== 'emote') {
      if (it.k === 'attack') this.notices.push({ t: 'denied', pid, reason: 'autopilot' });
      return;
    }
    switch (it.k) {
      case 'move': {
        const zone = this.world.zoneRect(t);
        const target = zone ? clampToRect(zone, it.x, it.y, 2) : { x: it.x, y: it.y };
        const path = planPath(this.world, p.eid, target.x, target.y, zone);
        if (path && path.length) {
          this.leshySees(p, t);
          this.emit({ t: 'move', eid: p.eid, path, at: t });
        }
        return;
      }
      case 'stop':
        this.emit({ t: 'stop', eid: p.eid, at: t });
        return;
      case 'emote': {
        this.leshySees(p, t);
        // в изнанке темы эмоция у всех одна (бой с тенью в подвале) — игрок не выделяется
        const kind: ActKind = twistEmote(this.theme, this.world.twist) ?? (it.kind && EMOTES.includes(it.kind) ? it.kind : this.rng.pick<ActKind>(EMOTES));
        this.emit({ t: 'act', eid: p.eid, kind, dur: emoteDur(kind), at: t });
        return;
      }
      case 'attack':
        if (it.eid >= 0) this.leshySees(p, t);
        // момент мира на экране нападавшего (не раньше LAG_GRACE_MS назад)
        this.attack(p, it.eid, e.x, e.y, Math.max(t - LAG_GRACE_MS, Math.min(t, it.wt ?? t)));
        return;
    }
  }

  /**
   * Леший смотрит (от конца стоп-кадра до приговора в watchUntil): замерший игрок, который пошёл,
   * помахал или ударил, для него — дёрнувшийся (judgeTick › prey). Стоп-кадр сам ставит позу поверх.
   */
  private leshySees(p: PlayerRound, t: number): void {
    const c = this.world.crowd;
    if (c && c.watchUntil !== undefined && c.warnAt === this.leshyWarn && t >= c.resumeAt && t <= c.watchUntil) p.leshyMoved = c.warnAt;
  }

  private recordPositions(): void {
    const pos = new Map<number, [number, number]>();
    for (const e of this.world.entities) if (e.alive) pos.set(e.eid, [e.x, e.y]);
    this.posHist.push({ t: this.world.time, pos });
    while (this.posHist.length && this.posHist[0].t < this.world.time - LAG_GRACE_MS - 100) this.posHist.shift();
  }

  /** Где была сущность в момент мира t (последний записанный шаг не позже t). */
  private posAt(eid: number, t: number): [number, number] | null {
    for (let i = this.posHist.length - 1; i >= 0; i--) if (this.posHist[i].t <= t) return this.posHist[i].pos.get(eid) ?? null;
    return null;
  }

  private attack(p: PlayerRound, target: number, ax: number, ay: number, view?: number): void {
    const cfg = this.cfg;
    const t = this.world.time;
    if (target < 0) {
      this.hitKiki(p, target, ax, ay);
      return;
    }
    // офис: в обычном облике не дерутся (клиент сам не шлёт; старой вкладке — «Не сейчас»)
    if (!canFight(this.theme, this.world.twist)) {
      this.notices.push({ t: 'denied', pid: p.pid, reason: 'not_now' });
      return;
    }
    // стоп-кадр «Море волнуется»: мир замер, все выбирают жест — бить нельзя ни игрокам, ни ИИ.
    // Судим по моменту на экране нападавшего: ударил до стоп-кадра, а дошло по сети уже в нём — засчитано
    if (this.world.isFrozen(view ?? t)) {
      this.notices.push({ t: 'denied', pid: p.pid, reason: 'not_now' });
      return;
    }
    if (p.attacksLeft <= 0) {
      this.notices.push({ t: 'denied', pid: p.pid, reason: 'no_attacks' });
      return;
    }
    const te = this.world.get(target);
    if (!te || !te.alive || target === p.eid) return;
    const reach = (x: number, y: number) => Math.hypot(x - ax, y - ay) <= cfg.attackRange + 1;
    // цель в радиусе сейчас или там, где её видел нападавший (его персонаж у хоста уже там, где был на его экране)
    const seen = view !== undefined && view < t ? this.posAt(target, view) : null;
    if (!reach(te.x, te.y) && !(seen && reach(seen[0], seen[1]))) {
      this.notices.push({ t: 'denied', pid: p.pid, reason: 'out_of_range' });
      return;
    }
    p.attacksLeft--;
    const victim = this.pr.find((v) => v.eid === target && v.alive);
    const hx = te.x;
    const hy = te.y;
    if (victim) {
      victim.alive = false;
      victim.diedAt = t;
      p.kills++;
      p.killTimes.push(t);
      this.roundKills.push({ by: p.eid, victim: target, at: t });
      this.matchKills[p.pid]++;
      this.addScore(p.pid, cfg.points.kill, 'kill');
      const key = [p.pid, victim.pid].sort().join('|');
      const n = this.neighbors.get(key);
      if (n) n.hit = true;
      if (victim.autopilot) this.bots.remove(victim.eid);
      // обычно кто бил — тайна; ночью в Майами замах виден всем (themes.ts › exposeKiller)
      const attacker = killerExposed(this.theme, this.world.twist) ? p.eid : undefined;
      this.emit({ t: 'hit', target, result: 'player', x: hx, y: hy, ...(attacker !== undefined ? { attacker } : {}), at: t });
    } else {
      p.botHits++;
      this.addSanity(p, -cfg.sanityBotHit);
      p.stunUntil = t + cfg.missStunSec * 1000;
      this.bots.remove(target);
      this.emit({ t: 'hit', target, result: 'bot', x: hx, y: hy, attacker: p.eid, at: t });
    }
    this.emit({ t: 'remove', eid: target, cause: victim ? 'player' : 'bot', at: t });
    this.notices.push({ t: 'attack', pid: p.pid, target, result: victim ? 'player' : 'bot', at: t });
    // рядом кого-то вырезали — не по себе всем, кто стоял близко (и нападавшему тоже)
    for (const o of this.pr) {
      if (!o.alive) continue;
      const oe = this.world.get(o.eid)!;
      if (Math.hypot(oe.x - hx, oe.y - hy) <= cfg.sanityNearRadius) this.addSanity(o, -cfg.sanityNearCut);
    }
    // испуг соседей маскирует нападающего
    for (const o of this.world.alive()) {
      if (o.eid === target) continue;
      if (!victim && o.eid === p.eid) continue;
      const dx = o.x - hx;
      const dy = o.y - hy;
      const d = Math.hypot(dx, dy);
      if (d > cfg.startleRadius) continue;
      const k = d > 0.01 ? cfg.startleStepPx / d : 0;
      const dur = cfg.startleSec * 1000;
      this.emit({ t: 'act', eid: o.eid, kind: 'startle', dur, dx: dx * k, dy: dy * k, at: t });
      this.bots.interrupt(o.eid, t + dur);
    }
    if (!victim) {
      this.emit({ t: 'act', eid: p.eid, kind: 'stun', dur: cfg.missStunSec * 1000, at: t });
      this.emit({ t: 'mark', eid: p.eid, until: t + cfg.missMarkSec * 1000, at: t });
    }
  }
}
