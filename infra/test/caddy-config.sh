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
for mode in legacy colors web eu relay; do
  rm -f "$t/etc/active-color" "$t/etc/web-active"
  [ "$mode" != legacy ] && echo green > "$t/etc/active-color"
  [ "$mode" != legacy ] && [ "$mode" != colors ] && echo blue > "$t/etc/web-active"
  # eu — сервер в Европе со входом пересылки; relay — Москва пересылает игру в Европу
  grep -v '^RELAY' "$t/etc/hosts.env" > "$t/etc/h" && mv "$t/etc/h" "$t/etc/hosts.env"
  [ "$mode" = eu ] && echo 'RELAY_FRONT=1' >> "$t/etc/hosts.env"
  [ "$mode" = relay ] && echo 'RELAY=127.0.0.1:18090' >> "$t/etc/hosts.env"
  bash "$here/infra/game/caddy.sh"
  [ "$mode" = eu ] && grep -q '^http://:8090 {' "$t/caddy/Caddyfile"
  # внутренние входы обязаны принимать любой Host (иначе через туннель — пустые ответы)
  if [ "$mode" != legacy ] && grep -q '^http://127.0.0.1:80[89]0' "$t/caddy/Caddyfile"; then echo "$mode: внутренний вход привязан к имени 127.0.0.1"; exit 1; fi
  [ "$mode" = relay ] && grep -q 'reverse_proxy 127.0.0.1:18090' "$t/caddy/Caddyfile"
  grep -q 'reverse_proxy' "$t/caddy/Caddyfile"
  [ -x "$CADDY_BIN" ] && echo "$mode: конфиг прошёл caddy validate" || echo "$mode: конфиг собран"
  # if, а не &&: без SHOW последней командой скрипта было бы «ложь» — и выход с кодом 1
  if [ -n "${SHOW:-}" ]; then cat "$t/caddy/Caddyfile"; fi
done

# Живая проверка адреса игрока при пересылке Москва → Европа (те же строки header_up, что в caddy.sh):
# Европа берёт адрес из X-Massovka-Client, Москва этот заголовок перезаписывает адресом соединения —
# подделать его снаружи нельзя. Без этого все пересланные игроки — «127.0.0.1»: общие лимиты на всех.
if [ -x "$CADDY_BIN" ] && [ -n "${REQUIRE_CADDY:-}" ]; then
  cat > "$t/echo.py" <<'PY'
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b = (self.headers.get('X-Forwarded-For') or '-').encode()
        self.send_response(200); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', 18999), H).serve_forever()
PY
  python3 "$t/echo.py" &
  echo_pid=$!
  hdr_moscow=$(grep -m1 'header_up X-Massovka-Client' "$here/infra/game/caddy.sh" | xargs)
  hdr_eu=$(grep -m1 'header_up X-Forwarded-For {http.request.header.X-Massovka-Client}' "$here/infra/game/caddy.sh" | xargs)
  cat > "$t/live.caddy" <<LIVE
{
	admin off
	auto_https off
}
http://127.0.0.1:18980 {
	reverse_proxy 127.0.0.1:18990 {
		$hdr_moscow
	}
}
# как вход пересылки в caddy.sh: адрес без имени — любой Host (запросы идут с Host api.benobody.app)
http://:18990 {
	bind 127.0.0.1
	reverse_proxy 127.0.0.1:18999 {
		$hdr_eu
	}
}
LIVE
  "$CADDY_BIN" run --config "$t/live.caddy" --adapter caddyfile >"$t/live.log" 2>&1 &
  caddy_pid=$!
  for _ in $(seq 1 50); do curl -fs -o /dev/null http://127.0.0.1:18980/ 2>/dev/null && break; sleep 0.2; done
  direct=$(curl -fsS -H 'Host: api.benobody.app' -H 'X-Massovka-Client: 203.0.113.7' http://127.0.0.1:18990/)
  spoof=$(curl -fsS -H 'X-Massovka-Client: 6.6.6.6' -H 'X-Forwarded-For: 7.7.7.7' http://127.0.0.1:18980/)
  kill "$caddy_pid" "$echo_pid" 2>/dev/null || true
  echo "вход пересылки Европы: X-Massovka-Client 203.0.113.7 → X-Forwarded-For «$direct»"
  echo "через Москву с подделкой: → «$spoof» (ждём адрес соединения 127.0.0.1)"
  [ "$direct" = 203.0.113.7 ] || { cat "$t/live.log"; echo "::error::Европа не берёт адрес игрока из X-Massovka-Client"; exit 1; }
  [ "$spoof" = 127.0.0.1 ] || { echo "::error::подделка адреса проходит через Москву"; exit 1; }
fi
