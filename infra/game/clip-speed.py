#!/usr/bin/env python3
"""Замер загрузки клипа на сервер бота: через Москву (туннель) и напрямую в Нидерланды.

Токен бота — из переменной TG_TOKEN (секрет GitHub), не печатается. Файл — 4 МБ случайных байт
(как клип 12–13 с). Клипы-замеры сервер сам удалит через 2 суток."""
import hashlib, hmac, json, os, time, urllib.parse, urllib.request

token = os.environ["TG_TOKEN"]
fields = {"auth_date": str(int(time.time())), "user": json.dumps({"id": 1, "first_name": "speedtest"})}
check = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
fields["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
init = urllib.parse.urlencode(fields)
body = os.urandom(4 * 1024 * 1024)
for name, base in (("Москва → туннель → NL", "https://api.benobody.app"), ("напрямую в NL", "https://72-56-73-184.sslip.io")):
    for i in range(2):
        req = urllib.request.Request(f"{base}/tg/clip", data=body, method="POST",
                                     headers={"content-type": "video/mp4", "x-tg-init": init})
        t = time.time()
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                st = r.status
        except Exception as e:  # noqa: BLE001
            st = type(e).__name__ + ": " + str(e)[:80]
        dt = time.time() - t
        print(f"{name}: {st}, {dt:.1f} с, {4 / dt:.2f} МБ/с")
