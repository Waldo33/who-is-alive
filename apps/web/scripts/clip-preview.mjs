// Кадры клипа для проверки глазами: node scripts/clip-preview.mjs <папка> <зерна через запятую> [тема]
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const [dir, seedsArg, themeArg] = process.argv.slice(2);
const out = await build({ entryPoints: ['scripts/clip-preview-entry.ts'], bundle: true, format: 'iife', write: false, logLevel: 'warning' });
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<!doctype html><body></body>');
await page.evaluate(([s, t]) => ((globalThis.__seeds = s), (globalThis.__theme = t)), [seedsArg.split(',').map(Number), themeArg === undefined ? -1 : Number(themeArg)]);
await page.addScriptTag({ content: out.outputFiles[0].text });
await page.waitForFunction(() => globalThis.__out, null, { timeout: 120000 });
const list = await page.evaluate(() => globalThis.__out);
await browser.close();
mkdirSync(dir, { recursive: true });
for (const { name, url } of list) {
  if (url.startsWith('data:text')) console.log(name, decodeURIComponent(url.split(',')[1]));
  else writeFileSync(`${dir}/${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
}
