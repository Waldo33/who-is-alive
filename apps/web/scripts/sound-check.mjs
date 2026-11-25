// Громкость звука на динамике телефона: node scripts/sound-check.mjs [фильтр,…] [--json файл]
// Рендерит каждый эффект и музыку каждой темы настоящим кодом игры (OfflineAudioContext в Chromium),
// печатает громкость полностью и после полосы телефона 350 Гц – 7 кГц и сверяет с целями звукового
// гайда (Claude Doc «Массовка — план улучшения звука», раздел «Звуковой гайд»).
// Колонки: phone — RMS на динамике по звучащей части, dB; peak50 — самые громкие 50 мс на динамике;
// low — доля энергии ниже 350 Гц, %; target — цель гайда.
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const jsonFile = jsonAt >= 0 ? args[jsonAt + 1] : null;
const only = args.filter((a, i) => !a.startsWith('--') && (jsonAt < 0 || i !== jsonAt + 1))[0] ?? '';

/**
 * Цели гайда, дБ на динамике телефона: [от, до]. P1 −30…−33, P2 −35…−39, музыка в дубле −40…−44
 * (изнанка не громче −36), фон P3 −46 и тише. Мерится RMS по звучащей части эффекта.
 */
const TARGETS = {
  'sfx:hitPlayer': [-32, -28, 'P1 ты выбил живого'],
  'sfx:knockedOut': [-33, -29, 'P1 тебя вырезали'],
  'sfx:hitBot': [-35, -31, 'P1 ударил бота'],
  'sfx:cut': [-33, -29, 'P1 тебя вырезали (без оружия)'],
  'sfx:hitOther': [-38, -34, 'P2 чужой удар по живому'],
  'sfx:starTake': [-35, -31, 'P1 звезда'],
  'sfx:ready': [-33, -29, 'P1 старт дубля'],
  'sfx:crowd': [-33, -29, 'P1 Море волнуется'],
  'sfx:drum': [-35, -31, 'P1 разоблачение: проектор'],
  'sfx:unmask': [-35, -30, 'P1 живой раскрыт'],
  'sfx:logo': [-34, -30, 'P1 звуковой логотип'],
  'sfx:wrap': [-34, -30, 'P1 «Снято!»'],
  'sfx:whack': [-38, -34, 'P2 бита'],
  'sfx:clang': [-38, -34, 'P2 труба'],
  'sfx:stab': [-38, -34, 'P2 нож'],
  'sfx:starSpawn': [-41, -37, 'P2 звезда появилась'],
  'sfx:flicker': [-40, -36, 'P2 изнанка: свет'],
  'sfx:dusk': [-40, -36, 'P2 изнанка: закат'],
  'sfx:step': [-90, -46, 'P3 фон'],
  'sfx:leshyStep': [-40, -32, 'P2 шаг Лешего вплотную (step 0 — тише)'],
  'sfx:leshyBreath': [-42, -35, 'P2 выдох Лешего над лугом'],
  'sfx:leshyStinger': [-33, -28, 'P1 Леший вышел на поляну'],
  'sfx:leshyTake': [-34, -28, 'P1 Леший забрал'],
  'sfx:leshyCall': [-46, -38, 'фон: «Ау» из леса'],
  'sfx:snap': [-48, -38, 'фон: треск ветки'],
  'sfx:whisper': [-44, -36, 'фон: шёпот из леса — должен быть слышен'],
  'sfx:hedge': [-90, -46, 'P3 фон'],
  'sfx:pigeon': [-90, -46, 'P3 фон'],
  'sfx:tick': [-90, -46, 'P3 фон'],
};
for (let th = 0; th < 8; th++) {
  TARGETS[`music:${th}:calm`] = [-45, -39, 'музыка в дубле'];
  TARGETS[`music:${th}:tense`] = [-44, -37, 'музыка, пик напряжения'];
  TARGETS[`music:${th}:twist`] = [-44, -36, 'изнанка ≤ −36'];
  TARGETS[`music:${th}:night`] = [-50, -38, 'глухая ночь: тише, но слышно'];
}
TARGETS['music:accuse'] = [-42, -38, 'обвинение'];
for (const k of ['hitPlayer', 'cut', 'knockedOut', 'hitBot']) TARGETS['kids:' + k] = [-36, -29, 'детский: P1'];
for (const k of ['hitOther', 'whack']) TARGETS['kids:' + k] = [-42, -33, 'детский: P2'];
TARGETS['music:6:blackout-gap'] = [-200, -70, 'тишина после «свет вырубили»'];

const out = await build({ entryPoints: ['scripts/sound-check-entry.ts'], bundle: true, format: 'iife', write: false, logLevel: 'warning' });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.setContent('<!doctype html><body></body>');
await page.evaluate((o) => (globalThis.__only = o), only);
await page.addScriptTag({ content: out.outputFiles[0].text });
await page.waitForFunction(() => globalThis.__out || globalThis.__err, null, { timeout: 600000 });
const [data, err] = await page.evaluate(() => [globalThis.__out, globalThis.__err]);
await browser.close();
if (err) {
  console.error(err);
  process.exit(1);
}
const res = JSON.parse(data);
if (jsonFile) writeFileSync(jsonFile, JSON.stringify(res, null, 1));
const pad = (s, n) => String(s).padEnd(n);
const num = (v) => String(v).padStart(7);
console.log(pad('звук', 22) + num('len,с') + num('full') + num('phone') + num('peak50') + num('low%') + '   цель');
let bad = 0;
for (const [k, m] of Object.entries(res)) {
  const tg = TARGETS[k];
  let mark = '';
  if (tg) {
    const ok = m.phone >= tg[0] && m.phone <= tg[1];
    if (!ok) bad++;
    mark = `${ok ? '  ok' : '  !!'} ${tg[0]}…${tg[1]} ${tg[2]}`;
  }
  console.log(pad(k, 22) + num(m.len) + num(m.full) + num(m.phone) + num(m.phonePeak50) + num(m.low) + mark);
}
console.log(`\nвне цели: ${bad}` + (errors.length ? `\nошибки страницы: ${errors.slice(0, 3).join(' | ')}` : ''));
