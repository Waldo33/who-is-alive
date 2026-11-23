# CLAUDE.md — контекст для агента

Этот файл — первое, что нужно прочитать перед работой в репозитории. Подробности — в `docs/`:

- `docs/architecture.md` — как устроены ядро, сеть, Supabase, клиент, звук, клип, превью;
- `docs/gotchas.md` — грабли, на которые уже наступали (Safari, Chrome на iPhone, Realtime, iOS-звук…);
- `docs/roadmap.md` — что сделано, что дальше, отложенные решения и что нужно от владельца.
- `docs/infra-plan.md` — план улучшения инфраструктуры: замеры, выкладка без обрыва матчей, S3, переезд игры в Европу, защита от всплеска;
- `docs/server-migration.md` — переезд на свои серверы (Timeweb Cloud: Москва — игра и сайт, Нидерланды — бот и наблюдение; как сделано — раздел 12).

Язык проекта — **русский**: комментарии в коде, сообщения коммитов, общение с владельцем. Владелец не программист в этом проекте: формулирует задачи как игрок («у друга лагает», «не успеваю нажать»), часто тестирует с iPhone (Safari и Chrome) и пишет прямо из приложения Claude на телефоне. Делай всё сам до конца, проверяй и коротко отчитывайся, что изменилось для игрока.

## Что это

**«Массовка» / «Be Nobody»** (раньше — «Кто тут живой?») — браузерная реалтайм-игра для компании, 2–4 игрока, только телефоны. Тон текстов — съёмочная площадка: раунд — «дубль», выбывший «вырезан» и «за кадром», хост — «режиссёр»; по-английски — extra / actor. Фразы с именами игроков — без падежей и рода (имена бывают любыми). Полный список — Claude Doc «Массовка / Be Nobody — текстовки».
На пиксельной площади 32 одинаковых человечка: почти все — боты, остальные — игроки. Каждый прячется в толпе, вычисляет живых по поведению и бьёт первым. Удар по живому — выбил, по боту — сам оглушён и раскрыт. Три звезды — победа в раунде. «Море волнуется»: музыка обрывается, мир замирает (стоп-кадр), надо нажать ту же команду, что и толпа. В конце раунда — обвинение («кто тут живой?»), разоблачение с повтором, награды. Матч до 8 очков (~5 минут).

- Прод: **https://benobody.app** (песочница с ботами — `/sandbox`, комната — `/r/КОД`); старый адрес who-is-alive.vercel.app перенаправляет туда.
- Репозиторий: `Waldo33/who-is-alive` (приватный), ветка `main`; **каждый push в `main` сразу выкатывается в прод** из GitHub Actions: `web-deploy` (сайт), `game-deploy` (игровой сервер).
- ТЗ — Claude Doc «Кто тут живой? — ТЗ для разработки». При расхождении прав код и `docs/`; ТЗ обновляет владелец.
- Художника и композитора нет: **весь арт и звук делаются кодом** (процедурные спрайты из палитры, синтез на Web Audio).

## Стек

