-- Срок жизни комнаты. Раньше пульс touch_room (раз в 20 с из каждой открытой вкладки) продлевал
-- комнату: забытая вкладка или браузер мессенджера держали лобби вечно. Теперь:
-- • пульс отмечает только участника (last_seen_at), комнату продлевают настоящие действия —
--   вход, старт и конец матча, настройки, имя, смена режиссёра, «убрать»;
-- • комната без действий 30 мин удаляется (уборка раз в 10 мин — фактически 30–40 мин);
-- • и в любом случае — через 6 часов после создания (вечер игры укладывается).
-- touch_room теперь сообщает, жива ли комната: 'ok' | 'gone' (комнаты нет) | 'out' (тебя в ней нет).
drop function if exists public.touch_room(text);
create function public.touch_room(p_code text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.rooms where code = upper(p_code)) then return 'gone'; end if;
  update public.room_members set last_seen_at = now()
    where room_code = upper(p_code) and user_id = auth.uid();
  if not found then return 'out'; end if;
  return 'ok';
end;
$$;
revoke all on function public.touch_room(text) from public, anon;
grant execute on function public.touch_room(text) to authenticated;

create or replace function private.cleanup() returns void
language sql security definer set search_path = '' as $$
  delete from public.rooms
    where last_active_at < now() - interval '30 minutes' or created_at < now() - interval '6 hours';
  delete from auth.users where is_anonymous is true and created_at < now() - interval '7 days'
    and id not in (select user_id from public.room_members);
$$;
revoke all on function private.cleanup() from public, anon, authenticated;
