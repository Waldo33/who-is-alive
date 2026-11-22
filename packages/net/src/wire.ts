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
});
export type WireRoomSettings = z.infer<typeof RoomSettingsSchema>;

export const DEFAULT_WIRE_SETTINGS: WireRoomSettings = { roundSec: 75, maxRounds: 5, kidsMode: false, aiFill: false };

const Name = z.string().max(40);

/** Клиент → сервер. */
export const ClientMsg = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), v: z.number().int(), token: z.string().max(2000), code: z.string().max(8), name: Name }),
  z.object({ t: z.literal('ready'), on: z.boolean() }),
  z.object({ t: z.literal('rename'), name: Name }),
  z.object({ t: z.literal('settings'), settings: RoomSettingsSchema }),
  z.object({ t: z.literal('kick'), userId: z.string().max(64) }),
  z.object({ t: z.literal('start') }),
  z.object({ t: z.literal('leave') }),
  /** Игровое сообщение хосту (`GuestMsg`), проверяется схемой у хоста. */
  z.object({ t: z.literal('g'), m: z.unknown() }),
]);
export type ClientMsg = z.infer<typeof ClientMsg>;

export interface WireMember {
  userId: string;
  name: string;
  color: number;
  joinedAt: number;
  online: boolean;
  ready: boolean;
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
  | 'rate_limited'
  | 'server_busy';

/** Сервер → клиент. */
export type ServerMsg =
  | { t: 'welcome'; selfId: string; room: WireRoom }
  | { t: 'room'; room: WireRoom }
  | { t: 'error'; code: WireError; fatal?: boolean }
  | { t: 'kicked' }
  | { t: 'closed' }
  /** Игра: ch = 'room' — всем, 'private' — лично тебе. */
  | { t: 'g'; ch: 'room' | 'private'; m: unknown }
  /** Пульс, когда долго нет других сообщений: связь жива. */
  | { t: 'hb' };

/** Буквы кода комнаты (как в Supabase: без похожих I, L, O). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
