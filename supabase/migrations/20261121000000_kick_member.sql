-- Режиссёр (хост) может убрать участника из комнаты в лобби — освободить место (например,
-- «призрака»: чужая вкладка или встроенный браузер мессенджера, где когда-то открыли ссылку).
-- Это не чёрный список: убранный может войти снова по ссылке, если место есть.
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
  update public.rooms set last_active_at = now() where code = v_room.code;
end;
$$;

revoke all on function public.kick_member(text, uuid) from public, anon;
grant execute on function public.kick_member(text, uuid) to authenticated;
