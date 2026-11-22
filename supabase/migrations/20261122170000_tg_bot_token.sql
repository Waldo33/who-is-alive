-- Ключ Telegram-бота для Edge Function tg-bot — из Supabase Vault (секрет `telegram_bot_token`,
-- кладётся вручную: select vault.create_secret('<токен>', 'telegram_bot_token');).
-- Запасной путь к секрету функции TELEGRAM_BOT_TOKEN: функция сначала смотрит его, потом сюда.
-- Вызывать может только service_role (сервер бота); анонимам и игрокам — нет.

create or replace function public.tg_bot_token()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'telegram_bot_token' limit 1;
$$;

revoke all on function public.tg_bot_token() from public, anon, authenticated;
grant execute on function public.tg_bot_token() to service_role;
