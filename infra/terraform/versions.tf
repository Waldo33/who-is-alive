# Серверы «Массовки» в Timeweb Cloud — описание в коде (docs/terraform.md).
# Terraform отвечает за сами машины (тариф, имя, ОС при создании, IPv4); что стоит внутри —
# infra/game (выкладка game-deploy), дальше — Ansible.
terraform {
  # import с for_each — с 1.7
  required_version = ">= 1.7.0"

  required_providers {
    twc = {
      source  = "timeweb-cloud/timeweb-cloud"
      version = "1.8.4"
    }
  }
}

# токен — из переменной окружения TWC_TOKEN (секрет GitHub), в коде его нет
provider "twc" {}
