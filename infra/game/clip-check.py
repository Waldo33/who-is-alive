#!/usr/bin/env python3
"""Живая проверка клипов для Telegram: анонимный вход → загрузка 1 МБ в Москву (/v1/clips) →
файл по ссылке → видео-карточка у бота (/tg/prepare, подпись initData токеном бота из TG_TOKEN —
не печатается). Карточка никуда не отправляется. Файл сервер удалит сам через 2 суток."""
import hashlib, hmac, json, os, time, urllib.parse, urllib.request

API = "https://api.benobody.app"
def call(url, data=None, headers=None, method=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers

st, body, _ = call(f"{API}/v1/auth/anon", b"", method="POST")
token = json.loads(body)["token"]
video = os.urandom(1024 * 1024)
t = time.time()
st, body, _ = call(f"{API}/v1/clips", video, {"authorization": f"Bearer {token}", "content-type": "video/mp4"})
print(f"загрузка 1 МБ: {st} за {time.time() - t:.1f} с")
clip = json.loads(body)["id"]
st, body, h = call(f"{API}/v1/clips/{clip}.mp4")
print(f"файл по ссылке: {st}, {h.get('content-type')}, {len(body)} байт, совпадает: {body == video}")
tok = os.environ["TG_TOKEN"]
fields = {"auth_date": str(int(time.time())), "user": json.dumps({"id": 1, "first_name": "check", "language_code": "ru"})}
check = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
fields["hash"] = hmac.new(hmac.new(b"WebAppData", tok.encode(), hashlib.sha256).digest(), check.encode(), hashlib.sha256).hexdigest()
init = urllib.parse.urlencode(fields)
st, body, _ = call(f"{API}/tg/prepare", json.dumps({"initData": init, "kind": "clip", "clip": clip, "text": "проверка", "thumb": False}).encode(),
                   {"content-type": "application/json"})
print(f"видео-карточка у бота: {st} {body[:80]!r}")