- Монорепо **pnpm 10.18.3**, Node 22, TypeScript 5.9 strict, ESLint 9 (flat config в корне), Vitest 3.
- `apps/web` — **Next.js 15.5** (App Router, React 19) + **Phaser 3.90**. Работает на своём сервере (Next standalone за Caddy, `.github/workflows/web-deploy.yml`, `infra/game/web.sh`). Vercel (проект `who-is-alive`, `prj_J1ZWu5Ncozw0FtcgTVoQGQFLrUNm`, команда `team_KRSpd6ofFYaA171W5rl60kY7`) — только перенаправление старого адреса (`redirects` в `next.config.ts` при `VERCEL`, пересборка лишь при изменении `next.config.ts`).
- **Свой игровой сервер** `apps/server` (Timeweb Cloud, Москва, `https://api.benobody.app`, с 22.11.2026): комнаты, лобби и матчи для всех — матч считает сервер, у всех игроков `RemoteSession` поверх `ServerLink`. Выкладка — `.github/workflows/game-deploy.yml` на каждый push в `apps/server`, `packages/*`, `infra/game` (живой прогон четырёх игроков в конце). Адрес для клиента — `GAME_API` в `apps/web/src/lib/env.ts`.
- **Два своих сервера** (Timeweb Cloud, всё ставит `game-deploy` по SSH, ключ выводится из `TWC_TOKEN`):
  - **Москва** `massovka-game` (1 vCPU / 1 ГБ, `129.101.104.99`): игровой сервер (`api.benobody.app`), сайт (`benobody.app`), Postgres (аналитика `analytics_events`), Caddy с сертификатами, копия базы раз в сутки.
  - **Нидерланды** `massovka-infra` (1 vCPU / 2 ГБ, `72.56.73.184`, `72-56-73-184.sslip.io`): Telegram-бот (`apps/server/src/bot.ts`, из Москвы `api.telegram.org` закрыт), сторож с тревогами в Telegram (`infra/game/watch.sh`), наблюдение (`infra/game/observe.sh`): VictoriaMetrics, VictoriaLogs, **Grafana** — `https://72-56-73-184.sslip.io/grafana/` (логин `admin`, пароль — секрет `GRAFANA_PASSWORD`; панели — `infra/grafana/generate.py`), ночная копия базы Москвы.
  - Связь: соединения Москва → Нидерланды режет фильтр, поэтому **туннель SSH поднимают Нидерланды** (`massovka-tunnel`): бот, логи Москвы сюда; база, метрики Москвы оттуда. `/tg/*` на `api.benobody.app` идёт через него.
  - Секреты рождаются на сервере (`/etc/massovka/secrets.env`, папка закрыта — настройки служб лежат отдельно) или приходят из GitHub Secrets (`TWC_TOKEN`, `TELEGRAM_BOT_TOKEN`, `ALERTS_BOT_TOKEN`, `GRAFANA_PASSWORD`) файлами по SSH — не в командной строке.
- **Supabase** (ref `wivildtgfkpuxvqoamqg`, Франкфурт) — больше не используется: там остались старые таблицы комнат, рейтинг кастинга и аналитика до 23.11 (`supabase/` — история). Сервисных ключей в репозитории нет и быть не должно.
- `packages/game-core` — правила игры, чистый детерминированный TS.
- `packages/net` — сетевой слой: транспорт, хост, гость, протокол (zod).
- `packages/assets` — палитра 32 цвета `PAL`, `PLAYER_COLORS`.

## Команды

```bash
pnpm install
pnpm dev                              # http://localhost:3000 (песочница: /sandbox)
pnpm lint && pnpm typecheck && pnpm test   # то же, что CI
pnpm sim -- --rounds 1000             # безголовая симуляция с проверкой инвариантов
pnpm --filter web build               # прод-сборка Next.js — гонять перед каждым push
pnpm --filter @kto/server dev        # игровой сервер локально (без базы — аналитика в памяти)
pnpm --filter @kto/server smoke https://api.benobody.app   # живой прогон 4 игроков против сервера
pnpm --filter web icons               # перерисовать иконки PWA из спрайтов (нужен Playwright)
pnpm --filter web og-bg               # фоны превью ссылок по темам: apps/web/assets/og/bg-N.png
pnpm --filter web clip-preview <папка> 11,12 [тема]   # кадры клипа «Лучший момент» по зернам — проверить глазами
pnpm --filter web theme-sheet 4 out.png          # лист темы ×8: костюм, свои позы, иконки команд
pnpm --filter web theme-video 4 out.mp4          # видео дубля в теме со звуком (нужен запущенный сайт на :3124 и ffmpeg)
pnpm --filter web clip-video 12 out.webm 4       # клип «Лучший момент» со звуком — как его выгрузит игрок
pnpm --filter web film-preview <папка> 12 [тема]  # кадры «Фильма матча» (целый матч с ИИ)
pnpm --filter web standalone          # песочница одним HTML-файлом: apps/web/dist/sandbox.html
```

Песочница: `?dev` — панель конфига, `?dev&speed=8` — ускорение времени, `?dev&theme=4` — все дубли в одной теме, в консоли `window.__kto` (сцена: `__kto.game.scene.getScene('game')`), `?lang=en`.

CI (`.github/workflows/ci.yml`): lint, typecheck, test, `sim --rounds 200`.

## Правила, которые нельзя нарушать

