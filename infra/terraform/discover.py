#!/usr/bin/env python3
"""
Перед планом Terraform: какие серверы уже есть в Timeweb и какой SSH-ключ у выкладки.

Пишет discovered.auto.tfvars.json (в .gitignore):
  existing_servers — имя → id для всех серверов аккаунта (servers.tf берёт нужные и подхватывает их import'ом);
  existing_buckets — имя → id бакетов S3 (storage.tf подхватывает massovka-media);
  ssh_key_ids      — id ключа, выведенного из TWC_TOKEN (тот же, что делает infra/game/provision.py).
Только читает API: ключ, которого ещё нет, не создаёт (это делает provision.py при выкладке).
Печатает имена и id — не секреты.
"""
import hashlib
import hmac
import json
import os
import sys
import urllib.error
import urllib.request

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

API = 'https://api.timeweb.cloud/api/v1'
TOKEN = os.environ['TWC_TOKEN']


def get(path):
    req = urllib.request.Request(API + path, headers={'Authorization': f'Bearer {TOKEN}'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def deploy_pubkey():
    # как provision.py › ssh_key: HMAC(TWC_TOKEN) → Ed25519
    seed = hmac.new(TOKEN.encode(), b'massovka-ssh-v1', hashlib.sha256).digest()
    pub = Ed25519PrivateKey.from_private_bytes(seed).public_key()
    return pub.public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH).decode()


def main():
    servers = get('/servers?limit=100').get('servers', [])
    existing = {}
    for s in servers:
        name = s.get('name')
        if name in existing:
            print(f'::error::два сервера с именем {name} ({existing[name]} и {s["id"]}) — Terraform не знает, какой взять; лишний удалить в панели')
            sys.exit(1)
        existing[name] = str(s['id'])
        print(f'есть: {name} id={s["id"]} тариф={s.get("preset_id")} статус={s.get("status")}')

    buckets = {}
    try:
        found = get('/storages/buckets').get('buckets', [])
    except urllib.error.HTTPError as e:
        # S3 в аккаунте ещё не подключено — значит, и бакетов нет
        print(f'бакеты: HTTP {e.code} — считаю, что их нет')
        found = []
    for b in found:
        # Timeweb может приписать к имени приставку («abcd1234-massovka-media») — ключ без неё
        name = b.get('name', '')
        short = 'massovka-media' if name.endswith('massovka-media') else name
        if short in buckets:
            print(f'::error::два бакета {short} ({buckets[short]} и {b["id"]}) — лишний удалить в панели')
            sys.exit(1)
        buckets[short] = str(b['id'])
        print(f'есть бакет: {name} id={b["id"]} тариф={b.get("preset_id")} статус={b.get("status")}')

    pub = deploy_pubkey().split()[:2]
    key_ids = [k['id'] for k in get('/ssh-keys').get('ssh_keys', []) if k.get('body', '').split()[:2] == pub]
    print('ключ выкладки:', key_ids[0] if key_ids else 'нет (новый сервер создастся без него — сначала запустить game-deploy)')

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'discovered.auto.tfvars.json')
    with open(out, 'w') as f:
        json.dump({'existing_servers': existing, 'existing_buckets': buckets, 'ssh_key_ids': key_ids[:1]}, f, indent=2)


if __name__ == '__main__':
    main()
