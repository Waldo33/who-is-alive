# S3 для видео (docs/infra-plan.md › этап 2): клипы «Лучший момент», «Фильм матча» с обложками и записи матчей.
# У Timeweb хранилище есть только в Петербурге (ru-1, s3.twcstorage.ru) — в Европе нет (infra-check, 23.11.2026).
# Тариф Standard 10 ГБ — 79 ₽/мес, исходящий трафик: 100 ГБ в месяц бесплатно, дальше ~1,3 ₽/ГБ.
# Всё хранится 2 суток (правило бакета ставит сам игровой сервер при старте, s3.ts › ensureLifecycle),
# поэтому 10 ГБ — с запасом: клип 2–4 МБ, фильм ~6 МБ.
#
# Бакет приватный: файлы отдаются по подписанным ссылкам на 2 суток, которые выдаёт игровой сервер
# (GET /v1/clips/<id>.mp4 → 302). Ключи доступа сюда не попадают: выкладка берёт их из API Timeweb
# по TWC_TOKEN (infra/game/s3-env.py) и кладёт файлом на сервер.
locals {
  media_bucket = "massovka-media"
}

data "twc_s3_preset" "media" {
  location      = "ru-1"
  storage_class = "hot"
  disk          = 10 * 1024
}

resource "twc_s3_bucket" "media" {
  name        = local.media_bucket
  type        = "private"
  preset_id   = data.twc_s3_preset.media.id
  description = "Массовка: клипы и фильмы матча (2 суток), из Terraform"

  # переполнение — не повод молча платить больше: сервер всё равно держит локальную копию
  is_allow_auto_upgrade = false

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [description, project_id]
  }
}
