import { GAME_API } from './env';
import type { WireRoomSettings } from '@kto/net';

/**
 * Вход и комнаты на своём игровом сервере. Один телефон — один игрок: id и токен хранятся постоянно
 * (localStorage). Для тестов нескольких игроков с одного телефона: ?player=2 (3, 4…).
 */
export interface GameUser {
  userId: string;
  token: string;
}

export class AuthError extends Error {}

function storageKey(): string {
  if (typeof location === 'undefined') return 'kto:auth2';
  const n = new URLSearchParams(location.search).get('player');
  return n && /^[1-9]$/.test(n) && n !== '1' ? `kto:auth2-${n}` : 'kto:auth2';
}

let cached: GameUser | null = null;

export async function ensureGameUser(): Promise<GameUser> {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(storageKey());
    if (raw) {
      const u = JSON.parse(raw) as GameUser;
      if (u.userId && u.token) return (cached = u);
    }
  } catch {
    // приватный режим или испорченная запись — войдём заново
  }
  let res: Response;
  try {
    res = await fetch(`${GAME_API}/v1/auth/anon`, { method: 'POST' });
  } catch {
    throw new Error('network');
  }
  if (!res.ok) throw new AuthError(`HTTP ${res.status}`);
  const u = (await res.json()) as GameUser;
  try {
    localStorage.setItem(storageKey(), JSON.stringify(u));
  } catch {
    // приватный режим: игрок живёт до закрытия вкладки
  }
  return (cached = u);
}

/** Токен сервер не признал (сменился ключ) — забыть и войти заново. */
export function forgetGameUser(): void {
  cached = null;
  try {
    localStorage.removeItem(storageKey());
  } catch {
    // приватный режим
  }
}

/** Создать комнату: код и адрес WebSocket. Ошибки — кодами словаря (`lobby.errors`). */
export async function createGameRoom(name: string, settings: WireRoomSettings | undefined, lang: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const u = await ensureGameUser();
    let res: Response;
    try {
      res = await fetch(`${GAME_API}/v1/rooms`, {
        method: 'POST',
        headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name, settings, lang }),
      });
    } catch {
      throw new Error('network');
    }
    if (res.status === 401 && attempt === 0) {
      forgetGameUser();
      continue;
    }
    if (!res.ok) throw new Error(res.status === 429 || res.status === 503 ? 'busy' : 'unknown');
    return ((await res.json()) as { code: string }).code;
  }
  throw new AuthError('bad_token');
}

export interface GameRoomInfo {
  code: string;
  status: 'lobby' | 'playing';
  players: { name: string; color: number }[];
  wsUrl: string;
}

/** Комната на сервере: есть ли, кто в ней, куда подключаться. null — нет такой. */
export async function gameRoomInfo(code: string, init?: RequestInit & { next?: { revalidate: number } }): Promise<GameRoomInfo | null> {
  if (!/^[A-Za-z]{4}$/.test(code)) return null;
  const res = await fetch(`${GAME_API}/v1/rooms/${code.toUpperCase()}`, init);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('network');
  return (await res.json()) as GameRoomInfo;
}
