#!/usr/bin/env python3
"""
Ключи S3 для игрового сервера — из API Timeweb по TWC_TOKEN (отдельного секрета в GitHub не нужно).

  python3 s3-env.py deploy/s3.env

Находит бакет massovka-media (infra/terraform/storage.tf), берёт его ключи доступа и проверяет их
настоящим запросом к S3 (ListBuckets): заодно узнаёт точное имя бакета — Timeweb может приписать к нему приставку.
Пишет S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY (файл 600). Бакета нет — файла нет, выход 0:
сервер работает с диском, как до S3. Печатает только имя бакета — не ключи.
"""
import datetime
import hashlib
import hmac
import json
import os
import re
import sys
import urllib.error
import urllib.request

API = 'https://api.timeweb.cloud/api/v1'
TOKEN = os.environ['TWC_TOKEN']
WANT = 'massovka-media'
ENDPOINT_HOST = 's3.twcstorage.ru'
REGION = 'ru-1'


def get(path):
    req = urllib.request.Request(API + path, headers={'Authorization': f'Bearer {TOKEN}'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def list_buckets(host, access, secret):
    """ListBuckets с подписью SigV4 — имена бакетов, которые видят эти ключи."""
    now = datetime.datetime.now(datetime.timezone.utc)
    amz, day = now.strftime('%Y%m%dT%H%M%SZ'), now.strftime('%Y%m%d')
    empty = hashlib.sha256(b'').hexdigest()
    canonical = f'GET\n/\n\nhost:{host}\nx-amz-content-sha256:{empty}\nx-amz-date:{amz}\n\nhost;x-amz-content-sha256;x-amz-date\n{empty}'
    scope = f'{day}/{REGION}/s3/aws4_request'
    to_sign = f'AWS4-HMAC-SHA256\n{amz}\n{scope}\n' + hashlib.sha256(canonical.encode()).hexdigest()
    k = ('AWS4' + secret).encode()
    for part in (day, REGION, 's3', 'aws4_request'):
        k = hmac.new(k, part.encode(), hashlib.sha256).digest()
    sig = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
    req = urllib.request.Request(f'https://{host}/', headers={
        'x-amz-date': amz,
        'x-amz-content-sha256': empty,
        'Authorization': f'AWS4-HMAC-SHA256 Credential={access}/{scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature={sig}',
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return re.findall(r'<Name>([^<]+)</Name>', r.read().decode())


def main():
    out = sys.argv[1]
    try:
        buckets = get('/storages/buckets').get('buckets', [])
    except urllib.error.HTTPError as e:
        print(f'S3: HTTP {e.code} от API — бакетов нет, сервер пишет клипы на диск')
        return
    mine = [b for b in buckets if str(b.get('name', '')).endswith(WANT)]
    if not mine:
        print('S3: бакета massovka-media нет (не куплен — infra-terraform apply) — сервер пишет клипы на диск')
        return
    b = mine[0]
    access, secret = b.get('access_key'), b.get('secret_key')
    if not access or not secret:
        users = get('/storages/users').get('users', [])
        if users:
            access, secret = users[0].get('access_key'), users[0].get('secret_key')
    if not access or not secret:
        print('::warning::S3: у бакета нет ключей в ответе API — сервер пишет клипы на диск')
        return
    host = b.get('hostname') or ENDPOINT_HOST
    host = re.sub(r'^https?://', '', host).strip('/')
    if host.endswith('.' + ENDPOINT_HOST):  # бакет в имени хоста — нам нужен общий адрес
        host = ENDPOINT_HOST
    try:
        names = list_buckets(host, access, secret)
    except Exception as e:  # noqa: BLE001 — любой сбой: без S3, но выкладку не роняем
        print(f'::warning::S3: ключи не прошли проверку ({e}) — сервер пишет клипы на диск')
        return
    name = next((n for n in names if n == b['name']), None) or next((n for n in names if n.endswith(WANT)), None)
    if not name:
        print(f'::warning::S3: ключи не видят бакет {b["name"]} (видят: {", ".join(names) or "ничего"}) — сервер пишет клипы на диск')
        return
    old = os.umask(0o077)
    with open(out, 'w') as f:
        f.write(f'S3_ENDPOINT=https://{host}\nS3_REGION={REGION}\nS3_BUCKET={name}\nS3_ACCESS_KEY={access}\nS3_SECRET_KEY={secret}\n')
    os.umask(old)
    print(f'S3: бакет {name} на {host} — ключи проверены, файл для сервера готов')


if __name__ == '__main__':
    main()
