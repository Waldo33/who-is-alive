// Значки для эмодзи-статуса: node scripts/badges.mjs
// Рисует значки (src/game/skins/badges.ts) в apps/server/stickers/badges/<id>.png (100×100, прозрачный фон).
// Бот берёт файлы оттуда (едут на сервер вместе со стикерами) и собирает из них набор эмодзи (server/src/badges.ts).
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = '../server/stickers/badges';

const bundle = await build({ entryPoints: ['scripts/badges-entry.ts'], bundle: true, format: 'iife', write: false, logLevel: 'warning' });
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.error(e.message));
await page.setContent('<!doctype html><body></body>');
await page.addScriptTag({ content: bundle.outputFiles[0].text });
await page.waitForFunction(() => globalThis.__out, null, { timeout: 60000 });
const list = await page.evaluate(() => globalThis.__out);
await browser.close();
mkdirSync(OUT, { recursive: true });
for (const { id, png } of list) {
  writeFileSync(join(OUT, `${id}.png`), Buffer.from(png.split(',')[1], 'base64'));
  console.log(`badges/${id}.png`);
}
