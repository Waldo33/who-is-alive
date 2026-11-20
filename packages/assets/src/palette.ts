/**
 * Палитра 32 цвета (кандидат — Endesga 32 с Lospec; лицензию подтвердить до релиза).
 * Все спрайты и интерфейс берут цвета только отсюда.
 */
export const PAL = {
  rust: '#be4a2f',
  clay: '#d77643',
  sand: '#ead4aa',
  tan: '#e4a672',
  brick: '#b86f50',
  umber: '#733e39',
  plum: '#3e2731',
  wine: '#a22633',
  red: '#e43b44',
  orange: '#f77622',
  amber: '#feae34',
  yellow: '#fee761',
  green: '#63c74d',
  forest: '#3e8948',
  pine: '#265c42',
  deep: '#193c3e',
  navy: '#124e89',
  blue: '#0099db',
  cyan: '#2ce8f5',
  white: '#ffffff',
  mist: '#c0cbdc',
  slate: '#8b9bb4',
  steel: '#5a6988',
  dusk: '#3a4466',
  night: '#262b44',
  ink: '#181425',
  magenta: '#ff0044',
  grape: '#68386c',
  orchid: '#b55088',
  coral: '#f6757a',
  peach: '#e8b796',
  fawn: '#c28569',
} as const;

export type PalName = keyof typeof PAL;

/** Цвета игроков: красный, синий, жёлтый, зелёный. */
export const PLAYER_COLORS = [PAL.red, PAL.blue, PAL.yellow, PAL.green] as const;

export function hexToInt(hex: string): number {
  return parseInt(hex.slice(1), 16);
}
