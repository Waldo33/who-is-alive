// Фоны превью ссылок по темам: бандлим og-entry.ts, рисуем в Chromium (Playwright), пишем assets/og/bg-N.png.
// Запуск: pnpm --filter web og-bg
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const out = await build({ entryPoints: ['scripts/og-entry.ts'], bundle: true, format: 'iife', write: false, logLevel: 'warning' });
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<!doctype html><body></body>');
await page.addScriptTag({ content: out.outputFiles[0].text });
const list = await page.evaluate(() => globalThis.__og);
await browser.close();
list.forEach((url, i) => {
  writeFileSync(`assets/og/bg-${i}.png`, Buffer.from(url.split(',')[1], 'base64'));
  console.log(`assets/og/bg-${i}.png`);
});
