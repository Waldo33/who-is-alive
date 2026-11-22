#!/usr/bin/env bash
# Настройка игрового сервера и выкладка новой версии. Запускается из GitHub Actions по SSH
# от root; повторный запуск безопасен. Всё нужное (Node, Caddy, сборка сервера) привозит Actions
# в /tmp/deploy: из России часть зарубежных сайтов (nodejs.org на Cloudflare) режется.
#
#   HOST=api.benobody.app [ALT_HOST=1-2-3-4.sslip.io] SHA=<коммит> bash setup.sh
# HOST — основной адрес (в нём WebSocket для клиентов), ALT_HOST — запасной, обслуживается так же.
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
if [ ! -f /etc/massovka/secrets.env ]; then
  say "ключ подписи токенов игроков"
  # umask — только для этого файла, иначе конфиги ниже станут нечитаемыми для служб
  ( umask 077; echo "AUTH_SIGNING_KEY=$(openssl rand -hex 32)" > /etc/massovka/secrets.env )
fi
chmod 600 /etc/massovka/secrets.env

cat > /etc/massovka/game.env <<EOF
NODE_ENV=production
PORT=8080
INSTANCE=blue
PUBLIC_WS_BASE=wss://$HOST
TRUST_PROXY=1
LOG_LEVEL=info
EOF

# ───────────── службы ─────────────
cat > /etc/systemd/system/massovka-game.service <<'EOF'
[Unit]
Description=Массовка: игровой сервер
After=network-online.target
Wants=network-online.target

[Service]
User=game
Group=game
EnvironmentFile=/etc/massovka/game.env
EnvironmentFile=/etc/massovka/secrets.env
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
MemoryMax=2G

[Install]
WantedBy=multi-user.target
EOF

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

cat > /etc/caddy/Caddyfile <<EOF
{
	admin localhost:2019
}

$HOST${ALT_HOST:+, $ALT_HOST} {
	encode zstd gzip
	# метрики — только изнутри
	@internal path /metrics
	respond @internal 404
	# X-Forwarded-For Caddy ставит сам (адрес клиента) — по нему лимиты на сервере
	reverse_proxy 127.0.0.1:8080
	log {
		output stdout
		format json
	}
}
EOF

chown root:caddy /etc/caddy/Caddyfile
chmod 640 /etc/caddy/Caddyfile
chmod 644 /etc/systemd/system/massovka-game.service /etc/systemd/system/caddy.service
chmod 600 /etc/massovka/game.env

# ───────────── выкладка версии ─────────────
say "версия $SHA"
rel="/opt/massovka/releases/$SHA"
install -d -o game -g game "$rel"
install -m 644 -o game -g game "$D/server.mjs" "$rel/server.mjs"
[ -f "$D/server.mjs.map" ] && install -m 644 -o game -g game "$D/server.mjs.map" "$rel/server.mjs.map"
ln -sfn "$rel" /opt/massovka/current
# хранить пять последних версий (откат — переключить ссылку)
ls -1dt /opt/massovka/releases/*/ | tail -n +6 | xargs -r rm -rf

systemctl daemon-reload
systemctl enable --now caddy >/dev/null 2>&1
systemctl reload caddy || systemctl restart caddy
systemctl enable massovka-game >/dev/null 2>&1
systemctl restart massovka-game

say "проверка"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:8080/healthz && echo
systemctl is-active massovka-game caddy
echo "Node: $(/opt/node/bin/node -v); Caddy: $(cat /etc/caddy/VERSION 2>/dev/null || echo ?)"
