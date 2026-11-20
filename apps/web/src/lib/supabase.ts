'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { SUPABASE_KEY as KEY, SUPABASE_URL as URL } from './env';

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  client ??= createClient(URL, KEY, {
    // сессия на вкладку: перезагрузка возвращает того же игрока, новая вкладка — новый игрок
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storageKey: 'kto-auth',
      storage: typeof window === 'undefined' ? undefined : window.sessionStorage,
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
