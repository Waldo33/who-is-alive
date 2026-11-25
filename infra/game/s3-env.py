#!/usr/bin/env python3
"""
Ключи S3 для игрового сервера — из API Timeweb по TWC_TOKEN (отдельного секрета в GitHub не нужно).

  python3 s3-env.py deploy/s3.env

Находит бакет massovka-media (infra/terraform/storage.tf), берёт его ключи (или ключи пользователя хранилища)
и проверяет их настоящим запросом к S3 — HEAD бакета; не подошло — печатает код ошибки S3 (не секрет).
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


def s3_request(host, path, access, secret, method='HEAD', region=REGION):
    """Подписанный (SigV4) запрос к S3 без тела. Возвращает (HTTP-код, код ошибки S3 или '')."""
    now = datetime.datetime.now(datetime.timezone.utc)
    amz, day = now.strftime('%Y%m%dT%H%M%SZ'), now.strftime('%Y%m%d')
    empty = hashlib.sha256(b'').hexdigest()
    canonical = f'{method}\n{path}\n\nhost:{host}\nx-amz-content-sha256:{empty}\nx-amz-date:{amz}\n\nhost;x-amz-content-sha256;x-amz-date\n{empty}'
    scope = f'{day}/{region}/s3/aws4_request'
    to_sign = f'AWS4-HMAC-SHA256\n{amz}\n{scope}\n' + hashlib.sha256(canonical.encode()).hexdigest()
    k = ('AWS4' + secret).encode()
    for part in (day, region, 's3', 'aws4_request'):
        k = hmac.new(k, part.encode(), hashlib.sha256).digest()
    sig = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
    req = urllib.request.Request(f'https://{host}{path}', method=method, headers={
        'x-amz-date': amz,
        'x-amz-content-sha256': empty,
        'Authorization': f'AWS4-HMAC-SHA256 Credential={access}/{scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature={sig}',
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, ''
    except urllib.error.HTTPError as e:
        m = re.search(r'<Code>([^<]+)</Code>', e.read().decode(errors='replace'))
        return e.code, m.group(1) if m else ''


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
    if (not access or not secret) and not os.environ.get('S3_SECRET_KEY'):
        print('::warning::S3: у бакета нет ключей в ответе API — сервер пишет клипы на диск')
        return
    host = b.get('hostname') or ENDPOINT_HOST
    host = re.sub(r'^https?://', '', host).strip('/')
    if host.endswith('.' + ENDPOINT_HOST):  # бакет в имени хоста — нам нужен общий адрес
        host = ENDPOINT_HOST
    # ключи бакета, затем ключи пользователей хранилища; проверка — HEAD самого бакета
    # (ListBuckets ключам одного бакета может быть запрещён: так и было при первой выкладке, 403)
    keys = [(access, secret)]
    # ключи из панели Timeweb (S3 › бакет › ключи доступа), если владелец положил их в GitHub Secrets
    # S3_ACCESS_KEY / S3_SECRET_KEY — пробуем первыми. 25.11: ключи из API (20 и 24 знака) не подошли
    # ни с одним регионом (SignatureDoesNotMatch) — похоже, API отдаёт не тот секрет
    if os.environ.get('S3_ACCESS_KEY') and os.environ.get('S3_SECRET_KEY'):
        keys.insert(0, (os.environ['S3_ACCESS_KEY'], os.environ['S3_SECRET_KEY']))
    try:
        keys += [(u.get('access_key'), u.get('secret_key')) for u in get('/storages/users').get('users', [])]
    except urllib.error.HTTPError:
        pass
    name = b['name']
    # поля ответа (без значений ключей) — чтобы по логу было видно, что прислал Timeweb
    print(f'S3: бакет {name} id={b.get("id")} статус={b.get("status")} хост={host} ключей-кандидатов={len([k for k in keys if k[0] and k[1]])}')
    ok = None
    region = REGION
    # 25.11: оба ключа с ru-1 получили SignatureDoesNotMatch при верной подписи (сверена с примерами AWS) —
    # пробуем и другие регионы подписи; какой подошёл, тот и уходит серверу (S3_REGION)
    for i, (a, sec) in enumerate([k for k in keys if k[0] and k[1]]):
        sec = sec.strip()
        a = a.strip()
        for reg in (REGION, 'us-east-1'):
            # адрес «путём» (так работает сервер) и, для сравнения, бакет в имени хоста
            for h, pth in ((host, f'/{name}'), (f'{name}.{host}', '/')):
                code, _ = s3_request(h, pth, a, sec, 'HEAD', reg)
                if code == 200:
                    break
                _, err = s3_request(h, pth, a, sec, 'GET', reg)
                print(f'S3: ключ #{i + 1}, регион {reg}, хост {h}: HTTP {code} {err}')
            if code == 200:
                if h == host:
                    ok, region = (a, sec), reg
                    break
                print(f'::warning::S3: ключ #{i + 1} подошёл только с бакетом в имени хоста ({reg}) — серверу нужен адрес путём, правка s3.ts')
                continue
        # длина и набор знаков секрета (не сам секрет) — видно, не пришло ли что-то не то
        kind = 'hex' if re.fullmatch(r'[0-9a-f]+', sec) else 'b64' if re.fullmatch(r'[A-Za-z0-9+/=]+', sec) else 'другое'
        print(f'S3: ключ #{i + 1}: ключ {len(a)} зн., секрет {len(sec)} зн., {kind}')
        if ok:
            break
    if not ok:
        print(f'::warning::S3: ни один ключ не открыл бакет {name} (хост {host}) — сервер пишет клипы на диск')
        return
    access, secret = ok
    old = os.umask(0o077)
    with open(out, 'w') as f:
        f.write(f'S3_ENDPOINT=https://{host}\nS3_REGION={region}\nS3_BUCKET={name}\nS3_ACCESS_KEY={access}\nS3_SECRET_KEY={secret}\n')
    os.umask(old)
    print(f'S3: бакет {name} на {host}, регион подписи {region} — ключи проверены, файл для сервера готов')


if __name__ == '__main__':
    main()
