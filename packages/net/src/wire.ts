import { z } from 'zod';

/**
 * Протокол своего игрового сервера (docs/server-migration.md › 3). Один WebSocket на игрока:
 * лобби (состав, «Готов», настройки, старт) и игра. Игровые сообщения те же, что и в старой
 * схеме (`RoomMsg`, `PrivateMsg`, `GuestMsg`), только вложены в конверт `g`; хост — сам сервер.
 */

/** Версия протокола: сервер отвечает `bad_version`, если клиент старше — клиент перезагружается. */
export const WIRE_VERSION = 1;

/** Максимальный размер сообщения клиента, байт. */
export const WIRE_MAX_BYTES = 4096;

export const RoomSettingsSchema = z.object({
  roundSec: z.union([z.literal(60), z.literal(75), z.literal(90)]),
  maxRounds: z.union([z.literal(3), z.literal(5), z.literal(7)]),
  kidsMode: z.boolean(),
  strictCrowd: z.boolean().optional(),
  aiFill: z.boolean(),
  /**
   * Музыка в дубле (настройка режиссёра): host — только у режиссёра (по умолчанию: игра делалась для
   * одной комнаты, 2–4 телефона с одной песней — какофония), all — у всех, none — ни у кого.
   * Эффекты и обрыв «Море волнуется» — у всех при любом выборе. Старые клиенты поля не шлют.
   */
  roomMusic: z.enum(['host', 'all', 'none']).optional(),
  /** «Оркестр из телефонов» в лобби: одна песня по часам сервера, у каждого телефона своя партия. */
  orchestra: z.boolean().optional(),
});
export type WireRoomSettings = z.infer<typeof RoomSettingsSchema>;

/** Как `DEFAULT_SETTINGS` клиента: ИИ-актёры включены (комната от старого клиента или бота без настроек — тоже с ИИ). */
export const DEFAULT_WIRE_SETTINGS: WireRoomSettings = { roundSec: 75, maxRounds: 5, kidsMode: false, aiFill: true };

const Name = z.string().max(40);

/** Клиент → сервер. */
export const ClientMsg = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    v: z.number().int(),
    token: z.string().max(2000),
    code: z.string().max(8),
    name: Name,
    /** Язык и «без крови» для клипа выбывшего: сервер заготовит его до нажатия. Старые клиенты не шлют. */
    clip: z.object({ lang: z.enum(['ru', 'en']), mild: z.boolean() }).optional(),
    /** Клиент умеет войти в идущий матч на место ИИ (иначе — только зрителем). Старые клиенты не шлют. */
    seat: z.boolean().optional(),
  }),
  z.object({ t: z.literal('ready'), on: z.boolean() }),
  z.object({ t: z.literal('rename'), name: Name }),
  z.object({ t: z.literal('settings'), settings: RoomSettingsSchema }),
  z.object({ t: z.literal('kick'), userId: z.string().max(64) }),
  z.object({ t: z.literal('start') }),
  z.object({ t: z.literal('leave') }),
  /** Зритель: матч кончился — занять место в комнате. */
  z.object({ t: z.literal('join') }),
  /** Игровое сообщение хосту (`GuestMsg`), проверяется схемой у хоста. */
  z.object({ t: z.literal('g'), m: z.unknown() }),
  /** Часы сервера (оркестр из телефонов): c — время клиента, вернётся в ответе. */
  z.object({ t: z.literal('clock'), c: z.number() }),
  /**
   * Клип выбывшего смонтировать на сервере (шлём, только если в welcome есть caps 'clip').
   * n — номер запроса (вернётся в ответе), round — дубль; кого подсветить, сервер решает сам.
   */
  z.object({ t: z.literal('clip'), n: z.number().int(), round: z.number().int(), lang: z.enum(['ru', 'en']), mild: z.boolean() }),
]);
export type ClientMsg = z.infer<typeof ClientMsg>;

export interface WireMember {
  userId: string;
  name: string;
  color: number;
  joinedAt: number;
  online: boolean;
  ready: boolean;
  /** Скин из гардероба (по покупкам, подставляет сервер). В лобби его видят все. Старые серверы не шлют. */
  skin?: string;
  /** Эффект на персонаже (по покупкам, подставляет сервер) — виден там же, где скин. Старые серверы не шлют. */
  fx?: string;
}

