# Все машины проекта. Поменять тариф — поменять preset_id здесь, PR покажет план,
# применение — кнопкой infra-terraform (apply), сервер при смене тарифа перезагружается (до ~10 минут: 25.11 — 9 минут).
# Тарифы и цены — infra-check.yml («S3 и серверы в Нидерландах»).
locals {
  servers = {
    # Европа: игра (api.benobody.app), сайт (benobody.app), Postgres, Caddy
    eu = {
      name = "massovka-eu"
      # Cloud NL-40: 2 vCPU, 2 ГБ, 40 ГБ, 2600 ₽/мес (было NL-30 — 6807, 1 vCPU, 1560 ₽).
      # Второе ядро — «Фильму матча» и запас под рекламу (решение владельца 25.11.2026)
      preset = 6809
      ipv4   = true # в Нидерландах сервер создаётся без своего IPv4 — заказываем
    }
    # Нидерланды: Telegram-бот, сторож, Grafana, копии базы
    infra = {
      name   = "massovka-infra"
      preset = 6807 # Cloud NL-30: 1 vCPU, 2 ГБ, 30 ГБ, 1560 ₽/мес
      ipv4   = true
    }
    # Москва (massovka-game) выведена 25.11.2026: Terraform её больше не видит (план ничего с ней не делает),
    # удаляет её кнопка infra-msk-off — Terraform удалять серверы не умеет нарочно (prevent_destroy).
  }

  # id уже существующих серверов по нашим ключам (eu, infra)
  existing = {
    for k, s in local.servers : k => var.existing_servers[s.name]
    if contains(keys(var.existing_servers), s.name)
  }
}

data "twc_os" "ubuntu" {
  name    = "ubuntu"
  version = "24.04"
}

# Живые серверы не создаются заново: перед каждым планом import.sh подхватывает их по id
# (terraform import). Состояние (state) нигде не хранится — оно собирается из Timeweb на каждом
# запуске, поэтому нет ни бакета, ни пароля root в файле состояния (docs/terraform.md › «Без состояния»).

resource "twc_server" "this" {
  for_each = local.servers

  name      = each.value.name
  preset_id = each.value.preset
  # ОС и ключ нужны только при создании; у живого сервера их не трогаем (ignore_changes).
  # os_id нельзя менять никогда: провайдер шлёт его в PATCH — это переустановка системы
  os_id                     = data.twc_os.ubuntu.id
  ssh_keys_ids              = var.ssh_key_ids
  is_root_password_required = false
  is_ddos_guard             = false
  comment                   = "Массовка: создан из Terraform (infra/terraform)"

  lifecycle {
    # Сервер с базой и игроками нельзя удалить или пересоздать из Terraform: план с удалением
    # падает с ошибкой. Пересоздать — только руками и осознанно (docs/terraform.md).
    prevent_destroy = true
    # то, что задаётся только при создании или живёт своей жизнью в панели, — не сравниваем
    ignore_changes = [
      os_id,
      ssh_keys_ids,
      is_root_password_required,
      is_ddos_guard,
      comment,
      cloud_init,
      image_id,
      software_id,
      source_server_id,
      availability_zone,
      hostname,
      project_id,
      bandwidth,
      floating_ip_id,
      configuration,
      local_network,
    ]
  }
}

# IPv4 — только новому серверу: у живых адрес уже есть (и висит в DNS).
# Timeweb выдаёт адрес, если на балансе не меньше ~5440 ₽ (abuse_prepayment_required).
resource "twc_server_ip" "ipv4" {
  for_each = {
    for k, s in local.servers : k => s
    if s.ipv4 && !contains(keys(local.existing), k)
  }

  source_server_id = twc_server.this[each.key].id
  type             = "ipv4"

  lifecycle {
    prevent_destroy = true
  }
}
