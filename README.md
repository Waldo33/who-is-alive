# «Массовка» · Be Nobody

Браузерная реалтайм-игра для компании, 2–4 игрока с телефонов: прячься в толпе одинаковых пиксельных человечков, вычисляй живых и бей первым. Без регистрации, по ссылке или QR.

**Играть:** https://who-is-alive.vercel.app (с ботами — `/sandbox`).

## Быстрый старт

```bash
corepack enable && pnpm install
pnpm dev                          # http://localhost:3000
pnpm lint && pnpm typecheck && pnpm test
pnpm sim -- --rounds 1000         # безголовая симуляция
pnpm --filter web build           # прод-сборка
```

## Устройство

- `apps/web` — Next.js 15 + Phaser 3: страницы, сцена, звук, клип, превью, PWA.
- `packages/game-core` — правила игры, детерминированные, без DOM и сети.
- `packages/net` — сетевая игра поверх Supabase Realtime (хост-клиент).
- `packages/assets` — палитра.
- `supabase/migrations` — схема, RLS, RPC.

Документация для разработки: [CLAUDE.md](CLAUDE.md), [docs/architecture.md](docs/architecture.md), [docs/gotchas.md](docs/gotchas.md), [docs/roadmap.md](docs/roadmap.md).

Весь арт и звук сделаны кодом. Шрифт — Press Start 2P (OFL).
