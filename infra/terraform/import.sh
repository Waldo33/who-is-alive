#!/usr/bin/env bash
# Собрать состояние Terraform из живого Timeweb (состояние нигде не хранится, docs/terraform.md › «Без состояния»).
# Нужен discovered.auto.tfvars.json от discover.py и terraform init.
#  1. каждый сервер из servers.tf, который уже есть в Timeweb, — terraform import по id;
#  2. в состояние дописывается os_id из ответа Timeweb (os[0].id). Иначе провайдер не меняет тариф
#     («server should have one of os_id or image_id»), а если указать os_id в конфигурации, он шлёт
#     PATCH {"os_id": …} — это ПЕРЕУСТАНОВКА системы. С os_id в состоянии PATCH идёт только с preset_id
#     (проверено на заглушке API, провайдер 1.8.4).
set -euo pipefail
cd "$(dirname "$0")"

keys=$(echo 'jsonencode(local.existing)' | terraform console | python3 -c 'import json,sys; [print(k, v) for k, v in json.loads(json.load(sys.stdin)).items()]')
while read -r key id; do
  [ -n "$key" ] || continue
  echo "подхватываю $key: id=$id"
  terraform import -no-color "twc_server.this[\"$key\"]" "$id" | grep -v -i 'root_pass\|vnc_pass' | grep -i 'import' || true
done <<< "$keys"

terraform state pull > /tmp/tfstate.json
python3 - <<'PY'
import json
p = '/tmp/tfstate.json'
s = json.load(open(p))
for r in s.get('resources', []):
    if r['type'] != 'twc_server':
        continue
    for i in r['instances']:
        a = i['attributes']
        if a.get('os_id') is None and a.get('os'):
            a['os_id'] = a['os'][0]['id']
            print(f'{i["index_key"]}: os_id={a["os_id"]} (как в Timeweb) — в состояние')
s['serial'] += 1
json.dump(s, open(p, 'w'))
PY
terraform state push /tmp/tfstate.json
rm -f /tmp/tfstate.json