1. **`game-core` чистый**: без Phaser, DOM, `window`, сети, `Math.random()`, `Date.now()` — только `Rng` с зерном и игровое время. Одно зерно → один и тот же матч.
2. **Никто, кроме хоста, не знает, какие сущности — игроки** (кроме себя). Команды ботов и игроков одного формата; в `hit` по игроку нет `attacker` (единственное исключение — решение владельца: изнанка темы с `exposeKiller`, ночь Майами, где убийца замахивается оружием на глазах у всех; `killerExposed` в `themes.ts`); связь игрок↔сущность приходит только личным сообщением (своя) и в итогах раунда. Это проверяет `packages/net/test/netplay.test.ts`. Любое новое сетевое поле проверяй на утечку.
3. **Пиксели**: только целочисленный масштаб (`integerZoom` в `boot.ts`), `pixelArt`, `roundPixels`, без сглаживания; цвета только из `PAL`. На canvas вне Phaser (клип, карточка) — `imageSmoothingEnabled = false` и **целые кегли** (см. `art.ts › text`).
4. **Тексты — только в словарях** `packages/game-core/src/locale/{ru,en}.ts` (одна структура, тип `Dict`). Строки на canvas ≤ 21 символа — проверяет `test/i18n.test.ts`; добавляешь строку для canvas — добавь и в тест.
5. **Мобильный веб**: экраны помещаются без прокрутки (решение владельца) — на iPhone SE и внутри Telegram с его шапкой; не влезает — сжимай поле и второстепенное, а не листай. Не ломать защиту от зума (`touch-action`, поля ≥ 16px, гашение двойного тапа и щипка в `shell.ts`), разблокировку звука по `touchend`/`click`, безопасные зоны (`env(safe-area-inset-*)`). Системное меню «Поделиться» вызывать только из свежего жеста (`pointerup`/`click`, не `pointerdown`).
6. Phaser импортировать как `import * as Phaser from 'phaser'` (иначе ломается прод-сборка Next).
7. Не ломать песочницу `/sandbox` — она работает без сети и без сервера.
8. Перед push: `pnpm lint && pnpm typecheck && pnpm test` и `pnpm --filter web build`. Изменил игру — пройди матч в браузере (Playwright, см. ниже). Как коммитить и пушить — раздел «Коммиты и push» ниже.
9. База своего сервера: схема — `MIGRATIONS` в `apps/server/src/store.ts`, только расширяющие изменения (сервер применяет при старте). Supabase — только для бота: миграции там — файл в `supabase/migrations/` и `apply_migration`.

## Коммиты и push

- **Работаем прямо в `main`**, без веток и PR — так договорились с владельцем. Push в `main` = прод через минуту-две. Ветку делай, только если владелец попросил или нужен предпросмотр рискованной правки (Vercel собирает превью по веткам).
- **Автор коммитов — `waldo <evgenijtser@gmail.com>`** (договорённость с владельцем). В новой среде сначала: `git config user.name waldo && git config user.email evgenijtser@gmail.com`. Если окружение (хук, инструкция) требует другого автора — не переписывай уже сделанные коммиты молча: скажи владельцу и делай, как он решит.
- **Сообщение — на русском:**
  - первая строка — что изменилось (для игрока или проекта), до ~70 символов;
  - пустая строка, тело — зачем и как, коротко;
  - в конце — трейлеры атрибуции, если их требует окружение (сейчас `Co-Authored-By: Claude …` и `Claude-Session: …`); свои не придумывай.
- **Один коммит — одна законченная мысль**: не смешивай фичу со случайными правками. Пушь только законченное и проверенное, «посмотреть» — скриншотом или видео, не продом.
- **Порядок перед push:**
  1. `pnpm lint && pnpm typecheck && pnpm test` и `pnpm --filter web build`; правил игру — матч в Playwright.
  2. Есть миграция Supabase — сначала применить её к проекту (MCP `apply_migration`), потом push клиента, который на неё опирается: иначе прод на минуты сломан.
  3. Миграции — только совместимые со старым клиентом: открытые вкладки и PWA живут на старой версии.
- **Не коммитить:**
  - секреты и `.env*`;
  - `node_modules`, `.next`, `dist`;
  - скриншоты, видео и черновики проверок — они живут в scratchpad, не в репозитории.
  - Сгенерированные ассеты (иконки, `apps/web/assets/og/bg-N.png`) коммитить можно, но по `git status` проверь, что старые файлы не поменялись случайно.
