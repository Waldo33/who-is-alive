#!/usr/bin/env bash
# Конфиг Caddy из /etc/massovka/hosts.env: игровой сервер на HOST (и запасном ALT_HOST),
# сайт на SITE_HOST — если сайт уже выложен на сервер, Caddy проксирует на него, иначе ведёт
# на старый адрес SITE_REDIRECT. Вызывают setup.sh и web.sh.
set -euo pipefail
. /etc/massovka/hosts.env
f=/etc/caddy/Caddyfile.new
cat > "$f" <<CADDY
{
	admin localhost:2019
}

$HOST${ALT_HOST:+, $ALT_HOST} {
	encode zstd gzip
$(if [ -n "${BOT_UPSTREAM:-}" ]; then cat <<BOT
	# Telegram-бот живёт на сервере за границей (из России api.telegram.org закрыт):
	# телефоны ходят сюда, в Москву, а мы пересылаем туда
	handle /tg/* {
		reverse_proxy $BOT_UPSTREAM {
			header_up Host {upstream_hostport}
		}
	}
BOT
fi)
	handle {
		# метрики — только изнутри
		@internal path /metrics
		respond @internal 404
		# X-Forwarded-For Caddy ставит сам (адрес клиента) — по нему лимиты на сервере
		reverse_proxy 127.0.0.1:8080
	}
	log {
		output stdout
		format json
	}
}
CADDY
if [ -n "${SITE_HOST:-}" ]; then
  if [ -e /opt/massovka/web/current/apps/web/server.js ]; then
    cat >> "$f" <<CADDY

$SITE_HOST {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000 {
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
  elif [ -n "${SITE_REDIRECT:-}" ]; then
    cat >> "$f" <<CADDY

$SITE_HOST, www.$SITE_HOST {
	redir $SITE_REDIRECT{uri} 302
}
CADDY
  fi
fi
chown root:caddy "$f"
chmod 640 "$f"
mv -f "$f" /etc/caddy/Caddyfile
if systemctl is-active -q caddy; then systemctl reload caddy; fi
