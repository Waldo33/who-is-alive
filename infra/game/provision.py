#!/usr/bin/env python3
"""
Игровой сервер в Timeweb Cloud: найти или создать (идемпотентно).

SSH-ключ выводится из TWC_TOKEN (HMAC → Ed25519): отдельный секрет не нужен, а у кого есть
токен API, тот и так управляет сервером. Сменили токен — ключ сменится, сервер надо будет
пересоздать или добавить новый ключ вручную (docs/server-migration.md).

Логи Actions публичные: печатаем только id, статус и IP (IP и так виден в DNS),
ответ создания сервера целиком не печатаем — в нём может быть пароль root.

Выход: ip, host (<ip-через-дефисы>.sslip.io), server_id — в $GITHUB_OUTPUT.
"""
import hashlib
import hmac
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

API = 'https://api.timeweb.cloud/api/v1'
TOKEN = os.environ['TWC_TOKEN']
# имя — только явно: 26.11.2026 проверка сети без SERVER_NAME по старому умолчанию «massovka-game»
# создала заново уже удалённый московский сервер
NAME = os.environ.get('SERVER_NAME', '')
# выведенные из работы машины — только найти (для кнопки удаления), никогда не создавать
RETIRED = {'massovka-game'}
# по очереди, пока не найдётся свободный: Cloud KZN 50 (Казань), Cloud EKB 50 (Екатеринбург) — 2 vCPU, 4 ГБ,
# 50 ГБ, 1000 ₽; дальше Москва (решение владельца 22.11.2026: в Казани и Екатеринбурге мест нет) —
# Cloud MSK 30 (1 vCPU, 2 ГБ, 1940 ₽), Cloud MSK 15 (1/1, 1180 ₽), MSK Ultra 15 и 30 (1720 и 2800 ₽).
# Одному игровому серверу без базы хватает 1 vCPU; размер потом увеличивается без переезда.
PRESETS = [int(x) for x in os.environ.get('SERVER_PRESETS', '6759,6749,4797,4795,6867,6869').split(',')]
OS_NAME = os.environ.get('SERVER_OS', 'ubuntu')
OS_VERSION = os.environ.get('SERVER_OS_VERSION', '24.04')
KEY_NAME = 'massovka-actions'


def api(method, path, body=None, soft=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers={
        'Authorization': f'Bearer {TOKEN}',
        'Content-Type': 'application/json',
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors='replace')[:400]
        if soft:
            return {'_error': e.code, '_msg': msg}
        print(f'::error::{method} {path}: HTTP {e.code}: {msg}')
        sys.exit(1)


def ssh_key():
    seed = hmac.new(TOKEN.encode(), b'massovka-ssh-v1', hashlib.sha256).digest()
    k = Ed25519PrivateKey.from_private_bytes(seed)
    priv = k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH, serialization.NoEncryption())
    pub = k.public_key().public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH).decode()
    path = os.path.expanduser('~/.ssh/id_ed25519')
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'wb') as f:
        f.write(priv)
    return pub


def ensure_key(pub):
    keys = api('GET', '/ssh-keys').get('ssh_keys', [])
    for k in keys:
        if k.get('body', '').split()[:2] == pub.split()[:2]:
            return k['id']
    for k in keys:
        if k.get('name') == KEY_NAME:
            print(f'::warning::ключ {KEY_NAME} есть, но другой (сменился TWC_TOKEN?) — добавляю новый')
    r = api('POST', '/ssh-keys', {'name': KEY_NAME + time.strftime('-%Y%m%d%H%M'), 'body': pub, 'is_default': False})
    kid = r['ssh_key']['id']
    print(f'SSH-ключ добавлен: {kid}')
    return kid


def find_os():
    oses = api('GET', '/os/servers').get('servers_os', [])
    for o in oses:
        if o.get('name') == OS_NAME and str(o.get('version')) == OS_VERSION:
            return o['id']
    print('::error::нет ОС', OS_NAME, OS_VERSION, 'среди:', sorted({f"{o.get('name')} {o.get('version')}" for o in oses}))
    sys.exit(1)


