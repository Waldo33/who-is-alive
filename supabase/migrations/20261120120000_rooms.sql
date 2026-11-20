-- Комнаты, участники, аналитика и права на приватные каналы Realtime (разделы 13–14 ТЗ).
-- Клиенты не пишут в таблицы напрямую: только через RPC ниже.

create schema if not exists private;

-- ───────────── таблицы ─────────────

create table public.rooms (
  code text primary key check (code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$'),
  host_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'lobby' check (status in ('lobby', 'playing')),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now()
);

create table public.room_members (
  room_code text not null references public.rooms (code) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 14),
  color smallint not null check (color between 0 and 3),
  joined_at timestamptz not null default now(),
  primary key (room_code, user_id),
  unique (room_code, color)
);
create index room_members_user_idx on public.room_members (user_id);
create index rooms_last_active_idx on public.rooms (last_active_at);
create index rooms_host_idx on public.rooms (host_id);

create table public.analytics_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid default auth.uid(),
  room_code text,
  name text not null check (char_length(name) <= 40),
  props jsonb not null default '{}'::jsonb
);

alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.analytics_events enable row level security;

revoke all on public.rooms, public.room_members, public.analytics_events from anon, authenticated;
grant select on public.rooms, public.room_members to authenticated;
grant insert on public.analytics_events to authenticated;

-- ───────────── помощники (security definer, без рекурсии RLS) ─────────────

create or replace function private.is_member(p_code text, p_uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.room_members m where m.room_code = p_code and m.user_id = p_uid);
$$;

create or replace function private.is_host(p_code text, p_uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.rooms r where r.code = p_code and r.host_id = p_uid);
$$;

revoke all on function private.is_member(text, uuid), private.is_host(text, uuid) from public;
grant usage on schema private to authenticated;
grant execute on function private.is_member(text, uuid), private.is_host(text, uuid) to authenticated;

-- ───────────── RLS таблиц ─────────────

create policy "members read their room" on public.rooms
  for select to authenticated using (private.is_member(code, (select auth.uid())));

create policy "members read room members" on public.room_members
  for select to authenticated using (private.is_member(room_code, (select auth.uid())));

create policy "anyone signed in logs own events" on public.analytics_events
  for insert to authenticated with check (user_id = (select auth.uid()));

-- ───────────── RPC ─────────────

