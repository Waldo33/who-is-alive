import type { ArenaDef, Rect } from './arena';
import { clampToRect, plazaArena, rectContains, shrinkRect } from './arena';
import type { AwardCard, RoundStats } from './awards';
import { pickMatchAwards, pickRoundAwards } from './awards';
import { BotBrain, CROWD_ACT, crowdActDur, crowdJitter, emoteDur, planPath } from './bots';
import type { GameConfig } from './config';
import { TICK_MS, accuseMs, crowdPauseMs, revealMs } from './config';
import type { ActKind, CrowdKind, Dir, EmoteKind, EntitySpawn, WorldEvent } from './events';

import { NavGrid } from './nav';
import { Rng } from './rng';
import { THEME_COUNT, killerExposed, themeRules, twistEmote } from './themes';
import { ROUND_MODS, roundMod } from './mods';
import { World } from './world';

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
  /** Нажал во время стоп-кадра: команда выполнится в этот момент вместе с толпой. */
  crowdQueued: { kind: CrowdKind; at: number } | null;
  /** Какой жест выбрал на последнюю команду (для «Жёсткого дубля» и «Толпа решает»). */
  crowdPick: CrowdKind | null;
  /** Нажал уже после стоп-кадра — опоздал (это видно на поле). */
  crowdLate: boolean;
  /** «Хлопушка» вырезанного: сколько осталось и когда можно снова (время мира). */
  clapsLeft: number;
  clapAt: number;
}

export interface PointsLine {
  kill: number;
  survive: number;
  stars: number;
  accuse: number;
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

/** Наблюдатель-ИИ (песочница и безголовая симуляция) получает только то, что видно на поле. */
export interface AiAgent {
  pid: string;
  onRound(sim: MatchSim, eid: number): void;
  update(sim: MatchSim): void;
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
  agents: AiAgent[] = [];

  playStart = 0;
  private nextTwistAt = Infinity;
  private lastTwistAt = -Infinity;
  private twistLeft = 0;
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
    this.theme = this.themeOrder[(this.round - 1) % THEME_COUNT];
    this.pickMod();
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
      attacksLeft: roundMod(this.mod) === 'onehit' ? 1 : this.cfg.attacksPerRound,
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
      crowdQueued: null,
      crowdPick: null,
      crowdLate: false,
      clapsLeft: this.cfg.ghostClaps,
      clapAt: 0,
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
    const pool = ROUND_MODS.map((_, i) => i).filter((i) => i > 0 && i !== prev);
    this.mod = this.rng.pick(pool);
  }

  /** Подключить ИИ-агентов (песочница/симуляция). */
  addAgent(a: AiAgent): void {
    this.agents.push(a);
    const p = this.playerRound(a.pid);
    if (p) a.onRound(this, p.eid);
  }

