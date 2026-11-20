-- Режиссёр (хост) может убрать участника из комнаты в лобби. Убранный не может вернуться в эту
-- комнату (иначе его открытая вкладка тут же вошла бы снова при возвращении — см. join_room
-- в Room.onVisible): запись в room_kicks живёт, пока жива комната.
create table if not exists public.room_kicks (
  room_code text not null references public.rooms (code) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kicked_at timestamptz not null default now(),
  primary key (room_code, user_id)
);
alter table public.room_kicks enable row level security;
-- политик нет: читать и писать только через функции ниже

create or replace function public.kick_member(p_code text, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_room public.rooms%rowtype;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into v_room from public.rooms where code = upper(p_code) for update;
  if not found then raise exception 'room_not_found'; end if;
  if v_room.host_id <> v_uid then raise exception 'not_host'; end if;
  if p_user = v_uid then raise exception 'cannot_kick_self'; end if;
  if v_room.status <> 'lobby' then raise exception 'room_playing'; end if;
  delete from public.room_members where room_code = v_room.code and user_id = p_user;
  insert into public.room_kicks (room_code, user_id) values (v_room.code, p_user) on conflict do nothing;
  update public.rooms set last_active_at = now() where code = v_room.code;
end;
$$;

revoke all on function public.kick_member(text, uuid) from public, anon;
grant execute on function public.kick_member(text, uuid) to authenticated;

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
  -- убранного режиссёром обратно не пускаем
  if exists (select 1 from public.room_kicks where room_code = v_room.code and user_id = v_uid) then
    raise exception 'kicked';
  end if;
  select color into v_color from public.room_members where room_code = v_room.code and user_id = v_uid;
  if found then
    update public.room_members set name = v_name, last_seen_at = now() where room_code = v_room.code and user_id = v_uid;
  else
    if v_room.status <> 'lobby' then raise exception 'room_playing'; end if;
    -- освободить места тех, кто давно не отмечался (закрыл вкладку, превью ссылки и т. п.)
    delete from public.room_members
      where room_code = v_room.code and user_id <> v_room.host_id and last_seen_at < now() - interval '75 seconds';
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
