#!/usr/bin/env bash
# Наблюдение: метрики, логи, Grafana, копии базы. Вызывает setup.sh; повторный запуск безопасен.
#   оба сервера: node_exporter (127.0.0.1:9100), журнал → VictoriaLogs (systemd-journal-upload);
#   game (Москва): роль базы «только чтение» grafana_ro (для Grafana и ночной копии);
#   infra (Нидерланды): VictoriaMetrics (:8428), VictoriaLogs (:9428), Grafana (:3001, /grafana), копии базы Москвы.
# Москва и Нидерланды связаны только туннелем (setup.sh): Москва видит логи Нидерландов на 127.0.0.1:9428,
# Нидерланды видят базу, метрики и node_exporter Москвы на 127.0.0.1:15432, :18080, :19100.
set -euo pipefail
D=${D:-/tmp/deploy}
ROLE=${ROLE:-game}
say() { echo "── $*"; }
unit() { # имя, содержимое — перезапуск, только если файл поменялся
  local f="/etc/systemd/system/$1" new
  new=$(cat)
  if [ "$(cat "$f" 2>/dev/null)" != "$new" ]; then echo "$new" > "$f"; chmod 644 "$f"; systemctl daemon-reload; echo changed; fi
}

# ───────────── node_exporter (оба) ─────────────
if [ -f "$D/node_exporter" ]; then
  say "node_exporter $(cat "$D/node_exporter.version")"
  install -m 755 "$D/node_exporter" /usr/local/bin/node_exporter.new && mv -f /usr/local/bin/node_exporter.new /usr/local/bin/node_exporter
  cp "$D/node_exporter.version" /etc/massovka/node_exporter.version
  NE_NEW=1
fi
if [ -x /usr/local/bin/node_exporter ]; then
  id node_exporter >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin node_exporter
  ch=$(unit node_exporter.service <<'EOF'
[Unit]
Description=node_exporter (метрики машины)
After=network-online.target
[Service]
User=node_exporter
ExecStart=/usr/local/bin/node_exporter --web.listen-address=127.0.0.1:9100 --collector.systemd --no-collector.wifi --no-collector.infiniband
Restart=always
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
[Install]
WantedBy=multi-user.target
EOF
)
  systemctl enable node_exporter >/dev/null 2>&1
  if [ -n "$ch" ] || [ -n "${NE_NEW:-}" ] || ! systemctl is-active -q node_exporter; then systemctl restart node_exporter; fi
fi

# ───────────── журнал → VictoriaLogs (оба) ─────────────
if [ ! -x /usr/lib/systemd/systemd-journal-upload ]; then
  say "systemd-journal-upload"
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq systemd-journal-remote >/dev/null
  systemctl disable --now systemd-journal-remote.socket systemd-journal-remote.service >/dev/null 2>&1 || true
fi
cat > /etc/systemd/journal-upload.conf <<'EOF'
[Upload]
URL=http://127.0.0.1:9428/insert/journald
EOF
install -d /etc/systemd/system/systemd-journal-upload.service.d
cat > /etc/systemd/system/systemd-journal-upload.service.d/90-massovka.conf <<'EOF'
# в Москве адрес приходит по туннелю: пока его нет — пробовать снова (место в журнале запоминается)
[Unit]
StartLimitIntervalSec=0
[Service]
Restart=always
RestartSec=15
EOF
systemctl daemon-reload
systemctl enable systemd-journal-upload >/dev/null 2>&1
systemctl restart systemd-journal-upload || true

# ───────────── роль базы «только чтение» (Москва) ─────────────
if [ "$ROLE" = game ] && [ -s "$D/pgro.env" ]; then
  . "$D/pgro.env"
  say "роль базы grafana_ro"
  sudo -u postgres psql -q massovka <<SQL
do \$\$ begin
  if not exists (select from pg_roles where rolname = 'grafana_ro') then create role grafana_ro login password '$PGRO_PASSWORD';
  else alter role grafana_ro password '$PGRO_PASSWORD'; end if;
end \$\$;
grant connect on database massovka to grafana_ro;
grant usage on schema public to grafana_ro;
grant select on all tables in schema public to grafana_ro;
grant select on all sequences in schema public to grafana_ro;
alter default privileges for role massovka in schema public grant select on tables to grafana_ro;
alter role grafana_ro set statement_timeout = '30s';
SQL
  rm -f "$D/pgro.env"
fi

[ "$ROLE" = infra ] || exit 0

# ───────────── VictoriaMetrics (Нидерланды) ─────────────
id victoria >/dev/null 2>&1 || useradd --system --home /var/lib/victoria --shell /usr/sbin/nologin victoria
install -d -o victoria -g victoria /var/lib/victoria/metrics /var/lib/victoria/logs
for b in victoria-metrics victoria-logs; do
  if [ -f "$D/$b" ]; then
    say "$b $(cat "$D/$b.version")"
    install -m 755 "$D/$b" "/usr/local/bin/$b.new" && mv -f "/usr/local/bin/$b.new" "/usr/local/bin/$b"
    cp "$D/$b.version" "/etc/massovka/$b.version"
    eval "NEW_${b//-/_}=1"
  fi
