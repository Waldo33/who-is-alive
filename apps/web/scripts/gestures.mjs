// Лист жестов «Своего стикера» и мемов пака: node scripts/gestures.mjs <папка> (DBG=[кадры] — лента для проверки, CAPTION=текст — подпись снизу)
// Рисует scripts/gestures-entry.ts → <папка>/zhesty-N.mp4, кадр zhesty-N.png и debug.png.
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const [dir = 'gestures-out'] = process.argv.slice(2);
const bundle = await build({ entryPoints: ['scripts/gestures-entry.ts'], bundle: true, format: 'iife', write: false, logLevel: 'warning' });
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page:', e.message));
await page.setContent('<!doctype html><body></body>');
const woff = (f) => readFileSync(`assets/og/press-start-2p-${f}-400-normal.woff`).toString('base64');
await page.addStyleTag({ content: ['cyrillic', 'latin'].map((f) => `@font-face{font-family:'Press Start 2P';src:url(data:font/woff;base64,${woff(f)}) format('woff')}`).join('') });
await page.evaluate(() => globalThis.document.fonts.load('8px "Press Start 2P"', 'Аa'));
if (process.env.DBG) await page.evaluate((d) => (globalThis.__dbg = d), JSON.parse(process.env.DBG));
if (process.env.CAPTION) await page.evaluate((c) => (globalThis.__caption = c), process.env.CAPTION);
await page.addScriptTag({ content: bundle.outputFiles[0].text });
await page.waitForFunction(() => globalThis.__out, null, { timeout: 120000 });
const list = await page.evaluate(() => globalThis.__out);
await browser.close();
mkdirSync(dir, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'gestures-'));
for (const { name, frames } of list) {
  const d = join(tmp, name);
  mkdirSync(d, { recursive: true });
  frames.forEach((u, i) => writeFileSync(join(d, `${String(i).padStart(2, '0')}.png`), Buffer.from(u.split(',')[1], 'base64')));
  writeFileSync(join(dir, `${name}.png`), Buffer.from(frames[Math.min(10, frames.length - 1)].split(',')[1], 'base64'));
  if (frames.length < 2) continue;
  // 5 кругов петли, ×2, 10 кадров/с
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-stream_loop', '4', '-framerate', '10', '-i', join(d, '%02d.png'), '-vf', 'scale=iw*2:ih*2:flags=neighbor', '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', join(dir, `${name}.mp4`)], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg');
  console.log(join(dir, `${name}.mp4`));
}
rmSync(tmp, { recursive: true, force: true });
