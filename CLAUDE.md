# CLAUDE.md — контекст для агента

Этот файл — первое, что нужно прочитать перед работой в репозитории. Подробности — в `docs/`:

- `docs/architecture.md` — как устроены ядро, сеть, Supabase, клиент, звук, клип, превью;
- `docs/gotchas.md` — грабли, на которые уже наступали (Safari, Chrome на iPhone, Realtime, iOS-звук…);
- `docs/roadmap.md` — что сделано, что дальше, отложенные решения и что нужно от владельца.

Язык проекта — **русский**: комментарии в коде, сообщения коммитов, общение с владельцем. Владелец не программист в этом проекте: формулирует задачи как игрок («у друга лагает», «не успеваю нажать»), часто тестирует с iPhone (Safari и Chrome) и пишет прямо из приложения Claude на телефоне. Делай всё сам до конца, проверяй и коротко отчитывайся, что изменилось для игрока.

## Что это

**«Массовка» / «Be Nobody»** (раньше — «Кто тут живой?») — браузерная реалтайм-игра для компании, 2–4 игрока, только телефоны. Тон текстов — съёмочная площадка: раунд — «дубль», выбывший «вырезан» и «за кадром», хост — «режиссёр»; по-английски — extra / actor. Фразы с именами игроков — без падежей и рода (имена бывают любыми). Полный список — Claude Doc «Массовка / Be Nobody — текстовки».
На пиксельной площади 32 одинаковых человечка: почти все — боты, остальные — игроки. Каждый прячется в толпе, вычисляет живых по поведению и бьёт первым. Удар по живому — выбил, по боту — сам оглушён и раскрыт. Три звезды — победа в раунде. «Море волнуется»: музыка обрывается, мир замирает (стоп-кадр), надо нажать ту же команду, что и толпа. В конце раунда — обвинение («кто тут живой?»), разоблачение с повтором, награды. Матч до 8 очков (~5 минут).

- Прод: https://who-is-alive.vercel.app (песочница с ботами — `/sandbox`, комната — `/r/КОД`).
- Репозиторий: `Waldo33/who-is-alive`, ветка `main`; **каждый push в `main` сразу деплоится в прод** (Vercel).
- ТЗ — Claude Doc «Кто тут живой? — ТЗ для разработки». При расхождении прав код и `docs/`; ТЗ обновляет владелец.
- Художника и композитора нет: **весь арт и звук делаются кодом** (процедурные спрайты из палитры, синтез на Web Audio).

## Стек

