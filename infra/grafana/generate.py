# Дашборды Grafana генерируются этим скриптом: python3 infra/grafana/generate.py (из корня репозитория)
import json
PG={"type":"grafana-postgresql-datasource","uid":"pg"}
VM={"type":"prometheus","uid":"vm"}
VL={"type":"victoriametrics-logs-datasource","uid":"vl"}
def grid(x,y,w,h): return {"x":x,"y":y,"w":w,"h":h}
pid=[0]
def nid():
    pid[0]+=1; return pid[0]
def sql(sql, fmt="table"): return {"datasource":PG,"refId":"A","rawQuery":True,"editorMode":"code","format":fmt,"rawSql":sql}
def stat(title,q,pos,unit="none",desc=""):
    return {"id":nid(),"type":"stat","title":title,"description":desc,"gridPos":pos,"datasource":PG,"targets":[sql(q)],
            "options":{"reduceOptions":{"calcs":["lastNotNull"],"fields":"","values":False},"colorMode":"none","graphMode":"none","textMode":"value"},
            "fieldConfig":{"defaults":{"unit":unit,"decimals":0},"overrides":[]}}
def ts_sql(title,q,pos,desc="",stack=False):
    return {"id":nid(),"type":"timeseries","title":title,"description":desc,"gridPos":pos,"datasource":PG,"targets":[sql(q,"time_series")],
            "fieldConfig":{"defaults":{"custom":{"drawStyle":"bars","fillOpacity":60,"barAlignment":0,"stacking":{"mode":"normal" if stack else "none"}},"decimals":0},"overrides":[]},
            "options":{"legend":{"displayMode":"list","placement":"bottom"},"tooltip":{"mode":"multi"}}}
def bars(title,q,pos,desc="",unit="none"):
    return {"id":nid(),"type":"bargauge","title":title,"description":desc,"gridPos":pos,"datasource":PG,"targets":[sql(q)],
            "options":{"orientation":"horizontal","displayMode":"basic","showUnfilled":True,"reduceOptions":{"calcs":["lastNotNull"],"fields":"","values":True},"valueMode":"text","namePlacement":"left","sizing":"auto"},
            "fieldConfig":{"defaults":{"unit":unit,"decimals":0,"color":{"mode":"continuous-BlPu"}},"overrides":[]}}
def table(title,q,pos,desc=""):
    return {"id":nid(),"type":"table","title":title,"description":desc,"gridPos":pos,"datasource":PG,"targets":[sql(q)],"options":{"showHeader":True},"fieldConfig":{"defaults":{},"overrides":[]}}
