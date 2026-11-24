# Обе переменные заполняет discover.py перед каждым планом (файл discovered.auto.tfvars.json,
# в репозиторий не попадает): какие серверы уже есть в Timeweb и какой SSH-ключ у выкладки.

variable "existing_servers" {
  description = "Серверы, которые уже есть в Timeweb: имя → id. Их Terraform подхватывает (import), а не создаёт"
  type        = map(string)
  default     = {}
}

variable "ssh_key_ids" {
  description = "id SSH-ключа выкладки (выводится из TWC_TOKEN, как в provision.py) — кладётся только в новый сервер"
  type        = list(number)
  default     = []
}
