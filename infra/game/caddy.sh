#!/usr/bin/env bash
# Конфиг Caddy из /etc/massovka/hosts.env: игровой сервер на HOST (и запасном ALT_HOST),
# сайт на SITE_HOST — если сайт уже выложен на сервер, Caddy проксирует на него (до выкладки сайта
# блока нет). Вызывают setup.sh и web.sh.
#
# Синий/зелёный (выкладка без обрыва, docs/infra-plan.md › этап 1): у игры и сайта по два экземпляра,
# активный — в /etc/massovka/active-color (игра: blue :8081, green :8082) и web-active (сайт: :3010, :3011).
# Всё идёт на активный, а если он не отвечает — на соседа (lb_policy first). /i/<цвет>/ws — к своему
# экземпляру: там доигрывается матч; когда экземпляр завершился, его адрес отдаётся соседу, а тот
# говорит «переезжай» или уже держит комнату. Изнутри машины игра — на 127.0.0.1:8080 (бот, метрики,
# сторож, туннель), тоже с активным впереди. Нет active-color — старая схема: один экземпляр на :8080.
#
# Переезд в Европу (docs/infra-plan.md › этап 3):
#   RELAY_FRONT=1 (Европа) — вход пересылки http://127.0.0.1:8090 для Москвы (туннель massovka-relay):
#     адрес игрока берётся из заголовка X-Massovka-Client, который ставит Москва; /metrics и /internal — 404;
#   RELAY=127.0.0.1:18090 (Москва) — игра пересылается в Европу: новые запросы — туда, а соединения
#     к своему экземпляру (/i/<цвет>/ws — идущие матчи) — к нему, пока он жив.
set -euo pipefail
# пути можно подменить для проверки конфига без сервера (CI: infra/test/caddy-config.sh)
ETC=${MASSOVKA_ETC:-/etc/massovka}
CADDY_DIR=${CADDY_DIR:-/etc/caddy}
CADDY_BIN=${CADDY_BIN:-/usr/local/bin/caddy}
WEB_ROOT=${WEB_ROOT:-/opt/massovka/web}
. "$ETC/hosts.env"
# web.sh и setup.sh могут звать одновременно (две выкладки): по очереди
exec 9>"${CADDY_LOCK:-/run/massovka-caddy.lock}"
flock -w 60 9

port_of() { [ "$1" = green ] && echo "$2" || echo "$3"; }
active=$(cat "$ETC/active-color" 2>/dev/null || true)
case "$active" in blue | green) ;; *) active="" ;; esac
if [ -n "$active" ]; then
  other=$([ "$active" = blue ] && echo green || echo blue)
  A="127.0.0.1:$(port_of "$active" 8082 8081)"
  B="127.0.0.1:$(port_of "$other" 8082 8081)"
  BLUE=127.0.0.1:8081
  GREEN=127.0.0.1:8082
fi
web_active=$(cat "$ETC/web-active" 2>/dev/null || true)
case "$web_active" in blue | green) ;; *) web_active="" ;; esac
if [ -n "$web_active" ]; then
  web_other=$([ "$web_active" = blue ] && echo green || echo blue)
  WA="127.0.0.1:$(port_of "$web_active" 3011 3010)"
  WB="127.0.0.1:$(port_of "$web_other" 3011 3010)"
fi

# первый живой из списка; WebSocket не рвать при перезагрузке конфига (стандартно Caddy закрывает их сразу)
proxy_opts() {
  cat <<OPTS
		lb_policy first
		lb_try_duration 3s
		fail_duration 10s
		stream_close_delay 2h
OPTS
}

f=$CADDY_DIR/Caddyfile.new
cat > "$f" <<CADDY
{
	admin localhost:2019
}

