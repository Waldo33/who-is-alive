// Публичные значения проекта (publishable key предназначен для браузера, права режут RLS-политики).
// Переменные окружения перекрывают их — например, для отдельного тестового проекта.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://wivildtgfkpuxvqoamqg.supabase.co';
export const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable_H7jmJUYfYmVIPXF15mr1gQ_PYNXmtdN';

/** Адрес сайта для абсолютных ссылок в превью (og:image и т. п.). */
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'https://who-is-alive.vercel.app');
