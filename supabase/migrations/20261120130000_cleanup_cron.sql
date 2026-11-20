-- Уборка раз в 10 минут: комнаты без активности дольше 30 минут и старые анонимные пользователи
-- (см. private.cleanup() в 20261120120000_rooms.sql). В проекте уже применено как миграция "cleanup_cron".
create extension if not exists pg_cron;
select cron.unschedule('who-is-alive-cleanup') where exists (select 1 from cron.job where jobname = 'who-is-alive-cleanup');
select cron.schedule('who-is-alive-cleanup', '*/10 * * * *', 'select private.cleanup()');
