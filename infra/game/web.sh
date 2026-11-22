#!/usr/bin/env bash
# Выкладка сайта (Next.js standalone) на сервер. Сервер уже настроен game-deploy (Node, Caddy, адреса).
#   SHA=<коммит> bash web.sh      (сборка — /tmp/deploy-web/web.tar.gz)
set -euo pipefail
: "${SHA:?нужен SHA}"
D=/tmp/deploy-web
say() { echo "── $*"; }
[ -x /opt/node/bin/node ] || { echo "нет Node — сначала game-deploy"; exit 1; }

id web >/dev/null 2>&1 || useradd --system --home /opt/massovka/web --shell /usr/sbin/nologin web
install -d -o web -g web /opt/massovka/web /opt/massovka/web/releases /var/cache/massovka-web

say "сайт, версия $SHA"
rel="/opt/massovka/web/releases/$SHA"
rm -rf "$rel"
install -d -o web -g web "$rel"
tar -xzf "$D/web.tar.gz" -C "$rel"
chown -R web:web "$rel"
# кэш Next (картинки превью и т. п.) — отдельно, общий для версий
rm -rf "$rel/apps/web/.next/cache"
ln -sfn /var/cache/massovka-web "$rel/apps/web/.next/cache"

cat > /etc/massovka/web.env <<ENV
NODE_ENV=production
PORT=3000
HOSTNAME=127.0.0.1
NEXT_TELEMETRY_DISABLED=1
ENV

cat > /etc/systemd/system/massovka-web.service <<'UNIT'
[Unit]
Description=Массовка: сайт (Next.js)
After=network-online.target
Wants=network-online.target

[Service]
User=web
Group=web
EnvironmentFile=/etc/massovka/web.env
WorkingDirectory=/opt/massovka/web/current/apps/web
ExecStart=/opt/node/bin/node --max-old-space-size=384 server.js
Restart=always
RestartSec=1
TimeoutStopSec=15
LimitNOFILE=65536
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/cache/massovka-web
MemoryMax=700M

[Install]
WantedBy=multi-user.target
UNIT
chmod 644 /etc/systemd/system/massovka-web.service

ln -sfn "$rel" /opt/massovka/web/current
ls -1dt /opt/massovka/web/releases/*/ | tail -n +4 | xargs -r rm -rf

systemctl daemon-reload
systemctl enable massovka-web >/dev/null 2>&1
systemctl restart massovka-web
for i in $(seq 1 40); do
  if curl -fsS -o /dev/null http://127.0.0.1:3000/; then break; fi
  sleep 1
done
curl -fsS -o /dev/null -w "сайт отвечает: %{http_code}\n" http://127.0.0.1:3000/
# Caddy: теперь сайт на сервере — проксировать, а не перенаправлять
install -d /opt/massovka/bin
install -m 755 "$D/caddy.sh" /opt/massovka/bin/caddy.sh
if [ -f /etc/massovka/hosts.env ]; then /opt/massovka/bin/caddy.sh
else echo "::warning::нет /etc/massovka/hosts.env — Caddy переключит game-deploy"; fi
systemctl is-active massovka-web caddy
free -m | head -2