export interface WireRoom {
  code: string;
  status: 'lobby' | 'playing';
  /** Режиссёр: настройки, старт, «Дальше», «Ещё дубль», кик. */
  directorId: string;
  settings: WireRoomSettings;
  members: WireMember[];
}

export type WireError =
  | 'bad_version'
  | 'bad_token'
  | 'bad_message'
  | 'room_not_found'
  | 'room_full'
  | 'room_playing'
  | 'not_director'
  | 'not_now'
  | 'not_enough_players'
  /** В лобби не все подключённые игроки нажали «Готов» (режиссёр — не в счёт). */
  | 'not_ready'
  | 'rate_limited'
  | 'server_busy';

/** Сервер → клиент. */
export type ServerMsg =
  /** spectator — пришёл посреди матча: смотрит общий канал, место займёт после матча (`join`). */
  /** caps — что умеет этот сервер сверх базового протокола ('clip' — монтирует клип выбывшего). */
  | { t: 'welcome'; selfId: string; room: WireRoom; spectator?: boolean; caps?: string[] }
  | { t: 'room'; room: WireRoom }
  | { t: 'error'; code: WireError; fatal?: boolean }
  | { t: 'kicked' }
  | { t: 'closed' }
  /** Игра: ch = 'room' — всем, 'private' — лично тебе. */
  | { t: 'g'; ch: 'room' | 'private'; m: unknown }
  /** Пульс, когда долго нет других сообщений: связь жива. */
  | { t: 'hb' }
  /**
   * Комната переехала на другой экземпляр сервера (выкладка без обрыва, docs/infra-plan.md › этап 1):
   * переподключиться по новому адресу с тем же токеном и кодом. Старые клиенты сообщение пропускают.
   */
  | { t: 'move'; url: string }
  /** Ответ на `clock`: c — время клиента из запроса, s — время сервера (Date.now), мс. */
  | { t: 'clock'; c: number; s: number }
  /**
   * «Фильм матча» (apps/server/src/film.ts) после конца матча: монтируется → готов (файл в /v1/clips/<id>.<ext>)
   * или не вышел (тогда телефон смонтирует сам). Старые клиенты сообщение не знают и пропускают.
   */
  /** none — начался новый матч: фильма прошлого больше нет. */
  | { t: 'film'; state: 'none' }
  | { t: 'film'; state: 'making' }
  | { t: 'film'; state: 'ready'; id: string; ext: 'mp4'; thumb: boolean }
  | { t: 'film'; state: 'failed' }
  /**
   * Загадка из фильма матча (apps/server/src/puzzles.ts): код страницы /c/<код> — в ссылку под фильмом,
   * в его финал и водяной знак. Приходит на разоблачении последнего дубля (или не приходит: честного
   * куска не нашлось). Ответа в нём нет. Старые клиенты сообщение не знают и пропускают.
   */
  | { t: 'puzzle'; code: string }
  /**
   * Клип выбывшего (ответ на `clip` с тем же n): making — в очереди, eta — мс до готовности;
   * ready — файл в /v1/clips/<id>.<ext>; failed — не вышло или очередь длинная: телефон монтирует сам.
   */
  | { t: 'clip'; n: number; state: 'making'; eta: number }
  | { t: 'clip'; n: number; state: 'ready'; id: string; ext: 'mp4'; thumb: boolean }
  | { t: 'clip'; n: number; state: 'failed' }
  /**
   * Переключатели сервера — сразу после welcome и при каждой смене. video: false — аварийно выключено
   * всё видео (клипы и фильм): кнопки спрятать, на телефоне тоже не монтировать. Старые клиенты пропускают.
   */
  | { t: 'flags'; video: boolean };

/** Состояние фильма матча у клиента. */
export type WireFilm = Extract<ServerMsg, { t: 'film' }>;
/** Ответ сервера про клип выбывшего. */
export type WireClip = Extract<ServerMsg, { t: 'clip' }>;

/** Буквы кода комнаты: без похожих I, L, O. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
