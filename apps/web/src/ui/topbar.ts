import { DICTS, LANGS } from '@kto/game-core';
import type { Lang } from '@kto/game-core';
import { LANG_KEY } from '../lib/lang';
import { getAudio } from '../game/audio';
import { RULES_CSS, rulesHtml } from './rules';

/**
 * Верхняя панель всех экранов: «← Назад» слева и шестерёнка справа.
 * Шестерёнка открывает лист настроек: язык, звук и «Как играть».
 * Без фреймворка — одна реализация для страниц React, песочницы и экрана игры.
 */
export const SOUND_KEY = 'kto:sound';
export const MUSIC_KEY = 'kto:music';

export function musicEnabled(): boolean {
  try {
    const m = localStorage.getItem(MUSIC_KEY);
    return m ? m !== 'off' : soundEnabled();
  } catch {
    return true;
  }
}

export function soundEnabled(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

function saveSound(on: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
  } catch {
    /* приватный режим */
  }
}

export interface TopBarOptions {
  lang: Lang;
  /** Нет — переключателя языка в листе нет (например, посреди матча). */
  onLang?: (l: Lang) => void;
  /** Звуки игры (эффекты) вкл/выкл. Хранение настройки — в getAudio(). */
  onSound?: (on: boolean) => void;
  /** Музыка вкл/выкл. */
  onMusic?: (on: boolean) => void;
  /** Нет — кнопки «Назад» нет. */
  onBack?: () => void;
  /** Пункт «Выйти в меню» в листе (в игре). */
  onExit?: () => void;
  /** Показать только шестерёнку, без полосы (поверх игры). */
  floating?: boolean;
  /** Скрыть шестерёнку (в игре её роль играет кнопка на холсте). */
  noGear?: boolean;
  /** Квадратная кнопка «Поделиться» рядом с шестерёнкой (только главная). Вызывается из click — свежий жест. */
  onShare?: () => void;
}

export interface TopBar {
  update(o: Partial<TopBarOptions>): void;
  openSettings(section?: 'rules'): void;
  destroy(): void;
}

/** Пиксельная шестерёнка 12×12. */
const GEAR_ROWS = [
  '.....##.....',
  '..#..##..#..',
  '.##########.',
  '..########..',
  '..###..###..',
  '####....####',
  '####....####',
  '..###..###..',
  '..########..',
  '.##########.',
  '..#..##..#..',
  '.....##.....',
];
const GEAR = `<svg viewBox="0 0 12 12" width="24" height="24" aria-hidden="true" shape-rendering="crispEdges" fill="currentColor">${GEAR_ROWS.flatMap(
  (r, y) => [...r].map((c, x) => (c === '#' ? `<rect x="${x}" y="${y}" width="1" height="1"/>` : '')),
).join('')}</svg>`;

/** Пиксельный значок «Поделиться» 12×12: стрелка вверх из коробки. */
const SHARE_ROWS = [
  '.....##.....',
  '....####....',
  '...######...',
  '..##.##.##..',
  '.....##.....',
  '.##..##..##.',
  '.##..##..##.',
  '.##..##..##.',
  '.##......##.',
  '.##########.',
  '.##########.',
  '............',
];
const SHARE = `<svg viewBox="0 0 12 12" width="24" height="24" aria-hidden="true" shape-rendering="crispEdges" fill="currentColor">${SHARE_ROWS.flatMap(
  (r, y) => [...r].map((c, x) => (c === '#' ? `<rect x="${x}" y="${y}" width="1" height="1"/>` : '')),
).join('')}</svg>`;

