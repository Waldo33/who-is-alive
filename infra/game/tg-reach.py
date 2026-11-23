#!/usr/bin/env python3
# Разовая проверка 23.11.2026: серверы Telegram достают и до Москвы, и до Нидерландов.
"""Достают ли серверы Telegram до наших адресов: sendPhoto по ссылке в чат тревог, сообщение сразу
удаляется. Токен — ALERTS_BOT_TOKEN (секрет), не печатается.
Владельцу при этом приходят уведомления о сообщениях, которых в чате уже нет, — поэтому в infra-diag
шаг выключен (TG_REACH: '1' — включить на одну проверку)."""
import json, os, urllib.parse, urllib.request

tok, chat = os.environ["TOKEN"], os.environ["CHAT"]
def api(m, **p):
    req = urllib.request.Request(f"https://api.telegram.org/bot{tok}/{m}", data=urllib.parse.urlencode(p).encode())
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return json.load(e)
for name, url in (("Москва (benobody.app)", "https://benobody.app/icons/icon-512.png"),
                  ("Москва (api.benobody.app)", "https://api.benobody.app/healthz"),
                  ("Нидерланды", "https://72-56-73-184.sslip.io/healthz")):
    if url.endswith("healthz"):
        r = api("sendDocument", chat_id=chat, document=url, disable_notification="true")
    else:
        r = api("sendPhoto", chat_id=chat, photo=url, disable_notification="true")
    print(f"{name}: {'достаёт' if r.get('ok') else 'НЕ достаёт — ' + str(r.get('description'))[:120]}")
    if r.get("ok"):
        api("deleteMessage", chat_id=chat, message_id=r["result"]["message_id"])
