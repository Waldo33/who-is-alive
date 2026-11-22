-- Зрители: опоздавший к матчу смотрит трансляцию (с задержкой на клиенте), место игрока не занимает.
-- Когда матч кончится (комната снова 'lobby'), зритель входит обычным join_room.
-- Совместимо со старым клиентом: новая таблица и функции, политика чтения общего канала расширена.

create table if not exists public.room_spectators (
  room_code text not null references public.rooms (code) on delete cascade,
  user_id uuid not null,
  name text not null,
  joined_at timestamptz not null default now(),
  primary key (room_code, user_id)
);
alter table public.room_spectators enable row level security;
revoke all on public.room_spectators from anon, authenticated;

create or replace function private.is_spectator(p_code text, p_uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.room_spectators s where s.room_code = p_code and s.user_id = p_uid);
$$;
revoke all on function private.is_spectator(text, uuid) from public;
grant execute on function private.is_spectator(text, uuid) to authenticated;

-- Стать зрителем: состав игроков (имена и цвета — их и так видят все) и состояние комнаты.
create or replace function public.spectate_room(p_code text, p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_room public.rooms%rowtype;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into v_room from public.rooms where code = upper(p_code);
  if not found then raise exception 'room_not_found'; end if;
  insert into public.room_spectators (room_code, user_id, name)
    values (v_room.code, v_uid, left(coalesce(nullif(trim(p_name), ''), 'Player'), 14))
    on conflict (room_code, user_id) do update set name = excluded.name, joined_at = now();
  return jsonb_build_object(
    'code', v_room.code, 'host_id', v_room.host_id, 'status', v_room.status, 'settings', v_room.settings,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', m.name, 'color', m.color) order by m.joined_at)
      from public.room_members m where m.room_code = v_room.code
    ), '[]'::jsonb)
  );
end;
$$;

-- Состояние комнаты для зрителя (раз в несколько секунд: не кончился ли матч).
create or replace function public.room_status(p_code text)
returns text language sql stable security definer set search_path = '' as $$
  select r.status from public.rooms r
  where r.code = upper(p_code)
    and (private.is_spectator(r.code, auth.uid()) or private.is_member(r.code, auth.uid()));
$$;

create or replace function public.unspectate_room(p_code text)
returns void language sql security definer set search_path = '' as $$
  delete from public.room_spectators where room_code = upper(p_code) and user_id = auth.uid();
$$;

revoke all on function public.spectate_room(text, text), public.room_status(text), public.unspectate_room(text) from public, anon;
grant execute on function public.spectate_room(text, text), public.room_status(text), public.unspectate_room(text) to authenticated;

-- Общий канал room:CODE читают и зрители (только читают: писать Broadcast и Presence им нельзя).
drop policy if exists "room channel: members read" on realtime.messages;
create policy "room channel: members read" on realtime.messages
  for select to authenticated using (
    split_part(realtime.topic(), ':', 1) = 'room'
    and (
      (split_part(realtime.topic(), ':', 3) = '' and (
        private.is_member(private.topic_code(), (select auth.uid()))
        or private.is_spectator(private.topic_code(), (select auth.uid()))
      ))
      or (split_part(realtime.topic(), ':', 3) = 'p' and split_part(realtime.topic(), ':', 5) = '' and (
        (split_part(realtime.topic(), ':', 4) = (select auth.uid())::text and private.is_member(private.topic_code(), (select auth.uid())))
        or private.is_host(private.topic_code(), (select auth.uid()))
      ))
    )
  );
