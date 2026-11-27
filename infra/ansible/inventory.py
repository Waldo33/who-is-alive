#!/usr/bin/env python3
"""
Инвентарь Ansible из живого Timeweb: адреса серверов по именам (те же, что в infra/terraform/servers.tf)
и SSH-ключ выкладки (выводится из TWC_TOKEN, как в infra/game/provision.py — он же кладёт ключ в ~/.ssh).
Пишет inventory.ini рядом (в .gitignore). Печатает имена и адреса — они и так в DNS.
"""
import os
import socket
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'game'))
import provision  # noqa: E402  (api, ipv4, ssh_key)

# группа Ansible → имя сервера в Timeweb (Москва, massovka-game, выключена 25.11.2026)
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
    # куда переезжают комнаты при выкладке: на домен, если DNS уже смотрит на Европу, иначе на её sslip.io
    eu = servers.get('massovka-eu')
    eu_ip = provision.ipv4(eu) if eu else None
    try:
        dns = socket.gethostbyname('api.benobody.app')
    except OSError:
        dns = None
    peer = 'api.benobody.app' if eu_ip and dns == eu_ip else (f"{eu_ip.replace('.', '-')}.sslip.io" if eu_ip else '')
    print(f'api.benobody.app → {dns}; переезд комнат — на {peer}')
    # где живёт Telegram-бот (infra | both | eu) — как в game-deploy: infra/game/bot-home
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'game', 'bot-home')) as f:
        bot_home = f.read().strip()
    if bot_home not in ('infra', 'both', 'eu'):
        sys.exit(f'infra/game/bot-home: «{bot_home}» — нужно infra, both или eu')
    print(f'бот: {bot_home}')
    lines += ['[all:vars]', f'peer_host={peer}', f'bot_home={bot_home}', '']
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'inventory.ini'), 'w') as f:
        f.write('\n'.join(lines))


if __name__ == '__main__':
    main()
