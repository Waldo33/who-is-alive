#!/usr/bin/env python3
"""Смена ключа выкладки (infra/game/keys.py › prune): убираем только старые ключи выкладки,
чужие и свой оставляем, а без своего ключа файл не пишем (иначе потеряли бы доступ к серверу)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'game'))
from keys import key_body, prune  # noqa: E402

CUR, OLD, OWNER = 'AAAAcurrent', 'AAAAold', 'AAAAowner'
text = '\n'.join([
    f'ssh-ed25519 {OLD} massovka-actions',
    f'ssh-ed25519 {OWNER} owner@laptop',
    f'no-port-forwarding,command="echo" ssh-ed25519 {OLD} restricted',
    '# комментарий',
    '',
    f'ssh-ed25519 {CUR}',
]) + '\n'

out, n = prune(text, [OLD], CUR)
assert n == 2, n
assert OLD not in out and OWNER in out and CUR in out and '# комментарий' in out, out
assert key_body(f'ssh-ed25519 {CUR} x') == CUR and key_body('# нет') is None

# пустое тело или наш же ключ среди «старых» ничего лишнего не убирает
out2, n2 = prune(text, ['', None, CUR], CUR)
assert n2 == 0 and out2 == text, (n2, out2)

# нашего ключа нет — отказ, файл не трогаем
try:
    prune(f'ssh-ed25519 {OLD}\n', [OLD], CUR)
    raise SystemExit('prune без нашего ключа должен отказать')
except ValueError:
    pass
print('keys: старые ключи выкладки убираются, свой и чужие остаются')
