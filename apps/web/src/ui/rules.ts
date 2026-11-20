import { PAL } from '@kto/assets';
import type { Dict } from '@kto/game-core';
import { tint } from '../game/art';
import { canvas } from '../game/pixels';
import { CH_H, CH_W, F, OL_H, OL_W, THEMES, makeCharacterSheets, makeIcons, makeMark, makeStar } from '../game/sprites';

/**
 * «Как играть»: каждый пункт правил — отдельная строка с пиксельной картинкой из игры:
 * человечек в жёлтом контуре живого, кулак удара, звезда, кнопка команды «Море волнуется»,
 * человечек под «?» с галочкой (обвинение).
 * Одна разметка для стартового экрана песочницы и листа настроек.
 */
let icons: string[] | null = null;

function makeRuleIcons(): string[] {
  const S = 20; // логический размер клетки иконки; на экране — ×2 (CSS, без сглаживания)
  const cell = () => canvas(S, S);
  const sheets = makeCharacterSheets(THEMES[0]);
  const glow = tint(sheets.outline, PAL.yellow);
  const ic = makeIcons();
  const iconAt = (g: CanvasRenderingContext2D, name: string, x: number, y: number) => {
    const i = Math.max(0, ic.names.indexOf(name));
    g.drawImage(ic.canvas, i * 8, 0, 8, 8, x, y, 8, 8);
  };

  // 1. ты — один из толпы: живой в жёлтом контуре
  const a = cell();
  a.g.drawImage(glow, F.D * OL_W, 0, OL_W, OL_H, 3, 1, OL_W, OL_H);
  a.g.drawImage(sheets.body, F.D * CH_W, 0, CH_W, CH_H, 4, 2, CH_W, CH_H);

  // 2. удар: кулак крупно
  const b = cell();
  b.g.save();
  b.g.scale(2, 2);
  iconAt(b.g, 'fist', 1, 1);
  b.g.restore();

  // 3. звезда
  const c = cell();
  c.g.save();
  c.g.scale(2, 2);
  c.g.drawImage(makeStar(), 0, 0, 10, 10, 0, 0, 10, 10);
  c.g.restore();

  // 4. кнопка команды, как в игре: тёмная плашка с жёлтой кромкой и значком
  const d = cell();
  d.g.fillStyle = PAL.ink;
  d.g.fillRect(1, 2, 18, 16);
  d.g.fillStyle = PAL.dusk;
  d.g.fillRect(2, 3, 16, 14);
  d.g.fillStyle = PAL.amber;
  d.g.fillRect(2, 3, 16, 1);
  iconAt(d.g, 'hand', 6, 7);

  // 5. обвинение: человечек под «?» и галочка — вычислил
  const e = cell();
  const q = makeMark('?');
  e.g.drawImage(sheets.body, F.D * CH_W, 0, CH_W, CH_H, 2, 4, CH_W, CH_H);
  e.g.drawImage(q, 8 - Math.floor(q.width / 2), 0);
  iconAt(e.g, 'check', 12, 11);

  return [a, b, c, d, e].map((x) => x.c.toDataURL('image/png'));
}

export function rulesHtml(t: Dict): string {
  if (typeof document === 'undefined') return '';
  icons ??= makeRuleIcons();
  return `<ol class="kto-rule-list">${t.start.rules
    .map((r, i) => `<li><img src="${icons![i % icons!.length]}" width="40" height="40" alt=""><span>${r}</span></li>`)
    .join('')}</ol>`;
}

export const RULES_CSS = `
.kto-rule-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;text-align:left}
.kto-rule-list li{display:flex;align-items:center;gap:10px;padding:8px 10px;background:#262b44;box-shadow:0 0 0 2px #181425;
  font-size:9px;line-height:1.8;color:#c0cbdc}
.kto-rule-list img{flex:none;width:40px;height:40px;image-rendering:pixelated;image-rendering:crisp-edges}
.kto-rule-list b{color:#ead4aa;font-weight:normal}
`;
