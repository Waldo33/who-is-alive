#!/usr/bin/env python3
"""
Короткая сводка плана Terraform по-русски: что подхватится, что создастся, что поменяется (поле: было → станет).
Читает `terraform show -json plan.tfplan` из stdin, пишет в stdout (и в $GITHUB_STEP_SUMMARY в workflow).
Удаление или пересоздание чего-либо — выход 1: в этом проекте так нельзя (prevent_destroy ловит то же, это — второй замок).
Чувствительные поля (пароль root, VNC) не печатаются.
"""
import json
import sys

plan = json.load(sys.stdin)
bad = False
lines = []
# поля, которые меняются сами (статус, диски, сети) — в сводке шум
NOISE = {'status', 'disks', 'networks', 'cpu_frequency', 'avatar_id', 'boot_mode', 'root_pass', 'vnc_pass'}

for rc in plan.get('resource_changes', []):
    actions = rc['change']['actions']
    addr = rc['address']
    imported = 'importing' in rc['change']
    if 'delete' in actions:
        bad = True
        lines.append(f'- ⛔ **{addr}** — {"пересоздать" if "create" in actions else "удалить"}: так нельзя, план остановлен')
        continue
    if actions == ['create']:
        lines.append(f'- 🆕 **{addr}** — создать (платно, см. тариф в servers.tf)')
        continue
    if actions == ['update']:
        before, after = rc['change']['before'] or {}, rc['change']['after'] or {}
        sens = {}
        for side in ('before_sensitive', 'after_sensitive'):
            v = rc['change'].get(side)
            if isinstance(v, dict):
                sens |= v
        diff = []
        for k in sorted(set(before) | set(after)):
            if k in NOISE or sens.get(k) is True or k in (rc['change'].get('after_unknown') or {}):
                continue
            if before.get(k) != after.get(k):
                diff.append(f'`{k}`: {json.dumps(before.get(k), ensure_ascii=False)} → {json.dumps(after.get(k), ensure_ascii=False)}')
        lines.append(f'- ✏️ **{addr}** — изменить' + (' (подхвачен)' if imported else '') + ': ' + (', '.join(diff) or 'вычисляемые поля'))
        continue
    if imported or actions == ['no-op']:
        lines.append(f'- ✅ {addr} — без изменений')

out = '### План Terraform\n\n' + ('\n'.join(lines) if lines else 'Изменений нет.') + '\n'
print(out)
sys.exit(1 if bad else 0)