def ipv4(server):
    for n in server.get('networks', []):
        if n.get('type') != 'public':
            continue
        for ip in n.get('ips', []):
            if ip.get('type') == 'ipv4':
                return ip['ip']
    return None


def describe(s):
    """Поля сервера без секретов: статус, тариф, локация, ОС, сети."""
    keep = {k: s.get(k) for k in ('id', 'status', 'preset_id', 'location', 'availability_zone', 'os', 'is_ddos_guard', 'created_at')}
    keep['networks'] = [{'type': n.get('type'), 'ips': [i.get('type') for i in n.get('ips', [])]} for n in s.get('networks', [])]
    return json.dumps(keep, ensure_ascii=False)


def drop(s):
    print(f'::warning::сервер {s["id"]} сломан при создании: {describe(s)} — удаляю')
    r = api('DELETE', f'/servers/{s["id"]}', soft=True)
    print('удалён' if '_error' not in r else f'удалить не вышло: HTTP {r["_error"]} {r["_msg"][:200]} — удалить в панели')
    time.sleep(10)


def wait(sid):
    """Ждать статуса on и публичного IPv4 (до 25 минут). Статус error — сразу (None, сервер)."""
    ip = None
    asked_ip = 0
    last = None
    for n in range(150):
        s = api('GET', f'/servers/{sid}')['server']
        ip = ipv4(s)
        if s.get('status') != last:
            last = s.get('status')
            print(f'статус: {last}')
        if s.get('status') == 'on' and ip:
            return ip, s
        if s.get('status') == 'error':
            return None, s
        # некоторые тарифы (MSK Ultra, с ноября 2026 и Нидерланды) создаются без публичного IPv4 — заказать.
        # Отказ «abuse_prepayment_required» — Timeweb просит баланс не меньше required_balance:
        # пробуем раз в минуту, пока владелец пополняет (до 25 минут)
        if s.get('status') == 'on' and not ip and n >= asked_ip:
            r = api('POST', f'/servers/{sid}/ips', {'type': 'ipv4'}, soft=True)
            if '_error' not in r:
                print('IPv4: заказан')
                asked_ip = 10**9
            else:
                print(f'IPv4: отказ ({r["_msg"][:200]}) — повторю через минуту')
                asked_ip = n + 6
        time.sleep(10)
    print(f'::error::сервер не готов за 25 минут: {describe(s)}')
    sys.exit(1)


def port_open(ip, port, seconds):
    end = time.time() + seconds
    while time.time() < end:
        try:
            with socket.create_connection((ip, port), timeout=5):
                return True
        except OSError:
            time.sleep(5)
    return False