R="$__timeFilter(created_at)"
HOST="(props->>'host')::boolean is true"
# часовые пояса России: при зарубежном адресе — «скорее всего VPN»
RU_TZ=",".join(f"'{z}'" for z in ["Europe/Moscow","Europe/Kaliningrad","Europe/Samara","Europe/Volgograd","Europe/Kirov","Europe/Astrakhan","Europe/Saratov","Europe/Ulyanovsk","Asia/Yekaterinburg","Asia/Omsk","Asia/Novosibirsk","Asia/Barnaul","Asia/Tomsk","Asia/Novokuznetsk","Asia/Krasnoyarsk","Asia/Irkutsk","Asia/Chita","Asia/Yakutsk","Asia/Khandyga","Asia/Vladivostok","Asia/Ust-Nera","Asia/Magadan","Asia/Sakhalin","Asia/Srednekolymsk","Asia/Kamchatka","Asia/Anadyr"])
product=[
 stat("Игроков (устройств)",f"select count(distinct device_id) from analytics_events where {R}",grid(0,0,4,4)),
 stat("Новых игроков",f"select count(*) from (select device_id, min(created_at) f from analytics_events group by 1) d where $__timeFilter(f)",grid(4,0,4,4),desc="Устройства, впервые зашедшие в выбранный период"),
 stat("Матчей начато",f"select count(*) from analytics_events where name='match_start' and {HOST} and {R}",grid(8,0,4,4),desc="Считается у режиссёра, чтобы не умножать на игроков"),
 stat("Матчей доиграно",f"select count(*) from analytics_events where name='match_end' and {HOST} and {R}",grid(12,0,4,4)),
 stat("Комнат создано",f"select count(*) from analytics_events where name='room_create' and {R}",grid(16,0,4,4)),
 stat("Поделились",f"select count(*) from analytics_events where name in ('share','clip_send','invite') and {R}",grid(20,0,4,4),desc="Приглашения, клипы, карточки"),
 ts_sql("Игроки по дням",f"select $__timeGroupAlias(created_at,1d), count(distinct device_id) as \"игроки\", count(distinct device_id) filter (where name in ('match_start')) as \"играли матч\" from analytics_events where {R} group by 1 order by 1",grid(0,4,12,8)),
 ts_sql("Матчи по дням",f"select $__timeGroupAlias(created_at,1d), count(*) filter (where name='match_start' and {HOST}) as \"начато\", count(*) filter (where name='match_end' and {HOST}) as \"доиграно\", count(*) filter (where name='match_exit') as \"вышли посреди\" from analytics_events where {R} group by 1 order by 1",grid(12,4,12,8)),
 bars("Воронка (устройства за период)",f"""select шаг, n from (with e as (select device_id, name, props from analytics_events where {R})
select 'Зашли' as шаг, count(distinct device_id) as n, 1 as o from e
union all select 'Начали обучение', count(distinct device_id), 2 from e where name='tutorial_start'
union all select 'В комнате', count(distinct device_id), 3 from e where name in ('room_create','room_join')
union all select 'Позвали друзей', count(distinct device_id), 4 from e where name in ('invite','invite_tap','invite_create')
union all select 'Матч начат', count(distinct device_id), 5 from e where name='match_start'
union all select 'Матч доигран', count(distinct device_id), 6 from e where name='match_end'
union all select 'Ещё матч', count(distinct device_id), 7 from e where name='rematch'
union all select 'Поделились клипом', count(distinct device_id), 8 from e where name in ('clip_send','share')
) f order by o""",grid(0,12,12,10),desc="Сколько устройств дошли до шага (шаг мог быть и без предыдущего)"),
 bars("Откуда пришли (первый источник)",f"""select coalesce(nullif(src0,''),'—') as источник, count(*) as n from (
  select distinct on (device_id) device_id, props->>'src0' as src0 from analytics_events where {R} order by device_id, created_at) d
group by 1 order by 2 desc limit 12""",grid(12,12,6,10),desc="src0: метка ?src= в первой ссылке, ref — с другого сайта, direct — напрямую"),
 bars("Где играют",f"""select coalesce(props->>'app', props->>'br', '—') as где, count(distinct device_id) n from analytics_events where {R} group by 1 order by 2 desc limit 10""",grid(18,12,6,10)),
 bars("Как кончаются дубли",f"""select coalesce(props->>'reason','—') as причина, count(*) n from analytics_events where name='round_end' and {HOST} and {R} group by 1 order by 2 desc""",grid(0,22,8,8),desc="stars — три звезды, time — время вышло, last — остался один…"),
 bars("Обвинения игроков",f"""select case props->>'accused' when 'right' then 'угадал' when 'wrong' then 'ошибся' else 'не обвинял' end as обвинение, count(*) n from analytics_events where name='round_end' and {R} group by 1 order by 2 desc""",grid(8,22,8,8)),
 table("Дубль в среднем (на игрока)",f"""select round(avg((props->>'kill')::numeric),2) as "выбил", round(avg((props->>'stars')::numeric),2) as "звёзды", round(100.0*avg(((props->>'alive')::boolean)::int),0) as "выжил, %", round(100.0*avg(((props->>'caught')::boolean)::int),0) as "раскрыт, %", count(*) as "дублей"
from analytics_events where name='round_end' and {R}""",grid(16,22,8,8)),
 table("Возвраты по дню первого входа",f"""with f as (select device_id, min(created_at)::date d0 from analytics_events group by 1),
a as (select distinct device_id, created_at::date d from analytics_events)
select f.d0 as "первый день", count(distinct f.device_id) as "новых",
 count(distinct a.device_id) filter (where a.d = f.d0 + 1) as "вернулись на 2-й день",
 count(distinct a.device_id) filter (where a.d between f.d0 + 2 and f.d0 + 7) as "вернулись за неделю"
from f left join a on a.device_id = f.device_id where $__timeFilter(f.d0::timestamptz) group by 1 order by 1 desc""",grid(0,30,12,9)),
 table("Ошибки входа в комнату",f"""select coalesce(props->>'error','—') as ошибка, count(*) as раз from analytics_events where name in ('room_error','room_create_fail') and {R} group by 1 order by 2 desc""",grid(12,30,12,9)),
 stat("Выключили звук, % игроков",f"""select round(100.0*count(distinct device_id) filter (where name='sound_toggle' and props->>'on'='false' and props->>'what' in ('sfx','music'))
 / nullif(count(distinct device_id) filter (where name='match_start'),0),0) from analytics_events where {R}""",grid(0,39,6,8),unit="percent",
  desc="Из игравших матч — сколько выключили музыку или звуки в шестерёнке. Больше 25% — звук раздражает (план звука)"),
 bars("Что выключают",f"""select (props->>'what') || case when props ? 'mode' then ': ' || (props->>'mode') else case when (props->>'on')::boolean then ' вкл' else ' выкл' end end as что,
 count(*) n from analytics_events where name='sound_toggle' and {R} group by 1 order by 2 desc""",grid(6,39,9,8),desc="sfx — звуки, music — музыка, room_music — режиссёр выбрал «Музыку в дубле», own_music — гость вернул музыку себе"),
 bars("Кто вырезал",f"""select case props->>'out' when 'director' then 'режиссёр (пропустил команду)' when 'player' then 'игрок' else 'не вырезали' end as кто, count(*) n
 from analytics_events where name='round_end' and props ? 'out' and {R} group by 1 order by 2 desc""",grid(15,39,9,8),desc="Режиссёр вырезает за пропущенную команду «Море волнуется» («Жёсткий дубль»): растёт — сигнал не слышат"),
 table("Доступность серверов: Москва и Европа (замер net_probe)",f"""with p as (select device_id, props, case when props->>'cc'='RU' then 'Россия без VPN'
   when props->>'tz' = any(array[{RU_TZ}]) then 'Россия, скорее всего VPN' when props->>'cc' is null then 'страна неизвестна' else 'из-за границы' end as кто
   from analytics_events where name='net_probe' and {R})
 select кто, count(distinct device_id) as телефонов,
  round(100.0*avg((props->>'msk_http')::int)) as "Москва: HTTPS %", round(100.0*avg((props->>'msk_big')::int)) as "Москва: 64 КБ %", round(100.0*avg((props->>'msk_ws')::int)) as "Москва: WS %",
  round(100.0*avg((props->>'eu_http')::int)) as "Европа: HTTPS %", round(100.0*avg((props->>'eu_big')::int)) as "Европа: 64 КБ %", round(100.0*avg((props->>'eu_ws')::int)) as "Европа: WS %",
  percentile_cont(0.5) within group (order by (props->>'msk_http_ms')::int) as "Москва, мс", percentile_cont(0.5) within group (order by (props->>'eu_http_ms')::int) as "Европа, мс"
 from p group by 1 order by 2 desc""",grid(0,47,24,8),
  desc="Раз в сутки телефон пробует оба сервера (lib/netprobe.ts). Развилка этапа 3: Европа отвечает ≥ 95% игроков «Россия без VPN» — российский вход не нужен. «64 КБ» ловит фильтр, глушащий соединение после 16 КБ. Страна — по адресу (DB-IP Lite, CC BY 4.0, db-ip.com)"),
]
def dash(uid,title,panels,frm="now-7d",extra=None):
    d={"uid":uid,"title":title,"tags":["massovka"],"timezone":"browser","schemaVersion":39,"version":1,"editable":False,
       "time":{"from":frm,"to":"now"},"refresh":"","panels":panels,"templating":{"list":[]},"annotations":{"list":[]}}
    if extra: d.update(extra)
    return d