done
cat > /etc/massovka/scrape.yml <<'EOF'
global:
  scrape_interval: 30s
scrape_configs:
  - job_name: node
    static_configs:
      - targets: ['127.0.0.1:9100']
        labels: { server: nl }
      - targets: ['127.0.0.1:19100']
        labels: { server: msk }
  - job_name: game
    metrics_path: /metrics
    static_configs:
      - targets: ['127.0.0.1:18080']
        labels: { server: msk }
      - targets: ['127.0.0.1:8080']
        labels: { server: nl }
  - job_name: victoria
    static_configs:
      - targets: ['127.0.0.1:8428', '127.0.0.1:9428']
        labels: { server: nl }
EOF
ch=$(unit victoria-metrics.service <<'EOF'
[Unit]
Description=VictoriaMetrics (метрики, 90 дней)
After=network-online.target
[Service]
User=victoria
ExecStart=/usr/local/bin/victoria-metrics -storageDataPath=/var/lib/victoria/metrics -retentionPeriod=90d -httpListenAddr=127.0.0.1:8428 -promscrape.config=/etc/massovka/scrape.yml -memory.allowedPercent=20
Restart=always
NoNewPrivileges=yes
[Install]
WantedBy=multi-user.target
EOF
)
systemctl enable victoria-metrics >/dev/null 2>&1
if [ -n "$ch" ] || [ -n "${NEW_victoria_metrics:-}" ] || ! systemctl is-active -q victoria-metrics; then systemctl restart victoria-metrics; else curl -fsS -X POST http://127.0.0.1:8428/-/reload >/dev/null || true; fi

ch=$(unit victoria-logs.service <<'EOF'
[Unit]
Description=VictoriaLogs (логи обоих серверов, 30 дней)
After=network-online.target
[Service]
User=victoria
ExecStart=/usr/local/bin/victoria-logs -storageDataPath=/var/lib/victoria/logs -retentionPeriod=30d -httpListenAddr=127.0.0.1:9428 -retention.maxDiskSpaceUsageBytes=6GiB
Restart=always
NoNewPrivileges=yes
[Install]
WantedBy=multi-user.target
EOF
)
systemctl enable victoria-logs >/dev/null 2>&1
if [ -n "$ch" ] || [ -n "${NEW_victoria_logs:-}" ] || ! systemctl is-active -q victoria-logs; then systemctl restart victoria-logs; fi

# ───────────── Grafana (Нидерланды) ─────────────
id grafana >/dev/null 2>&1 || useradd --system --home /var/lib/grafana --shell /usr/sbin/nologin grafana
install -d -o grafana -g grafana /var/lib/grafana /var/lib/grafana/plugins /var/log/grafana
if [ -f "$D/grafana.tar.gz" ]; then
  v=$(cat "$D/grafana.version")
  say "Grafana $v"
  rm -rf "/opt/grafana-$v"; mkdir -p "/opt/grafana-$v"
  tar -xzf "$D/grafana.tar.gz" -C "/opt/grafana-$v" --strip-components=1
  ln -sfn "/opt/grafana-$v" /opt/grafana
  echo "$v" > /etc/massovka/grafana.version
  for old in /opt/grafana-*/; do [ "$old" = "/opt/grafana-$v/" ] || rm -rf "$old"; done
  NEW_GRAFANA=1
fi
if [ -x /opt/grafana/bin/grafana ]; then
  if [ ! -d /var/lib/grafana/plugins/victoriametrics-logs-datasource ]; then
    say "плагин VictoriaLogs для Grafana"
    sudo -u grafana /opt/grafana/bin/grafana cli --homepath /opt/grafana --pluginsDir /var/lib/grafana/plugins plugins install victoriametrics-logs-datasource >/dev/null || echo "::warning::плагин VictoriaLogs не поставился"
  fi
  . /etc/massovka/hosts.env
  install -d -m 750 -o root -g grafana /etc/massovka/grafana /etc/massovka/grafana/datasources /etc/massovka/grafana/dashboards
  [ -s "$D/pgro.env" ] && { install -m 640 -o root -g grafana "$D/pgro.env" /etc/massovka/grafana/pgro.env; rm -f "$D/pgro.env"; }
  PGRO_PASSWORD=$(. /etc/massovka/grafana/pgro.env 2>/dev/null; echo "${PGRO_PASSWORD:-}")
  cat > /etc/massovka/grafana/grafana.ini <<EOF
