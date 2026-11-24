#!/usr/bin/env bash
# Сторож (сервер в Нидерландах, раз в минуту): сайт, игра, бот, туннель в Москву.
# Тревога в Telegram — если проверка не проходит 5 минут подряд; «восстановлено» — когда снова в порядке.
# Связь Нидерланды → Москва режется фильтрами (новые соединения проходят на 20–40%), поэтому каждая
# внешняя проверка делает до 6 попыток с коротким таймаутом: хоть одна удалась — значит, работает.
set -uo pipefail
. /etc/massovka/alerts.env   # ALERTS_BOT_TOKEN, ALERTS_CHAT
STATE=/var/lib/massovka-watch
LIMIT=5
mkdir -p "$STATE"

send() {
  curl -s -m 15 -X POST "https://api.telegram.org/bot${ALERTS_BOT_TOKEN}/sendMessage" \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg c "$ALERTS_CHAT" --arg t "$1" '{chat_id: $c, text: $t, disable_web_page_preview: true}')" >/dev/null || true
}

# внешний адрес: до 6 попыток; ok — если ответ с нужным кодом
http_ok() {
  local url=$1 want=${2:-200} code
  for _ in 1 2 3 4 5 6; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 -m 8 "$url" || true)
    [ "$code" = "$want" ] && return 0
    sleep 1
  done
  return 1
}

# учёт: name, ok(0/1), описание для тревоги
check() {
  local name=$1 ok=$2 what=$3 f="$STATE/$1" n
  n=$(cat "$f" 2>/dev/null || echo 0)
  if [ "$ok" = 0 ]; then
    if [ "$n" -ge "$LIMIT" ]; then send "✅ Восстановлено: $what"; fi
    echo 0 > "$f"
  else
    n=$((n + 1))
    echo "$n" > "$f"
    if [ "$n" = "$LIMIT" ]; then send "🔴 Не работает уже $LIMIT мин: $what"; fi
    # напоминание раз в час, пока не починится
    if [ "$n" -gt "$LIMIT" ] && [ $(((n - LIMIT) % 60)) = 0 ]; then send "🔴 Всё ещё не работает ($n мин): $what"; fi
  fi
}

http_ok https://benobody.app/; check site $? "сайт benobody.app"
# песочница — отдельная страница сайта (Next рендерит её сам): 5xx здесь при живой главной — сломанная сборка
http_ok https://benobody.app/sandbox; check site_sandbox $? "страница песочницы benobody.app/sandbox"