pid[0]=0
def ts_vm(title,exprs,pos,unit="none",desc=""):
    return {"id":nid(),"type":"timeseries","title":title,"description":desc,"gridPos":pos,"datasource":VM,
            "targets":[{"datasource":VM,"refId":chr(65+i),"expr":e,"legendFormat":l} for i,(e,l) in enumerate(exprs)],
            "fieldConfig":{"defaults":{"unit":unit,"custom":{"fillOpacity":10}},"overrides":[]},"options":{"legend":{"displayMode":"list","placement":"bottom"},"tooltip":{"mode":"multi"}}}
def stat_vm(title,expr,pos,unit="none"):
    return {"id":nid(),"type":"stat","title":title,"gridPos":pos,"datasource":VM,"targets":[{"datasource":VM,"refId":"A","expr":expr}],
            "options":{"reduceOptions":{"calcs":["lastNotNull"],"fields":"","values":False},"colorMode":"value","graphMode":"area"},"fieldConfig":{"defaults":{"unit":unit},"overrides":[]}}
tech=[
 stat_vm("Игроков онлайн",'sum(game_players_online{server="eu"})',grid(0,0,6,4)),
 stat_vm("Комнат",'sum(game_rooms{server="eu"})',grid(6,0,6,4)),
 stat_vm("Идут матчи",'sum(game_rooms_playing{server="eu"})',grid(12,0,6,4)),
 stat_vm("Шаг матча, p99",'max(game_step_ms_p99{server="eu"})',grid(18,0,6,4),unit="ms"),
 ts_vm("Онлайн и комнаты",[('game_players_online{server="eu"}','игроки'),('game_rooms{server="eu"}','комнаты'),('game_rooms_playing{server="eu"}','матчи'),('game_connections{server="eu"}','соединения'),('max(game_rooms_limit{server="eu"})','потолок комнат')],grid(0,4,12,8)),
 ts_vm("Шаг матча, p99 (норма < 1 мс, тревога — 20, бюджет — 50)",[('game_step_ms_p99{server="eu"}','мс')],grid(12,4,12,8),unit="ms"),
 ts_vm("Процессор",[('100 - avg by (server) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100','{{server}}')],grid(0,12,8,8),unit="percent"),
 ts_vm("Память",[('(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100','{{server}}')],grid(8,12,8,8),unit="percent"),
 ts_vm("Диск /",[('(1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) * 100','{{server}}')],grid(16,12,8,8),unit="percent"),
 ts_vm("Сеть",[('sum by (server) (rate(node_network_receive_bytes_total{device!~"lo"}[5m]))','{{server}} приём'),('sum by (server) (rate(node_network_transmit_bytes_total{device!~"lo"}[5m]))','{{server}} отдача')],grid(0,20,12,8),unit="Bps"),
 ts_vm("Связь с источниками метрик (1 — есть)",[('up','{{server}} {{job}}')],grid(12,20,12,8),desc="eu через туннель: пропадает, если туннель Нидерланды → Европа упал"),
 ts_vm("Место под клипы Telegram (Европа; лимит 1 ГБ, тревога на 80%)",[('game_clips_bytes{server="eu"}','занято'),('game_clips_limit_bytes{server="eu"}','лимит')],grid(0,28,12,8),unit="bytes",
       desc="Клипы хранятся 2 суток, при лимите старые вытесняются. Упирается в лимит раньше двух суток — пора переносить на S3"),
 ts_vm("Клипов в хранилище",[('game_clips_count{server="eu"}','клипов')],grid(12,28,12,8)),
 ts_vm("Ошибки JS на телефонах (за 10 минут; тревога — больше 30)",[('sum(increase(game_client_errors_total{server="eu"}[10m]))','ошибки')],grid(0,36,10,10),
       desc="lib/errors.ts на сайте: исключения и непойманные обещания, не больше 10 разных за заход. Скачок после выкладки — откатывать"),
 {"id":nid(),"type":"logs","title":"Ошибки JS на телефонах (последние)","gridPos":grid(10,36,14,10),"datasource":VL,
  "description":"error — текст, at — место в коде (по картам исходников), fp — группа в панели «Массовка — ошибки», build — версия сайта, ua — браузер, path — страница",
  "targets":[{"datasource":VL,"refId":"A","expr":'_msg:client_error',"queryType":"instant"}],
  "options":{"showTime":True,"wrapLogMessage":True,"sortOrder":"Descending","enableLogDetails":True}},
 {"id":nid(),"type":"logs","title":"Ошибки в логах обоих серверов","gridPos":grid(0,46,24,12),"datasource":VL,
  "targets":[{"datasource":VL,"refId":"A","expr":'(level:error OR level:warn OR _msg:~"(?i)error|fail") -_SYSTEMD_UNIT:"massovka-watch.service" -_msg:client_error',"queryType":"instant"}],
  "options":{"showTime":True,"wrapLogMessage":True,"sortOrder":"Descending","enableLogDetails":True}},
]
pid[0]=0
# трекер ошибок (apps/server/src/errors.ts): группы в error_groups, случаи по дням в error_daily
SRC="case g.source when 'web' then 'телефоны' when 'server' then 'сервер' when 'bot' then 'бот' when 'film' then 'монтаж' else g.source end"
FP_LINK=[{"title":"Подробно","url":"/grafana/d/massovka-errors/?var-fp=${__data.fields.fp}&${__url_time_range}"}]
def link_fp(p):
    p["fieldConfig"]["overrides"].append({"matcher":{"id":"byName","options":"fp"},"properties":[{"id":"links","value":FP_LINK}]})
    p["fieldConfig"]["overrides"].append({"matcher":{"id":"byName","options":"ошибка"},"properties":[{"id":"links","value":FP_LINK},{"id":"custom.width","value":520}]})
    return p
