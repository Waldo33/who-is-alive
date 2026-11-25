#!/usr/bin/env bash
# Программы, ключи и выкладка новой версии игрового сервера (настройку машины перед этим делает Ansible).
# Запускается из GitHub Actions по SSH от root; повторный запуск безопасен. Всё нужное (Node, Caddy, сборка сервера) привозит Actions
# в /tmp/deploy: из России часть зарубежных сайтов (nodejs.org на Cloudflare) режется.
#
#   HOST=api.benobody.app [ALT_HOST=1-2-3-4.sslip.io] SHA=<коммит> bash setup.sh
# HOST — основной адрес (в нём WebSocket для клиентов): api.benobody.app, если DNS уже смотрит на сервер;
# ALT_HOST — запасной <IP>.sslip.io, обслуживается так же.
set -euo pipefail

: "${HOST:?нужен HOST}"
: "${SHA:?нужен SHA}"
D=/tmp/deploy
say() { echo "── $*"; }

# Настройку машины (пользователи, подкачка, SSH, файрвол, Postgres, ffmpeg, туннели, сторож, game.env,
# службы игры и Caddy, hosts.env, caddy.sh) делает Ansible (infra/ansible, game-deploy запускает его перед
# этим скриптом). Здесь — программы, ключи и выкладка версии.
if [ -z "${ANSIBLE:-}" ]; then
  echo "::error::сначала Ansible: infra/ansible/site.yml (game-deploy делает это сам)"
  exit 1
fi

# ───────────── Node и Caddy ─────────────
if [ -f "$D/node.tar.xz" ]; then
  ver=$(cat "$D/node.version")
  say "Node $ver"
  rm -rf "/opt/node-$ver"
  mkdir -p "/opt/node-$ver"
  tar -xJf "$D/node.tar.xz" -C "/opt/node-$ver" --strip-components=1
  echo "$ver" > "/opt/node-$ver/VERSION"
  ln -sfn "/opt/node-$ver" /opt/node
fi
if [ -f "$D/caddy" ]; then
  say "Caddy $(cat "$D/caddy.version")"
  install -m 755 "$D/caddy" /usr/local/bin/caddy.new
  mv -f /usr/local/bin/caddy.new /usr/local/bin/caddy
  cp "$D/caddy.version" /etc/caddy/VERSION
fi

# ───────────── секреты (рождаются на сервере и не покидают его) ─────────────
if ! grep -q '^AUTH_SIGNING_KEY=' /etc/massovka/secrets.env 2>/dev/null; then
  say "ключ подписи токенов игроков"
  # umask — только для этого файла, иначе конфиги ниже станут нечитаемыми для служб
  ( umask 077; echo "AUTH_SIGNING_KEY=$(openssl rand -hex 32)" >> /etc/massovka/secrets.env )
fi
# ключ нагрузочного прогона (load-test.yml читает его по SSH): снимает лимиты по адресу только с тестовых клиентов
if ! grep -q '^LOAD_KEY=' /etc/massovka/secrets.env 2>/dev/null; then
  ( umask 077; echo "LOAD_KEY=$(openssl rand -hex 24)" >> /etc/massovka/secrets.env )
fi
chmod 600 /etc/massovka/secrets.env

