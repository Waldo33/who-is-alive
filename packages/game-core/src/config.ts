/**
 * Все числа баланса — в одном месте (раздел 16 ТЗ).
 * Хост рассылает итоговый конфиг в match_start, поэтому у всех клиентов он одинаковый.
 */
export const DEFAULT_CONFIG = {
  // арена и толпа
  logicalWidth: 180,
  logicalHeight: 320,
  arenaWidth: 180,
  arenaHeight: 260,
  navCellSize: 4, // пикс., сетка поиска пути
  entitiesTotal: 32, // игроки + боты
  entitySpeed: 18, // пикс./с, одинаково для всех

  // раунд и матч
  countdownSec: 3,
  roundSec: 75,
  accuseSec: 5,
  kidsAccuseSec: 8,
  // Разоблачение: барабанная дробь → повтор последних N с в ускорении → финальный кадр.
  // В ТЗ на всю фазу 8 с, но повтор 20 с ×2,5 сам длится 8 с, поэтому фаза = 1 + 8 + 3 = 12 с.
  revealDrumSec: 1,
  revealReplaySec: 20,
  revealSpeed: 2.5,
  revealFinalSec: 3,
  resultsSec: 5,
  autoNextSec: 10,
  // 8, а не 5 из ТЗ: по симуляции при 5 матч кончался за 2 раунда, при 8 — около 3,5 раунда и ~5 минут
  scoreToWin: 8,
  // дубль кончается, когда живым остался один (в пробном дубле — нет)
  endWhenLastAlive: true,
  maxRounds: 5,
  // тема всех дублей: -1 — случайный порядок (themes.ts); песочница: ?dev&theme=4
  fixedTheme: -1,

  // боты
  botWanderRadius: [20, 80] as [number, number],
  botPauseSec: [0.8, 3.0] as [number, number],
  botTargetWeights: { random: 0.7, interest: 0.2, star: 0.1 },
  botTurnChance: 0.15,
  botEmoteChance: 0.08,
  botCrowdReactMs: [0, 300] as [number, number],
  // статисты тоже хватают звёзды: подбор звезды — подозрение, а не доказательство
  botStarTakeChance: 0.25,
  // «Чудачества»: изредка бот ведёт себя как живой игрок — ложный след для охотников.
  // Частота — эпизодов в минуту на одного бота (28 ботов × 0,1 ≈ 3 эпизода за раунд).
  botQuirkPerMin: 0.1,
  botQuirkWeights: { zigzag: 0.3, stalker: 0.25, starRun: 0.2, emoteSpam: 0.15, late: 0.1 },

  // удары
  attackRange: 14,
  tapTolerance: 10,
  attacksPerRound: 3,
  attackConfirm: 'tap' as 'tap' | 'hold',
  holdMs: 250,
  missStunSec: 2,
  missMarkSec: 2,
  startleRadius: 24,
  startleSec: 0.5,
  startleStepPx: 4,

  // «Море волнуется»
  crowdCmdIntervalSec: [10, 15] as [number, number],
  // нарастание: к началу сужения интервал сжимается до этого (линейно по ходу дубля)
  crowdCmdIntervalEndSec: [5, 7] as [number, number],
  // «Толпа решает» (со 2-го дубля): команда без названия — угадай жест большинства.
  // За crowdMoodLeadMs до неё толпа «разогревается» нужным жестом — подсказка внимательным.
  // режиссёр жест больше не «прячет»: не названный жест загадывает только вырезанный «Хлопушкой» (решение владельца, 22.11.2026)
  crowdVoteChance: 0,
  crowdVoteMajority: 0.65, // доля ботов, выбравших жест большинства; остальные — вразнобой
  crowdMoodLeadMs: 3000,
  // Стоп-кадр: мир замирает и сереет, пока игроки выбирают команду.
  // Нажал во время паузы — выполнишь вместе с толпой; после паузы — опоздал, и это видно.
  crowdPauseMs: 1500,
  kidsPauseMs: 2500,
  crowdLateMs: 1000, // сколько после паузы ещё можно нажать (с опозданием)
  freezeSec: 2,
  jumpSec: 0.6,
  danceSec: 2,

  // «Хлопушка»: вырезанный сам подаёт команду толпе
  ghostClaps: 2,
  ghostClapCooldownSec: 12,

  // «Условия съёмки» (mods.ts): со 2-го дубля — случайное правило дубля
  roundMods: true,
  roundModChance: 0.75,

  // Прожектор режиссёра: кто не повторил названный жест (не нажал, не тот, опоздал) — над ним
  // круг, в котором ещё несколько человечков. Улика «где-то тут», а не указатель.
  spotSec: 2.5,
  spotRadius: 20,
  spotJitter: 11,

  // звёзды (3 по симуляции: статисты тоже берут звёзды, раунды по звёздам ~1/3)
  maxStars: 3,
  starRespawnSec: 6,
  starsToWin: 3,
  starPickupRadius: 6,

  // сужение
  zoneStartBeforeEndSec: 20,
  zoneShrinkSec: 15,
  zoneFinalAreaRatio: 0.5,

  // очки
  points: { kill: 1, survive: 1, stars: 2, accuse: 1 },

  // сеть
  hostTickHz: 20,
  cmdBatchMs: 200,
  snapEveryMs: 2000,
  renderDelayMs: 100,
  hostLostSec: 5,

  // режим для детей (настройка хоста)
  kidsMode: false,
  // «Жёсткие съёмки» (настройка комнаты): весь матч как «Жёсткий дубль» — не повторил названный жест толпы — вырезан
  strictCrowd: false,
};

export type GameConfig = typeof DEFAULT_CONFIG;

export function makeConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

export const TICK_MS = 50; // 20 Гц, фиксированный шаг симуляции

export function crowdPauseMs(cfg: GameConfig): number {
  return cfg.kidsMode ? cfg.kidsPauseMs : cfg.crowdPauseMs;
}

export function accuseMs(cfg: GameConfig): number {
  return (cfg.kidsMode ? cfg.kidsAccuseSec : cfg.accuseSec) * 1000;
}

export function revealMs(cfg: GameConfig): number {
  return (cfg.revealDrumSec + cfg.revealReplaySec / cfg.revealSpeed + cfg.revealFinalSec) * 1000;
}
