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
 stat_vm("Игроков онлайн",'sum(game_players_online{server="msk"})',grid(0,0,6,4)),
 stat_vm("Комнат",'sum(game_rooms{server="msk"})',grid(6,0,6,4)),
 stat_vm("Идут матчи",'sum(game_rooms_playing{server="msk"})',grid(12,0,6,4)),
 stat_vm("Шаг матча, p99",'max(game_step_ms_p99{server="msk"})',grid(18,0,6,4),unit="ms"),
 ts_vm("Онлайн и комнаты",[('game_players_online{server="msk"}','игроки'),('game_rooms{server="msk"}','комнаты'),('game_rooms_playing{server="msk"}','матчи'),('game_connections{server="msk"}','соединения')],grid(0,4,12,8)),
 ts_vm("Шаг матча, p99 (бюджет — 50 мс)",[('game_step_ms_p99{server="msk"}','мс')],grid(12,4,12,8),unit="ms"),
 ts_vm("Процессор",[('100 - avg by (server) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100','{{server}}')],grid(0,12,8,8),unit="percent"),
 ts_vm("Память",[('(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100','{{server}}')],grid(8,12,8,8),unit="percent"),
 ts_vm("Диск /",[('(1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) * 100','{{server}}')],grid(16,12,8,8),unit="percent"),
 ts_vm("Сеть",[('sum by (server) (rate(node_network_receive_bytes_total{device!~"lo"}[5m]))','{{server}} приём'),('sum by (server) (rate(node_network_transmit_bytes_total{device!~"lo"}[5m]))','{{server}} отдача')],grid(0,20,12,8),unit="Bps"),
 ts_vm("Связь с источниками метрик (1 — есть)",[('up','{{server}} {{job}}')],grid(12,20,12,8),desc="msk через туннель: пропадает, если туннель Нидерланды → Москва упал"),
 ts_vm("Место под клипы Telegram (Москва; лимит 1 ГБ, тревога на 80%)",[('game_clips_bytes{server="msk"}','занято'),('game_clips_limit_bytes{server="msk"}','лимит')],grid(0,28,12,8),unit="bytes",
       desc="Клипы хранятся 2 суток, при лимите старые вытесняются. Упирается в лимит раньше двух суток — пора переносить на S3"),
 ts_vm("Клипов в хранилище",[('game_clips_count{server="msk"}','клипов')],grid(12,28,12,8)),
 {"id":nid(),"type":"logs","title":"Ошибки в логах обоих серверов","gridPos":grid(0,36,24,12),"datasource":VL,
  "targets":[{"datasource":VL,"refId":"A","expr":'(level:error OR level:warn OR _msg:~"(?i)error|fail") -_SYSTEMD_UNIT:"massovka-watch.service"',"queryType":"instant"}],
  "options":{"showTime":True,"wrapLogMessage":True,"sortOrder":"Descending","enableLogDetails":True}},
]
open('infra/grafana/product.json','w').write(json.dumps(dash("massovka-product","Массовка — игроки и матчи",product),ensure_ascii=False,indent=1))
open('infra/grafana/tech.json','w').write(json.dumps(dash("massovka-servers","Массовка — серверы",tech,frm="now-24h",extra={"refresh":"1m"}),ensure_ascii=False,indent=1))
print('ok', len(product), len(tech))
