/**
 * Новогодний сезон: с 1 декабря по 14 января меню праздничное (снег, колпаки, гирлянда)
 * и музыка меню — с бубенцами. Мотив общий с темой «Корпоратив» (themes/party.ts), чтобы
 * меню и дубль звучали как одна песня.
 *
 * Посмотреть вне сезона: `?season=ny` (выключить в сезоне — `?season=off`); выбор помнится
 * до закрытия вкладки.
 */
export function newYearSeason(d = new Date()): boolean {
  if (typeof window !== 'undefined') {
    try {
      const q = new URLSearchParams(location.search).get('season');
      if (q === 'ny' || q === 'off') sessionStorage.setItem('kto:season', q);
      const s = sessionStorage.getItem('kto:season');
      if (s === 'ny') return true;
      if (s === 'off') return false;
    } catch {
      /* приватный режим: по дате */
    }
  }
  const m = d.getMonth();
  return m === 11 || (m === 0 && d.getDate() <= 14);
}

// ───────────── общий мотив (соль мажор: G – Em – Am – D; мелодия своя) ─────────────

export const NY_ROOTS = [43, 40, 45, 38]; // G2 E2 A2 D2
export const NY_TRIADS = [[0, 4, 7], [0, 3, 7], [0, 3, 7], [0, 4, 7]];
/** Мелодия по тактам круга: [шестнадцатая, нота MIDI, длительность в шестнадцатых]. */
export const NY_MELODY: [number, number, number][][] = [
  [[0, 74, 2], [2, 71, 2], [4, 74, 2], [6, 79, 6], [12, 78, 2], [14, 76, 2]],
  [[0, 76, 4], [4, 79, 2], [6, 76, 2], [8, 71, 6], [14, 74, 2]],
  [[0, 72, 2], [2, 76, 2], [4, 81, 4], [8, 79, 2], [10, 76, 2], [12, 72, 4]],
  [[0, 74, 2], [2, 78, 2], [4, 81, 2], [6, 78, 2], [8, 74, 6], [14, 69, 2]],
];

export function nyMelodyAt(ch: number, s: number): [number, number] | null {
  const n = NY_MELODY[ch].find((e) => e[0] === s);
  return n ? [n[1], n[2]] : null;
}
