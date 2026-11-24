#!/usr/bin/env python3
"""
Переключить записи A домена с одного сервера на другой через API Timeweb (переезд в Европу,
docs/infra-plan.md › этап 3). Записи DNS и так публичны — печатаем их целиком; токен — нет.

  TWC_TOKEN=… FROM_IP=129.101.104.99 TO_IP=1.2.3.4 python3 dns-switch.py [benobody.app]

Меняются только записи A, которые сейчас смотрят на FROM_IP (корень, www, api). TTL — 60 с, чтобы
откат (FROM_IP и TO_IP наоборот) доходил до телефонов за минуту. Сначала API v2 (путь — полное имя),
не вышло — v1 (зона в пути, поддомен в теле). DRY=1 — только показать.
"""
import json
import os
import sys
import urllib.error
import urllib.request

TOKEN = os.environ['TWC_TOKEN']
FROM_IP = os.environ['FROM_IP']
TO_IP = os.environ['TO_IP']
ZONE = sys.argv[1] if len(sys.argv) > 1 else 'benobody.app'
DRY = os.environ.get('DRY') == '1'
TTL = int(os.environ.get('TTL', '60'))


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request('https://api.timeweb.cloud' + path, data=data, method=method, headers={
        'Authorization': f'Bearer {TOKEN}',
        'Content-Type': 'application/json',
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        return e.code, {'_msg': e.read().decode(errors='replace')[:300]}


def records(fqdn):
    code, body = api('GET', f'/api/v1/domains/{fqdn}/dns-records')
    if code != 200:
        print(f'  {fqdn}: список записей — HTTP {code} {body.get("_msg", "")}')
        return []
    return body.get('dns_records', [])


def show(fqdn, recs):
    for r in recs:
        d = r.get('data', {})
        print(f'  {fqdn}: id={r.get("id")} {r.get("type")} {d.get("subdomain") or "@"} → {d.get("value")} ttl={r.get("ttl", d.get("ttl", "?"))}')


changed = 0
found = 0
# записи поддоменов Timeweb держит то в зоне (data.subdomain), то у самого поддомена — смотрим везде
for fqdn in [ZONE, f'www.{ZONE}', f'api.{ZONE}']:
    recs = records(fqdn)
    show(fqdn, recs)
    for r in recs:
        d = r.get('data', {})
        if r.get('type') != 'A' or d.get('value') != FROM_IP:
            continue
        sub = d.get('subdomain') or ''
        # полное имя записи: поддомен из тела (в зоне) или сам поддомен (если смотрим у него)
        name = f'{sub}.{ZONE}' if sub and fqdn == ZONE else fqdn
        found += 1
        if DRY:
            print(f'  DRY: {name} {FROM_IP} → {TO_IP}')
            continue
        code, body = api('PATCH', f'/api/v2/domains/{name}/dns-records/{r["id"]}', {'type': 'A', 'value': TO_IP, 'ttl': TTL})
        print(f'  {name}: PATCH v2 → HTTP {code} {body.get("_msg", "")}')
        if code not in (200, 201, 204):
            b = {'type': 'A', 'value': TO_IP}
            if sub and fqdn == ZONE:
                b['subdomain'] = sub
            code, body = api('PATCH', f'/api/v1/domains/{fqdn}/dns-records/{r["id"]}', b)
            print(f'  {name}: PATCH v1 → HTTP {code} {body.get("_msg", "")}')
        if code in (200, 201, 204):
            changed += 1

print(f'записей A на {FROM_IP}: {found}, переключено на {TO_IP}: {changed}')
if not DRY:
    for fqdn in [ZONE, f'www.{ZONE}', f'api.{ZONE}']:
        show(fqdn, records(fqdn))
    if found and changed < found:
        print('::error::не все записи переключились — поменять в панели DNS Timeweb вручную')
        sys.exit(1)
