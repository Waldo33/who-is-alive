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
  // отдельного экрана обвинения нет с 23.11 (обвиняют вырезанные по ходу дубля); поля — для старых клиентов
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
  // тема первого дубля каждого матча: -1 — нет; в новогодний сезон — «Корпоратив» (seasonLeadTheme)
  leadTheme: -1,

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

  // Звёзды. Раньше все три лежали на поле с первой секунды, и «бегу по звёздам» выигрывал дубль за
  // секунды (у владельца: игра превратилась в «собери 3 звезды», 23.11.2026). Теперь на поле не больше
  // двух, в начале — одна, остальные появляются по одной (starRespawnSec): третью придётся ждать на виду.
  maxStars: 2,
  starsAtStart: 1,
  starRespawnSec: 6,
  starsToWin: 3,
  starPickupRadius: 6,

  // Рассудок («Купальская ночь», sanity.ts). Одиночка без цветов — на нуле к ~60-й с, в толпе — к ~75-й; дальше 4,5/с: дубль до последнего живого.
  // Симуляция (pnpm sim -- --cfg '{"fixedTheme":7}'): сгинули в тумане ~11% игроков, минимум в среднем ~50.
  sanityStart: 100,
  sanityDrainAtSec: [20, 45, 75] as number[], // границы сумерек, ночи, глухой ночи и «за полночь»
  sanityDrainRate: [0.9, 1.6, 2.8, 4.5] as number[], // ед./с в каждой части: к концу дубля в живых почти никого — побеждает последний
  sanityNightSec: 60, // за сколько секунд сумерки становятся ночью (облик)
  sanityStages: [70, 45, 25] as [number, number, number], // «Шёпот», «Морок», «Кошмар»
  sanityCrowdRadius: 20, // толпа рядом успокаивает
  sanityCrowdMin: 4, // сколько человечков рядом (кроме себя) — уже толпа
  sanityCrowdMul: 0.7,
  sanityFireRadius: 30, // у костра рассудок не падает, а растёт
  sanityFireGain: 0.6,
  sanityFireOutSec: 50, // к этой секунде костёр прогорает
  sanityFlower: 15,
  sanityFlowerSlow: 0.1, // каждый цветок в венке — падение на 10% медленнее
  sanityGesture: 5,
  sanitySlip: 8,
  sanityBotHit: 15,
  sanityNearCut: 5,
  sanityNearRadius: 24,
  // Кикиморы («Кошмар», рассудок ниже sanityStages[2]): видит только свой игрок
  kikiMoreAt: [15, 6] as [number, number], // ниже — вторая и третья
  kikiWarnMs: 1500, // рябь на воде до появления
  kikiGapMs: 3000, // не чаще одной новой
  kikiSpeed: [12, 16] as [number, number], // пикс./с у порога и на нуле (человечек — 18)
  kikiTouch: 6,
  kikiSpawnMinDist: 60,
  kikiHp: 2,
  kikiBanish: 15, // отбил — рассудок вернулся
  kikiDreadRadius: 30,
  kikiDreadMul: 1.5,
  // Купальские обряды (команды толпы в теме с рассудком)
  torchMs: 10000, // «Факел!» вовремя — столько горит факел после окна команды
  torchRadius: 24, // ближе света кикимора не подходит (и столько же на поле светлеет)
  danceRing: 8, // «Хоровод!» рядом с другими танцующими — ещё к рассудку
  danceRingMin: 2,
  nightMaxSec: 180, // таймера нет — дубль до последнего живого; это потолок
  leshyLeadSec: 8, // шаги Лешего слышны за столько секунд до «Тсс!»
  leshyQuietSec: 14, // столько секунд после его прихода обычных команд нет
  nightCrowdMul: 1.4, // обычные команды ночью реже во столько раз
  leshyPauseMs: 4000, // стоп-кадр Лешего длиннее обычного: он выходит на поляну, озирается и уходит
  // «Перепуг»: бот вздрагивает и убегает от пустоты — ложный след для охотников (эпизодов в минуту на бота к глухой ночи)
  botPanicPerMin: 0.12,

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

export function revealMs(cfg: GameConfig): number {
  return (cfg.revealDrumSec + cfg.revealReplaySec / cfg.revealSpeed + cfg.revealFinalSec) * 1000;
}
