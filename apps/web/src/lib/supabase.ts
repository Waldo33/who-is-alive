'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { SUPABASE_KEY as KEY, SUPABASE_URL as URL } from './env';

let client: SupabaseClient | null = null;

/**
 * Один телефон — один игрок: анонимная сессия хранится постоянно (localStorage). Раньше она жила
 * в sessionStorage одной вкладки — после перезахода по ссылке, новой вкладки или сброса вкладки
 * браузером (Chrome на iPhone) человек входил новым игроком, а старый «он» оставался хостом-призраком.
 * Сессию из старого хранилища подхватываем, чтобы не потерять текущего игрока.
 * Для тестов нескольких игроков с одного телефона: ?player=2 (3, 4…) — отдельный игрок.
 */
const authStorage = {
  getItem(k: string): string | null {
    try {
      const v = localStorage.getItem(k);
      if (v !== null) return v;
      // переезд со старого хранения на вкладку: переносим, чтобы новая вкладка была тем же игроком
      const old = sessionStorage.getItem(k);
      if (old !== null) localStorage.setItem(k, old);
      return old;
    } catch {
      return null;
    }
  },
  setItem(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* приватный режим: сессия останется только в памяти */
    }
  },
  removeItem(k: string): void {
    try {
      localStorage.removeItem(k);
      sessionStorage.removeItem(k);
    } catch {
      /* приватный режим */
    }
  },
};

function storageKey(): string {
  if (typeof location === 'undefined') return 'kto-auth';
  const n = new URLSearchParams(location.search).get('player');
  return n && /^[1-9]$/.test(n) && n !== '1' ? `kto-auth-${n}` : 'kto-auth';
}

export function supabase(): SupabaseClient {
  client ??= createClient(URL, KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storageKey: storageKey(),
      storage: typeof window === 'undefined' ? undefined : authStorage,
    },
    realtime: { params: { eventsPerSecond: 40 } },
  });
  return client;
}

export class AuthError extends Error {}

/** Анонимный вход без регистрации: возвращает id игрока для RLS. */
export async function ensureAnonymousUser(): Promise<string> {
  const sb = supabase();
  const { data } = await sb.auth.getSession();
  if (data.session) return data.session.user.id;
  const res = await sb.auth.signInAnonymously();
  if (res.error || !res.data.user) throw new AuthError(res.error?.message ?? 'no user');
  return res.data.user.id;
}

/** Код ошибки из RPC (raise exception 'room_full' → 'room_full'). */
export function rpcErrorCode(err: unknown): string {
  const msg = (err as { message?: string })?.message ?? '';
  const m = msg.match(/room_not_found|room_full|room_playing|not_host|not_member|not_signed_in/);
  if (m) return m[0];
  if (/fetch|network|Failed to/i.test(msg)) return 'network';
  return 'unknown';
}