envsum_before=$( { cat /etc/massovka/*.env 2>/dev/null || true; } | sha256sum)
game_port() { [ "$1" = green ] && echo 8082 || echo 8081; }
# база стран для замера доступности (geo.ts): привозит game-deploy, если версия поменялась
if [ -s "$D/geoip.mmdb" ]; then
  install -d /opt/massovka/geoip
  install -m 644 "$D/geoip.mmdb" /opt/massovka/geoip/country.mmdb
  cp "$D/geoip.version" /etc/massovka/geoip.version
fi
# ключ Telegram-бота привозит выкладка из GitHub Secrets TELEGRAM_BOT_TOKEN (в /tmp/deploy/bot.env),
# на диске — /etc/massovka/bot.env, только root; читает его systemd при запуске игрового сервера
if [ -s "$D/bot.env" ]; then install -m 600 "$D/bot.env" /etc/massovka/bot.env; rm -f "$D/bot.env"; fi
# бот живёт только на сервере бота (infra): на игровом ключа быть не должно
if [ "${ROLE:-game}" = game ]; then rm -f /etc/massovka/bot.env; fi
envsum_after=$(cat /etc/massovka/*.env 2>/dev/null | sha256sum)

# наблюдение (метрики, логи, Grafana, копии) — до Caddy: он смотрит, стоит ли Grafana
if [ -f "$D/observe.sh" ]; then D=$D ROLE=${ROLE:-game} bash "$D/observe.sh" || echo "::warning::наблюдение настроилось не полностью"; fi
/opt/massovka/bin/caddy.sh

# ───────────── выкладка версии: синий/зелёный без обрыва матчей ─────────────
# Новая версия поднимается в свободном цвете, Caddy переключается на неё, старый экземпляр уходит в drain:
# лобби переезжают к новому, матчи доигрываются, затем он выходит сам (до 20 минут).
# Откат: echo <прежний цвет> > /etc/massovka/active-color; systemctl start massovka-game@<прежний>;
#        /opt/massovka/bin/caddy.sh; curl -X POST 127.0.0.1:<порт нового>/internal/drain
say "версия $SHA"
rel="/opt/massovka/releases/$SHA"
install -d -o game -g game "$rel"
install -m 644 -o game -g game "$D/server.mjs" "$rel/server.mjs"
[ -f "$D/server.mjs.map" ] && install -m 644 -o game -g game "$D/server.mjs.map" "$rel/server.mjs.map"
# процесс монтажа фильма матча, его шрифты и нативные модули — рядом с server.mjs той же версии
if [ -f "$D/film.tar.gz" ]; then
  tar -xzf "$D/film.tar.gz" -C "$rel"
  chown -R game:game "$rel"
fi
# хранить шесть последних версий: две из них могут работать одновременно (активная и доигрывающая)
ls -1dt /opt/massovka/releases/*/ | tail -n +7 | xargs -r rm -rf
install -d /opt/massovka/color

systemctl daemon-reload
systemctl enable --now caddy >/dev/null 2>&1
systemctl reload caddy || systemctl restart caddy

active=$(cat /etc/massovka/active-color 2>/dev/null || true)
case "$active" in blue | green) ;; *) active="" ;; esac
if [ -n "$active" ] && systemctl is-active -q "massovka-game@$active" \
  && cmp -s "$D/server.mjs" "/opt/massovka/color/$active/server.mjs" \
  && [ "$envsum_before" = "$envsum_after" ] \
  && [ ! -f /etc/massovka/restart-needed ] \
  && ! systemctl show "massovka-game@$active" -p NeedDaemonReload | grep -q yes; then
  # код сервера не изменился (правили только настройку) — ничего не трогаем
  say "код сервера тот же — без перезапуска ($active)"
else
  new=$([ "$active" = blue ] && echo green || echo blue)
  # свободный цвет ещё доигрывает матчи прошлой выкладки — подождать (до 15 минут), потом закрыть
  if systemctl is-active -q "massovka-game@$new"; then
    say "$new ещё доигрывает прошлую выкладку — жду до 15 минут"
    for _ in $(seq 1 180); do systemctl is-active -q "massovka-game@$new" || break; sleep 5; done
    systemctl stop "massovka-game@$new" 2>/dev/null || true
  fi
  ln -sfn "$rel" "/opt/massovka/color/$new"
  systemctl reset-failed "massovka-game@$new" 2>/dev/null || true
  systemctl start "massovka-game@$new"
  ok=0
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$(game_port "$new")/readyz" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  if [ "$ok" != 1 ]; then
    journalctl -u "massovka-game@$new" -n 40 --no-pager -o cat || true
    systemctl stop "massovka-game@$new" || true
    echo "::error::новая версия ($new) не поднялась — игроки остаются на прежней (${active:-нет})"
    exit 1
  fi
  # одноразовый переход со старой схемы (одна служба на :8080): её матчи обрываются в последний раз
  if [ -f /etc/systemd/system/massovka-game.service ]; then
    say "переход на синий/зелёный: старая служба massovka-game останавливается"
    systemctl disable --now massovka-game.service >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/massovka-game.service
    rm -rf /etc/systemd/system/massovka-game.service.d
    systemctl daemon-reload
  fi
  echo "$new" > /etc/massovka/active-color
  # новая настройка (метка Ansible) теперь у работающего экземпляра
  rm -f /etc/massovka/restart-needed
  systemctl enable "massovka-game@$new" >/dev/null 2>&1
  /opt/massovka/bin/caddy.sh
  say "активный экземпляр: $new ($SHA)"
  if [ -n "$active" ] && systemctl is-active -q "massovka-game@$active"; then
    say "$active → drain: лобби переезжают на $new, матчи доигрываются, потом он выйдет сам"
    curl -fsS -m 10 -X POST "http://127.0.0.1:$(game_port "$active")/internal/drain" && echo || echo "::warning::$active не принял drain"
    systemctl disable "massovka-game@$active" >/dev/null 2>&1 || true
  fi
fi

say "проверка"
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:8080/healthz && echo
# метрики игры через внутренний вход (их читают Grafana и сторож): пусто — графики и тревоги ослепли
m=$(curl -fsS http://127.0.0.1:8080/metrics 2>/dev/null | grep -c '^game_' || true)
if [ "${m:-0}" -gt 0 ]; then echo "метрики игры: $m строк"; else echo "::warning::метрики игры через 127.0.0.1:8080 не отдаются — Grafana и сторож их не увидят"; fi
systemctl is-active "massovka-game@$(cat /etc/massovka/active-color)" caddy
echo "Node: $(/opt/node/bin/node -v); Caddy: $(cat /etc/caddy/VERSION 2>/dev/null || echo ?)"
