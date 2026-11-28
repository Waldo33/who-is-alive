import { Rng } from './rng';
import { THEME_RULES } from './themes';
import type { MatchSummary, RoundSummary } from './match';
import type { RoundRecording } from './moments';

/**
 * «Новогодняя премьера» (решение владельца 28.11.2026): с 17 по 30 декабря игроки копят «контрамарки» за игру,
 * 31 декабря бот разыгрывает Telegram Premium — только жребием, шанс по числу контрамарок.
 * Контрамарки дают не матчи сами по себе, а разные механики игры (задания дня и недели) и компания (друзья
 * по ссылке, полные комнаты). Купить контрамарки нельзя ничем: участие бесплатное.
 *
 * Здесь — только правила: чистые функции без часов и сети. Счёт ведёт игровой сервер по связке
 * «игрок ↔ Telegram» (`apps/server/src/premiere.ts`), всё, что прислал телефон, не учитывается.
 */

/** Сутки — по Москве (UTC+3): задания дня меняются в полночь по Москве. */
const MSK = 3 * 3600_000;
const DAY = 24 * 3600_000;

/** Сутки по Москве: «2026-12-17». */
export function premiereDay(ms: number): string {
  return new Date(ms + MSK).toISOString().slice(0, 10);
}

/** Сезон: первый и последний день, когда идут контрамарки, день розыгрыша и начало «двойной недели» (дни по Москве). */
export const PREMIERE = {
  start: '2026-12-17',
  end: '2026-12-30',
  /** С этого дня задания дня дают вдвое больше. */
  double: '2026-12-24',
  draw: '2026-12-31',
} as const;

/** До, во время или после сезона. */
export function premierePhase(ms: number, season = PREMIERE): 'before' | 'on' | 'after' {
  const d = premiereDay(ms);
  return d < season.start ? 'before' : d > season.end ? 'after' : 'on';
}

/** Неделя сезона: 0 — с 17.12, 1 — с 24.12 (недели с четверга). До сезона — -1. */
export function premiereWeek(ms: number, season = PREMIERE): number {
  const start = Date.parse(season.start + 'T00:00:00Z') - MSK;
  return ms < start ? -1 : Math.floor((ms - start) / (7 * DAY));
}

/** Матч засчитывается, если в нём не меньше стольких разных аккаунтов Telegram. */
export const PREMIERE_MIN_TG = 2;
/** Сколько контрамарок нужно для участия в розыгрыше. */
export const PREMIERE_ENTRY = 5;
/** Базовая контрамарка за матч — не больше стольких матчей в сутки. */
export const BASE_PER_DAY = 3;
/** Друг засчитывается после стольких своих матчей. */
export const FRIEND_MATCHES = 3;
export const FRIEND_REWARD = 5;
export const FRIEND_MAX = 10;
/** Доля с друзей: столько процентов их контрамарок за игру, всего не больше `SHARE_MAX`. */
export const SHARE_PCT = 20;
export const SHARE_MAX = 30;
/** Серия дней подряд с матчем: награды за 3 и 7 дней. */
export const STREAK_REWARDS: readonly { days: number; n: number }[] = [
  { days: 3, n: 3 },
  { days: 7, n: 7 },
];
/** «Награды по пути» (рисует код, выдаёт бот): на скольких контрамарках что открывается. */
export const MILESTONES: readonly { at: number; id: 'sticker' | 'badge' | 'effect' }[] = [
  { at: 10, id: 'sticker' },
  { at: 30, id: 'badge' },
  { at: 60, id: 'effect' },
];

/** Что сделал игрок в одном матче — из итогов дублей (их же видит фильм матча, после матча это не секрет). */
export interface PremiereFacts {
  won: boolean;
  /** «Чистая работа»: дублей, где игрок вырезал актёра и ни разу не промахнулся по боту (и не попался шефу). */
  clean: number;
  /** Верных меток «?» из-за кадра. */
  accused: number;
  /** Вырезанных актёров (других игроков). */
  cuts: number;
  /** Дублей, которые игрок дожил до конца. */
  survived: number;
  /** Собрал звёзды в дубле (победа звёздами). */
  stars: boolean;
  /** Награды дублей (id из awards.ts). */
  awards: string[];
  /** Площадки дублей (id из themes.ts). */
  themes: string[];
}

