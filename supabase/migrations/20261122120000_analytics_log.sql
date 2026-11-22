-- Аналитика воронки (этап G): клиент пишет события пачками через RPC log_events.
-- Без имён и IP. device_id — случайный id телефона из localStorage (связывает визиты до и после
-- анонимного входа), session_id — один заход на страницу. user_id — auth.uid(), если игрок уже вошёл.
-- Писать могут и не вошедшие (главная, песочница, обучение): поэтому RPC доступен роли anon,
-- а проверки — внутри: имя события по шаблону, не больше 30 событий за вызов, props до 2 КБ.
-- Совместимо со старым клиентом: он в таблицу не писал.

alter table public.analytics_events
  add column if not exists device_id text check (char_length(device_id) <= 64),
  add column if not exists session_id text check (char_length(session_id) <= 64);

create index if not exists analytics_events_created_idx on public.analytics_events (created_at);
create index if not exists analytics_events_name_created_idx on public.analytics_events (name, created_at);
create index if not exists analytics_events_device_idx on public.analytics_events (device_id);

create or replace function public.log_events(p_device text, p_session text, p_events jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  e jsonb;
  n integer := 0;
  v_props jsonb;
begin
  if p_device is null or p_device !~ '^[A-Za-z0-9-]{8,64}$' then return 0; end if;
  if p_session is not null and p_session !~ '^[A-Za-z0-9-]{8,64}$' then p_session := null; end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then return 0; end if;
  for e in select value from jsonb_array_elements(p_events) limit 30 loop
    continue when jsonb_typeof(e) <> 'object' or coalesce(e->>'n', '') !~ '^[a-z][a-z0-9_]{0,39}$';
    v_props := e->'p';
    if v_props is null or jsonb_typeof(v_props) <> 'object' or pg_column_size(v_props) > 2048 then
      v_props := '{}'::jsonb;
    end if;
    insert into public.analytics_events (user_id, device_id, session_id, room_code, name, props)
    values (
      auth.uid(),
      p_device,
      p_session,
      case when coalesce(e->>'r', '') ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$' then e->>'r' end,
      e->>'n',
      v_props
    );
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.log_events(text, text, jsonb) from public;
grant execute on function public.log_events(text, text, jsonb) to anon, authenticated;