errors=[
 stat("Новых ошибок",f"select count(*) from error_groups where $__timeFilter(first_seen)",grid(0,0,6,4),desc="Групп, впервые встреченных в выбранный период: про каждую сторож написал в чат тревог"),
 stat("Случаев",f"select coalesce(sum(d.count),0) from error_daily d where $__timeFilter(d.day::timestamptz)",grid(6,0,6,4),desc="С телефона одна и та же ошибка считается один раз за заход"),
 stat("Групп было",f"select count(*) from error_groups where $__timeFilter(last_seen)",grid(12,0,6,4)),
 stat("Вернулись после недели тишины",f"select count(*) from error_groups where $__timeFilter(reopened_at)",grid(18,0,6,4)),
 ts_sql("Случаи по дням",f"""select d.day::timestamptz as time, {SRC} as metric, sum(d.count) as value
 from error_daily d join error_groups g using (fp) where $__timeFilter(d.day::timestamptz) group by 1, 2 order by 1""",grid(0,4,24,7),stack=True),
 link_fp(table("Ошибки (новые сверху; нажмите — подробности ниже)",f"""select {SRC} as откуда, g.title as ошибка, g.culprit as где, g.count as всего,
 coalesce((select sum(d.count) from error_daily d where d.fp = g.fp and $__timeFilter(d.day::timestamptz)), 0) as "за период",
 g.first_seen as впервые, g.last_seen as "в последний раз", g.last_build as версия,
 (select string_agg(k || ' ' || v, ', ' order by v::bigint desc) from (select k, v from jsonb_each_text(g.tags) as t(k, v) order by v::bigint desc limit 4) x) as "чаще всего",
 g.fp
 from error_groups g where $__timeFilter(g.last_seen) order by g.first_seen desc limit 200""",grid(0,11,24,12),
  desc="Группа — одна и та же ошибка в одном месте кода (без строк и версий). «Где» — файл › функция по картам исходников. «Чаще всего» — платформа, тема, фаза")),
 table("Подробно: последний случай выбранной ошибки",f"""select k as поле, v as значение from (
  select 1 o, 'ошибка' k, g.title v from error_groups g where g.fp = '$fp'
  union all select 2, 'где', g.culprit from error_groups g where g.fp = '$fp'
  union all select 3, 'контекст', (select string_agg(key || ': ' || value, ' · ') from jsonb_each_text(g.sample->'ctx')) from error_groups g where g.fp = '$fp'
  union all select 4, 'шаги перед ошибкой', (select string_agg(x, '  →  ') from jsonb_array_elements_text(g.sample->'crumbs') x) from error_groups g where g.fp = '$fp'
  union all select 5, 'стек', g.sample->>'stack' from error_groups g where g.fp = '$fp'
  union all select 6, 'разбивка', (select string_agg(key || ' ' || value, ', ' order by value::bigint desc) from jsonb_each_text(g.tags)) from error_groups g where g.fp = '$fp'
  union all select 7, 'версии', g.first_build || ' → ' || g.last_build from error_groups g where g.fp = '$fp'
 ) r order by o""",grid(0,23,24,14),desc="Выберите ошибку в таблице выше (или вставьте fp в поле сверху)"),
 {"id":nid(),"type":"logs","title":"Журнал: эта ошибка с телефонов","gridPos":grid(0,37,24,8),"datasource":VL,
  "targets":[{"datasource":VL,"refId":"A","expr":'_msg:client_error fp:"$fp"',"queryType":"instant"}],
  "options":{"showTime":True,"wrapLogMessage":True,"sortOrder":"Descending","enableLogDetails":True}},
]
for p in errors:
    if p["type"]=="table": p["options"]["cellHeight"]="sm"
errors[6]["fieldConfig"]["defaults"]["custom"]={"cellOptions":{"type":"auto","wrapText":True}}
open('infra/grafana/errors.json','w').write(json.dumps(dash("massovka-errors","Массовка — ошибки",errors,frm="now-7d",
  extra={"templating":{"list":[{"type":"textbox","name":"fp","label":"Ошибка (fp)","query":"","current":{"text":"","value":""}}]}}),ensure_ascii=False,indent=1))
open('infra/grafana/product.json','w').write(json.dumps(dash("massovka-product","Массовка — игроки и матчи",product),ensure_ascii=False,indent=1))
open('infra/grafana/tech.json','w').write(json.dumps(dash("massovka-servers","Массовка — серверы",tech,frm="now-24h",extra={"refresh":"1m"}),ensure_ascii=False,indent=1))
print('ok', len(product), len(tech), len(errors))