[server]
http_addr = 127.0.0.1
http_port = 3001
root_url = https://$HOST/grafana/
serve_from_sub_path = true
[paths]
data = /var/lib/grafana
logs = /var/log/grafana
plugins = /var/lib/grafana/plugins
provisioning = /etc/massovka/grafana
[security]
admin_user = admin
admin_password = \$__file{/etc/massovka/grafana/admin.pw}
cookie_secure = true
disable_gravatar = true
[users]
allow_sign_up = false
default_language = ru-RU
[auth.anonymous]
enabled = false
[analytics]
reporting_enabled = false
check_for_updates = false
check_for_plugin_updates = false
[news]
news_feed_enabled = false
[log]
mode = console
level = warn
EOF
  if [ -s "$D/grafana_admin" ]; then install -m 640 -o root -g grafana "$D/grafana_admin" /etc/massovka/grafana/admin.pw; rm -f "$D/grafana_admin"
  elif [ ! -s /etc/massovka/grafana/admin.pw ]; then ( umask 077; head -c 24 /dev/urandom | base64 | tr -d '/+=' > /etc/massovka/grafana/admin.pw ); echo "::warning::нет GRAFANA_PASSWORD — Grafana закрыта случайным паролем"
  fi
  cat > /etc/massovka/grafana/datasources/massovka.yml <<EOF
apiVersion: 1
deleteDatasources: []
datasources:
  - name: Метрики
    uid: vm
    type: prometheus
    access: proxy
    url: http://127.0.0.1:8428
    isDefault: true
  - name: Логи
    uid: vl
    type: victoriametrics-logs-datasource
    access: proxy
    url: http://127.0.0.1:9428
  - name: База Москвы
    uid: pg
    type: grafana-postgresql-datasource
    access: proxy
    url: 127.0.0.1:15432
    user: grafana_ro
    jsonData:
      database: massovka
      sslmode: disable
      postgresVersion: 1600
      timescaledb: false
    secureJsonData:
      password: "$PGRO_PASSWORD"
EOF
  cat > /etc/massovka/grafana/dashboards/massovka.yml <<'EOF'
apiVersion: 1
providers:
  - name: massovka
    folder: Массовка
    type: file
    allowUiUpdates: false
    options:
      path: /opt/massovka/grafana-dashboards
EOF
  install -d /opt/massovka/grafana-dashboards
  [ -d "$D/dashboards" ] && cp -f "$D"/dashboards/*.json /opt/massovka/grafana-dashboards/
  chown -R root:grafana /etc/massovka/grafana; chmod -R g+r /etc/massovka/grafana
  ch=$(unit grafana.service <<'EOF'
[Unit]
Description=Grafana (графики, логи, продуктовые метрики)
After=network-online.target victoria-metrics.service victoria-logs.service
[Service]
User=grafana
WorkingDirectory=/opt/grafana
ExecStart=/opt/grafana/bin/grafana server --homepath /opt/grafana --config /etc/massovka/grafana/grafana.ini
Restart=always
MemoryMax=400M
NoNewPrivileges=yes
[Install]
WantedBy=multi-user.target
EOF
)
  systemctl enable grafana >/dev/null 2>&1
  systemctl restart grafana
  # пароль входа: из GitHub Secrets GRAFANA_PASSWORD, а пока его нет — случайный, рождённый здесь
  # (никогда не остаётся admin/admin: Grafana смотрит в интернет)
  for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:3001/api/health && break; sleep 1; done
  sudo -u grafana /opt/grafana/bin/grafana cli --homepath /opt/grafana --config /etc/massovka/grafana/grafana.ini admin reset-admin-password --password-from-stdin < /etc/massovka/grafana/admin.pw >/dev/null 2>&1 && echo "пароль Grafana на месте" || echo "::warning::пароль Grafana не обновился"
fi

# ───────────── ночная копия базы Москвы (Нидерланды, 30 дней) ─────────────
if [ -f /etc/massovka/grafana/pgro.env ]; then
  install -d -m 750 -o postgres -g postgres /var/backups/massovka-msk
  install -m 640 -o root -g postgres /etc/massovka/grafana/pgro.env /etc/massovka/pgro-backup.env
  cat > /opt/massovka/bin/msk-backup.sh <<'EOF'
#!/bin/sh
# копия базы Москвы через туннель (127.0.0.1:15432), хранить 30 дней
set -e
f=/var/backups/massovka-msk/massovka-$(date +%F).dump
PGPASSWORD="$PGRO_PASSWORD" pg_dump -h 127.0.0.1 -p 15432 -U grafana_ro -Fc -f "$f.part" massovka
mv "$f.part" "$f"
find /var/backups/massovka-msk -name '*.dump' -mtime +30 -delete
EOF
  chmod 755 /opt/massovka/bin/msk-backup.sh
  unit massovka-msk-backup.service >/dev/null <<'EOF'
[Unit]
Description=Массовка: копия базы Москвы (через туннель)
[Service]
Type=oneshot
User=postgres
EnvironmentFile=/etc/massovka/pgro-backup.env
ExecStart=/opt/massovka/bin/msk-backup.sh
Restart=on-failure
RestartSec=10min
EOF
  unit massovka-msk-backup.timer >/dev/null <<'EOF'
[Unit]
Description=Массовка: копия базы Москвы раз в сутки
[Timer]
OnCalendar=*-*-* 03:40:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
  systemctl enable massovka-msk-backup.timer >/dev/null 2>&1
  systemctl restart massovka-msk-backup.timer
fi
say "наблюдение готово: $(systemctl is-active victoria-metrics victoria-logs grafana node_exporter systemd-journal-upload | tr '\n' ' ')"
