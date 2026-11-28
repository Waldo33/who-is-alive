import {
  FRIEND_MATCHES,
  FRIEND_MAX,
  MILESTONES,
  PREMIERE,
  PREMIERE_ENTRY,
  PREMIERE_MIN_TG,
  SHARE_MAX,
  STREAK_REWARDS,
  dayTasks,
  friendReady,
  newPremiere,
  premiereDay,
  premiereFriend,
  premiereMatch,
  premierePhase,
  premiereShare,
  premiereWeek,
  rollPremiere,
  weekTasks,
} from '@kto/game-core';
import type { Gain, PremiereFacts, PremiereState } from '@kto/game-core';
import type { Store, TgLink } from './store';

/**
 * «Новогодняя премьера» на сервере: после матча — контрамарки людям с Telegram (правила — game-core/premiere.ts),
 * экран «Съёмочный план» (`/tg/shop/premiere`) и привязка друга по ссылке. Всё считает сервер по итогам матча;
 * с телефона берётся только, кто ты (initData Telegram) и чья ссылка тебя привела.
 */

export type PremiereStore = Pick<Store, 'premiere' | 'premiereUpdate' | 'tgStats'>;

const logOf = (gains: Gain[]) => gains.map((g) => ({ reason: g.reason, n: g.n, ...(g.ref ? { ref: g.ref } : {}) }));

/** Матч сыгран: начислить всем людям с Telegram. Возвращает, сколько контрамарок раздано (для журнала). */
export async function premiereAfterMatch(
  store: PremiereStore,
  links: readonly TgLink[],
  m: { director: string | null; facts?: Record<string, PremiereFacts> },
  now: number,
): Promise<number> {
  if (premierePhase(now) !== 'on' || !m.facts) return 0;
  // один аккаунт Telegram на двух телефонах — один игрок
  const byTg = new Map<number, string[]>();
  for (const l of links) byTg.set(l.tgUser, [...(byTg.get(l.tgUser) ?? []), l.gameUser]);
  if (byTg.size < PREMIERE_MIN_TG) return 0;
  let total = 0;
  for (const [tg, pids] of byTg) {
    const pid = pids.find((p) => m.facts![p]);
    if (!pid) continue;
    const others = [...byTg.keys()].filter((x) => x !== tg);
    const directed = m.director !== null && pids.includes(m.director);
    let gains: Gain[] = [];
    let after: PremiereState | null = null;
    after = await store.premiereUpdate(tg, (s) => {
      const r = premiereMatch(s ?? newPremiere(), m.facts![pid], { others, directed }, now);
      gains = r.gains;
      return r.gains.length || s ? { state: r.state, log: logOf(r.gains) } : null;
    });
    total += gains.reduce((a, g) => a + g.n, 0);
    if (!after || after.refBy === undefined) continue;
    const ref = after.refBy;
    // друг сыграл свои матчи — засчитать пригласившему (отметка у друга — в той же логике, без повторов)
    if (friendReady(after)) {
      await store.premiereUpdate(tg, (s) => (s && friendReady(s) ? { state: { ...s, refPaid: true }, log: [] } : null));
      await store.premiereUpdate(ref, (s) => {
        const r = premiereFriend(s ?? newPremiere());
        return r.gains.length ? { state: r.state, log: logOf(r.gains) } : null;
      });
    }
    // доля с друга — с того, что он получил за игру
    const played = gains;
    if (played.length) {
      await store.premiereUpdate(ref, (s) => {
        const r = premiereShare(s ?? newPremiere(), played);
        return r.gains.length ? { state: r.state, log: logOf(r.gains) } : null;
      });
    }
  }
  return total;
}

/**
 * Игрок открыл игру по ссылке друга (`startapp=ref_<id>`). Засчитываем, только если он новичок: ещё не играл
 * и не привязан к другому другу; себя пригласить нельзя. После сезона — не привязываем.
 */
export async function bindPremiereRef(store: PremiereStore, tgUser: number, ref: number, now: number): Promise<boolean> {
  if (!Number.isSafeInteger(ref) || ref <= 0 || ref === tgUser || premierePhase(now) === 'after') return false;
  const stats = await store.tgStats(tgUser);
  if (stats.matches > 0) return false;
  let bound = false;
  await store.premiereUpdate(tgUser, (s) => {
    if (s && s.refBy !== undefined) return null;
    bound = true;
    return { state: { ...(s ?? newPremiere()), refBy: ref }, log: [] };
  });
  return bound;
}

/** Экран «Съёмочный план»: счёт, задания с прогрессом, серия, друзья. */
export async function premiereView(store: PremiereStore, tgUser: number, now: number, subscribed: boolean) {
  const raw = (await store.premiere(tgUser)) ?? newPremiere();
  const phase = premierePhase(now);
  const s = phase === 'on' ? rollPremiere(raw, now) : raw;
  const day = premiereDay(now);
  const week = Math.max(0, premiereWeek(now));
  const task = (t: { id: string; goal: number; reward: number; scope: 'day' | 'week' }) => ({
    id: t.id,
    goal: t.goal,
    reward: t.scope === 'day' && day >= PREMIERE.double ? t.reward * 2 : t.reward,
    progress: Math.min(s.prog[t.id] ?? (t.id === 'themes' ? s.themes.length : t.id === 'awards' ? s.awards.length : 0), t.goal),
    done: s.done.includes(t.id),
  });
  // серия жива, если последний матч — сегодня или вчера
  const yesterday = premiereDay(now - 86400_000);
  const streak = s.streakDay === day || s.streakDay === yesterday ? s.streak : 0;
  return {
    phase,
    season: PREMIERE,
    tickets: s.tickets,
    entry: PREMIERE_ENTRY,
    subscribed,
    entered: s.tickets >= PREMIERE_ENTRY && subscribed,
    double: day >= PREMIERE.double,
    day: phase === 'on' ? dayTasks(day).map(task) : [],
    week: phase === 'on' ? weekTasks(week).map(task) : [],
    streak,
    playedToday: s.streakDay === day,
    streakRewards: STREAK_REWARDS,
    friends: s.friends,
    friendsMax: FRIEND_MAX,
    friendMatches: FRIEND_MATCHES,
    shared: s.shared,
    sharedMax: SHARE_MAX,
    milestones: MILESTONES.map((x) => ({ ...x, open: s.tickets >= x.at })),
  };
}
