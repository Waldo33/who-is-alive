// Пакет Telegram-визуалов: бандлим telegram-entry.ts, рисуем в Chromium (Playwright), пишем в assets/telegram.
// Запуск: pnpm --filter web telegram-assets
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const out = await build({ entryPoints: ['scripts/telegram-entry.ts'], bundle: true, format: 'iife', write: false, logLevel: 'warning' });
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<!doctype html><body></body>');
await page.addScriptTag({ content: out.outputFiles[0].text });
const files = await page.evaluate(() => globalThis.__tg);
await browser.close();
mkdirSync('assets/telegram', { recursive: true });
for (const [name, body] of Object.entries(files)) {
  writeFileSync(`assets/telegram/${name}`, body);
  console.log('assets/telegram/' + name);
}
