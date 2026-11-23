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
# каталог версии уникален: повторная выкладка того же коммита не трогает работающую копию
rel="/opt/massovka/web/releases/$SHA-$(date +%s)"
install -d -o web -g web "$rel"
tar -xzf "$D/web.tar.gz" -C "$rel"
chown -R web:web "$rel"
# кэш Next (картинки превью и т. п.) — отдельно, общий для версий
rm -rf "$rel/apps/web/.next/cache"
ln -sfn /var/cache/massovka-web "$rel/apps/web/.next/cache"

# синий/зелёный (docs/infra-plan.md › этап 1): новая версия поднимается рядом, Caddy переключается,
# когда она ответила, старая дослуживает начатые запросы (20 с) и останавливается — сайт не моргает
web_port() { [ "$1" = green ] && echo 3011 || echo 3010; }
cat > /etc/massovka/web.env <<ENV
NODE_ENV=production
HOSTNAME=127.0.0.1
NEXT_TELEMETRY_DISABLED=1
ENV
for c in blue green; do echo "PORT=$(web_port $c)" > "/etc/massovka/web-$c.env"; done

cat > /etc/systemd/system/massovka-web@.service <<'UNIT'
[Unit]
Description=Массовка: сайт (Next.js, %i)
After=network-online.target
Wants=network-online.target

[Service]
User=web
Group=web
EnvironmentFile=/etc/massovka/web.env
EnvironmentFile=/etc/massovka/web-%i.env
WorkingDirectory=/opt/massovka/web/color/%i/apps/web
ExecStart=/opt/node/bin/node --max-old-space-size=384 server.js
Restart=on-failure
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
chmod 644 /etc/systemd/system/massovka-web@.service

active=$(cat /etc/massovka/web-active 2>/dev/null || true)
case "$active" in blue | green) ;; *) active="" ;; esac
new=$([ "$active" = blue ] && echo green || echo blue)
# старые вкладки и PWA догружают куски прошлой версии (темы, сцены): статика прошлой версии за 2 суток
# переезжает в новую (имена с хэшем не пересекаются) — до S3 (этап 2) так открытая вкладка не ловит 404
prev=$(readlink -f "/opt/massovka/web/color/${active:-none}" 2>/dev/null || readlink -f /opt/massovka/web/current 2>/dev/null || true)
if [ -n "$prev" ] && [ -d "$prev/apps/web/.next/static" ] && [ "$prev" != "$rel" ]; then
  carried=$(cd "$prev/apps/web/.next/static" && find . -type f -mtime -2 -print0 | while IFS= read -r -d '' f; do
    [ -e "$rel/apps/web/.next/static/$f" ] && continue
    install -D -p -o web -g web "$f" "$rel/apps/web/.next/static/$f" && echo x
  done | wc -l)
  say "статика прошлой версии для открытых вкладок: $carried файлов"
fi
install -d /opt/massovka/web/color
ln -sfn "$rel" "/opt/massovka/web/color/$new"
ln -sfn "$rel" /opt/massovka/web/current
# версии: последние три, и никогда — те, на которых стоят цвета
keep=$(readlink -f /opt/massovka/web/color/blue /opt/massovka/web/color/green 2>/dev/null || true)
for d in $(ls -1dt /opt/massovka/web/releases/*/ | tail -n +4); do
  echo "$keep" | grep -qx "${d%/}" || rm -rf "$d"
done

systemctl daemon-reload
systemctl reset-failed "massovka-web@$new" 2>/dev/null || true
systemctl restart "massovka-web@$new"
ok=0
for _ in $(seq 1 40); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$(web_port "$new")/"; then ok=1; break; fi
  sleep 1
done
if [ "$ok" != 1 ]; then
  journalctl -u "massovka-web@$new" -n 40 --no-pager -o cat || true
  systemctl stop "massovka-web@$new" || true
  echo "::error::новая версия сайта ($new) не ответила — остаётся прежняя (${active:-старая служба})"
  exit 1
fi
curl -fsS -o /dev/null -w "сайт ($new) отвечает: %{http_code}\n" "http://127.0.0.1:$(web_port "$new")/"
echo "$new" > /etc/massovka/web-active
systemctl enable "massovka-web@$new" >/dev/null 2>&1
# Caddy: на новую версию (и с соседом как запасным)
install -d /opt/massovka/bin
install -m 755 "$D/caddy.sh" /opt/massovka/bin/caddy.sh
if [ -f /etc/massovka/hosts.env ]; then /opt/massovka/bin/caddy.sh
else echo "::warning::нет /etc/massovka/hosts.env — Caddy переключит game-deploy"; fi
# прежняя версия дослуживает начатые запросы и останавливается
sleep 20
if [ -n "$active" ] && [ "$active" != "$new" ]; then systemctl disable --now "massovka-web@$active" >/dev/null 2>&1 || true; fi
# одноразовый переход со старой схемы (одна служба на :3000)
if [ -f /etc/systemd/system/massovka-web.service ]; then
  systemctl disable --now massovka-web.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/massovka-web.service
  systemctl daemon-reload
fi
systemctl is-active "massovka-web@$new" caddy
free -m | head -2
