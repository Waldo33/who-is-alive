-- Призраки в комнате: участник, закрывший вкладку, и браузер-превью ссылки (iMessage и меню «Поделиться»
-- на iOS выполняют скрипты страницы) оставались в room_members до удаления комнаты и занимали место.
-- Теперь каждый участник отмечается раз в ~20 с (touch_room), а при входе нового игрока в лобби
-- молчащие дольше 75 с (кроме хоста) освобождают место.
alter table public.room_members add column if not exists last_seen_at timestamptz not null default now();

create or replace function public.touch_room(p_code text)
returns void language sql security definer set search_path = '' as $$
  update public.room_members set last_seen_at = now()
  where room_code = upper(p_code) and user_id = auth.uid();
  update public.rooms set last_active_at = now()
  where code = upper(p_code) and private.is_member(upper(p_code), auth.uid());
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

-- Хост ушёл: роль — тому, кто отмечался недавно (не призраку); если активных нет — самому раннему.
create or replace function public.leave_room(p_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_next uuid;
begin
  delete from public.room_members where room_code = p_code and user_id = v_uid;
  if private.is_host(p_code, v_uid) then
    select user_id into v_next from public.room_members where room_code = p_code
      order by (last_seen_at > now() - interval '75 seconds') desc, joined_at limit 1;
    if v_next is null then
      delete from public.rooms where code = p_code;
    else
      update public.rooms set host_id = v_next where code = p_code;
    end if;
  end if;
end;
$$;
