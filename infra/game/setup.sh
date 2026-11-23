#!/usr/bin/env bash
# Настройка игрового сервера и выкладка новой версии. Запускается из GitHub Actions по SSH
# от root; повторный запуск безопасен. Всё нужное (Node, Caddy, сборка сервера) привозит Actions
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

# ───────────── система ─────────────
say "пользователи и папки"
id game >/dev/null 2>&1 || useradd --system --home /opt/massovka --shell /usr/sbin/nologin game
id caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy
install -d -o game -g game /opt/massovka /opt/massovka/releases
install -d -o caddy -g caddy /var/lib/caddy
install -d -m 755 /etc/caddy
install -d -m 700 /etc/massovka

say "подкачка 1 ГБ (страховка от нехватки памяти)"
if ! swapon --show | grep -q /swapfile; then
  [ -f /swapfile ] || { fallocate -l 1G /swapfile; chmod 600 /swapfile; mkswap /swapfile >/dev/null; }
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "сеть: много соединений"
cat > /etc/sysctl.d/90-massovka.conf <<'EOF'
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 4096
net.ipv4.ip_local_port_range = 10240 65535
fs.file-max = 1048576
EOF
sysctl -q --system || true

say "SSH только по ключу"
cat > /etc/ssh/sshd_config.d/90-massovka.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true

say "файрвол: 22, 80, 443"
if command -v ufw >/dev/null; then
  ufw allow 22/tcp >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
  ufw --force enable >/dev/null
fi

say "журнал не больше 500 МБ"
install -d /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\n' > /etc/systemd/journald.conf.d/90-massovka.conf
systemctl restart systemd-journald

# ───────────── ffmpeg: «Фильм матча» монтирует игровой сервер (apps/server/src/film.ts) ─────────────
if [ "${ROLE:-game}" = game ] && ! command -v ffmpeg >/dev/null; then
  say "ffmpeg"
  # нет ffmpeg — сервер просто не монтирует фильмы (их смонтирует телефон), выкладку не роняем
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ffmpeg >/dev/null 2>&1 \
    || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ffmpeg >/dev/null; } \
    || echo "::warning::ffmpeg не поставился — фильм матча будет монтировать телефон"
fi

# ───────────── Postgres (аналитика, рейтинг бота) ─────────────
if ! command -v psql >/dev/null; then
  say "Postgres"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq postgresql >/dev/null
fi
PGVER=$(ls /etc/postgresql | sort -V | tail -1)
# маленькая машина (1 ГБ): скромные буферы, только localhost
cat > "/etc/postgresql/$PGVER/main/conf.d/90-massovka.conf" <<'EOF'
listen_addresses = 'localhost'
max_connections = 30
shared_buffers = 64MB
effective_cache_size = 256MB
work_mem = 4MB
maintenance_work_mem = 32MB
wal_buffers = 4MB
EOF
systemctl enable --now postgresql >/dev/null 2>&1
systemctl reload postgresql || systemctl restart postgresql
if ! grep -q '^DATABASE_URL=' /etc/massovka/secrets.env 2>/dev/null; then
  say "база massovka"
  pw=$(openssl rand -hex 24)
  sudo -u postgres psql -qtAc "do \$\$ begin if not exists (select from pg_roles where rolname = 'massovka') then create role massovka login password '$pw'; else alter role massovka password '$pw'; end if; end \$\$;"
  sudo -u postgres psql -qtAc "select 1 from pg_database where datname = 'massovka'" | grep -q 1 || sudo -u postgres createdb -O massovka massovka
  ( umask 077; echo "DATABASE_URL=postgres://massovka:$pw@127.0.0.1:5432/massovka" >> /etc/massovka/secrets.env )
fi

