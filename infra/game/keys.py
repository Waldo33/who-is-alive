#!/usr/bin/env python3
"""
Ключ выкладки на всех серверах сразу — первая задача game-deploy (docs/security.md › 5).

Ключ SSH выкладки выводится из TWC_TOKEN (provision.py › ssh_key). Сменили токен — сменился ключ:
1. новый ключ — в аккаунт Timeweb и на каждый сервер из SERVERS, который его ещё не пускает
   (API Timeweb ставит ключ на живой сервер без перезагрузки); ждём, пока пустят все;
2. старые ключи выкладки (в аккаунте — с именем massovka-actions…, тело не наше) убираем
   из /root/.ssh/authorized_keys каждого сервера и из аккаунта.
Чужие ключи (свой ключ владельца, ключи туннелей — они у пользователя tunnel) не трогаем:
удаляется только строка, где стоит тело старого ключа выкладки. Наш ключ обязан остаться — иначе
файл не пишем.

Логи Actions публичные: печатаем имена, id и IP, без тел ключей.
"""
import os
import subprocess
import sys
import time

KEY_PREFIX = 'massovka-actions'


def key_body(line):
    """Тело ключа (base64) из строки authorized_keys или открытого ключа; None — не ключ."""
    parts = line.split()
    for i, p in enumerate(parts):
        if p.startswith(('ssh-', 'ecdsa-', 'sk-')) and i + 1 < len(parts):
            return parts[i + 1]
    return None


def prune(text, old_bodies, current_body):
    """authorized_keys без строк со старыми ключами выкладки. (новый текст, сколько убрано).
    Наш ключ должен остаться — иначе ValueError: такой файл писать нельзя (потеряем доступ)."""
    old = {b for b in old_bodies if b and b != current_body}
    keep, removed = [], 0
    for line in text.splitlines():
        if key_body(line) in old:
            removed += 1
            continue
        keep.append(line)
    if not any(key_body(line) == current_body for line in keep):
        raise ValueError('нашего ключа нет в authorized_keys — файл не меняю')
    return '\n'.join(keep) + ('\n' if keep else ''), removed


def ssh(ip, cmd, data=None):
    opts = os.environ.get('SSH_OPTS', '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 -o LogLevel=ERROR').split()
    return subprocess.run(['ssh', *opts, f'root@{ip}', cmd], input=data, capture_output=True, text=True, timeout=120)


def main():
    import provision as p  # читает TWC_TOKEN и выводит ключ — только в бою, не в тесте

    names = os.environ.get('SERVERS', 'massovka-eu massovka-infra').split()
    pub = p.ssh_key()
    me = key_body(pub)
    key_id = p.ensure_key(pub)
    all_servers = p.api('GET', '/servers').get('servers', [])
    targets = []
    for name in names:
        found = [s for s in all_servers if s.get('name') == name]
        ip = p.ipv4(found[0]) if found else None
        if not ip:
            print(f'{name}: нет (создаст выкладка — ключ при создании)')
            continue
        targets.append((name, found[0]['id'], ip))

    # 1. новый ключ — на все серверы, которые его не пускают
    for name, sid, ip in targets:
        r = ssh(ip, 'true')
        if r.returncode == 0:
            print(f'{name}: ключ выкладки уже пускают')
            continue
        if 'Permission denied' not in r.stderr:
            print(f'::warning::{name}: SSH не ответил ({r.stderr.strip()[:200]}) — ключ не трогаю, разберётся выкладка')
            continue
        a = p.api('POST', f'/servers/{sid}/ssh-keys', {'ssh_key_ids': [key_id]}, soft=True)
        if '_error' in a:
            print(f'::error::{name}: Timeweb не поставил ключ: HTTP {a["_error"]}: {a["_msg"][:200]} — добавьте ключ {KEY_PREFIX}… в панели (сервер › SSH-ключи)')
            sys.exit(1)
        print(f'{name}: новый ключ отправлен на сервер')
    for name, sid, ip in targets:
        for _ in range(30):
            if ssh(ip, 'true').returncode == 0:
                break
            time.sleep(10)
        else:
            print(f'::error::{name}: новый ключ так и не пустили за 5 минут')
            sys.exit(1)
    print('ключ выкладки пускают все серверы')

    # 2. старые ключи выкладки — с серверов и из аккаунта
    old = [k for k in p.api('GET', '/ssh-keys').get('ssh_keys', [])
           if str(k.get('name', '')).startswith(KEY_PREFIX) and key_body(k.get('body', '')) not in (None, me)]
    if not old:
        print('старых ключей выкладки нет')
        return
    bodies = [key_body(k['body']) for k in old]
    for name, sid, ip in targets:
        r = ssh(ip, 'cat /root/.ssh/authorized_keys')
        if r.returncode != 0:
            print(f'::error::{name}: не прочитал authorized_keys')
            sys.exit(1)
        try:
            text, removed = prune(r.stdout, bodies, me)
        except ValueError as e:
            print(f'::error::{name}: {e}')
            sys.exit(1)
        if removed:
            w = ssh(ip, 'f=/root/.ssh/authorized_keys; cat > "$f.new" && chmod 600 "$f.new" && mv "$f.new" "$f"', text)
            if w.returncode != 0 or ssh(ip, 'true').returncode != 0:
                print(f'::error::{name}: после правки authorized_keys SSH не пускает — проверьте консолью Timeweb')
                sys.exit(1)
        print(f'{name}: старых ключей выкладки убрано: {removed}')
    for k in old:
        r = p.api('DELETE', f'/ssh-keys/{k["id"]}', soft=True)
        print(f'аккаунт: ключ {k.get("name")} ({k["id"]}) ' + ('удалён' if '_error' not in r else f'не удалён: HTTP {r["_error"]}'))


if __name__ == '__main__':
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