export function mountTopBar(parent: HTMLElement, init: TopBarOptions): TopBar {
  ensureTopBarCss();
  let o: TopBarOptions = { ...init };
  const bar = document.createElement('div');
  bar.className = 'kto-topbar' + (o.floating ? ' floating' : '');
  bar.innerHTML = `<button type="button" class="kto-back"></button><button type="button" class="kto-share">${SHARE}</button><button type="button" class="kto-gear">${GEAR}</button>`;
  const sheet = document.createElement('div');
  sheet.className = 'kto-sheet';
  sheet.hidden = true;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  parent.appendChild(bar);
  document.body.appendChild(sheet);
  const back = bar.querySelector<HTMLButtonElement>('.kto-back')!;
  const gear = bar.querySelector<HTMLButtonElement>('.kto-gear')!;
  const share = bar.querySelector<HTMLButtonElement>('.kto-share')!;
  // не пускать касания к игре под панелью и листом
  for (const el of [bar, sheet]) for (const ev of ['pointerdown', 'pointerup', 'touchstart', 'touchend']) el.addEventListener(ev, (e) => e.stopPropagation());

  const render = () => {
    const t = DICTS[o.lang];
    back.hidden = !o.onBack;
    back.textContent = `< ${t.ui.back}`; // стрелки «←» нет в пиксельном шрифте
    gear.hidden = !!o.noGear;
    gear.setAttribute('aria-label', t.ui.settings);
    share.hidden = !o.onShare;
    share.setAttribute('aria-label', t.lobby.shareGame);
    if (sheet.hidden) return;
    const on = soundEnabled();
    const mus = musicEnabled();
    sheet.setAttribute('aria-label', t.ui.settings);
    sheet.innerHTML = `
      <div class="kto-sheet-box">
        <h2>${t.ui.settings}</h2>
        ${
          o.onLang
            ? `<div class="kto-set"><span>${t.ui.language}</span><div class="kto-seg" role="group" aria-label="${t.ui.language}">
                ${LANGS.map((l) => `<button type="button" data-lang="${l}" aria-pressed="${l === o.lang}">${l.toUpperCase()}</button>`).join('')}
               </div></div>`
            : ''
        }
        <div class="kto-set"><span>${t.ui.music}</span><div class="kto-seg" role="group" aria-label="${t.ui.music}">
          <button type="button" data-music="on" aria-pressed="${mus}">${t.ui.on}</button>
          <button type="button" data-music="off" aria-pressed="${!mus}">${t.ui.off}</button>
        </div></div>
        <div class="kto-set"><span>${t.ui.sfx}</span><div class="kto-seg" role="group" aria-label="${t.ui.sfx}">
          <button type="button" data-sound="on" aria-pressed="${on}">${t.ui.on}</button>
          <button type="button" data-sound="off" aria-pressed="${!on}">${t.ui.off}</button>
        </div></div>
        <section class="kto-howto" id="kto-howto">
          <h3>${t.ui.howTo}</h3>
          ${o.onExit || location.pathname === '/learn' ? '' : `<a class="kto-learn" href="/learn">${t.tutorial.cta}</a>`}
          ${rulesHtml(t)}
        </section>
        <div class="kto-sheet-actions">
          ${o.onExit ? `<button type="button" class="kto-sheet-exit">${t.ui.exit}</button>` : ''}
          <button type="button" class="kto-sheet-close">${t.ui.close}</button>
        </div>
        <p class="kto-credit">${t.ui.author} · <a href="https://t.me/waldente" target="_blank" rel="noopener">@waldente</a></p>
      </div>`;
    sheet.querySelectorAll<HTMLButtonElement>('[data-lang]').forEach((b) =>
      b.addEventListener('click', () => {
        const l = b.dataset.lang as Lang;
        try {
          localStorage.setItem(LANG_KEY, l);
        } catch {
          /* приватный режим */
        }
        o.lang = l;
        o.onLang?.(l);
        render();
      }),
    );
    sheet.querySelectorAll<HTMLButtonElement>('[data-sound]').forEach((b) =>
      b.addEventListener('click', () => {
        const v = b.dataset.sound === 'on';
        saveSound(v);
        getAudio().setSfxEnabled(v);
        o.onSound?.(v);
        render();
      }),
    );
    sheet.querySelectorAll<HTMLButtonElement>('[data-music]').forEach((b) =>
      b.addEventListener('click', () => {
        const v = b.dataset.music === 'on';
        getAudio().setMusicEnabled(v);
        o.onMusic?.(v);
        render();
      }),
    );
    sheet.querySelector('.kto-sheet-close')!.addEventListener('click', close);
    sheet.querySelector('.kto-sheet-exit')?.addEventListener('click', () => {
      close();
      o.onExit?.();
    });
  };

  let openedAt = 0;
  const open = (section?: 'rules') => {
    openedAt = performance.now();
    sheet.hidden = false;
    render();
    (sheet.querySelector('.kto-sheet-close') as HTMLButtonElement | null)?.focus();
    if (section === 'rules') sheet.querySelector('#kto-howto')?.scrollIntoView({ block: 'start' });
  };
  const close = () => {
    sheet.hidden = true;
    sheet.innerHTML = '';
    gear.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !sheet.hidden) close();
  };
  sheet.addEventListener('click', (e) => {
    // тот же палец, что открыл лист (с холста игры), не должен сразу его закрыть
    if (e.target === sheet && performance.now() - openedAt > 400) close();
  });
  document.addEventListener('keydown', onKey);
  back.addEventListener('click', () => o.onBack?.());
  gear.addEventListener('click', () => open());
  share.addEventListener('click', () => o.onShare?.());
  render();

  return {
    update(p) {
      o = { ...o, ...p };
      render();
    },
    openSettings: open,
    destroy() {
      document.removeEventListener('keydown', onKey);
      bar.remove();
      sheet.remove();
    },
  };
}

