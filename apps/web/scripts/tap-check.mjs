/* global document, getComputedStyle, innerHeight, window, localStorage */
// Зоны нажатия ≥ 44×44 CSS px (минимум Apple) на телефонах: HTML-кнопки главной, старта песочницы,
// листа настроек и кнопки холста во всех фазах матча с ИИ (у кнопки холста зона — b.hit или сама кнопка).
// Нужен запущенный сайт: pnpm --filter web build && pnpm --filter web start -p 3124
// Запуск: pnpm --filter web tap-check [папка для скриншотов фаз] (LOC=en-US — английский)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const out = process.argv[2];
const shots = !!out;
if (out) mkdirSync(out, { recursive: true });
const BASE = process.env.BASE || 'http://localhost:3124';
const SIZES = [[320, 568], [375, 553], [375, 667], [390, 844]];
const MIN = 44;
const browser = await chromium.launch();
const LOCALE = process.env.LOC || 'ru-RU';
const bad = [];

async function htmlTargets(page, where) {
  const r = await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, a[href], input, select, [role=button], label.kto-check')];
    return els.filter((e) => {
      const s = getComputedStyle(e);
      const b = e.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0 && !e.closest('.kto-dev') && !e.classList.contains('kto-dev-toggle')
        && b.bottom > 0 && b.top < innerHeight;
    }).map((e) => {
      const b = e.getBoundingClientRect();
      // чекбокс внутри label: зона — label
      const z = e.tagName === 'INPUT' && e.type === 'checkbox' && e.closest('label') ? e.closest('label').getBoundingClientRect() : b;
      return { tag: e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).split(' ')[0] : ''), text: (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 20), w: Math.round(z.width), h: Math.round(z.height) };
    });
  });
  for (const t of r) if (t.w < MIN || t.h < MIN) bad.push(`${where} HTML ${t.tag} «${t.text}» ${t.w}×${t.h}`);
}

async function canvasTargets(page, where) {
  const r = await page.evaluate(() => {
    const g = window.__kto?.game;
    const sc = g?.scene.getScene('game');
    if (!sc) return [];
    const z = g.scale.zoom;
    return sc.buttons.filter((b) => b.visible()).map((b) => {
      const h = b.hit ?? [b.x, b.y, b.w, b.h];
      return { id: b.id, w: +(h[2] * z).toFixed(1), h: +(h[3] * z).toFixed(1), phase: sc.sim.phase };
    });
  });
  for (const t of r) if (t.w < MIN || t.h < MIN) bad.push(`${where} canvas ${t.phase} ${t.id} ${t.w}×${t.h}`);
}

for (const [w, h] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w === 390 ? 3 : 2, isMobile: true, hasTouch: true, locale: LOCALE });
  await ctx.addInitScript(() => { try { localStorage.setItem('kto:tutorial', '1'); localStorage.setItem('kto:name', 'Важный Тостер'); } catch { /* приватный режим */ } });
  const page = await ctx.newPage();
  const tag = `${w}x${h}`;
  await page.goto(BASE + '/');
  await page.waitForTimeout(800);
  await htmlTargets(page, tag + ' /');
  if (shots) await page.screenshot({ path: `${out}/${tag}-home.png` });
  await page.goto(BASE + '/sandbox?dev&speed=6');
  await page.waitForSelector('.kto-play');
  await page.waitForTimeout(500);
  await htmlTargets(page, tag + ' /sandbox');
  if (shots) await page.screenshot({ path: `${out}/${tag}-start.png` });
  // шестерёнка меню
  const gear = page.locator('.kto-gear');
  if (await gear.count()) {
    await gear.first().click();
    await page.waitForTimeout(300);
    await htmlTargets(page, tag + ' sheet');
    if (shots) await page.screenshot({ path: `${out}/${tag}-sheet.png` });
    await page.keyboard.press('Escape');
    await page.goto(BASE + '/sandbox?dev&speed=6');
    await page.waitForSelector('.kto-play');
  }
  await page.click('.kto-play');
  await page.waitForFunction(() => window.__kto?.game?.scene.getScene('game')?.sim);
  const seen = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    const ph = await page.evaluate(() => {
      const sc = window.__kto.game.scene.getScene('game');
      return sc.sim.phase + (sc.sim.phase === 'play' && sc.sim.crowdWindowOpen?.(sc.sim.world.time) ? '-crowd' : '');
    });
    if (!seen.has(ph)) {
      seen.add(ph);
      await page.waitForTimeout(ph.startsWith('results') || ph.startsWith('match_end') ? 1500 : 300);
      await canvasTargets(page, tag);
      if (shots) await page.screenshot({ path: `${out}/${tag}-${ph}.png` });
    }
    if (ph === 'match_end') break;
    await page.waitForTimeout(150);
  }
  console.log(tag, [...seen].join(' '));
  await ctx.close();
}
await browser.close();
console.log(bad.length ? 'МАЛЫЕ ЗОНЫ:\n' + [...new Set(bad)].join('\n') : 'все зоны ≥ 44×44');
process.exitCode = bad.length ? 1 : 0;
