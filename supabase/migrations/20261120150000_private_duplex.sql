-- Личный канал room:CODE:p:UID стал двусторонним: гость шлёт в него намерения, хост — личные данные.
-- Подписаться на канал можно, только если есть право читать, поэтому читать и писать в нём могут
-- ровно двое: сам UID и хост комнаты. Отдельный канал room:CODE:host больше не нужен.
drop policy if exists "room channel: members read" on realtime.messages;
drop policy if exists "room channel: write by role" on realtime.messages;

create policy "room channel: members read" on realtime.messages
  for select to authenticated using (
    split_part(realtime.topic(), ':', 1) = 'room'
    and (
      (split_part(realtime.topic(), ':', 3) = '' and private.is_member(private.topic_code(), (select auth.uid())))
      or (split_part(realtime.topic(), ':', 3) = 'p' and split_part(realtime.topic(), ':', 5) = '' and (
        (split_part(realtime.topic(), ':', 4) = (select auth.uid())::text and private.is_member(private.topic_code(), (select auth.uid())))
        or private.is_host(private.topic_code(), (select auth.uid()))
      ))
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
      or (split_part(realtime.topic(), ':', 3) = 'p' and split_part(realtime.topic(), ':', 5) = ''
          and realtime.messages.extension = 'broadcast' and (
        (split_part(realtime.topic(), ':', 4) = (select auth.uid())::text and private.is_member(private.topic_code(), (select auth.uid())))
        or private.is_host(private.topic_code(), (select auth.uid()))
      ))
    )
  );
