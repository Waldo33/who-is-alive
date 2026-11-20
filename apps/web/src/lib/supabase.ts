'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

/** Клиент Supabase с анонимной сессией (этап 1). Комнаты и Realtime подключаются на этапах 3–4. */
export function supabase(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  client ??= createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });
  return client;
}

/** Анонимный вход без регистрации: возвращает id игрока для RLS. */
export async function ensureAnonymousUser(): Promise<string | null> {
  const sb = supabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  if (data.session) return data.session.user.id;
  const res = await sb.auth.signInAnonymously();
  return res.data.user?.id ?? null;
}