export type FactsRound = Pick<RoundSummary, 'reveal' | 'accusations' | 'awards' | 'starWinner' | 'kills'> & {
  rec?: Pick<RoundRecording, 'log' | 'players' | 'theme'>;
};

/** Факты матча для игрока `pid`. */
export function premiereFacts(pid: string, rounds: readonly FactsRound[], match: Pick<MatchSummary, 'winners'>): PremiereFacts {
  const f: PremiereFacts = { won: match.winners.includes(pid), clean: 0, accused: 0, cuts: 0, survived: 0, stars: false, awards: [], themes: [] };
  const awards = new Set<string>();
  const themes = new Set<string>();
  for (const r of rounds) {
    const me = r.reveal.find((x) => x.pid === pid);
    if (!me) continue;
    if (me.alive) f.survived++;
    f.accused += r.accusations.filter((a) => a.pid === pid && a.correct).length;
    const players = new Set(r.reveal.map((x) => x.eid));
    const cuts = (r.kills ?? []).filter((k) => k.by === me.eid && players.has(k.victim)).length;
    f.cuts += cuts;
    if (r.starWinner === pid) f.stars = true;
    for (const a of r.awards) if (a.pids.includes(pid)) awards.add(a.id);
    if (r.rec) {
      const id = THEME_RULES[r.rec.theme]?.id;
      if (id) themes.add(id);
      // метка — промах по боту или пойман шефом (match.ts › attack, bossCatch)
      if (cuts > 0 && !r.rec.log.some((e) => e.t === 'mark' && e.eid === me.eid)) f.clean++;
    }
  }
  f.awards = [...awards];
  f.themes = [...themes];
  return f;
}

/** Задание: прогресс за матч (сколько прибавить), сколько нужно, сколько контрамарок даёт. */
export interface PremiereTask {
  id: string;
  scope: 'day' | 'week';
  goal: number;
  reward: number;
  /** Прибавка за матч. Задания недели «разные площадки / награды» считает `progressOf` по накопленным спискам. */
  add?: (f: PremiereFacts, m: MatchCtx) => number;
}

/** Что ещё о матче знает сервер (не из итогов дублей). */
export interface MatchCtx {
  /** Игрок собрал эту комнату режиссёром, и в ней было 4 человека. */
  directed: boolean;
  /** Сколько людей в матче впервые сыграли с этим игроком за сезон. */
  newFaces: number;
}

/** Задания дня: выполняются обычной хорошей игрой и не портят матч другим. Тексты — словари (`premiere.tasks`). */
export const DAY_TASKS: readonly PremiereTask[] = [
  { id: 'clean', scope: 'day', goal: 1, reward: 2, add: (f) => f.clean },
  { id: 'accuse', scope: 'day', goal: 1, reward: 2, add: (f) => f.accused },
  { id: 'ninja', scope: 'day', goal: 1, reward: 2, add: (f) => (f.awards.includes('ninja') ? 1 : 0) },
  { id: 'botlike', scope: 'day', goal: 1, reward: 2, add: (f) => (f.awards.includes('botlike') ? 1 : 0) },
  { id: 'stars', scope: 'day', goal: 1, reward: 2, add: (f) => (f.stars ? 1 : 0) },
  { id: 'cuts', scope: 'day', goal: 3, reward: 2, add: (f) => f.cuts },
  { id: 'win', scope: 'day', goal: 1, reward: 3, add: (f) => (f.won ? 1 : 0) },
  { id: 'survive', scope: 'day', goal: 4, reward: 2, add: (f) => f.survived },
];

