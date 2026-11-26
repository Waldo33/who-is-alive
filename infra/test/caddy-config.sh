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

  # Бот за туннелем (/tg/* игрового сервера → :8080 сервера бота → бот): те же строки, что в caddy.sh.
  # 1) бот видит адрес игрока, а не 127.0.0.1 туннеля; подделать его заголовком нельзя;
  # 2) «кривые» пути (/tg/..\internal, %2e%2e, %2f) не доходят до бота так, чтобы Node схлопнул их в /internal/*.
  # Игрок ходит с 127.0.0.2 (curl --interface), туннель — с 127.0.0.1: так их видно по отдельности.
  cat > "$t/echo2.py" <<'PY'
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b = ((self.headers.get('X-Forwarded-For') or '-') + '|' + (self.headers.get('X-Massovka-Client') or '-') + '|' + self.path).encode()
        self.send_response(200); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', 18998), H).serve_forever()
PY
  python3 "$t/echo2.py" &
  echo_pid=$!
  hdr_front=$(grep -A3 'handle /tg/\* {' "$here/infra/game/caddy.sh" | grep -m1 'header_up X-Massovka-Client' | xargs)
  hdr_bot=$(sed -n '/^http:\/\/:8080 {/,/^}/p' "$here/infra/game/caddy.sh" | grep 'header_up' | sed 's/^[[:space:]]*//')
  [ -n "$hdr_front" ] && [ -n "$hdr_bot" ] || { echo "::error::не нашёл строки header_up бота в caddy.sh"; exit 1; }
  cat > "$t/bot.caddy" <<LIVE
{
	admin off
	auto_https off
}
http://:18981 {
	handle /tg/* {
		reverse_proxy 127.0.0.1:18991 {
			$hdr_front
		}
	}
	handle {
		respond 404
	}
}
http://:18991 {
	bind 127.0.0.1
	reverse_proxy 127.0.0.1:18998 {
$hdr_bot
	}
}
LIVE
  "$CADDY_BIN" run --config "$t/bot.caddy" --adapter caddyfile >"$t/bot.log" 2>&1 &
  caddy_pid=$!
  for _ in $(seq 1 50); do curl -fs -o /dev/null http://127.0.0.1:18981/tg/info 2>/dev/null && break; sleep 0.2; done
  player=$(curl -fsS --interface 127.0.0.2 -H 'X-Massovka-Client: 6.6.6.6' -H 'X-Forwarded-For: 7.7.7.7' http://127.0.0.2:18981/tg/info)
  inside=$(curl -fsS http://127.0.0.1:18991/tg/status)
  echo "бот: игрок с подделкой → «$player»; изнутри машины → «$inside»"
  [ "${player%%|*}" = 127.0.0.2 ] || { kill "$caddy_pid" "$echo_pid"; cat "$t/bot.log"; echo "::error::бот не видит адрес игрока (или его можно подделать)"; exit 1; }
  case "$inside" in 127.0.0.1\|* | \|* | -\|*) ;; *) kill "$caddy_pid" "$echo_pid"; echo "::error::запрос изнутри машины пришёл с чужим адресом"; exit 1 ;; esac
  bad=0
  for path in '/tg/../internal/drain' '/tg/%2e%2e/internal/drain' '/tg/..%2finternal/drain' '/tg/..%5cinternal/drain' '/tg/..\internal/drain' '/tg/%2E%2E%2Finternal/drain'; do
    got=$(curl -s --path-as-is --interface 127.0.0.2 "http://127.0.0.2:18981$path" || true)
    fwd=${got##*|}
    [ "$got" = "$fwd" ] && fwd=''  # не дошло до бота (404 Caddy)
    # то же, что делает сервер: badPath (server.ts) — отказ; иначе маршрут по new URL(...).pathname
    verdict=$(node -e '
      const raw = process.argv[1];
      if (!raw) { console.log("blocked"); process.exit(0); }
      const bad = /(^|\/)\.\.?(\/|$)|\\|%2e|%2f|%5c/i.test(raw.split("?")[0]);
      const p = new URL(raw, "http://x").pathname;
      console.log(bad ? "rejected" : p.startsWith("/internal") ? "LEAK " + p : "ok " + p);
    ' "$fwd")
    echo "  $path → бот получил «${fwd:--}» → $verdict"
    case "$verdict" in LEAK*) bad=1 ;; esac
  done
  kill "$caddy_pid" "$echo_pid" 2>/dev/null || true
  [ "$bad" = 0 ] || { echo "::error::кривой путь доходит до /internal/* бота"; exit 1; }
fi
