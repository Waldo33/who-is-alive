// Клип «Лучший момент» со звуком — как его выгрузит игрок: node scripts/clip-video.mjs <зерно> <файл.webm> [тема]
// Безголовый матч с ИИ до разоблачения, лучший момент, запись MediaRecorder (картинка + музыка темы и звуки).
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const [seedArg, outFile, themeArg] = process.argv.slice(2);
if (!seedArg || !outFile) {
  console.error('node scripts/clip-video.mjs <зерно> <файл.webm> [тема]');
  process.exit(1);
}
const out = await build({ entryPoints: ['scripts/clip-video-entry.ts'], bundle: true, format: 'iife', write: false, logLevel: 'warning' });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.setContent('<!doctype html><body></body>');
await page.evaluate(([s, t]) => ((globalThis.__seed = s), (globalThis.__theme = t)), [Number(seedArg), themeArg === undefined ? -1 : Number(themeArg)]);
await page.addScriptTag({ content: out.outputFiles[0].text });
await page.waitForFunction(() => globalThis.__out, null, { timeout: 120000 });
const [data, info] = await page.evaluate(() => [globalThis.__out, globalThis.__info]);
await browser.close();
writeFileSync(outFile, Buffer.from(data, 'base64'));
console.log(outFile, info, errors.length ? errors.slice(0, 3).join(' | ') : '');
// громкость для соцсетей: цель −14 LUFS в среднем, пики не выше −1 дБ (Reels, TikTok, Shorts выравнивают к ней)
const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', outFile, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' });
if (r.status === 0) {
  const sum = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  const lufs = sum.match(/I:\s+(-?[\d.]+) LUFS/)?.[1];
  const peak = sum.match(/Peak:\s+(-?[\d.]+) dBFS/)?.[1];
  console.log(`громкость: ${lufs} LUFS (цель −14), пик ${peak} dBFS (не выше −1)`);
} else console.log('громкость: нет ffmpeg — не мерил');