$HOST${ALT_HOST:+, $ALT_HOST} {
	encode zstd gzip
$(if [ -n "${BOT_UPSTREAM:-}" ]; then cat <<BOT
	# Telegram-бот живёт на сервере за границей (из России api.telegram.org закрыт):
	# телефоны ходят сюда, в Москву, а мы пересылаем туда
	# адрес игрока — в X-Massovka-Client (перезаписываем: снаружи не подделать); вход :8080 на сервере бота
	# кладёт его в X-Forwarded-For. Иначе бот видит всех как 127.0.0.1 туннеля: общий лимит на всех
	# и «запрос изнутри машины» для любого внешнего
	handle /tg/* {
		reverse_proxy $BOT_UPSTREAM {
			header_up X-Massovka-Client {remote_host}
		}
	}
BOT
fi)
$(if [ -x /opt/grafana/bin/grafana ]; then cat <<GRAFANA
	# Grafana (сервер в Нидерландах): графики, логи, продуктовые метрики; вход — admin и пароль владельца
	handle /grafana/* {
		reverse_proxy 127.0.0.1:3001
	}
GRAFANA
fi)
	# метрики и внутренние маршруты (переезд комнат, drain) — только изнутри
	handle /metrics {
		respond 404
	}
	handle /internal/* {
		respond 404
	}
$(if [ -n "$active" ] && [ -n "${RELAY:-}" ]; then cat <<RELAYED
	# игра переехала в Европу: идущие здесь матчи доигрывают на своём экземпляре, всё остальное —
	# по туннелю в Европу (адрес игрока — в X-Massovka-Client, его читает вход пересылки там)
	handle /i/blue/* {
		reverse_proxy $BLUE $GREEN $RELAY {
$(proxy_opts)
			header_up X-Massovka-Client {remote_host}
		}
	}
	handle /i/green/* {
		reverse_proxy $GREEN $BLUE $RELAY {
$(proxy_opts)
			header_up X-Massovka-Client {remote_host}
		}
	}
	handle {
		reverse_proxy $RELAY {
			stream_close_delay 2h
			header_up X-Massovka-Client {remote_host}
		}
	}
RELAYED
elif [ -n "$active" ]; then cat <<COLORS
	# соединение игрока — к своему экземпляру (там идёт его матч), экземпляра нет — к соседу
	handle /i/blue/* {
		reverse_proxy $BLUE $GREEN {
$(proxy_opts)
		}
	}
	handle /i/green/* {
		reverse_proxy $GREEN $BLUE {
$(proxy_opts)
		}
	}
	handle {
		# X-Forwarded-For Caddy ставит сам (адрес клиента) — по нему лимиты на сервере
		reverse_proxy $A $B {
$(proxy_opts)
		}
	}
COLORS
else cat <<LEGACY
	handle {
		# X-Forwarded-For Caddy ставит сам (адрес клиента) — по нему лимиты на сервере
		reverse_proxy 127.0.0.1:8080
	}
LEGACY
fi)
	# журнал запросов не пишем: в нём адреса игроков, а логи уходят в общее хранилище
}
$(if [ -n "$active" ]; then cat <<FRONT

# игра изнутри машины (бот, сторож, метрики, туннель из Нидерландов): активный экземпляр, затем сосед.
# Адрес без имени (:8080) — любой Host: через туннель приходят запросы с Host api.benobody.app
# (/tg/* из Москвы), а сайт http://127.0.0.1:8080 их не узнавал и отвечал пустым 200
http://:8080 {
	bind 127.0.0.1
	reverse_proxy $A $B {
$(proxy_opts)
		# запрос игрока, пересланный с /tg/* игрового сервера по туннелю: его адрес — из X-Massovka-Client
		# (нет заголовка — свой запрос изнутри машины, адреса клиента нет)
		header_up X-Forwarded-For {http.request.header.X-Massovka-Client}
		header_up -X-Massovka-Client
	}
}

# вход для туннеля из Нидерландов (метрики, аналитика, ошибки и гардероб сервера бота: учёт покупок, рисование
# своих стикеров) — только эти пути, а не вся игра
# изнутри: иначе через Grafana там (источник данных на 127.0.0.1:28080) дотянулись бы до /internal/drain
# и /internal/import (ревью безопасности, M5)
http://:8079 {
	bind 127.0.0.1
	# /tg/status — сторожу в Нидерландах, когда бот живёт в игровом сервере (infra/game/bot-home: eu)
	@allowed path /metrics /v1/events /internal/errors /internal/shop /internal/sticker /tg/status
	handle @allowed {
		reverse_proxy $A $B {
$(proxy_opts)
			header_up -X-Massovka-Client
		}
	}
	handle {
		respond 404
	}
}
FRONT
fi)
$(if [ -n "$active" ] && [ -n "${RELAY_FRONT:-}" ]; then cat <<RFRONT

# вход пересылки из Москвы (туннель massovka-relay, только 127.0.0.1): те же маршруты, что снаружи,
# адрес игрока — из X-Massovka-Client (его ставит Caddy Москвы), а не 127.0.0.1 туннеля
http://:8090 {
	bind 127.0.0.1
	handle /metrics {
		respond 404
	}
	handle /internal/* {
		respond 404
	}
	handle /i/blue/* {
		reverse_proxy $BLUE $GREEN {
$(proxy_opts)
			header_up X-Forwarded-For {http.request.header.X-Massovka-Client}
		}
	}
	handle /i/green/* {
		reverse_proxy $GREEN $BLUE {
$(proxy_opts)
			header_up X-Forwarded-For {http.request.header.X-Massovka-Client}
		}
	}
	handle {
		reverse_proxy $A $B {
$(proxy_opts)
			header_up X-Forwarded-For {http.request.header.X-Massovka-Client}
		}
	}
}
RFRONT
fi)
CADDY
if [ -n "${SITE_HOST:-}" ]; then
  if [ -n "$web_active" ] || [ -e "$WEB_ROOT/current/apps/web/server.js" ]; then
    if [ -n "$web_active" ]; then up="$WA $WB"; else up="127.0.0.1:3000"; fi
    cat >> "$f" <<CADDY

$SITE_HOST {
	encode zstd gzip
	reverse_proxy $up {
$(if [ -n "$web_active" ]; then cat <<WEBLB
		# синий/зелёный сайт: активный, не ответил — сосед (выкладка без простоя)
		lb_policy first
		lb_try_duration 5s
		fail_duration 10s
WEBLB
fi)
		# Next отвечает долго только на картинки превью — запас
		transport http {
			response_header_timeout 30s
		}
	}
}

www.$SITE_HOST {
	redir https://$SITE_HOST{uri} 301
}
CADDY
  fi
fi
[ -n "${CADDY_DRY:-}" ] || { chown root:caddy "$f"; chmod 640 "$f"; }
# проверить до замены: кривой конфиг не должен уронить рабочий
if [ -x "$CADDY_BIN" ] && ! "$CADDY_BIN" validate --config "$f" --adapter caddyfile >/tmp/caddy-validate.log 2>&1; then
  cat /tmp/caddy-validate.log
  echo "::error::конфиг Caddy не прошёл проверку — оставляю прежний"
  rm -f "$f"
  exit 1
fi
mv -f "$f" "$CADDY_DIR/Caddyfile"
if [ -z "${CADDY_DRY:-}" ] && systemctl is-active -q caddy; then systemctl reload caddy; fi
