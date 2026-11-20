import { PAL } from '@kto/assets';

/**
 * Люди толпы: кожа и волосы. У темы с двумя обликами фигура с номером i — один и тот же человек
 * в обоих (меняется только одежда): костюмы облика идут в этом порядке (`chars`, затем `variants`).
 */
export const PEOPLE: { skin: [string, string]; hair: [string, string, string] | null }[] = [
  { skin: [PAL.peach, PAL.fawn], hair: [PAL.umber, PAL.plum, PAL.brick] }, // светлый, каштановые волосы
  { skin: [PAL.tan, PAL.fawn], hair: [PAL.night, PAL.ink, PAL.dusk] }, // загорелый брюнет
  { skin: [PAL.fawn, PAL.brick], hair: [PAL.ink, PAL.ink, PAL.night] }, // смуглый брюнет
  { skin: [PAL.brick, PAL.umber], hair: [PAL.ink, PAL.ink, PAL.night] }, // темнокожий
  { skin: [PAL.peach, PAL.fawn], hair: null }, // лысый
];

/** Цвета лица и головы человека i для карты букв персонажа (h H k r R — волосы, s S m c — лицо). */
export function face(i: number): Record<string, string> {
  const p = PEOPLE[i];
  const [s, S] = p.skin;
  const [h, H, k] = p.hair ?? [s, S, PAL.sand];
  return { s, S, m: S, c: s, h, H, k, r: p.hair ? h : s, R: p.hair ? H : S };
}

/** Кожа человека i — для рук и голых ног, которые видны в любом костюме. */
export function skin(i: number): string {
  return PEOPLE[i].skin[0];
}
