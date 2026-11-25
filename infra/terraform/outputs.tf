# Адреса и тарифы — для Ansible (инвентарь) и чтобы видеть в плане, что стоит сейчас
output "servers" {
  value = {
    for k, s in twc_server.this : k => {
      id     = s.id
      name   = s.name
      preset = s.preset_id
      cpu    = s.cpu
      ram    = s.ram
      ipv4   = try(twc_server_ip.ipv4[k].ip, s.main_ipv4)
    }
  }
}

# Бакет для видео: имя (с приставкой Timeweb) и адрес — без ключей (они sensitive и в план не попадают)
output "media_bucket" {
  value = {
    name     = twc_s3_bucket.media.full_name
    hostname = twc_s3_bucket.media.hostname
    location = twc_s3_bucket.media.location
  }
}