# сертификаты (Caddy продлевает сам; не продлил — узнаём за две недели). Раз в час: связь до Москвы
# режется фильтром, поэтому без ответа просто ждём следующего часа, тревожит только известный срок
if [ "$(date +%M)" = 17 ] || [ ! -s "$STATE/cert_days" ]; then
  min=""
  for h in benobody.app api.benobody.app; do
    for _ in 1 2 3 4 5 6; do
      end=$(echo | timeout 8 openssl s_client -connect "$h:443" -servername "$h" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
      [ -n "$end" ] && break
      sleep 1
    done
    [ -z "$end" ] && continue
    d=$(( ($(date -d "$end" +%s) - $(date +%s)) / 86400 ))
    if [ -z "$min" ] || [ "$d" -lt "$min" ]; then min=$d; fi
  done
  [ -n "$min" ] && echo "$min" > "$STATE/cert_days"
fi
cd_=$(cat "$STATE/cert_days" 2>/dev/null || echo "")
if [ -n "$cd_" ]; then [ "$cd_" -ge 14 ]; check cert $? "сертификат benobody.app истекает через $cd_ дн. — Caddy не продлил"; fi
http_ok https://api.benobody.app/healthz; check game $? "игровой сервер api.benobody.app"
# бот через Москву — заодно проверка туннеля
http_ok https://api.benobody.app/tg/info; check bot_via_msk $? "бот через Москву (туннель Нидерланды → Москва)"

# IPv6: у серверов его нет, поэтому записей AAAA у домена быть не должно — иначе телефоны с IPv6
# уходят мимо игры (22.11 benobody.app и www смотрели на заглушку Timeweb)
v6=""
command -v dig >/dev/null && for h in benobody.app www.benobody.app api.benobody.app; do
  # спрашиваем публичный резолвер: getent на сервере без IPv6 записи AAAA может не запрашивать
  a=$(dig +short +time=3 +tries=2 AAAA "$h" @8.8.8.8 2>/dev/null | grep ':' | tr '\n' ' ')
  [ -n "$a" ] && v6="$v6 $h→$a"
done
[ -z "$v6" ]; check dns_aaaa $? "у домена есть записи AAAA (IPv6), а у серверов IPv6 нет:$v6— удалить в панели DNS"

# бот у себя: вебхук на месте, Telegram не жалуется на доставку
st=$(curl -s -m 15 http://127.0.0.1:8080/tg/status || true)
if echo "$st" | jq -e '.webhook == true and ((.pending // 0) < 100)' >/dev/null 2>&1; then r=0; else r=1; fi
check bot_webhook $r "вебхук Telegram-бота (ошибка: $(echo "$st" | jq -r '.lastError // "нет ответа"' 2>/dev/null))"

# место на диске и память самого сервера в Нидерландах
disk=$(df --output=pcent / | tail -1 | tr -dc 0-9)
[ "${disk:-0}" -lt 90 ]; check nl_disk $? "диск сервера в Нидерландах заполнен на ${disk}%"

# наблюдение: метрики собираются со всех источников (Москва — через туннель), Grafana жива
if [ -x /usr/local/bin/victoria-metrics ]; then
  down=$(curl -s -m 5 'http://127.0.0.1:8428/api/v1/query?query=up==0' | jq -r '[.data.result[] | .metric.job + "/" + .metric.server] | join(", ")' 2>/dev/null)
  [ -n "${down+x}" ] && curl -s -m 5 -o /dev/null http://127.0.0.1:8428/health && [ -z "$down" ]
  check metrics $? "сбор метрик${down:+ (не отвечает: $down)}"
  curl -s -m 5 -o /dev/null -f http://127.0.0.1:3001/api/health; check grafana $? "Grafana"

  # диск Москвы и память обоих серверов (по метрикам; нет данных — не тревожим, за это «сбор метрик»)
  vm() { curl -s -m 5 --data-urlencode "query=$1" http://127.0.0.1:8428/api/v1/query | jq -r '.data.result[] | "\(.metric.server // "") \(.value[1])"' 2>/dev/null; }
  pct() { awk -v v="$1" 'BEGIN { printf "%d", v * 100 }'; }
  # «в норме»: значение не выше порога (0 — норма, как у остальных проверок)
  within() { awk -v v="$1" -v lim="$2" 'BEGIN { exit !(v <= lim) }'; }
  for s in msk nl; do
    name=$([ $s = msk ] && echo "Москвы" || echo "в Нидерландах")
    # диск Нидерландов уже проверяется выше по df (работает и без метрик)
    [ $s = nl ] && d="" || d=$(vm "1 - node_filesystem_avail_bytes{server=\"$s\",mountpoint=\"/\"} / node_filesystem_size_bytes{server=\"$s\",mountpoint=\"/\"}" | awk '{print $NF}' | head -1)
    if [ -n "$d" ]; then within "$d" 0.85; check "disk_$s" $? "диск сервера $name заполнен на $(pct "$d")%"; fi
    m=$(vm "1 - node_memory_MemAvailable_bytes{server=\"$s\"} / node_memory_MemTotal_bytes{server=\"$s\"}" | awk '{print $NF}' | head -1)
    if [ -n "$m" ]; then within "$m" 0.92; check "mem_$s" $? "память сервера $name занята на $(pct "$m")%"; fi
  done
  # шаг матча на сервере: обычно меньше 1 мс; дольше 20 мс в p99 — сервер не успевает, у игроков лаги
  st=$(vm 'max(game_step_ms_p99{server="msk"})' | awk '{print $NF}' | head -1)
  if [ -n "$st" ]; then within "$st" 20; check step_msk $? "матчи в Москве тормозят: шаг p99 $(printf '%.0f' "$st") мс (норма < 1)"; fi
  # ошибки JS с телефонов (lib/errors.ts): больше 30 за 10 минут — что-то сломали выкладкой
  e=$(vm 'sum(increase(game_client_errors_total{server="msk"}[10m]))' | awk '{print $NF}' | head -1)
  if [ -n "$e" ]; then within "$e" 30; check client_errors $? "ошибки на телефонах: $(printf '%.0f' "$e") за 10 минут (VictoriaLogs: client_error)"; fi
  # комнаты у потолка MAX_ROOMS: выше 80% — скоро новые получат «сервер занят»
  r=$(vm 'max(game_rooms{server="msk"}) / max(game_rooms_limit{server="msk"})' | awk '{print $NF}' | head -1)
  if [ -n "$r" ]; then within "$r" 0.8; check rooms_msk $? "комнат в Москве $(pct "$r")% от лимита — скоро «сервер занят»"; fi
  # выкладка синий/зелёный: старый экземпляр доигрывает матчи до 20 минут и выходит сам — дольше 30 минут
  # в drain значит завис (новая выкладка будет ждать его 15 минут, а потом оборвёт матчи)
  dr=$(vm 'max(max_over_time(game_draining{server="msk"}[30m]) * min_over_time(game_draining{server="msk"}[30m]))' | awk '{print $NF}' | head -1)
  if [ -n "$dr" ]; then within "$dr" 0; check drain_stuck $? "экземпляр игры в Москве больше 30 минут в drain (выкладка синий/зелёный)"; fi
  # клипы для Telegram в Москве: лимит папки 1 ГБ, старые вытесняются — на 80% пора думать об S3
  c=$(vm 'max(game_clips_bytes{server="msk"}) / max(game_clips_limit_bytes{server="msk"})' | awk '{print $NF}' | head -1)
  if [ -n "$c" ]; then within "$c" 0.8; check clips_msk $? "место под клипы в Москве занято на $(pct "$c")% из 1 ГБ (пора S3)"; fi
fi
# копия восстанавливается (раз в неделю, observe.sh › backup-check): итог не старше 8 суток и «ok»
if systemctl is-enabled -q massovka-backup-check.timer 2>/dev/null && [ -s /var/lib/postgresql/backup-check.status ]; then
  bc=$(cat /var/lib/postgresql/backup-check.status)
  [ "${bc%% *}" = ok ] && [ -n "$(find /var/lib/postgresql/backup-check.status -mmin -11520 2>/dev/null)" ]
  check backup_restore $? "копия базы Москвы не восстанавливается или давно не проверялась: ${bc#* }"
fi
# ночная копия базы Москвы: свежей суток с запасом (раз в сутки в 03:40 UTC)
if systemctl is-enabled -q massovka-msk-backup.timer 2>/dev/null; then
  [ -n "$(find /var/backups/massovka-msk -name '*.dump' -mmin -1560 2>/dev/null | head -1)" ]
  check msk_backup $? "копия базы Москвы старше 26 часов"
fi
exit 0
