// Видео дубля в теме со звуком игры: node scripts/theme-video.mjs <индекс темы> <файл.mp4> [адрес]
// Нужен запущенный сайт (по умолчанию http://localhost:3124: pnpm --filter web build && pnpm --filter web start -p 3124) и ffmpeg.
// Картинка — с холста игры (180×320, потом ×4 без сглаживания), звук — прямо из Web Audio (без микрофона).
// Своим персонажем управляет скрипт: ходит как бот, выполняет команды «Море волнуется», жмёт эмоцию, обвиняет.
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { Buffer } from 'node:buffer';
/* global window, AudioNode, AudioDestinationNode, MediaStream, MediaRecorder, Blob, btoa, performance, setInterval -- код внутри page.evaluate выполняется в браузере */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const [themeArg, outFile, base = 'http://localhost:3124'] = process.argv.slice(2);
if (themeArg === undefined || !outFile) {
  console.error('node scripts/theme-video.mjs <индекс темы> <файл.mp4> [адрес]');
  process.exit(1);
}
const MAX_SEC = 150;
const S = "window.__kto.game.scene.getScene('game')";

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ru-RU' });
// всё, что идёт в динамики, дублируем в поток для записи
await ctx.addInitScript(() => {
  const orig = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dst, ...rest) {
    const r = orig.call(this, dst, ...rest);
    if (dst instanceof AudioDestinationNode) {
      const c = dst.context;
      if (!c.__msd) {
        c.__msd = c.createMediaStreamDestination();
        window.__msd = c.__msd;
      }
      orig.call(this, c.__msd);
    }
    return r;
  };
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${base}/sandbox?dev&theme=${themeArg}`);
await page.waitForTimeout(1500);
await page.tap('.kto-play');
await page.waitForFunction(() => window.__kto?.game && window.__msd);
await page.evaluate(() => {
  const cv = window.__kto.game.canvas;
  const st = new MediaStream([...cv.captureStream(30).getVideoTracks(), ...window.__msd.stream.getAudioTracks()]);
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(st, { mimeType: mime, videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 192_000 });
  window.__chunks = [];
  rec.ondataavailable = (e) => e.data.size && window.__chunks.push(e.data);
  rec.start(1000);
  window.__rec = rec;
});
await page.evaluate((sel) => {
  const sc = () => eval(sel);
  let auto = false;
  let answered = -1;
  let lastEmote = 0;
  let accused = -1;
  setInterval(() => {
    const s = sc();
    if (!s?.sim) return;
    const sim = s.sim;
    const w = sim.world;
    const me = sim.me?.();
    if (sim.phase === 'play' && me?.alive) {
      const c = w.crowd;
      if (c && sim.crowdWindowOpen(w.time)) {
        if (answered !== c.warnAt && w.time >= c.showAt + 300) {
          if (auto) sim.intent({ k: 'autopilot', on: false });
          auto = false;
          sim.intent({ k: 'crowd', kind: c.kind });
          answered = c.warnAt;
        }
      } else if (!auto) {
        sim.intent({ k: 'autopilot', on: true });
        auto = true;
      }
      if (performance.now() - lastEmote > 6000) {
        sim.intent({ k: 'emote' });
        lastEmote = performance.now();
      }
    } else if (auto) {
      sim.intent({ k: 'autopilot', on: false });
      auto = false;
    }
    if (sim.phase === 'accuse' && accused !== sim.round) {
      const alive = w.alive().filter((e) => !me || e.eid !== me.eid);
      if (alive.length) sim.intent({ k: 'accuse', eid: alive[Math.floor(alive.length / 2)].eid });
      accused = sim.round;
    }
  }, 100);
}, S);
// один дубль: до итогов и ещё 4,5 с
let endAt = Infinity;
for (let t = 0; t < MAX_SEC * 10 && t < endAt; t++) {
  const phase = await page.evaluate((sel) => eval(sel).sim.phase, S);
  if (phase === 'results' && endAt === Infinity) endAt = t + 45;
  await page.waitForTimeout(100);
}
await page.evaluate(() => new Promise((r) => ((window.__rec.onstop = r), window.__rec.stop())));
const b64 = await page.evaluate(async () => {
  const buf = new Uint8Array(await new Blob(window.__chunks).arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
});
await browser.close();
const raw = `${outFile}.webm`;
writeFileSync(raw, Buffer.from(b64, 'base64'));
const ff = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-vf', 'scale=720:1280:flags=neighbor,fps=30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', outFile], { stdio: 'inherit' });
rmSync(raw, { force: true });
if (ff.status !== 0) process.exit(ff.status ?? 1);
console.log(outFile, errors.length ? `ошибки страницы: ${errors.slice(0, 3).join(' | ')}` : '');
