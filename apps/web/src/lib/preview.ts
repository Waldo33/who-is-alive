import { gameRoomInfo } from './game-server';

export interface RoomPreview {
  code: string;
  host_name: string | null;
  players: number;
  status: string;
}

/** Кто зовёт в комнату — для превью ссылки. Без входа: мессенджеры спрашивают анонимно. */
export async function roomPreview(code: string): Promise<RoomPreview | null> {
  try {
    const r = await gameRoomInfo(code, { next: { revalidate: 30 }, signal: AbortSignal.timeout(2500) });
    if (!r) return null;
    return { code: r.code, host_name: r.players[0]?.name ?? null, players: r.players.length, status: r.status };
  } catch {
    return null;
  }
}
