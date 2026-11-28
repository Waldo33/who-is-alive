// Видеостикеры для Telegram: node scripts/stickers.mjs [папка-просмотра]
// Рисует все стикеры (src/game/skins/stickers.ts) на обоих языках и кодирует их в WEBM VP9 с прозрачностью
// (512×512, 10 кадров/с, 2 с — у «Пшшш!» 3 с, ≤ 256 КБ — требования Telegram) в apps/server/stickers/<язык>/<id>.webm.
// Бот берёт файлы оттуда (они уезжают на сервер вместе с выкладкой). Папка-просмотра — лист первых кадров.
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const [preview] = process.argv.slice(2);
const OUT = '../server/stickers';
const MAX = 256 * 1024;

const bundle = await build({ entryPoints: ['scripts/stickers-entry.ts'], bundle: true, format: 'iife', write: false, logLevel: 'warning' });
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<!doctype html><body></body>');
const woff = (f) => readFileSync(`assets/og/press-start-2p-${f}-400-normal.woff`).toString('base64');
await page.addStyleTag({
  content: ['cyrillic', 'latin'].map((f) => `@font-face{font-family:'Press Start 2P';src:url(data:font/woff;base64,${woff(f)}) format('woff')}`).join(''),
});
await page.evaluate(() => globalThis.document.fonts.load('8px "Press Start 2P"', 'Аa'));
await page.addScriptTag({ content: bundle.outputFiles[0].text });
await page.waitForFunction(() => globalThis.__out, null, { timeout: 120000 });
const list = await page.evaluate(() => globalThis.__out);
await browser.close();

const tmp = mkdtempSync(join(tmpdir(), 'stickers-'));
for (const { lang, id, frames } of list) {
  const dir = join(tmp, lang, id);
  mkdirSync(dir, { recursive: true });
  frames.forEach((u, i) => writeFileSync(join(dir, `${String(i).padStart(2, '0')}.png`), Buffer.from(u.split(',')[1], 'base64')));
  mkdirSync(join(OUT, lang), { recursive: true });
  const file = join(OUT, lang, `${id}.webm`);
  // пиксель-арт жмётся хорошо; не влез в 256 КБ — грубее
  for (const crf of [24, 32, 40, 48]) {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '10', '-i', join(dir, '%02d.png'), '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', String(crf), '-an', '-auto-alt-ref', '0', file], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`ffmpeg ${lang}/${id}`);
    if (statSync(file).size <= MAX) break;
  }
  const kb = Math.round(statSync(file).size / 1024);
  if (kb * 1024 > MAX) throw new Error(`${lang}/${id}: ${kb} КБ > 256`);
  console.log(`${lang}/${id}.webm ${kb} КБ`);
}
if (preview) {
  // лист: первый кадр каждого стикера, по ряду на язык
  mkdirSync(preview, { recursive: true });
  for (const lang of new Set(list.map((x) => x.lang))) {
    const ids = list.filter((x) => x.lang === lang).map((x) => join(tmp, lang, x.id, '05.png'));
    spawnSync('ffmpeg', ['-v', 'error', '-y', ...ids.flatMap((f) => ['-i', f]), '-filter_complex', `${ids.map((_, i) => `[${i}]`).join('')}xstack=inputs=${ids.length}:layout=${ids.map((_, i) => `${(i % 6) * 512}_${Math.floor(i / 6) * 512}`).join('|')}:fill=0x3b4a5a,scale=iw/2:ih/2:flags=neighbor`, join(preview, `stickers-${lang}.png`)], { stdio: 'inherit' });
  }
}
rmSync(tmp, { recursive: true, force: true });
