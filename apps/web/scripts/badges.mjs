// Значки для эмодзи-статуса: node scripts/badges.mjs
// Рисует значки (src/game/skins/badges.ts) в apps/server/stickers/badges/<id>.png (100×100, прозрачный фон),
// анимированные (значки-слоты) — ещё и <id>.webm: видео-эмодзи Telegram, VP9 с прозрачностью, ≤ 3 с, ≤ 64 КБ.
// Бот берёт файлы оттуда (едут на сервер вместе со стикерами) и собирает из них набор эмодзи (server/src/badges.ts).
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
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
const MAX = 64 * 1024;
for (const { id, png, frames, fps } of list) {
  writeFileSync(join(OUT, `${id}.png`), Buffer.from(png.split(',')[1], 'base64'));
  console.log(`badges/${id}.png`);
  if (!frames.length) continue;
  const tmp = mkdtempSync(join(tmpdir(), 'badge-'));
  frames.forEach((u, i) => writeFileSync(join(tmp, `${String(i).padStart(3, '0')}.png`), Buffer.from(u.split(',')[1], 'base64')));
  const file = join(OUT, `${id}.webm`);
  for (const crf of [20, 30, 40, 50]) {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(fps), '-i', join(tmp, '%03d.png'), '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', String(crf), '-an', '-auto-alt-ref', '0', file], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`ffmpeg ${id}`);
    if (statSync(file).size <= MAX) break;
  }
  rmSync(tmp, { recursive: true, force: true });
  const kb = Math.round(statSync(file).size / 1024);
  if (statSync(file).size > MAX) throw new Error(`${id}.webm: ${kb} КБ > 64`);
  console.log(`badges/${id}.webm ${kb} КБ`);
}
