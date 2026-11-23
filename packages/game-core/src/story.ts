/**
 * Сюжет матча для финала «Фильма матча» (film.ts): по итогам дублей — как была выиграна игра.
 * Эвристика: у каждого сюжета есть условие и сила; берётся самый сильный (при равенстве — более
 * драматичный, он раньше в списке). Детерминированно: один матч — одна история.
 *
 *   comeback — победитель отставал на STORY_COMEBACK очков и больше, но выиграл («Камбэк матча»);
 *   photo    — разница первого и второго места ≤ 1 очка («Фотофиниш»);
 *   duel     — победитель и соперник вырезали друг друга ≥ 4 раз, и победитель — чаще («Дуэль матча»);
 *   hunter   — победитель вырезал ≥ 4 актёров и не меньше половины всех вырезаний («Гроза площадки»);
 *   ghost    — победителя ни разу не вырезали и не раскрыли ударом по массовке («Невидимка»);
 *   runaway  — победитель лидировал после каждого дубля («Без шансов»);
 *   star     — ничего яркого: просто «Звезда фильма».
 */
export type StoryKind = 'comeback' | 'photo' | 'duel' | 'hunter' | 'ghost' | 'runaway' | 'star';

/** Итоги одного дубля для сюжета: очки за дубль, кто кого вырезал (игроки), удары по массовке. */
export interface StoryRound {
  points: Record<string, number>;
  kills: { by: string; victim: string }[];
  botHits: Record<string, number>;
}

export interface MatchStory {
  kind: StoryKind;
  /** Герой истории — победитель. */
  hero: string;
  /** Соперник: второе место (фотофиниш), противник в дуэли. */
  rival?: string;
  /** Главная цифра сюжета: отставание, разница очков, вырезано; в дуэли — вырезал герой. */
  value: number;
  /** Дуэль: сколько раз соперник вырезал героя. */
  value2?: number;
  /** Кого вырезал герой (по порядку, для «Грозы площадки»). */
  victims: string[];
  /** Очки каждого после каждого дубля (с нулём в начале) — график «гонки» в финале. */
  history: Record<string, number[]>;
  /** Дубль (1…), где отставание героя было самым большим (камбэк). */
  lowRound?: number;
}

export const STORY_COMEBACK = 3;
const HUNTER_MIN = 4;
const DUEL_MIN = 4;

/**
 * Сюжет матча. pids — все игроки, winners — победители матча (первый — герой), tooAlive — «Слишком
 * заметные» (победителя нет). null — дублей нет.
 */
export function matchStory(rounds: readonly StoryRound[], pids: readonly string[], winners: readonly string[], tooAlive = false): MatchStory | null {
  if (!rounds.length || !pids.length) return null;
  const history: Record<string, number[]> = {};
  for (const p of pids) {
    const h = [0];
    for (const r of rounds) h.push(h[h.length - 1] + (r.points[p] ?? 0));
    history[p] = h;
  }
  const final = (p: string) => history[p][rounds.length];
  const byScore = [...pids].sort((a, b) => final(b) - final(a) || pids.indexOf(a) - pids.indexOf(b));
  const hero = !tooAlive && winners[0] && pids.includes(winners[0]) ? winners[0] : byScore[0];
  const others = pids.filter((p) => p !== hero);
  const kills = rounds.flatMap((r) => r.kills);
  const victims = kills.filter((k) => k.by === hero).map((k) => k.victim);
  const base: MatchStory = { kind: 'star', hero, value: 0, victims, history };
  if (tooAlive || !others.length) return base;

  type Cand = { s: number; story: MatchStory };
  const cands: Cand[] = [];
  const n = rounds.length;

  // камбэк: самое большое отставание от лидера по ходу матча (кроме финального счёта)
  let deficit = 0;
  let low = 0;
  for (let i = 1; i < n; i++) {
    const lead = Math.max(...others.map((p) => history[p][i]));
    const d = lead - history[hero][i];
    if (d > deficit) {
      deficit = d;
      low = i;
    }
  }
  if (deficit >= STORY_COMEBACK) cands.push({ s: 10 + deficit, story: { ...base, kind: 'comeback', value: deficit, lowRound: low } });

  // фотофиниш: второе место в очке (или вровень — победил по звёздам и выбиваниям)
  const second = byScore.find((p) => p !== hero)!;
  const margin = final(hero) - final(second);
  if (n >= 3 && margin <= 1) cands.push({ s: 9 + (1 - margin), story: { ...base, kind: 'photo', rival: second, value: Math.max(0, margin) } });

  // дуэль: герой и соперник вырезали друг друга
  let duel: { p: string; a: number; b: number } | null = null;
  for (const p of others) {
    const a = kills.filter((k) => k.by === hero && k.victim === p).length;
    const b = kills.filter((k) => k.by === p && k.victim === hero).length;
    // в финале герой добивает соперника — дуэль должна быть за ним
    if (b >= 1 && a > b && a + b >= DUEL_MIN && (!duel || a + b > duel.a + duel.b)) duel = { p, a, b };
  }
  if (duel) cands.push({ s: 8 + duel.a + duel.b, story: { ...base, kind: 'duel', rival: duel.p, value: duel.a, value2: duel.b } });

  // гроза площадки: больше всех вырезаний — и половина всех
  if (victims.length >= HUNTER_MIN && victims.length * 2 >= kills.length) cands.push({ s: 7 + victims.length, story: { ...base, kind: 'hunter', value: victims.length } });

  // невидимка: ни разу не вырезан и не раскрыт ударом по массовке
  const died = kills.some((k) => k.victim === hero);
  const exposed = rounds.some((r) => (r.botHits[hero] ?? 0) > 0);
  if (n >= 3 && !died && !exposed) cands.push({ s: 6 + n * 0.1, story: { ...base, kind: 'ghost', value: n } });

  // без шансов: лидер (единолично) после каждого дубля
  let led = true;
  for (let i = 1; i <= n && led; i++) led = others.every((p) => history[p][i] < history[hero][i]);
  if (n >= 2 && led) cands.push({ s: 5 + n * 0.1, story: { ...base, kind: 'runaway', value: n } });

  let best: Cand | null = null;
  for (const c of cands) if (!best || c.s > best.s) best = c;
  return best ? best.story : base;
}
