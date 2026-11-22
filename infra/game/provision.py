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
import sys
import time
import urllib.error
import urllib.request

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

API = 'https://api.timeweb.cloud/api/v1'
TOKEN = os.environ['TWC_TOKEN']
NAME = os.environ.get('SERVER_NAME', 'massovka-game')
# по очереди, пока не найдётся свободный: Cloud KZN 50 (Казань), Cloud EKB 50 (Екатеринбург) — 2 vCPU, 4 ГБ, 50 ГБ, 1000 ₽
PRESETS = [int(x) for x in os.environ.get('SERVER_PRESETS', '6759,6749').split(',')]
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


def main():
    pub = ssh_key()
    key_id = ensure_key(pub)
    servers = [s for s in api('GET', '/servers').get('servers', []) if s.get('name') == NAME]
    if servers:
        s = servers[0]
        print(f'сервер есть: id={s["id"]}, статус={s.get("status")}')
    else:
        os_id = find_os()
        s = None
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
            break
        if s is None:
            print('::error::ни один тариф не свободен:', PRESETS)
            sys.exit(1)
    sid = s['id']
    ip = None
    for _ in range(90):
        s = api('GET', f'/servers/{sid}')['server']
        ip = ipv4(s)
        if s.get('status') == 'on' and ip:
            break
        time.sleep(10)
    if not ip or s.get('status') != 'on':
        print(f'::error::сервер не готов: статус={s.get("status")}, ip={ip}')
        sys.exit(1)
    host = ip.replace('.', '-') + '.sslip.io'
    print(f'готов: ip={ip}, host={host}, локация={s.get("location")}')
    with open(os.environ.get('GITHUB_OUTPUT', '/dev/null'), 'a') as f:
        f.write(f'ip={ip}\nhost={host}\nserver_id={sid}\n')


if __name__ == '__main__':
    main()