export const TOPBAR_CSS = `
.kto-topbar-host{position:fixed;top:0;left:0;right:0;z-index:20;height:0}
.kto-topbar{position:absolute;top:0;left:0;right:0;z-index:20;display:flex;justify-content:space-between;align-items:center;
  padding:calc(8px + env(safe-area-inset-top)) calc(8px + env(safe-area-inset-right)) 0 calc(8px + env(safe-area-inset-left));pointer-events:none}
.kto-topbar button{pointer-events:auto;font:inherit;font-family:var(--font-pixel,'Press Start 2P'),monospace;font-size:10px;min-height:44px;min-width:44px;
  border:0;border-radius:0;background:#262b44;color:#ead4aa;box-shadow:0 0 0 2px #181425,0 3px 0 #181425;cursor:pointer;padding:0 12px;
  display:inline-flex;align-items:center;justify-content:center;gap:6px}
.kto-topbar button[hidden]{display:none}
.kto-topbar .kto-gear,.kto-topbar .kto-share{margin-left:auto;padding:0;width:44px;color:#c0cbdc}
.kto-topbar .kto-share:not([hidden])+.kto-gear{margin-left:12px}
.kto-topbar button:active{transform:translateY(2px);box-shadow:0 0 0 2px #181425}
.kto-topbar button:focus-visible{outline:2px solid #fee761;outline-offset:2px}
.kto-sheet{position:fixed;inset:0;z-index:60;background:rgba(24,20,37,.86);display:flex;align-items:flex-end;justify-content:center;
  font-family:var(--font-pixel,'Press Start 2P'),monospace;touch-action:manipulation}
.kto-sheet[hidden]{display:none}
.kto-sheet-box{width:100%;max-width:440px;max-height:88dvh;overflow:auto;background:#262b44;color:#ead4aa;
  box-shadow:0 0 0 2px #181425,0 0 0 4px #5a6988;padding:20px 16px calc(20px + env(safe-area-inset-bottom));margin:0 8px}
.kto-sheet h2{font-size:13px;color:#fee761;margin:0 0 18px;font-weight:normal}
.kto-sheet h3{font-size:11px;color:#fee761;margin:0 0 12px;font-weight:normal}
.kto-set{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:10px;margin-bottom:14px}
.kto-seg{display:flex;box-shadow:0 0 0 2px #181425}
.kto-seg button{font:inherit;font-size:10px;min-width:56px;min-height:44px;border:0;border-radius:0;background:#181425;color:#5a6988;cursor:pointer}
.kto-seg button[aria-pressed="true"]{background:#feae34;color:#181425}
.kto-seg button:focus-visible,.kto-sheet-actions button:focus-visible{outline:2px solid #fee761;outline-offset:2px}
.kto-howto{margin-top:20px;border-top:2px solid #181425;padding-top:16px}
.kto-howto ul{margin:0;padding:0 0 0 14px;font-size:9px;line-height:1.9;color:#c0cbdc}
.kto-howto li{margin-bottom:8px}
.kto-learn{display:flex;align-items:center;justify-content:center;min-height:48px;margin:0 0 16px;background:#2ce8f5;color:#181425;
  font-size:10px;text-decoration:none;box-shadow:0 4px 0 #0095e9,0 0 0 2px #181425}
.kto-learn:focus-visible{outline:2px solid #fee761;outline-offset:2px}
.kto-howto b{color:#ead4aa;font-weight:normal}
.kto-sheet-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap}
.kto-sheet-actions button{font:inherit;font-size:11px;min-height:48px;padding:0 16px;border:0;border-radius:0;cursor:pointer;
  background:#feae34;color:#181425;box-shadow:0 4px 0 #be4a2f,0 0 0 2px #181425}
.kto-sheet-actions .kto-sheet-exit{background:#181425;color:#ead4aa;box-shadow:0 0 0 2px #5a6988}
.kto-credit{margin:18px 0 0;font-size:8px;line-height:1.6;color:#5a6988;text-align:right}
.kto-credit a{color:#5a6988;text-decoration:none;padding:6px 0}
`;

let cssAdded = false;
export function ensureTopBarCss(): void {
  if (cssAdded || typeof document === 'undefined') return;
  cssAdded = true;
  const s = document.createElement('style');
  s.textContent = TOPBAR_CSS + RULES_CSS;
  document.head.appendChild(s);
}
