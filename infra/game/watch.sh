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
http_ok https://api.benobody.app/healthz; check game $? "игровой сервер api.benobody.app"
# бот через Москву — заодно проверка туннеля
http_ok https://api.benobody.app/tg/info; check bot_via_msk $? "бот через Москву (туннель Нидерланды → Москва)"

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
  # клипы для Telegram в Москве: лимит папки 1 ГБ, старые вытесняются — на 80% пора думать об S3
  c=$(vm 'max(game_clips_bytes{server="msk"}) / max(game_clips_limit_bytes{server="msk"})' | awk '{print $NF}' | head -1)
  if [ -n "$c" ]; then within "$c" 0.8; check clips_msk $? "место под клипы в Москве занято на $(pct "$c")% из 1 ГБ (пора S3)"; fi
fi
# ночная копия базы Москвы: свежей суток с запасом (раз в сутки в 03:40 UTC)
if systemctl is-enabled -q massovka-msk-backup.timer 2>/dev/null; then
  [ -n "$(find /var/backups/massovka-msk -name '*.dump' -mmin -1560 2>/dev/null | head -1)" ]
  check msk_backup $? "копия базы Москвы старше 26 часов"
fi
exit 0
