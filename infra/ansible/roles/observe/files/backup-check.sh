#!/bin/sh
# последняя копия базы игры → черновая база massovka_restore_check → сколько событий и игроков → удалить
out=/var/lib/postgresql/backup-check.status
f=$(ls -1t /var/backups/massovka-"$(cat /etc/massovka/game-site 2>/dev/null || echo msk)"/*.dump 2>/dev/null | head -1)
if [ -z "$f" ]; then echo "fail нет копий" > "$out"; exit 1; fi
dropdb --if-exists massovka_restore_check 2>/dev/null
if ! createdb massovka_restore_check || ! pg_restore --no-owner --no-privileges -d massovka_restore_check "$f" 2>/tmp/backup-check.err; then
  echo "fail не восстановилась: $(basename "$f") $(tail -1 /tmp/backup-check.err)" > "$out"
  dropdb --if-exists massovka_restore_check 2>/dev/null
  exit 1
fi
n=$(psql -tA -d massovka_restore_check -c "select count(*) from analytics_events" 2>/dev/null)
d=$(psql -tA -d massovka_restore_check -c "select count(distinct device_id) from analytics_events" 2>/dev/null)
dropdb --if-exists massovka_restore_check
if [ -z "$n" ]; then echo "fail нет таблицы analytics_events в $(basename "$f")" > "$out"; exit 1; fi
echo "ok $(basename "$f") событий=$n телефонов=$d" > "$out"
