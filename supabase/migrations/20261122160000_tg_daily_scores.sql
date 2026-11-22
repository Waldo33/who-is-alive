-- Рейтинг загадки дня внутри чата Telegram. Пишет и читает только функция бота (Edge Function
-- tg-bot, сервисный ключ) после проверки подписи initData Mini App. Клиентам таблица закрыта.
-- chat_instance — id чата от Telegram (Mini App, открытая по прямой ссылке в чате); tg_user_id и имя —
-- из подписанных данных Telegram. Старше 30 дней — удаляется.

create table if not exists public.tg_daily_scores (
  chat_instance text not null check (char_length(chat_instance) <= 64),
  tg_user_id bigint not null,
  name text not null check (char_length(name) <= 32),
  n integer not null check (n between 1 and 100000),
  tries smallint not null check (tries between 1 and 3),
  won boolean not null,
  created_at timestamptz not null default now(),
  primary key (chat_instance, n, tg_user_id)
);

alter table public.tg_daily_scores enable row level security;
revoke all on public.tg_daily_scores from anon, authenticated;

create index if not exists tg_daily_scores_created_idx on public.tg_daily_scores (created_at);

select cron.unschedule('tg-daily-cleanup') where exists (select 1 from cron.job where jobname = 'tg-daily-cleanup');
select cron.schedule('tg-daily-cleanup', '17 4 * * *', $$delete from public.tg_daily_scores where created_at < now() - interval '30 days'$$);
