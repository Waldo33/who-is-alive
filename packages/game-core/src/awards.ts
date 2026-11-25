import type { AwardId } from './locale';

export interface AwardCard {
  id: AwardId;
  pids: string[];
  value: number;
}

export interface RoundStats {
  pid: string;
  alive: boolean;
  diedAtFromStart: number | null;
  kills: number;
  killTimes: number[];
  botHits: number;
  stars: number;
  accused: number | null;
  accuseCorrect: boolean;
  accusedAsGhost: boolean;
  timesAccused: number;
  /** Выговоров от шефа за дубль (офис). */
  reprimands?: number;
}

export interface AwardContext {
  stats: RoundStats[];
  /** Самая длинная серия «рядом» для пары живых, мс. */
  neighbors: { a: string; b: string; ms: number; hit: boolean }[];
  crowdShowTimes: number[];
  plannedPlayEnd: number;
}

/** Порядок = приоритет (таблица в разделе 7). Не больше 2 карточек за раунд. */
export function pickRoundAwards(ctx: AwardContext, max = 2): AwardCard[] {
  const out: AwardCard[] = [];
  const add = (c: AwardCard | null) => {
    if (c && out.length < max) out.push(c);
  };
  const s = ctx.stats;

  // офис: больше всех выговоров от шефа — на виду у всех (решение владельца: строка в итогах)
  const rep = [...s].filter((p) => (p.reprimands ?? 0) > 0).sort((a, b) => (b.reprimands ?? 0) - (a.reprimands ?? 0))[0];
  add(rep ? { id: 'reprimand', pids: [rep.pid], value: rep.reprimands! } : null);

  const nb = ctx.neighbors.filter((n) => !n.hit && n.ms >= 8000).sort((a, b) => b.ms - a.ms)[0];
  add(nb ? { id: 'blindNeighbors', pids: [nb.a, nb.b], value: Math.floor(nb.ms / 1000) } : null);

  const ninja = s.find((p) =>
    p.killTimes.some(
      (t) => ctx.crowdShowTimes.some((c) => t >= c && t - c <= 2000) || ctx.plannedPlayEnd - t <= 3000,
    ),
  );
  add(ninja ? { id: 'ninja', pids: [ninja.pid], value: ninja.kills } : null);

  const para = [...s].filter((p) => p.botHits >= 2).sort((a, b) => b.botHits - a.botHits)[0];
  add(para ? { id: 'paranoid', pids: [para.pid], value: para.botHits } : null);

  const bot = s.find((p) => p.alive && p.timesAccused === 0);
  add(bot ? { id: 'botlike', pids: [bot.pid], value: 0 } : null);

  const greedy = [...s].filter((p) => p.stars >= 2).sort((a, b) => b.stars - a.stars)[0];
  add(greedy ? { id: 'greedy', pids: [greedy.pid], value: greedy.stars } : null);

  const kami = s.find((p) => p.diedAtFromStart !== null && p.diedAtFromStart <= 10000);
  add(kami ? { id: 'kamikaze', pids: [kami.pid], value: Math.max(1, Math.round(kami.diedAtFromStart! / 1000)) } : null);

  const clair = s.find((p) => p.accuseCorrect && p.accusedAsGhost);
  add(clair ? { id: 'clairvoyant', pids: [clair.pid], value: 0 } : null);

  return out;
}

const PRIORITY: AwardId[] = ['reprimand', 'blindNeighbors', 'ninja', 'paranoid', 'botlike', 'greedy', 'kamikaze', 'clairvoyant'];

/** Награды матча: главный охотник + самая частая награда раунда. */
export function pickMatchAwards(rounds: AwardCard[][], killsByPid: Record<string, number>): AwardCard[] {
  const out: AwardCard[] = [];
  const hunter = Object.entries(killsByPid).sort((a, b) => b[1] - a[1])[0];
  if (hunter && hunter[1] > 0) out.push({ id: 'topHunter', pids: [hunter[0]], value: hunter[1] });
  const counts = new Map<string, { card: AwardCard; n: number }>();
  for (const cards of rounds) {
    for (const c of cards) {
      const key = c.id + ':' + c.pids.join(',');
      const cur = counts.get(key);
      if (cur) {
        cur.n++;
        cur.card = { ...c, value: Math.max(cur.card.value, c.value) };
      } else counts.set(key, { card: c, n: 1 });
    }
  }
  const best = [...counts.values()].sort(
    (a, b) => b.n - a.n || PRIORITY.indexOf(a.card.id) - PRIORITY.indexOf(b.card.id),
  )[0];
  if (best && out.length < 2) out.push(best.card);
  return out;
}
