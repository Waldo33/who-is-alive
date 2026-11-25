# Настройка машин из кода: Ansible

Terraform (`docs/terraform.md`) создаёт машину и задаёт тариф, Ansible (`infra/ansible/`) настраивает её изнутри.
Цель — сервер с нуля целиком из репозитория: `infra-terraform` (apply) → `infra-ansible` (apply) → `game-deploy`.

## Что уже в Ansible

`site.yml`, роли:
- `base` — пользователи `game`/`caddy` и папки, подкачка 1 ГБ, сетевые лимиты (sysctl), SSH только по ключу,
  файрвол (22, 80, 443 tcp/udp), журнал ≤ 500 МБ;
- `postgres` — Postgres, настройка под маленькую машину, база `massovka` с паролем, рождённым на сервере
  (`/etc/massovka/secrets.env`), копия базы раз в сутки на 14 дней;
- `tunnels` — туннель SSH из Нидерландов в Европу (`massovka-tunnel-eu`); вход `tunnel` на игровом сервере только
  для проброса нужных портов, ключ сервера бота роль читает с Нидерландов. Туннели в Москву (`massovka-tunnel`,
  `massovka-relay`) выключены 25.11.2026 — `tunnels_retired`: роль их останавливает и убирает юниты;
- `app` — `game.env` (потолок комнат по памяти и ядрам), `game-blue/green.env`, юниты `massovka-game@` и `caddy`,
  ограничение памяти, `hosts.env` (RELAY сохраняется), `caddy.sh`. Адреса — в `group_vars/{game,infra}.yml`,
  куда переезжают комнаты (`peer_host`) — считает инвентарь по DNS. Ничего не перезапускает;
- `observe` — node_exporter и отправка журнала (оба), VictoriaMetrics, VictoriaLogs, Grafana, ночные копии базы
  игры и еженедельная проверка восстановления (Нидерланды);
- `ffmpeg` — для монтажа «Фильма матча» (только игровой сервер);
- `watch` — сторож с тревогами в Telegram (Нидерланды).

Файлы роли — байт в байт те, что раньше писал `setup.sh`: перед переключением сухой прогон на живых серверах
показал `changed=0` (24.11, massovka-eu и massovka-infra).

## Как устроена выкладка (с 25.11)

`game-deploy` для каждого сервера: `inventory.py` → `ansible-playbook site.yml --limit <сервер> --diff` →
`setup.sh` (с `ANSIBLE=1`; без него скрипт отказывается работать). Ansible ничего в игре не перезапускает:
если поменялись `game.env`, `game-<цвет>.env`, юниты игры или память, роль `app` оставляет метку
`/etc/massovka/restart-needed`, и `setup.sh` по ней поднимает новый экземпляр синим/зелёным (матчи доигрываются),
после чего метку снимает. Правка в `infra/ansible/**` тоже запускает `game-deploy`.

В `setup.sh` осталось то, что не состояние, а доставка и действия:
- программы, которые привозит `game-deploy`: Node, Caddy, GeoIP; в `observe.sh` — node_exporter, VictoriaMetrics/Logs,
  Grafana (их настройка в `observe.sh` пока дублирует роль `observe` — следующий шаг убрать);
- ключи, рождённые на сервере (`secrets.env`: ключ токенов, ключ нагрузки), ключ бота (`bot.env`),
  роль базы `grafana_ro` и пароль Grafana (`observe.sh`);
- выкладка версии (синий/зелёный, drain) и запуск `caddy.sh`.

## Как пользоваться

- Сухой прогон — сам на каждом PR с правкой `infra/ansible`; итог (`PLAY RECAP`) — в Summary прогона.
- Применить — Actions › `infra-ansible` › Run workflow, `apply` = true.
- Инвентарь — `inventory.py`: адреса из Timeweb по именам серверов, ключ SSH выводится из `TWC_TOKEN`
  (как в `provision.py`). Москва (`massovka-game`) выведена 25.11.2026.