export const WEEK_TASKS: readonly PremiereTask[] = [
  { id: 'themes', scope: 'week', goal: 5, reward: 5 },
  { id: 'awards', scope: 'week', goal: 4, reward: 5 },
  { id: 'director', scope: 'week', goal: 3, reward: 6, add: (_f, m) => (m.directed ? 1 : 0) },
  { id: 'faces', scope: 'week', goal: 3, reward: 5, add: (_f, m) => m.newFaces },
];

const TASKS = new Map([...DAY_TASKS, ...WEEK_TASKS].map((t) => [t.id, t]));
export const premiereTask = (id: string) => TASKS.get(id);

/** Зерно из строки (для выбора заданий дня): одинаковые задания у всех в этот день. */
function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function pick<T>(list: readonly T[], n: number, seed: string): T[] {
  const rng = new Rng(seedOf(seed));
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/** Три задания дня — одинаковые у всех (их можно обсуждать в канале). */
export const dayTasks = (day: string) => pick(DAY_TASKS, 3, 'day:' + day);
/** Задания недели — три из четырёх, тоже у всех одинаковые. */
export const weekTasks = (week: number) => pick(WEEK_TASKS, 3, 'week:' + week);

/** Учёт игрока за сезон (хранит сервер как JSON). Сбрасываемое — по ключам дня и недели. */
export interface PremiereState {
  tickets: number;
  day: string;
  /** Матчей с базовой контрамаркой сегодня. */
  dayBase: number;
  week: number;
  /** Прогресс заданий текущих дня и недели: id → сколько. */
  prog: Record<string, number>;
  /** Выполненные задания текущих дня и недели. */
  done: string[];
  /** Разные площадки и награды недели. */
  themes: string[];
  awards: string[];
  /** Серия: последний день с матчем и длина серии; за какие длины в этой серии уже выдано. */
  streakDay: string;
  streak: number;
  streakPaid: number[];
  /** С кем уже играл за сезон (id Telegram, не больше `SEEN_MAX`). */
  seen: number[];
  /** Пришёл по ссылке друга: его id Telegram; сколько своих матчей сыграл; засчитан ли другу. */
  refBy?: number;
  refMatches: number;
  refPaid?: boolean;
  /** Друзей засчитано; контрамарок получено долей с друзей. */
  friends: number;
  shared: number;
}

export const SEEN_MAX = 300;

export const newPremiere = (): PremiereState => ({
  tickets: 0,
  day: '',
  dayBase: 0,
  week: -1,
  prog: {},
  done: [],
  themes: [],
  awards: [],
  streakDay: '',
  streak: 0,
  streakPaid: [],
  seen: [],
  refMatches: 0,
  friends: 0,
  shared: 0,
});

export type GainReason = 'match' | 'shift' | 'streak' | 'task' | 'friend' | 'share';
export interface Gain {
  reason: GainReason;
  n: number;
  /** Задание или длина серии. */
  ref?: string;
}

const prevDay = (day: string) => new Date(Date.parse(day + 'T00:00:00Z') - DAY).toISOString().slice(0, 10);

/** Привести состояние к текущим суткам и неделе: прогресс прошлых — в архив (просто сбросить). */
export function rollPremiere(s: PremiereState, now: number): PremiereState {
  const day = premiereDay(now);
  const week = premiereWeek(now);
  const out = { ...s, prog: { ...s.prog }, done: [...s.done] };
  if (out.day !== day) {
    for (const t of DAY_TASKS) {
      delete out.prog[t.id];
      out.done = out.done.filter((x) => x !== t.id);
    }
    out.day = day;
    out.dayBase = 0;
  }
  if (out.week !== week) {
    for (const t of WEEK_TASKS) {
      delete out.prog[t.id];
      out.done = out.done.filter((x) => x !== t.id);
    }
    out.week = week;
    out.themes = [];
    out.awards = [];
  }
  return out;
}

/**
 * Засчитать матч игроку. `others` — id Telegram других людей в матче (матч засчитан, если вместе с игроком
 * их не меньше `PREMIERE_MIN_TG`). Вне сезона — ничего. Возвращает новое состояние и что начислено.
 */
export function premiereMatch(prev: PremiereState, f: PremiereFacts, ctx: { others: number[]; directed: boolean }, now: number): { state: PremiereState; gains: Gain[] } {
  if (premierePhase(now) !== 'on' || ctx.others.length + 1 < PREMIERE_MIN_TG) return { state: prev, gains: [] };
  const s = rollPremiere(prev, now);
  const gains: Gain[] = [];
  const day = s.day;
  const mul = day >= PREMIERE.double ? 2 : 1;

  if (s.dayBase < BASE_PER_DAY) {
    s.dayBase++;
    gains.push({ reason: 'match', n: 1 });
  }
  // смена: первый матч дня; серия дней подряд
  if (s.streakDay !== day) {
    gains.push({ reason: 'shift', n: 1 });
    if (s.streakDay === prevDay(day)) s.streak++;
    else {
      s.streak = 1;
      s.streakPaid = [];
    }
    s.streakDay = day;
    for (const r of STREAK_REWARDS) {
      if (s.streak >= r.days && !s.streakPaid.includes(r.days)) {
        s.streakPaid = [...s.streakPaid, r.days];
        gains.push({ reason: 'streak', n: r.n, ref: String(r.days) });
      }
    }
  }

  const seen = new Set(s.seen);
  const fresh = ctx.others.filter((x) => !seen.has(x));
  s.seen = [...s.seen, ...fresh].slice(-SEEN_MAX);
  s.themes = [...new Set([...s.themes, ...f.themes])];
  s.awards = [...new Set([...s.awards, ...f.awards])];
  const m: MatchCtx = { directed: ctx.directed, newFaces: fresh.length };

  const active = [...dayTasks(day), ...weekTasks(s.week)];
  for (const t of active) {
    if (s.done.includes(t.id)) continue;
    const p = t.id === 'themes' ? s.themes.length : t.id === 'awards' ? s.awards.length : (s.prog[t.id] ?? 0) + (t.add?.(f, m) ?? 0);
    s.prog[t.id] = Math.min(p, t.goal);
    if (p >= t.goal) {
      s.done = [...s.done, t.id];
      gains.push({ reason: 'task', n: t.scope === 'day' ? t.reward * mul : t.reward, ref: t.id });
    }
  }

  if (s.refBy !== undefined) s.refMatches++;
  s.tickets += gains.reduce((a, g) => a + g.n, 0);
  return { state: s, gains };
}

/** Друг сыграл свои `FRIEND_MATCHES` матчей: засчитать его пригласившему (один раз, не больше `FRIEND_MAX`). */
export function premiereFriend(s: PremiereState): { state: PremiereState; gains: Gain[] } {
  if (s.friends >= FRIEND_MAX) return { state: s, gains: [] };
  return { state: { ...s, friends: s.friends + 1, tickets: s.tickets + FRIEND_REWARD }, gains: [{ reason: 'friend', n: FRIEND_REWARD }] };
}

/**
 * Доля с друга: `SHARE_PCT` процентов от того, что друг получил за игру (без своих друзей и долей — без пирамиды).
 * Копится дробно на стороне друга нельзя — берём целую часть от его прибавки, но не меньше 0 и не выше `SHARE_MAX` за сезон.
 */
export function premiereShare(s: PremiereState, friendGains: readonly Gain[]): { state: PremiereState; gains: Gain[] } {
  const played = friendGains.filter((g) => g.reason !== 'friend' && g.reason !== 'share').reduce((a, g) => a + g.n, 0);
  const n = Math.min(Math.floor((played * SHARE_PCT) / 100), SHARE_MAX - s.shared);
  if (n <= 0) return { state: s, gains: [] };
  return { state: { ...s, shared: s.shared + n, tickets: s.tickets + n }, gains: [{ reason: 'share', n }] };
}

/** Друг засчитывается пригласившему, когда сыграл нужное число матчей (и ещё не засчитан). */
export const friendReady = (s: PremiereState) => s.refBy !== undefined && !s.refPaid && s.refMatches >= FRIEND_MATCHES;
