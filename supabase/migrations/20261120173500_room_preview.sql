-- Превью ссылки на комнату (OG-картинка, заголовок): имя хоста, сколько игроков, статус.
-- Доступно без входа: мессенджеры запрашивают превью анонимно. Код комнаты и так знает тот,
-- кто получил ссылку; ничего, кроме выбранного игроком имени, не раскрывается.
create or replace function public.room_preview(p_code text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'code', r.code,
    'host_name', m.name,
    'players', (select count(*) from public.room_members x where x.room_code = r.code),
    'status', r.status
  )
  from public.rooms r
  left join public.room_members m on m.room_code = r.code and m.user_id = r.host_id
  where r.code = upper(p_code)
$$;
revoke all on function public.room_preview(text) from public;
grant execute on function public.room_preview(text) to anon, authenticated;
