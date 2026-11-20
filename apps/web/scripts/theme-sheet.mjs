// Лист темы для проверки глазами: node scripts/theme-sheet.mjs <индекс темы> <файл.png>
// Строки на каждый облик: общие кадры (вниз, шаг, спиной, бок, замер, волна, танец, прыжок, оглушение), свои позы, иконки команд.
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const [themeArg, outFile] = process.argv.slice(2);
if (themeArg === undefined || !outFile) {
  console.error('node scripts/theme-sheet.mjs <индекс темы> <файл.png>');
  process.exit(1);
}
const out = await build({ entryPoints: ['scripts/theme-sheet-entry.ts'], bundle: true, format: 'iife', write: false, logLevel: 'warning' });
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<!doctype html><body></body>');
await page.evaluate((t) => (globalThis.__theme = t), Number(themeArg));
await page.addScriptTag({ content: out.outputFiles[0].text });
await page.waitForFunction(() => globalThis.__png);
const url = await page.evaluate(() => globalThis.__png);
await browser.close();
writeFileSync(outFile, Buffer.from(url.split(',')[1], 'base64'));
console.log(outFile);
