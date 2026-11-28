import { createHash } from 'node:crypto';

/**
 * Жеребьёвка «Новогодней премьеры» (31.12): честно и проверяемо.
 *
 * 1. Заморозка (30.12 после конца сезона, кнопка premiere-draw › freeze): список участников — у кого ≥ 5
 *    контрамарок и подписка на канал — строками `<id> <контрамарки>` по возрастанию id. В канал публикуем
 *    SHA-256 этого текста и номер будущего раунда drand (публичный маяк случайности, https://drand.love).
 * 2. Розыгрыш (31.12 после того раунда, кнопка › draw): случайность раунда → победители. Подменить список
 *    после публикации хеша нельзя, угадать случайность заранее — тоже.
 * 3. Проверка: любой с тем же списком и раундом получает тех же победителей (`drawWinners`, без сети).
 *
 * Шанс пропорционален контрамаркам; один человек выигрывает не больше одного приза.
 */

export interface Entrant {
  tg: number;
  tickets: number;
}

/** Призы по порядку вытягивания: первый — 12 месяцев, затем пять по 3 месяца (7500 ⭐: 2500 + 5×1000). */
export const PRIZES: readonly { months: 3 | 6 | 12; stars: number }[] = [
  { months: 12, stars: 2500 },
  { months: 3, stars: 1000 },
  { months: 3, stars: 1000 },
  { months: 3, stars: 1000 },
  { months: 3, stars: 1000 },
  { months: 3, stars: 1000 },
];

/** Канонический текст списка: его хеш публикуется заранее. */
export function entrantsText(list: readonly Entrant[]): string {
  return [...list]
    .sort((a, b) => a.tg - b.tg)
    .map((e) => `${e.tg} ${e.tickets}`)
    .join('\n');
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Главная цепочка drand (League of Entropy): раунд каждые 30 с от генезиса. */
export const DRAND = {
  url: 'https://api.drand.sh/public/',
  genesis: 1595431050,
  period: 30,
} as const;

/** Первый раунд drand, выпущенный не раньше `ms`. */
export function drandRound(ms: number): number {
  return Math.max(1, Math.ceil((ms / 1000 - DRAND.genesis) / DRAND.period) + 1);
}

/** Время выхода раунда (мс). */
export const drandTime = (round: number) => (DRAND.genesis + (round - 1) * DRAND.period) * 1000;

/**
 * Победители: k-й приз — число u = первые 13 hex-цифр SHA-256(`<randomness>:<k>`) / 16^13 из [0, 1);
 * шагаем по оставшимся участникам (по возрастанию id), пока сумма контрамарок не превысит u × всего.
 * Вытянутый выбывает. Участников меньше призов — призов меньше.
 */
export function drawWinners(list: readonly Entrant[], randomness: string, n = PRIZES.length): number[] {
  if (!/^[0-9a-f]{64}$/.test(randomness)) throw new Error('bad_randomness');
  const left = [...list].filter((e) => e.tickets > 0).sort((a, b) => a.tg - b.tg);
  const out: number[] = [];
  for (let k = 0; k < n && left.length; k++) {
    const u = parseInt(sha256(`${randomness}:${k}`).slice(0, 13), 16) / 16 ** 13;
    const total = left.reduce((a, e) => a + e.tickets, 0);
    let x = u * total;
    let i = 0;
    while (i < left.length - 1 && x >= left[i].tickets) x -= left[i++].tickets;
    out.push(left[i].tg);
    left.splice(i, 1);
  }
  return out;
}

/** Состояние розыгрыша в базе (одна запись на сезон). */
export interface DrawRecord {
  frozenAt: number;
  list: Entrant[];
  digest: string;
  round: number;
  randomness?: string;
  winners?: number[];
  /** Кому Premium уже подарен (id → время): повторный запуск не дарит дважды. */
  gifted?: Record<string, number>;
}