  private beginPlay(): void {
    this.setPhase('play', this.cfg.roundSec * 1000);
    this.playStart = this.world.time;
    this.plannedPlayEnd = this.playStart + this.cfg.roundSec * 1000;
    this.crowdCount = 0;
    this.hardChecked = -1;
    this.scheduleCrowd(this.playStart);
    for (let i = 0; i < this.maxStars(); i++) this.spawnStar();
    // изнанка темы: расписание на дубль (зерно — общее, поэтому повтор совпадает)
    const tw = themeRules(this.theme).twist;
    this.twistLeft = tw ? tw.max : 0;
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
    if (t > c.windowEnd + crowdActDur(this.cfg, c.kind) + 1500) return false;
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
    this.emit({ t: 'twist', on, at: t });
    this.lastTwistAt = t;
    if (on) this.twistLeft--;
    const [a, b] = on ? tw.onSec : tw.gapSec;
    this.nextTwistAt = t + this.rng.range(a, b) * 1000;
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
    const mul = roundMod(this.mod) === 'rush' ? 0.5 : 1;
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

  private fireCrowd(kind: CrowdKind, vote: boolean, ghost = false): void {
    const t = this.world.time;
    const cfg = this.cfg;
    const pause = crowdPauseMs(cfg);
    const resumeAt = t + pause;
    this.emit({ t: 'crowd', kind, at: t, showAt: t, resumeAt, windowEnd: resumeAt + cfg.crowdLateMs, ...(vote ? { vote: true } : {}), ...(ghost ? { ghost: true } : {}) });
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
   */
  private judgeTick(t: number): void {
    const c = this.world.crowd;
    if (!c || c.vote || this.hardChecked === c.warnAt || t <= c.windowEnd + LAG_GRACE_MS) return;
    this.hardChecked = c.warnAt;
    const cfg = this.cfg;
    const hard = roundMod(this.mod) === 'hard' || cfg.strictCrowd;
    const slips: number[] = [];
    for (const p of this.pr) {
      if (!p.alive || (p.crowdAnswered === c.warnAt && p.crowdPick === c.kind && !p.crowdLate)) continue;
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

  private emit(ev: WorldEvent): void {
    this.world.push(ev);
  }

  private playTick(): void {
    const t = this.world.time;
    const cfg = this.cfg;
    this.twistTick(t);

    // «Море волнуется»; перед «Толпа решает» толпа заранее «разогревается» жестом большинства
    if (this.nextVote && !this.moodOn && t >= this.nextCrowdAt - cfg.crowdMoodLeadMs && this.crowdCanStart(t)) {
      this.moodOn = true;
      this.bots.setMood(this.nextVote, t, this.nextCrowdAt);
    }
    if (t >= this.nextCrowdAt && this.crowdCanStart(t)) {
      if (this.nextVote) this.fireCrowd(this.nextVote, true, this.nextGhost);
      else this.fireCrowd(this.forcedKind ?? this.rng.pick<CrowdKind>(['freeze', 'jump', 'dance']), false);
    }
    this.judgeTick(t);
    // нажавшие во время стоп-кадра выполняют команду вместе с толпой, с тем же разбросом, что у ботов
    for (const p of this.pr) {
      if (p.crowdQueued && t >= p.crowdQueued.at) {
        const k = p.crowdQueued.kind;
        p.crowdQueued = null;
        if (p.alive) this.emit({ t: 'act', eid: p.eid, kind: CROWD_ACT[k], dur: crowdActDur(cfg, k), at: t });
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
          this.starSpawnQueue.push(t + this.starRespawnMs());
          if (p.stars >= cfg.starsToWin && !this.starWinner) {
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
          this.starSpawnQueue.push(t + this.starRespawnMs());
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

    this.world.step();
    this.recordPositions();

    const aliveCount = this.pr.filter((p) => p.alive).length;
    const lastAlive = cfg.endWhenLastAlive && this.players.length >= 2 && aliveCount <= 1;
    if (lastAlive && this.endReason === 'time') this.endReason = 'last_alive';
    if (this.starWinner || lastAlive || this.world.time >= this.plannedPlayEnd) this.beginAccuse();
  }

  private starTouched = new Set<number>();

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

  private beginAccuse(): void {
    this.playEnd = this.world.time;
    for (const e of this.world.alive()) this.world.push({ t: 'stop', eid: e.eid, at: this.world.time });
    // свет обратно: обвинение — в обычном облике темы
    if (this.world.twist) this.emit({ t: 'twist', on: false, at: this.world.time });
    this.world.step(); // применить остановку
    this.setPhase('accuse', accuseMs(this.cfg));
  }

  private finishRound(): void {
    const cfg = this.cfg;
    const pts: Record<string, PointsLine> = {};
    for (const p of this.pr) pts[p.pid] = { kill: p.kills * cfg.points.kill, survive: 0, stars: 0, accuse: 0, total: 0 };
    const aliveEids = new Set(this.pr.filter((p) => p.alive).map((p) => p.eid));
    const accusations: RoundSummary['accusations'] = [];
    const accusedCount = new Map<number, number>();
    for (const p of this.pr) {
      if (p.accused === null) continue;
      const correct = aliveEids.has(p.accused);
      accusations.push({ pid: p.pid, eid: p.accused, correct });
      accusedCount.set(p.accused, (accusedCount.get(p.accused) ?? 0) + 1);
      if (correct) this.addScore(p.pid, cfg.points.accuse, 'accuse', pts);
    }
    for (const p of this.pr) {
      // выжил, но тебя вычислили — очко за выживание пропадает (обвинитель своё +1 уже получил)
      if (p.alive && !accusedCount.get(p.eid)) this.addScore(p.pid, cfg.points.survive, 'survive', pts);
      if (this.starWinner === p.pid) this.addScore(p.pid, cfg.points.stars, 'stars', pts);
    }
    for (const p of this.pr) pts[p.pid].total = pts[p.pid].kill + pts[p.pid].survive + pts[p.pid].stars + pts[p.pid].accuse;

    const stats: RoundStats[] = this.pr.map((p) => ({
      pid: p.pid,
      alive: p.alive,
      diedAtFromStart: p.diedAt === null ? null : p.diedAt - this.playStart,
      kills: p.kills,
      killTimes: p.killTimes,
      botHits: p.botHits,
      stars: p.stars,
      accused: p.accused,
      accuseCorrect: p.accused !== null && aliveEids.has(p.accused),
      accusedAsGhost: p.accusedAsGhost,
      timesAccused: accusedCount.get(p.eid) ?? 0,
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

  private addScore(pid: string, delta: number, reason: keyof Omit<PointsLine, 'total'>, pts?: Record<string, PointsLine>): void {
    if (!delta) return;
    this.scores[pid] += delta;
    if (pts) pts[pid][reason] += delta;
    this.notices.push({ t: 'score', pid, delta, reason });
  }

  private advanceAfterResults(): void {
    const top = Math.max(...Object.values(this.scores));
    if (top >= this.cfg.scoreToWin || this.round >= this.cfg.maxRounds) {
      const leaders = this.players.filter((p) => this.scores[p.pid] === top).map((p) => p.pid);
      let winners = leaders;
      let tooAlive = false;
      if (leaders.length > 1) {
        const k = Math.max(...leaders.map((pid) => this.matchKills[pid]));
        winners = leaders.filter((pid) => this.matchKills[pid] === k);
        tooAlive = winners.length > 1;
      }
      this.match = {
        winners,
        tooAlive,
        scores: { ...this.scores },
        awards: pickMatchAwards(this.roundAwards, this.matchKills),
      };
      this.setPhase('match_end', 0);
    } else {
      this.startRound();
    }
  }

  private shuffleThemes(): void {
    const last = this.theme;
    const fixed = this.cfg.fixedTheme;
    if (fixed >= 0 && fixed < THEME_COUNT) {
      this.themeOrder = Array.from({ length: THEME_COUNT }, () => fixed);
      return;
    }
    const order = this.rng.shuffle(Array.from({ length: THEME_COUNT }, (_, i) => i));
    // реванш не начинается с той же темы, которой закончился прошлый матч
    if (this.round > 0 && order[0] === last) order.push(order.shift()!);
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
      if (this.phase !== 'accuse' || it.eid === p.eid) return;
      const e = this.world.get(it.eid);
      if (!e || !e.alive) return;
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
          this.emit({ t: 'act', eid: p.eid, kind: CROWD_ACT[it.kind], dur: crowdActDur(cfg, it.kind), at: t });
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
        if (path && path.length) this.emit({ t: 'move', eid: p.eid, path, at: t });
        return;
      }
      case 'stop':
        this.emit({ t: 'stop', eid: p.eid, at: t });
        return;
      case 'emote': {
        // в изнанке темы эмоция у всех одна (бой с тенью в подвале) — игрок не выделяется
        const kind: ActKind = twistEmote(this.theme, this.world.twist) ?? (it.kind && EMOTES.includes(it.kind) ? it.kind : this.rng.pick<ActKind>(EMOTES));
        this.emit({ t: 'act', eid: p.eid, kind, dur: emoteDur(kind), at: t });
        return;
      }
      case 'attack':
        // момент мира на экране нападавшего (не раньше LAG_GRACE_MS назад)
        this.attack(p, it.eid, e.x, e.y, Math.max(t - LAG_GRACE_MS, Math.min(t, it.wt ?? t)));
        return;
    }
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
      const attacker = killerExposed(this.theme, this.world.twist, cfg.kidsMode) ? p.eid : undefined;
      this.emit({ t: 'hit', target, result: 'player', x: hx, y: hy, ...(attacker !== undefined ? { attacker } : {}), at: t });
    } else {
      p.botHits++;
      p.stunUntil = t + cfg.missStunSec * 1000;
      this.bots.remove(target);
      this.emit({ t: 'hit', target, result: 'bot', x: hx, y: hy, attacker: p.eid, at: t });
    }
    this.emit({ t: 'remove', eid: target, cause: victim ? 'player' : 'bot', at: t });
    this.notices.push({ t: 'attack', pid: p.pid, target, result: victim ? 'player' : 'bot', at: t });
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
