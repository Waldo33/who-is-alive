import type { RoundSummary } from './match';
import { tp } from './locale';
import type { Dict, Lang } from './locale';

/** Свой итог дубля для строки шаринга. */
export type RoundOutcome = 'win' | 'alive' | 'cut';

/** Квадрат на дубль: жёлтый — выиграл (3 звезды или последний в кадре), зелёный — дожил, красный — вырезан. */
export const OUTCOME_SQUARE: Record<RoundOutcome, string> = { win: '🟨', alive: '🟩', cut: '🟥' };

/** Итог дубля для игрока — только по своей строке разоблачения (чужие роли не нужны). */
export function roundOutcome(s: RoundSummary, pid: string): RoundOutcome | null {
  const r = s.reveal.find((x) => x.pid === pid);
  if (!r) return null;
  if (s.starWinner === pid || (s.endReason === 'last_alive' && r.alive)) return 'win';
  return r.alive ? 'alive' : 'cut';
}

/**
 * Текст «Поделиться» итогом матча: «Массовка · имя — N очков», строка квадратов, призыв.
 * В строке только свои итоги: квадраты не выдают, кто был живым.
 */
export function matchShareText(t: Dict, lang: Lang, o: { name: string; score: number; rounds: readonly (RoundOutcome | null)[] }): string {
  return tp(lang, t.share.text, 0, {
    title: t.meta.title,
    name: o.name,
    points: tp(lang, t.share.points, o.score),
    squares: o.rounds.map((r) => (r ? OUTCOME_SQUARE[r] : '⬛')).join(''),
    cta: t.share.cta,
  });
}
