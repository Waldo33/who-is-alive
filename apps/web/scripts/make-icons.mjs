// Сборка иконок: бандлим icons-entry.ts, рисуем в Chromium (Playwright), пишем PNG в public/icons.
// Запуск: pnpm --filter web icons
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const out = await build({ entryPoints: ['scripts/icons-entry.ts'], bundle: true, format: 'iife', write: false, logLevel: 'warning' });
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<!doctype html><body></body>');
await page.addScriptTag({ content: out.outputFiles[0].text });
const icons = await page.evaluate(() => globalThis.__icons);
await browser.close();
mkdirSync('public/icons', { recursive: true });
for (const [name, url] of Object.entries(icons)) {
  writeFileSync(`public/icons/${name}`, Buffer.from(url.split(',')[1], 'base64'));
  console.log('icons/' + name);
}