- **Никогда:** `git push --force`, переписывание истории `main`, `--amend` или rebase уже запушенного, `--no-verify`. Ошибку исправляй новым коммитом или `git revert`.
- **После push:**
  - GitHub Actions: `web-deploy` и `game-deploy` зелёные (`gh run list`); `game-deploy` в конце гоняет живой прогон четырёх игроков;
  - `ERROR` — читай логи сборки и чини следующим коммитом сразу, не оставляй прод сломанным;
  - CI в GitHub Actions тоже должен быть зелёным (`gh run list`).
  - Владельцу после деплоя — совет закрыть и заново открыть страницу или PWA: вкладка может держать старую версию.
- **Push не прошёл** (нет доступа, отказ) — скажи владельцу, не обходи другим путём.

## Карта кода

| Где | Что |
|---|---|
| `packages/game-core/src/config.ts` | все числа баланса (`DEFAULT_CONFIG`, `makeConfig`) |
| `…/mods.ts` | «Условия съёмки» дубля (`ROUND_MODS`, индекс уходит в сеть) — жёсткий дубль, один удар, звездопад, шквал команд |
| `…/themes.ts` | реестр тем (`THEME_RULES`, индекс уходит в сеть) и их правила: изнанка (`twist`), эмоция толпы в ней |
| `…/match.ts` | `MatchSim` — авторитетный матч: фазы, намерения (`Intent`), удары, звёзды, «Море волнуется», очки, итоги; `LAG_GRACE_MS` |
| `…/world.ts` | `World` — воспроизводимое состояние, шаг 50 мс, события с `at`, ключевые кадры, `makeReplay`, `filter` |
| `…/events.ts` | `WorldEvent` — всё видимое на поле |
| `…/bots.ts`, `ai.ts` | мозг ботов (+ «чудачества»), ИИ-игроки песочницы |
| `…/session.ts` | `ClientView`/`ClientSession`, `LocalSession` (песочница), `createLocalSession` |
| `…/moments.ts` | поиск «лучшего момента» для клипа, `recordRound` |
| `…/locale/` | словари ru/en, `tp()` (множественное число), `fmt()`, `pickLang()` |
| `packages/net/src/transport.ts` | интерфейс `Transport`, `LoopbackHub` (петля в памяти для тестов) |
| `…/wire.ts`, `ws.ts` | протокол своего сервера и `ServerLink` — клиент (лобби + транспорт игры на одном WebSocket) |
| `…/host.ts`, `remote.ts` | `HostSession` (оборачивает `MatchSim`), `RemoteSession` (гость: прогноз и сверка) |
| `…/protocol.ts` | типы сообщений и zod-схемы того, что гость шлёт хосту |
| `apps/web/src/net/room.ts` | `Room`: комната на игровом сервере — вход, состав, «Готов», старт, зритель (опоздал к матчу); `lib/game-server.ts` — анонимный вход (`kto:auth2`), создание комнаты, информация о комнате для превью |
| `apps/web/src/app/` | страницы: `/` (`HomeClient`), `/r/[code]` (`RoomClient`: лобби + игра), `/sandbox`; превью ссылок `og.tsx` + маршрут `og/route.tsx` (язык отправителя из `?l=`); `manifest.ts`, `PwaRegister.tsx` |
| `apps/web/src/game/scene.ts` | сцена Phaser (~1400 строк): рендер, HUD, оверлеи фаз, ввод, музыка по фазам |
| `…/game/themes/` | пакеты тем («площадки»): облик толпы, локация, музыка; каждый — свой файл, грузится по требованию (`index.ts › loadTheme`, до старта игры — `loadAllThemes`). Парк — в `sprites.ts`. Новая тема на заданный сеттинг — скилл `.claude/skills/new-theme/SKILL.md` |
| `…/game/sprites.ts`, `art.ts`, `frames.ts`, `pixels.ts`, `font.ts` | процедурный арт, битмап-шрифт, выбор кадра персонажа |
| `…/game/audio.ts`, `music.ts` | звук: `getAudio()` (один на приложение), эффекты, музыкальный секвенсор |
| `…/game/clip.ts`, `film.ts`, `clip-ui.ts`, `card.ts` | клип выбывшего и куски фильма (вёрстка под ленты, подсветка героя и врагов, QR), «Фильм матча» (крючок → 3 момента → титры), экраны монтажа, карточка результата. Без DOM (фабрика холстов `pixels.ts`, звук `clip-audio.ts` + `sfx.ts`) — тот же код рисует фильм на сервере |
| `…/game/shell.ts`, `boot.ts` | оболочка песочницы, запуск Phaser |
| `…/game/tutorial.ts`, `apps/web/src/ui/TutorialStage.tsx`, `/learn` | «Пробный дубль» — обучение действием (сценарий поверх песочницы без ИИ) |
| `apps/web/src/ui/topbar.ts` | верхняя панель «< Назад» + шестерёнка (язык, музыка, звуки, «Как играть») |
| `apps/web/src/lib/` | `telegram` (Telegram Mini App: SDK, полный экран, родные «Назад», вибрация, ссылки `startapp`, `docs/architecture.md › 4.1`), `features` (флаги фич: `featureOn('casting')` — «Кастинг дня» спрятан), `analytics` (`track` — события воронки на свой сервер, `POST /v1/events`), `share` (поделиться с запасными путями, `withLang` — `?l=` и метка `?src=` в ссылках), `meta` (метаданные превью по языку), `chunk` (перезагрузка при устаревшей вкладке), `preview` (комната с сервера для OG), `game-server`, `env`, `lang`, `name` |
| `apps/web/public/sw.js` | сервис-воркер PWA |
| `supabase/migrations/` | схема Supabase (история; сейчас нужна только боту) |
| `apps/server/` | свой игровой сервер (в проде с 22.11.2026): `server.ts` — HTTP + WebSocket, лимиты, уборка комнат, `/v1/events` (аналитика); `room.ts` — комната и матч (безголовый `HostSession`); `auth.ts` — анонимные токены; `clips.ts` — клипы для Telegram (`/v1/clips`, 2 суток; телефон грузит заранее — `apps/web/src/lib/clips.ts`); `film.ts`, `film-worker.ts`, `film-render.ts` — монтаж «Фильма матча» в отдельном процессе (@napi-rs/canvas, node-web-audio-api, ffmpeg; импортирует сцены из `apps/web/src/game`, поэтому `game-deploy` срабатывает и на них); `store.ts` — Postgres; `bot.ts` — Telegram-бот (работает на сервере в Нидерландах). Развёртывание — `infra/game/` (`provision.py`, `setup.sh`, `caddy.sh`, `web.sh`, `observe.sh`, `watch.sh`), панели Grafana — `infra/grafana/`. Клиент к нему — `ServerLink` (`packages/net/src/ws.ts`), протокол — `wire.ts`. Запуск: `pnpm --filter @kto/server dev` |
| `supabase/functions/tg-bot/` | прежний сервер бота (Edge Function, история; рабочая копия — `apps/server/src/bot.ts`, `docs/architecture.md › 4.2`) |

