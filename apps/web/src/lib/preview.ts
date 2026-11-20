import { SUPABASE_KEY, SUPABASE_URL } from './env';

export interface RoomPreview {
  code: string;
  host_name: string | null;
  players: number;
  status: string;
}

/** Кто зовёт в комнату — для превью ссылки. Без входа: мессенджеры спрашивают анонимно. */
export async function roomPreview(code: string): Promise<RoomPreview | null> {
  if (!/^[A-Za-z]{4}$/.test(code)) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/room_preview`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_code: code.toUpperCase() }),
      next: { revalidate: 30 },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    return ((await res.json()) as RoomPreview | null) ?? null;
  } catch {
    return null;
  }
}
