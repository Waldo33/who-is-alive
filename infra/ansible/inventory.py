#!/usr/bin/env python3
"""
Инвентарь Ansible из живого Timeweb: адреса серверов по именам (те же, что в infra/terraform/servers.tf)
и SSH-ключ выкладки (выводится из TWC_TOKEN, как в infra/game/provision.py — он же кладёт ключ в ~/.ssh).
Пишет inventory.ini рядом (в .gitignore). Печатает имена и адреса — они и так в DNS.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'game'))
import provision  # noqa: E402  (api, ipv4, ssh_key)

# группа Ansible → имя сервера в Timeweb. Москва (massovka-game) доживает неделю и сюда не входит.
HOSTS = {
    'game': ['massovka-eu'],
    'infra': ['massovka-infra'],
}


def main():
    provision.ssh_key()  # ~/.ssh/id_ed25519
    servers = {s.get('name'): s for s in provision.api('GET', '/servers').get('servers', [])}
    lines = []
    for group, names in HOSTS.items():
        lines.append(f'[{group}]')
        for name in names:
            s = servers.get(name)
            ip = provision.ipv4(s) if s else None
            if not ip:
                print(f'::warning::{name}: нет в Timeweb или без IPv4 — пропускаю (создать: infra-terraform)')
                continue
            print(f'{group}: {name} {ip}')
            lines.append(f'{name} ansible_host={ip} ansible_user=root')
        lines.append('')
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'inventory.ini'), 'w') as f:
        f.write('\n'.join(lines))


if __name__ == '__main__':
    main()