def main():
    if not NAME:
        print('::error::не задано имя сервера (SERVER_NAME)')
        sys.exit(1)
    pub = ssh_key()
    # открытый ключ — не секрет: им шифруют данные для переноса на сервер (infra/game/import.py)
    print('ключ сервера (открытый):', pub)
    key_id = ensure_key(pub)
    servers = [s for s in api('GET', '/servers').get('servers', []) if s.get('name') == NAME]
    # только узнать адрес другого сервера (Москве — адрес сервера бота); нет его — пустой вывод
    if os.environ.get('FIND_ONLY') == '1':
        ip = ipv4(servers[0]) if servers else None
        if ip:
            host = ip.replace('.', '-') + '.sslip.io'
            print(f'{NAME}: {host}')
            with open(os.environ.get('GITHUB_OUTPUT', '/dev/null'), 'a') as f:
                f.write(f'ip={ip}\nhost={host}\nserver_id={servers[0]["id"]}\n')
        else:
            print(f'{NAME}: нет')
        return
    if len(servers) > 1:
        print(f'::warning::серверов с именем {NAME}: {len(servers)} (id: {[x["id"] for x in servers]}) — беру первый, лишние удалить в панели')
    # сломанный при создании (статус error и ни разу не получил адрес, 24.11 у Cloud NL-15) — удалить и
    # создать заново: в нём ничего нет. Только по разрешению (RECREATE_BROKEN=1) и только без IPv4:
    # рабочий сервер с базой так не удалится, даже если Timeweb на минуту покажет «error»
    if servers and servers[0].get('status') == 'error' and not ipv4(servers[0]) and os.environ.get('RECREATE_BROKEN') == '1':
        drop(servers[0])
        servers = []
    # тариф сменили (Cloud NL-15 без своего IPv4 так и не открыл SSH, 24.11; решение владельца — NL-30),
    # а сервер старого тарифа так и не получил IPv4 — в нём ничего нет: удалить и создать на новом.
    # Только без IPv4: тариф живого сервера теперь меняет Terraform (infra/terraform), и сервер с базой,
    # который на минуту не ответил по SSH (перезагрузка после смены тарифа), удаляться не должен
    if servers and os.environ.get('RECREATE_BROKEN') == '1' and servers[0].get('preset_id') not in PRESETS:
        if not ipv4(servers[0]):
            drop(servers[0])
            servers = []
        else:
            print(f'::warning::у {NAME} тариф {servers[0].get("preset_id")}, а в SERVER_PRESETS {PRESETS} — сервер живой, не трогаю (тариф — infra/terraform/servers.tf)')
    if not servers and NAME in RETIRED:
        print(f'::error::{NAME} выведен из работы — создавать его нельзя (docs/server-migration.md › 15)')
        sys.exit(1)
    created = False
    if servers:
        s = servers[0]
        print(f'сервер есть: id={s["id"]}, статус={s.get("status")}')
        ip, s = wait(s['id'])
        if not ip:
            print(f'::error::сервер не в порядке: {describe(s)}')
            sys.exit(1)
    else:
        os_id = find_os()
        ip = None
        for preset in PRESETS:
            body = {
                'name': NAME,
                'preset_id': preset,
                'os_id': os_id,
                'ssh_keys_ids': [key_id],
                'is_ddos_guard': False,
                'comment': 'Массовка: игровой сервер (создан из GitHub Actions)',
            }
            r = api('POST', '/servers', body, soft=True)
            if '_error' in r:
                print(f'тариф {preset}: отказ ({r["_msg"][:160]})')
                continue
            s = r['server']
            print(f'сервер создан: id={s["id"]}, тариф {preset}')
            ip, s = wait(s['id'])
            if ip:
                created = True
                break
            # только что созданный не поднялся (статус error) — удалить и попробовать следующий тариф
            drop(s)
        if not ip:
            print('::error::ни один тариф не поднялся:', PRESETS)
            sys.exit(1)
    sid = s['id']
    # Cloud NL-15 создаётся без IPv4: заказанный потом адрес система видит только после перезагрузки
    # (24.11: адрес есть, SSH 15 минут молчит). Порт 22 не отвечает — перезагрузить один раз.
    # Только только что созданный: живой сервер с игроками из-за минутной заминки SSH не перезагружаем
    if created and os.environ.get('RECREATE_BROKEN') == '1' and not port_open(ip, 22, 90):
        print('SSH не отвечает — перезагружаю сервер (новый IPv4 появится в системе)')
        r = api('POST', f'/servers/{sid}/reboot', {}, soft=True)
        if '_error' in r:
            r = api('POST', f'/servers/{sid}/action', {'action': 'reboot'}, soft=True)
        print('перезагрузка: ' + ('ok' if '_error' not in r else f'HTTP {r["_error"]} {r["_msg"][:200]}'))
        time.sleep(20)
        ip, s = wait(sid)
        print('SSH после перезагрузки: ' + ('есть' if ip and port_open(ip, 22, 300) else 'нет'))
    host = ip.replace('.', '-') + '.sslip.io'
    print(f'готов: ip={ip}, host={host}, локация={s.get("location")}')
    with open(os.environ.get('GITHUB_OUTPUT', '/dev/null'), 'a') as f:
        f.write(f'ip={ip}\nhost={host}\nserver_id={sid}\n')


if __name__ == '__main__':
    main()
