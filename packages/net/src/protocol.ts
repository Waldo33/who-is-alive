import { z } from 'zod';

/** Схемы намерений игрок → хост (раздел 13). Хост валидирует каждое входящее сообщение. */
export const IntentMsg = z.discriminatedUnion('k', [
  z.object({ k: z.literal('move'), x: z.number().int().min(0).max(180), y: z.number().int().min(0).max(260) }),
  z.object({ k: z.literal('stop') }),
  z.object({ k: z.literal('emote') }),
  z.object({ k: z.literal('crowd'), kind: z.enum(['freeze', 'jump', 'dance']) }),
  z.object({ k: z.literal('attack'), eid: z.number().int() }),
  z.object({ k: z.literal('autopilot'), on: z.boolean() }),
  z.object({ k: z.literal('accuse'), eid: z.number().int() }),
  z.object({ k: z.literal('next') }),
  z.object({ k: z.literal('rematch') }),
]);
export type IntentMsg = z.infer<typeof IntentMsg>;

export const TimePing = z.object({ k: z.literal('time_ping'), c: z.number() });
export const Resync = z.object({ k: z.literal('resync'), playerId: z.string(), seq: z.number().int() });