## Как проверять

- Юнит и сетевые тесты: `pnpm test` (game-core ~28, net ~10: позиции гостей = хост, нет утечек игроков, нагрузка ≤ 35 сообщений/с, потери 5%, переподключение, смена хоста, «нет откатов своего персонажа» на трёх сетях).
- Браузер: `pnpm --filter web build && pnpm --filter web start -p 3124`, затем Playwright (Chromium предустановлен; WebKit скачать нельзя — Safari проверяется только у владельца). Пройти матч: `/sandbox?dev&speed=8`, нажать `.kto-play`, ждать `phase === 'match_end'` через `window.__kto`. Эмуляция телефона: `p.devices['Pixel 7']`/`['iPhone 13']`, касания — `page.tap`/`page.touchscreen.tap`.
- Живая сеть: `apps/server/test` (сервер на localhost + настоящие `RemoteSession`) и `smoke` против прода — его гоняет `game-deploy`. Из среды агента benobody.app закрыт прокси: всё про прод — через GitHub Actions (`infra-netcheck.yml`, `infra-check.yml`, `infra-domain.yml`).
- После push: `gh run list` — `web-deploy`, `game-deploy`, `CI` зелёные.

## Статус (ноябрь 2026)

Готово: песочница, лобби и комнаты, напряжение (прожектор, «Толпа решает», «Хлопушка», условия съёмки) и «Пробный дубль», сетевая игра через свой сервер (матч считает сервер, прогноз своего персонажа, переподключение, зрители), клип и карточка, превью ссылок (OG), PWA и иконки, верхняя панель с настройками, музыкальный секвенсор с музыкой меню, ru/en. Дальше — арт тем (Этап F), аналитика и плейтесты (Этап G). Подробно — `docs/roadmap.md`.