create or replace function public.create_room(p_name text, p_settings jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_code text;
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ';
  i int;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  for attempt in 1..50 loop
    v_code := '';
    for i in 1..4 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    begin
      insert into public.rooms (code, host_id, settings) values (v_code, v_uid, coalesce(p_settings, '{}'::jsonb));
      exit;
    exception when unique_violation then
      v_code := null;
    end;
  end loop;
  if v_code is null then raise exception 'no_free_code'; end if;
  insert into public.room_members (room_code, user_id, name, color)
    values (v_code, v_uid, left(coalesce(nullif(trim(p_name), ''), 'Host'), 14), 0);
  return jsonb_build_object('code', v_code, 'color', 0, 'host_id', v_uid, 'status', 'lobby');
end;
$$;

create or replace function public.join_room(p_code text, p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_room public.rooms%rowtype;
  v_color smallint;
  v_name text := left(coalesce(nullif(trim(p_name), ''), 'Player'), 14);
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into v_room from public.rooms where code = upper(p_code) for update;
  if not found then raise exception 'room_not_found'; end if;
  select color into v_color from public.room_members where room_code = v_room.code and user_id = v_uid;
  if found then
    update public.room_members set name = v_name where room_code = v_room.code and user_id = v_uid;
  else
    if v_room.status <> 'lobby' then raise exception 'room_playing'; end if;
    if (select count(*) from public.room_members where room_code = v_room.code) >= 4 then raise exception 'room_full'; end if;
    select c into v_color from generate_series(0, 3) c
      where c not in (select color from public.room_members where room_code = v_room.code) order by c limit 1;
    insert into public.room_members (room_code, user_id, name, color) values (v_room.code, v_uid, v_name, v_color);
  end if;
  update public.rooms set last_active_at = now() where code = v_room.code;
  return jsonb_build_object('code', v_room.code, 'color', v_color, 'host_id', v_room.host_id,
                            'status', v_room.status, 'settings', v_room.settings);
end;
$$;

create or replace function public.leave_room(p_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_next uuid;
begin
  delete from public.room_members where room_code = p_code and user_id = v_uid;
  if private.is_host(p_code, v_uid) then
    select user_id into v_next from public.room_members where room_code = p_code order by joined_at limit 1;
    if v_next is null then
      delete from public.rooms where code = p_code;
    else
      update public.rooms set host_id = v_next where code = p_code;
    end if;
  end if;
end;
$$;

-- Прежний хост пропал из Presence — его роль забирает участник (решение принимает клиент, раздел 13).
create or replace function public.claim_host(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if not private.is_member(p_code, v_uid) then raise exception 'not_member'; end if;
  update public.rooms set host_id = v_uid, last_active_at = now() where code = p_code;
  return jsonb_build_object('host_id', v_uid);
end;
$$;

create or replace function public.touch_room(p_code text)
returns void language sql security definer set search_path = '' as $$
  update public.rooms set last_active_at = now()
  where code = p_code and private.is_member(p_code, auth.uid());
$$;

create or replace function public.set_room_status(p_code text, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_host(p_code, auth.uid()) then raise exception 'not_host'; end if;
  update public.rooms set status = p_status, last_active_at = now() where code = p_code;
end;
$$;

create or replace function public.update_room_settings(p_code text, p_settings jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_host(p_code, auth.uid()) then raise exception 'not_host'; end if;
  update public.rooms set settings = coalesce(p_settings, '{}'::jsonb), last_active_at = now() where code = p_code;
end;
$$;

create or replace function public.rename_member(p_code text, p_name text)
returns void language sql security definer set search_path = '' as $$
  update public.room_members set name = left(coalesce(nullif(trim(p_name), ''), name), 14)
  where room_code = p_code and user_id = auth.uid();
$$;

revoke all on function
  public.create_room(text, jsonb), public.join_room(text, text), public.leave_room(text),
  public.claim_host(text), public.touch_room(text), public.set_room_status(text, text),
  public.update_room_settings(text, jsonb), public.rename_member(text, text)
from public, anon;
grant execute on function
  public.create_room(text, jsonb), public.join_room(text, text), public.leave_room(text),
  public.claim_host(text), public.touch_room(text), public.set_room_status(text, text),
  public.update_room_settings(text, jsonb), public.rename_member(text, text)
to authenticated;

-- ───────────── Realtime: приватные каналы ─────────────
-- room:CODE          — все участники читают; Presence пишут все; Broadcast пишет только хост
-- room:CODE:host     — читает только хост; пишут участники (намерения)
-- room:CODE:p:UID    — читает только UID; пишет хост

create or replace function private.topic_code() returns text
language sql stable set search_path = '' as $$ select split_part(realtime.topic(), ':', 2) $$;

create policy "room channel: members read" on realtime.messages
  for select to authenticated using (
    split_part(realtime.topic(), ':', 1) = 'room'
    and (
      (split_part(realtime.topic(), ':', 3) = '' and private.is_member(private.topic_code(), (select auth.uid())))
      or (split_part(realtime.topic(), ':', 3) = 'host' and private.is_host(private.topic_code(), (select auth.uid())))
      or (split_part(realtime.topic(), ':', 3) = 'p'
          and split_part(realtime.topic(), ':', 4) = (select auth.uid())::text
          and private.is_member(private.topic_code(), (select auth.uid())))
    )
  );

create policy "room channel: write by role" on realtime.messages
  for insert to authenticated with check (
    split_part(realtime.topic(), ':', 1) = 'room'
    and (
      (split_part(realtime.topic(), ':', 3) = '' and (
        (realtime.messages.extension = 'presence' and private.is_member(private.topic_code(), (select auth.uid())))
        or (realtime.messages.extension = 'broadcast' and private.is_host(private.topic_code(), (select auth.uid())))
      ))
      or (split_part(realtime.topic(), ':', 3) = 'host' and realtime.messages.extension = 'broadcast'
          and private.is_member(private.topic_code(), (select auth.uid())))
      or (split_part(realtime.topic(), ':', 3) = 'p' and realtime.messages.extension = 'broadcast'
          and private.is_host(private.topic_code(), (select auth.uid())))
    )
  );

grant execute on function private.topic_code() to authenticated;

-- ───────────── очистка ─────────────

create or replace function private.cleanup() returns void
language sql security definer set search_path = '' as $$
  delete from public.rooms where last_active_at < now() - interval '30 minutes';
  delete from auth.users where is_anonymous is true and created_at < now() - interval '7 days'
    and id not in (select user_id from public.room_members);
$$;
revoke all on function private.cleanup() from public, anon, authenticated;