- Монорепо **pnpm 10.18.3**, Node 22, TypeScript 5.9 strict, ESLint 9 (flat config в корне), Vitest 3.
- `apps/web` — **Next.js 15.5** (App Router, React 19) + **Phaser 3.90**. Деплой: Vercel Hobby, проект `who-is-alive` (`prj_J1ZWu5Ncozw0FtcgTVoQGQFLrUNm`, команда `team_KRSpd6ofFYaA171W5rl60kY7`), Root Directory = `apps/web`.
- **Supabase** (проект `who-is-alive`, ref `wivildtgfkpuxvqoamqg`, Франкфурт): анонимный вход, Postgres + RLS, Realtime (Broadcast + Presence, приватные каналы), pg_cron. Публичный URL и publishable key вшиты как запасные значения в `apps/web/src/lib/env.ts` (это нормально: ключ публичный, права режут RLS). Сервисных ключей в репозитории нет и быть не должно.
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
pnpm --filter web live-e2e            # живой прогон через настоящий Supabase (нужна сеть до supabase.co)
pnpm --filter web icons               # перерисовать иконки PWA из спрайтов (нужен Playwright)
pnpm --filter web og-bg               # фоны превью ссылок по темам: apps/web/assets/og/bg-N.png
pnpm --filter web clip-preview <папка> 11,12 [тема]   # кадры клипа «Лучший момент» по зернам — проверить глазами
pnpm --filter web theme-sheet 4 out.png          # лист темы ×8: костюм, свои позы, иконки команд
pnpm --filter web theme-video 4 out.mp4          # видео дубля в теме со звуком (нужен запущенный сайт на :3124 и ffmpeg)
pnpm --filter web standalone          # песочница одним HTML-файлом: apps/web/dist/sandbox.html
```

Песочница: `?dev` — панель конфига, `?dev&speed=8` — ускорение времени, `?dev&theme=4` — все дубли в одной теме, в консоли `window.__kto` (сцена: `__kto.game.scene.getScene('game')`), `?lang=en`.

CI (`.github/workflows/ci.yml`): lint, typecheck, test, `sim --rounds 200`.

## Правила, которые нельзя нарушать

1. **`game-core` чистый**: без Phaser, DOM, `window`, сети, `Math.random()`, `Date.now()` — только `Rng` с зерном и игровое время. Одно зерно → один и тот же матч.
2. **Никто, кроме хоста, не знает, какие сущности — игроки** (кроме себя). Команды ботов и игроков одного формата; в `hit` по игроку нет `attacker`; связь игрок↔сущность приходит только личным сообщением (своя) и в итогах раунда. Это проверяет `packages/net/test/netplay.test.ts`. Любое новое сетевое поле проверяй на утечку.
3. **Пиксели**: только целочисленный масштаб (`integerZoom` в `boot.ts`), `pixelArt`, `roundPixels`, без сглаживания; цвета только из `PAL`. На canvas вне Phaser (клип, карточка) — `imageSmoothingEnabled = false` и **целые кегли** (см. `art.ts › text`).
4. **Тексты — только в словарях** `packages/game-core/src/locale/{ru,en}.ts` (одна структура, тип `Dict`). Строки на canvas ≤ 21 символа — проверяет `test/i18n.test.ts`; добавляешь строку для canvas — добавь и в тест.
5. **Мобильный веб**: не ломать защиту от зума (`touch-action`, поля ≥ 16px, гашение двойного тапа и щипка в `shell.ts`), разблокировку звука по `touchend`/`click`, безопасные зоны (`env(safe-area-inset-*)`). Системное меню «Поделиться» вызывать только из свежего жеста (`pointerup`/`click`, не `pointerdown`).
6. Phaser импортировать как `import * as Phaser from 'phaser'` (иначе ломается прод-сборка Next).
7. Не ломать песочницу `/sandbox` — она работает без сети и без Supabase.
8. Перед push: `pnpm lint && pnpm typecheck && pnpm test` и `pnpm --filter web build`. Изменил игру — пройди матч в браузере (Playwright, см. ниже). Коммиты осмысленные, на русском, с трейлерами атрибуции, если их требует окружение.
9. Миграции Supabase: файл в `supabase/migrations/` **и** применить к проекту (MCP `apply_migration`). Функции — `security definer` + `set search_path = ''`, проверка прав внутри; новые таблицы — с RLS.

## Карта кода

| Где | Что |
|---|---|
| `packages/game-core/src/config.ts` | все числа баланса (`DEFAULT_CONFIG`, `makeConfig`) |
| `…/themes.ts` | реестр тем (`THEME_RULES`, индекс уходит в сеть) и их правила: изнанка (`twist`), эмоция толпы в ней |
| `…/match.ts` | `MatchSim` — авторитетный матч: фазы, намерения (`Intent`), удары, звёзды, «Море волнуется», очки, итоги; `LAG_GRACE_MS` |
| `…/world.ts` | `World` — воспроизводимое состояние, шаг 50 мс, события с `at`, ключевые кадры, `makeReplay`, `filter` |
| `…/events.ts` | `WorldEvent` — всё видимое на поле |
| `…/bots.ts`, `ai.ts` | мозг ботов (+ «чудачества»), ИИ-игроки песочницы |
| `…/session.ts` | `ClientView`/`ClientSession`, `LocalSession` (песочница), `createLocalSession` |
| `…/moments.ts` | поиск «лучшего момента» для клипа, `recordRound` |
| `…/locale/` | словари ru/en, `tp()` (множественное число), `fmt()`, `pickLang()` |
| `packages/net/src/transport.ts` | интерфейс `Transport`, `LoopbackHub` (петля в памяти для тестов) |
| `…/supabase.ts` | `SupabaseTransport` — каналы Realtime |
| `…/host.ts`, `remote.ts` | `HostSession` (оборачивает `MatchSim`), `RemoteSession` (гость: прогноз и сверка) |
| `…/protocol.ts` | типы сообщений и zod-схемы того, что гость шлёт хосту |
| `apps/web/src/net/room.ts` | `Room`: вход по RPC, состав, Presence, старт матча, смена хоста |
| `apps/web/src/app/` | страницы: `/` (`HomeClient`), `/r/[code]` (`RoomClient`: лобби + игра), `/sandbox`; превью ссылок `og.tsx` + маршрут `og/route.tsx` (язык отправителя из `?l=`); `manifest.ts`, `PwaRegister.tsx` |
| `apps/web/src/game/scene.ts` | сцена Phaser (~1400 строк): рендер, HUD, оверлеи фаз, ввод, музыка по фазам |
| `…/game/themes/` | пакеты тем («площадки»): облик толпы, локация, музыка; каждый — свой файл, грузится по требованию (`index.ts › loadTheme`, до старта игры — `loadAllThemes`). Парк — в `sprites.ts`. Новая тема на заданный сеттинг — скилл `.claude/skills/new-theme/SKILL.md` |
| `…/game/sprites.ts`, `art.ts`, `frames.ts`, `pixels.ts`, `font.ts` | процедурный арт, битмап-шрифт, выбор кадра персонажа |
| `…/game/audio.ts`, `music.ts` | звук: `getAudio()` (один на приложение), эффекты, музыкальный секвенсор |
| `…/game/clip.ts`, `clip-ui.ts`, `card.ts` | клип «Лучший момент» (MediaRecorder), экран монтажа, карточка результата |
| `…/game/shell.ts`, `boot.ts` | оболочка песочницы, запуск Phaser |
| `apps/web/src/ui/topbar.ts` | верхняя панель «< Назад» + шестерёнка (язык, музыка, звуки, «Как играть») |
| `apps/web/src/lib/` | `share` (поделиться с запасными путями, `withLang` — `?l=` в ссылках), `meta` (метаданные превью по языку), `chunk` (перезагрузка при устаревшей вкладке), `preview` (RPC для OG), `env`, `supabase`, `lang`, `name` |
| `apps/web/public/sw.js` | сервис-воркер PWA |
| `supabase/migrations/` | схема БД, RLS, RPC, политики Realtime |

## Как проверять

- Юнит и сетевые тесты: `pnpm test` (game-core ~28, net ~10: позиции гостей = хост, нет утечек игроков, нагрузка ≤ 35 сообщений/с, потери 5%, переподключение, смена хоста, «нет откатов своего персонажа» на трёх сетях).
- Браузер: `pnpm --filter web build && pnpm --filter web start -p 3124`, затем Playwright (Chromium предустановлен; WebKit скачать нельзя — Safari проверяется только у владельца). Пройти матч: `/sandbox?dev&speed=8`, нажать `.kto-play`, ждать `phase === 'match_end'` через `window.__kto`. Эмуляция телефона: `p.devices['Pixel 7']`/`['iPhone 13']`, касания — `page.tap`/`page.touchscreen.tap`.
- Живая сеть: `pnpm --filter web live-e2e` (3 анонимных игрока, комната, права каналов, задержка, совпадение мира, смена хоста). Из рабочей среды агента supabase.co может быть недоступен — тогда запускать в Vercel Sandbox (fra1), клонируя публичный репозиторий.
- После push: проверить деплой (Vercel MCP `list_deployments`, состояние `READY`).

## Статус (ноябрь 2026)

Готово: песочница, лобби и комнаты, сетевая игра через Supabase (хост-клиент, прогноз своего персонажа, переподключение, смена хоста), клип и карточка, превью ссылок (OG), PWA и иконки, верхняя панель с настройками, музыкальный секвенсор с музыкой меню, ru/en. Дальше — арт тем (Этап F), аналитика и плейтесты (Этап G). Подробно — `docs/roadmap.md`.
