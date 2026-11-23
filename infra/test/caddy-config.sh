#!/usr/bin/env bash
# Проверка конфига Caddy без сервера: infra/game/caddy.sh во временной папке для трёх случаев —
# старая схема (один экземпляр), синий/зелёный у игры, синий/зелёный у игры и сайта; caddy validate.
#   CADDY_BIN=/путь/к/caddy infra/test/caddy-config.sh
set -euo pipefail
here=$(cd "$(dirname "$0")/../.." && pwd)
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
mkdir -p "$t/etc" "$t/caddy" "$t/web/current/apps/web"
touch "$t/web/current/apps/web/server.js"
cat > "$t/etc/hosts.env" <<HOSTS
HOST=api.benobody.app
ALT_HOST=129-101-104-99.sslip.io
SITE_HOST=benobody.app
SITE_REDIRECT=https://who-is-alive.vercel.app
BOT_UPSTREAM=http://127.0.0.1:9090
HOSTS
export MASSOVKA_ETC="$t/etc" CADDY_DIR="$t/caddy" WEB_ROOT="$t/web" CADDY_LOCK="$t/lock" CADDY_DRY=1
export CADDY_BIN=${CADDY_BIN:-$(command -v caddy || echo /usr/local/bin/caddy)}
if [ ! -x "$CADDY_BIN" ]; then
  # в CI caddy обязателен (REQUIRE_CADDY=1), локально без него — только собрать и показать конфиг
  [ -n "${REQUIRE_CADDY:-}" ] && { echo "нет caddy ($CADDY_BIN)"; exit 1; }
  echo "caddy нет — конфиг без проверки"
fi
for mode in legacy colors web; do
  rm -f "$t/etc/active-color" "$t/etc/web-active"
  [ "$mode" != legacy ] && echo green > "$t/etc/active-color"
  [ "$mode" = web ] && echo blue > "$t/etc/web-active"
  bash "$here/infra/game/caddy.sh"
  grep -q 'reverse_proxy' "$t/caddy/Caddyfile"
  [ -x "$CADDY_BIN" ] && echo "$mode: конфиг прошёл caddy validate" || echo "$mode: конфиг собран"
  [ -n "${SHOW:-}" ] && cat "$t/caddy/Caddyfile"
done
