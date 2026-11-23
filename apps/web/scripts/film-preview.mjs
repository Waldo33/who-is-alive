// Кадры «Фильма матча» для проверки глазами: node scripts/film-preview.mjs <папка> <зерно> [тема]
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const [dir, seedsArg, themeArg] = process.argv.slice(2);
const out = await build({ entryPoints: ['scripts/film-preview-entry.ts'], bundle: true, format: 'iife', write: false, logLevel: 'warning' });
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<!doctype html><body></body>');
// шрифт игры (как в клипе у игрока): кириллица и латиница из assets/og
const woff = (f) => readFileSync(`assets/og/press-start-2p-${f}-400-normal.woff`).toString('base64');
await page.addStyleTag({
  content: ['cyrillic', 'latin'].map((f) => `@font-face{font-family:'Press Start 2P';src:url(data:font/woff;base64,${woff(f)}) format('woff')}`).join(''),
});
await page.evaluate(() => globalThis.document.fonts.load('8px "Press Start 2P"', 'Аa'));
await page.evaluate(([s, t]) => ((globalThis.__seed = s[0]), (globalThis.__theme = t)), [seedsArg.split(',').map(Number), themeArg === undefined ? -1 : Number(themeArg)]);
await page.addScriptTag({ content: out.outputFiles[0].text });
await page.waitForFunction(() => globalThis.__out, null, { timeout: 120000 });
const list = await page.evaluate(() => globalThis.__out);
await browser.close();
mkdirSync(dir, { recursive: true });
for (const { name, url } of list) {
  if (url.startsWith('data:text')) console.log(name, decodeURIComponent(url.split(',')[1]));
  else writeFileSync(`${dir}/${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
}