say "копия базы раз в сутки (14 дней)"
install -d -m 700 -o postgres -g postgres /var/backups/massovka
cat > /etc/systemd/system/massovka-backup.service <<'EOF'
[Unit]
Description=Массовка: копия базы
[Service]
Type=oneshot
User=postgres
ExecStart=/bin/sh -c 'pg_dump -Fc massovka > /var/backups/massovka/massovka-$(date +%%F).dump && find /var/backups/massovka -name "*.dump" -mtime +14 -delete'
EOF
cat > /etc/systemd/system/massovka-backup.timer <<'EOF'
[Unit]
Description=Массовка: копия базы раз в сутки
[Timer]
OnCalendar=*-*-* 03:17:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now massovka-backup.timer >/dev/null 2>&1

# ───────────── туннель Нидерланды → Москва ─────────────
# Из Москвы соединения за границу режутся (api.telegram.org, наш сервер в Нидерландах), а обратно — нет.
# Поэтому сервер в Нидерландах (infra) сам держит SSH-туннель в Москву: в Москве на 127.0.0.1:9090
# появляется его игровой сервер с ботом, и Caddy в Москве пересылает туда /tg/*.
if [ "${ROLE:-game}" = infra ] && [ -n "${TUNNEL_TO:-}" ]; then
  say "туннель в Москву ($TUNNEL_TO)"
  [ -f /etc/massovka/tunnel_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -C massovka-tunnel -f /etc/massovka/tunnel_ed25519
  unit_before=$(cat /etc/systemd/system/massovka-tunnel.service 2>/dev/null | sha256sum)
  cat > /etc/systemd/system/massovka-tunnel.service <<EOF
[Unit]
Description=Массовка: туннель в Москву (бот; логи Москвы сюда; база, метрики Москвы отсюда)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
ExecStart=/usr/bin/ssh -N -i /etc/massovka/tunnel_ed25519 -o ExitOnForwardFailure=yes -o ConnectTimeout=5 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/etc/massovka/tunnel_known_hosts -R 127.0.0.1:9090:127.0.0.1:8080 -R 127.0.0.1:9428:127.0.0.1:9428 -L 127.0.0.1:15432:127.0.0.1:5432 -L 127.0.0.1:18080:127.0.0.1:8080 -L 127.0.0.1:19100:127.0.0.1:9100 tunnel@$TUNNEL_TO
# новые соединения в Москву из-за фильтров проходят через раз (20–40%), уже открытое держится:
# пробуем часто и коротко, а без нужды не переподключаемся
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable massovka-tunnel >/dev/null 2>&1
  if [ "$unit_before" != "$(sha256sum < /etc/systemd/system/massovka-tunnel.service)" ] || ! systemctl is-active -q massovka-tunnel; then systemctl restart massovka-tunnel; fi
fi
if [ "${ROLE:-game}" = game ] && [ -s "$D/tunnel.pub" ]; then
  say "вход для туннеля из Нидерландов (только проброс 127.0.0.1:9090)"
  id tunnel >/dev/null 2>&1 || useradd --system --create-home --home /var/lib/tunnel --shell /usr/sbin/nologin tunnel
  install -d -m 700 -o tunnel -g tunnel /var/lib/tunnel/.ssh
  # можно: открыть у себя 9090 (бот) и 9428 (логи → Нидерланды); пройти к базе, метрикам игры и машины
  echo "restrict,port-forwarding,permitlisten=\"127.0.0.1:9090\",permitlisten=\"127.0.0.1:9428\",permitopen=\"127.0.0.1:5432\",permitopen=\"127.0.0.1:8080\",permitopen=\"127.0.0.1:9100\" $(cat "$D/tunnel.pub")" > /var/lib/tunnel/.ssh/authorized_keys
  chown tunnel:tunnel /var/lib/tunnel/.ssh/authorized_keys
  chmod 600 /var/lib/tunnel/.ssh/authorized_keys
fi

# ───────────── сторож и тревоги (сервер в Нидерландах) ─────────────
if [ -s "$D/alerts.env" ]; then install -m 600 "$D/alerts.env" /etc/massovka/alerts.env; rm -f "$D/alerts.env"; fi
if [ "${ROLE:-game}" = infra ] && [ -f /etc/massovka/alerts.env ] && [ -f "$D/watch.sh" ]; then
  say "сторож: проверки раз в минуту, тревоги в Telegram"
  command -v jq >/dev/null || { apt-get update -qq; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq jq >/dev/null; }
  install -d /opt/massovka/bin
  install -m 755 "$D/watch.sh" /opt/massovka/bin/watch.sh
  cat > /etc/systemd/system/massovka-watch.service <<'EOF'
[Unit]
Description=Массовка: сторож (сайт, игра, бот, туннель)
[Service]
Type=oneshot
ExecStart=/opt/massovka/bin/watch.sh
TimeoutStartSec=170
EOF
  cat > /etc/systemd/system/massovka-watch.timer <<'EOF'
[Unit]
Description=Массовка: сторож раз в минуту
[Timer]
# каждую минуту по часам (OnUnitActiveSec у короткой службы может не перевзводиться)
OnCalendar=*-*-* *:*:05
AccuracySec=5s
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable massovka-watch.timer >/dev/null 2>&1
  systemctl restart massovka-watch.timer
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
chmod 600 /etc/massovka/secrets.env

envsum_before=$(cat /etc/massovka/*.env 2>/dev/null | sha256sum)
# потолок комнат под память машины: нагрузочный прогон 23.11 — около 1,5 МБ на комнату (250 комнат = 440 МБ);
# на сайт, базу, Caddy и «Фильм матча» оставляем ~600 МБ, комнату считаем по 2 МБ с запасом.
# 1 ГБ → ~150 комнат, 2 ГБ → ~650, 4 ГБ → ~1650. Больше лимита — «сервер занят», а не подкачка и лаги у всех.
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
max_rooms=$(( (mem_mb - 600) / 2 ))
[ "$max_rooms" -lt 50 ] && max_rooms=50
[ "$max_rooms" -gt 2000 ] && max_rooms=2000
cat > /etc/massovka/game.env <<EOF
NODE_ENV=production
PORT=8080
INSTANCE=blue
PUBLIC_WS_BASE=wss://$HOST
PUBLIC_API_BASE=https://$HOST
SITE_URL=${BOT_SITE:-https://${SITE_HOST:-$HOST}}
TG_APP_NAME=play
# клипы для Telegram лежат на игровом сервере в Москве — бот (Нидерланды) даёт ссылки туда
CLIP_BASE=${CLIP_BASE:-https://api.benobody.app}
TRUST_PROXY=1
LOG_LEVEL=info
MAX_ROOMS=$max_rooms
EOF
# ключ Telegram-бота привозит выкладка из GitHub Secrets TELEGRAM_BOT_TOKEN (в /tmp/deploy/bot.env),
# на диске — /etc/massovka/bot.env, только root; читает его systemd при запуске игрового сервера
if [ -s "$D/bot.env" ]; then install -m 600 "$D/bot.env" /etc/massovka/bot.env; rm -f "$D/bot.env"; fi
# бот живёт только на сервере бота (infra): на игровом ключа быть не должно
if [ "${ROLE:-game}" = game ]; then rm -f /etc/massovka/bot.env; fi
envsum_after=$(cat /etc/massovka/*.env 2>/dev/null | sha256sum)

# ───────────── службы ─────────────
cat > /etc/systemd/system/massovka-game.service <<'EOF'
[Unit]
Description=Массовка: игровой сервер
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=game
Group=game
EnvironmentFile=/etc/massovka/game.env
EnvironmentFile=/etc/massovka/secrets.env
EnvironmentFile=-/etc/massovka/bot.env
ExecStart=/opt/node/bin/node --enable-source-maps /opt/massovka/current/server.mjs
Restart=always
RestartSec=1
KillSignal=SIGTERM
TimeoutStopSec=30
LimitNOFILE=65536
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
ReadOnlyPaths=/opt/massovka
# клипы «Лучший момент» для Telegram (apps/server/src/clips.ts): /var/lib/massovka-clips, 2 суток
StateDirectory=massovka-clips
# память: MemoryHigh/MemoryMax ниже дописывает setup.sh (drop-in) по размеру машины

[Install]
WantedBy=multi-user.target
EOF
# память игрового сервера — по размеру машины, не больше физической (раньше стояло 2 ГБ при 1 ГБ):
# выше MemoryHigh ядро тормозит и отжимает службу, MemoryMax — жёсткий потолок вместе с «Фильмом матча».
# Перегрузку должен ловить MAX_ROOMS («сервер занят»), а не нехватка памяти.
install -d /etc/systemd/system/massovka-game.service.d
cat > /etc/systemd/system/massovka-game.service.d/memory.conf <<EOF
[Service]
MemoryHigh=$(( mem_mb * 75 / 100 ))M
MemoryMax=$(( mem_mb * 90 / 100 ))M
EOF
chmod 644 /etc/systemd/system/massovka-game.service.d/memory.conf

cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy (HTTPS и прокси к игровому серверу)
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
Environment=XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
Restart=always
RestartSec=2
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
LimitNOFILE=1048576
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF

# адреса — в файл: их читает caddy.sh (его вызывает и выкладка сайта)
cat > /etc/massovka/hosts.env <<EOF
HOST=$HOST
ALT_HOST=${ALT_HOST:-}
SITE_HOST=${SITE_HOST:-}
SITE_REDIRECT=${SITE_REDIRECT:-}
BOT_UPSTREAM=${BOT_UPSTREAM:-}
EOF
install -d /opt/massovka/bin
install -m 755 "$D/caddy.sh" /opt/massovka/bin/caddy.sh
# наблюдение (метрики, логи, Grafana, копии) — до Caddy: он смотрит, стоит ли Grafana
if [ -f "$D/observe.sh" ]; then D=$D ROLE=${ROLE:-game} bash "$D/observe.sh" || echo "::warning::наблюдение настроилось не полностью"; fi
/opt/massovka/bin/caddy.sh
chmod 644 /etc/systemd/system/massovka-game.service /etc/systemd/system/caddy.service
chmod 600 /etc/massovka/game.env

# ───────────── выкладка версии ─────────────
say "версия $SHA"
# код сервера не изменился (правили только настройку) — не перезапускать: идущие матчи не оборвутся
same=0
if [ -f /opt/massovka/current/server.mjs ] && cmp -s "$D/server.mjs" /opt/massovka/current/server.mjs; then same=1; fi
rel="/opt/massovka/releases/$SHA"
install -d -o game -g game "$rel"
install -m 644 -o game -g game "$D/server.mjs" "$rel/server.mjs"
[ -f "$D/server.mjs.map" ] && install -m 644 -o game -g game "$D/server.mjs.map" "$rel/server.mjs.map"
# процесс монтажа фильма матча, его шрифты и нативные модули — рядом с server.mjs той же версии
if [ -f "$D/film.tar.gz" ]; then
  tar -xzf "$D/film.tar.gz" -C "$rel"
  chown -R game:game "$rel"
fi
ln -sfn "$rel" /opt/massovka/current
# хранить пять последних версий (откат — переключить ссылку)
ls -1dt /opt/massovka/releases/*/ | tail -n +6 | xargs -r rm -rf

systemctl daemon-reload
systemctl enable --now caddy >/dev/null 2>&1
systemctl reload caddy || systemctl restart caddy
systemctl enable massovka-game >/dev/null 2>&1
if [ "$same" = 1 ] && [ "$envsum_before" = "$envsum_after" ] && ! systemctl show massovka-game -p NeedDaemonReload | grep -q yes && systemctl is-active -q massovka-game; then
  say "код сервера тот же — без перезапуска"
else
  systemctl restart massovka-game
fi

say "проверка"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:8080/healthz && echo
systemctl is-active massovka-game caddy
echo "Node: $(/opt/node/bin/node -v); Caddy: $(cat /etc/caddy/VERSION 2>/dev/null || echo ?)"
