#!/usr/bin/env python3
"""Правила безопасности для .github/workflows (docs/security.md, ревью H4 и N2). Гоняет CI.

1. Каждый чужой action закреплён полным SHA коммита (тег можно перевесить на другой код).
2. Каждая задача, которая читает секреты (кроме github.token), идёт в окружении production —
   его секреты GitHub отдаёт только ветке main.
3. Задача с секретами не запускается на pull_request и на push в другие ветки.
4. Каждый вызов infra/game/provision.py называет сервер (SERVER_NAME), а выведенный из работы
   massovka-game — только ищет (FIND_ONLY): 26.11.2026 проверка сети без имени создала его заново.
"""
import glob
import re
import sys

RETIRED = ('massovka-game',)

bad = []
for f in sorted(glob.glob('.github/workflows/*.yml')):
    s = open(f, encoding='utf-8').read()
    jobs_txt = s.split('\njobs:\n', 1)[1] if '\njobs:\n' in s else ''
    for jm in re.finditer(r'(?ms)^  ([A-Za-z0-9_-]+):\n(.*?)(?=^  [A-Za-z0-9_-]+:\n|\Z)', jobs_txt):
        name, body = jm.group(1), jm.group(2)
        head, _, steps = body.partition('\n    steps:\n')
        for step in re.split(r'(?m)^      - ', steps):
            if 'provision.py' not in step:
                continue
            ctx = head + step
            if 'SERVER_NAME' not in ctx:
                bad.append(f'{f}: задача {name} зовёт provision.py без SERVER_NAME')
            for r in RETIRED:
                if r in step and not re.search(r"FIND_ONLY:\s*'1'", ctx):
                    bad.append(f'{f}: задача {name} может создать выведенный {r} (нет FIND_ONLY)')
    for m in re.finditer(r'(?m)^\s*-?\s*uses:\s*([^\s#]+)', s):
        ref = m.group(1)
        if ref.startswith('./'):
            continue
        if not re.search(r'@[0-9a-f]{40}$', ref):
            bad.append(f'{f}: action не закреплён SHA: {ref}')
    uses_secrets = re.search(r'secrets\.(?!GITHUB_TOKEN)[A-Z_]+', s)
    if not uses_secrets:
        continue
    # задачи: блоки с отступом 2 под jobs:
    jobs = s.split('\njobs:\n', 1)[1] if '\njobs:\n' in s else ''
    for jm in re.finditer(r'(?ms)^  ([A-Za-z0-9_-]+):\n(.*?)(?=^  [A-Za-z0-9_-]+:\n|\Z)', jobs):
        name, body = jm.group(1), jm.group(2)
        if re.search(r'secrets\.(?!GITHUB_TOKEN)[A-Z_]+', body) and not re.search(r'(?m)^    environment: production\s*$', body):
            bad.append(f'{f}: задача {name} читает секреты без environment: production')
    trig = s.split('\njobs:\n', 1)[0]
    if re.search(r'(?m)^  pull_request(_target)?:', trig):
        bad.append(f'{f}: секреты в workflow, который запускается на pull_request')
    for bm in re.finditer(r'(?ms)^  push:\n(.*?)(?=^  \S|^\S)', trig):
        br = re.search(r'branches:\s*\[([^\]]*)\]', bm.group(1))
        if not br or [b.strip(" '\"") for b in br.group(1).split(',')] != ['main']:
            bad.append(f'{f}: секреты в workflow, который запускается на push не только в main')

if bad:
    print('\n'.join(bad))
    sys.exit(1)
print('workflows: actions закреплены, секреты только в production и только для main, provision.py — с именем сервера')
