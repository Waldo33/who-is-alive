import { DEFAULT_CONFIG, DICTS, LANGS } from '@kto/game-core';
import { LANG_KEY, detectLang } from '../lib/lang';
import type { Dict, GameConfig, Lang } from '@kto/game-core';
import { PAL } from '@kto/assets';
import { Audio } from './audio';
import { bootGame } from './boot';
import type { RunningGame } from './boot';

/**
 * Оболочка песочницы: стартовый экран, «рамка автомата», заглушка горизонтали, дев-панель (?dev).
 * Используется и страницей Next.js, и автономным HTML-билдом.
 */
const CSS = `
.kto-root,.kto-root *{touch-action:manipulation}
.kto-stage,.kto-stage *{touch-action:none}
.kto-root{position:fixed;inset:0;-webkit-text-size-adjust:100%;text-size-adjust:100%;background:${PAL.ink};color:${PAL.sand};font-family:var(--kto-font);
  padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;
  overscroll-behavior:none;
  background-image:repeating-linear-gradient(0deg,${PAL.ink} 0 6px,${PAL.plum} 6px 7px);}
.kto-stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;}
.kto-stage canvas{image-rendering:pixelated;image-rendering:crisp-edges;
  box-shadow:0 0 0 2px ${PAL.night},0 0 0 4px ${PAL.ink},0 0 0 6px ${PAL.grape},0 0 0 8px ${PAL.ink};}
.kto-start{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:18px;padding:24px;text-align:center;z-index:5;background:${PAL.ink}ee;}
.kto-logo{font-size:22px;line-height:1.35;color:${PAL.yellow};text-shadow:3px 3px 0 ${PAL.rust},6px 6px 0 ${PAL.ink};margin:0;max-width:12ch}
.kto-tag{font-size:10px;color:${PAL.coral};margin:0}
.kto-rules{font-size:9px;line-height:1.9;color:${PAL.mist};max-width:34ch;margin:0;text-align:left}
.kto-rules b{color:${PAL.sand};font-weight:normal}
.kto-row{display:flex;gap:10px;align-items:center;font-size:9px}
.kto-input{font:inherit;font-size:16px;line-height:1.2;max-width:calc(100vw - 120px);background:${PAL.night};color:${PAL.white};border:2px solid ${PAL.dusk};
  padding:10px;width:14ch;outline:none;border-radius:0;-webkit-appearance:none;appearance:none}
.kto-input:focus-visible,.kto-btn:focus-visible{outline:2px solid ${PAL.yellow};outline-offset:2px}
.kto-btn{font:inherit;font-size:12px;color:${PAL.ink};background:${PAL.amber};border:0;padding:16px 22px;min-height:56px;
  box-shadow:0 4px 0 ${PAL.rust},0 0 0 2px ${PAL.ink};cursor:pointer;border-radius:0}
.kto-btn:active{transform:translateY(3px);box-shadow:0 1px 0 ${PAL.rust},0 0 0 2px ${PAL.ink}}
.kto-small{font-size:8px;color:${PAL.steel};max-width:36ch;line-height:1.8;margin:0}
.kto-check{display:flex;align-items:center;gap:8px;font-size:9px;color:${PAL.mist}}
.kto-check input{width:20px;height:20px;accent-color:${PAL.amber}}
.kto-lang{position:absolute;top:calc(12px + env(safe-area-inset-top));left:12px;display:flex;gap:0;box-shadow:0 0 0 2px ${PAL.dusk}}
.kto-lang button{font:inherit;font-size:9px;min-width:44px;min-height:36px;border:0;border-radius:0;background:${PAL.night};color:${PAL.steel};cursor:pointer}
.kto-lang button[aria-pressed="true"]{background:${PAL.dusk};color:${PAL.yellow}}
.kto-lang button:focus-visible{outline:2px solid ${PAL.yellow};outline-offset:2px}
.kto-rotate{position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:16px;
  background:${PAL.ink};z-index:20;font-size:11px;color:${PAL.sand};text-align:center;padding:24px}
@media (orientation:landscape) and (max-height:500px){.kto-rotate{display:flex}}
.kto-toast{position:absolute;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));transform:translateX(-50%);
  background:${PAL.night};color:${PAL.sand};font-size:9px;padding:10px 14px;box-shadow:0 0 0 2px ${PAL.ink};z-index:30;display:none}
.kto-dev{position:absolute;top:0;right:0;z-index:40;background:${PAL.night}f2;color:${PAL.mist};font:11px/1.4 ui-monospace,monospace;
  max-height:100%;overflow:auto;padding:8px;width:min(320px,90vw);display:none}
.kto-dev label{display:flex;justify-content:space-between;gap:6px;margin:2px 0}
.kto-dev input,.kto-dev select{width:90px;font:inherit;background:${PAL.ink};color:${PAL.white};border:1px solid ${PAL.dusk}}
.kto-dev-toggle{position:absolute;top:calc(4px + env(safe-area-inset-top));right:4px;z-index:41;font:10px ui-monospace,monospace;
  background:${PAL.grape};color:${PAL.white};border:0;padding:6px 8px}
@media (prefers-reduced-motion:reduce){.kto-btn:active{transform:none}}
`;

function randomName(t: Dict): string {
  const a = t.names.adj[Math.floor(Math.random() * t.names.adj.length)];
  const n = t.names.noun[Math.floor(Math.random() * t.names.noun.length)];
  return `${a} ${n}`;
}

export interface ShellOptions {
  /** CSS font-family пиксельного шрифта, например '"Press Start 2P"'. */
  fontFamily: string;
}

export function mountSandbox(root: HTMLElement, opts: ShellOptions): () => void {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  root.classList.add('kto-root');
  root.style.setProperty('--kto-font', opts.fontFamily);
  const dev = new URLSearchParams(location.search).has('dev');

  let lang = detectLang();
  let t = DICTS[lang];

  root.innerHTML = `
    <div class="kto-stage"></div>
    <section class="kto-start">
      <div class="kto-lang" role="group">
        ${LANGS.map((l) => `<button type="button" data-lang="${l}">${l.toUpperCase()}</button>`).join('')}
      </div>
      <h1 class="kto-logo"></h1>
      <p class="kto-tag"></p>
      <p class="kto-rules"></p>
      <label class="kto-row"><span class="kto-name-label"></span> <input class="kto-input" maxlength="14"></label>
      <label class="kto-check"><input type="checkbox" class="kto-kids"> <span class="kto-kids-label"></span></label>
      <button class="kto-btn kto-play"></button>
      <p class="kto-small"></p>
    </section>
    <div class="kto-rotate" role="alert"></div>
    <div class="kto-toast" role="status"></div>
    ${dev ? '<button class="kto-dev-toggle">dev</button><form class="kto-dev"></form>' : ''}
  `;
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const stage = root.querySelector<HTMLElement>('.kto-stage')!;
  const start = root.querySelector<HTMLElement>('.kto-start')!;
  const nameInput = root.querySelector<HTMLInputElement>('.kto-input')!;
  const kids = root.querySelector<HTMLInputElement>('.kto-kids')!;
  const toastEl = root.querySelector<HTMLElement>('.kto-toast')!;
  let saved = '';
  try {
    saved = localStorage.getItem('kto:name') ?? '';
  } catch {
    saved = '';
  }
  let nameIsRandom = !saved;
  nameInput.value = saved || randomName(t);
  nameInput.addEventListener('input', () => (nameIsRandom = false));

  const applyLang = () => {
    t = DICTS[lang];
    document.documentElement.lang = lang;
    document.title = t.meta.title;
    $('.kto-start').setAttribute('aria-label', t.start.aria);
    $('.kto-lang').setAttribute('aria-label', t.start.language);
    root.querySelectorAll<HTMLButtonElement>('.kto-lang button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
    $('.kto-logo').textContent = t.meta.title;
    $('.kto-tag').textContent = t.meta.tagline;
    $('.kto-rules').innerHTML = t.start.rules.join('<br>');
    $('.kto-name-label').textContent = t.start.name;
    nameInput.setAttribute('aria-label', t.start.nameAria);
    $('.kto-kids-label').textContent = t.start.kids;
    $('.kto-play').textContent = t.start.play;
    $('.kto-small').textContent = t.start.note;
    $('.kto-rotate').textContent = t.start.rotate;
    if (nameIsRandom) nameInput.value = randomName(t);
    const devBtn = root.querySelector<HTMLButtonElement>('.kto-dev .kto-btn');
    if (devBtn) devBtn.textContent = t.start.devApply;
  };
  root.querySelectorAll<HTMLButtonElement>('.kto-lang button').forEach((b) =>
    b.addEventListener('click', () => {
      lang = b.dataset.lang as Lang;
      try {
        localStorage.setItem(LANG_KEY, lang);
      } catch {
        /* приватный режим */
      }
      applyLang();
    }),
  );
  applyLang();

  const audio = new Audio();
  let running: RunningGame | null = null;
  let overrides: Partial<GameConfig> = {};

  const toast = (s: string) => {
    toastEl.textContent = s;
    toastEl.style.display = 'block';
    setTimeout(() => (toastEl.style.display = 'none'), 2200);
  };

  const onShare = async (text: string) => {
    const url = location.origin + location.pathname;
    try {
      if (navigator.share) {
        await navigator.share({ text, url });
        return;
      }
    } catch {
      return; // пользователь закрыл меню
    }
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      toast(t.start.copied);
    } catch {
      toast(text);
    }
  };

  // Никакого масштабирования страницы: щипок, двойной тап, зум при фокусе поля.
  // iOS Safari игнорирует user-scalable=no, поэтому гасим жесты вручную.
  const block = (e: Event) => e.preventDefault();
  const isField = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
  let lastTouchEnd = 0;
  const noDoubleTap = (e: TouchEvent) => {
    const now = performance.now();
    if (now - lastTouchEnd < 350 && !isField(e.target)) e.preventDefault();
    lastTouchEnd = now;
  };
  const noPinch = (e: TouchEvent) => {
    if (e.touches.length > 1) e.preventDefault();
  };
  const noMove = (e: TouchEvent) => {
    if (!(e.target instanceof Element && e.target.closest('.kto-dev'))) e.preventDefault();
  };
  const gestureEvents = ['gesturestart', 'gesturechange', 'gestureend', 'dblclick'];
  for (const ev of gestureEvents) document.addEventListener(ev, block, { passive: false });
  document.addEventListener('touchend', noDoubleTap, { passive: false });
  document.addEventListener('touchstart', noPinch, { passive: false });
  root.addEventListener('touchmove', noMove, { passive: false });
  // если поле ввода всё же увеличило страницу — вернуть масштаб после потери фокуса
  nameInput.addEventListener('blur', () => window.scrollTo(0, 0));

  root.querySelector('.kto-play')!.addEventListener('click', async () => {
    audio.unlock();
    audio.play('ready');
    const playerName = nameInput.value.trim().slice(0, 14) || randomName(t);
    try {
      localStorage.setItem('kto:name', playerName);
    } catch {
      /* приватный режим */
    }
    start.style.display = 'none';
    const cfg = { ...overrides, kidsMode: kids.checked };
    if (running) running.restart({ playerName, cfg, lang });
    else {
      const speed = dev ? Number(new URLSearchParams(location.search).get('speed')) || 1 : 1;
      running = await bootGame(stage, { playerName, fontFamily: opts.fontFamily, audio, cfg, onShare, timeScale: speed, lang });
      if (dev) (window as unknown as { __kto: RunningGame }).__kto = running;
    }
  });

  if (dev) {
    const form = root.querySelector<HTMLFormElement>('.kto-dev')!;
    root.querySelector('.kto-dev-toggle')!.addEventListener('click', () => {
      form.style.display = form.style.display === 'block' ? 'none' : 'block';
    });
    const keys = Object.entries(DEFAULT_CONFIG).filter(([, v]) => typeof v === 'number') as [keyof GameConfig, number][];
    form.innerHTML =
      keys.map(([k, v]) => `<label>${k}<input name="${k}" type="number" step="any" value="${v}"></label>`).join('') +
      `<label>attackConfirm<select name="attackConfirm"><option>tap</option><option>hold</option></select></label>
       <button class="kto-btn" style="font-size:10px;margin-top:8px">${t.start.devApply}</button>`;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const o: Record<string, unknown> = {};
      for (const [k, v] of keys) {
        const n = Number(fd.get(k));
        if (Number.isFinite(n) && n !== v) o[k] = n;
      }
      o.attackConfirm = fd.get('attackConfirm');
      overrides = o as Partial<GameConfig>;
      form.style.display = 'none';
      running?.restart({ cfg: { ...overrides, kidsMode: kids.checked }, lang });
      toast(t.start.devApplied);
    });
  }

  return () => {
    running?.destroy();
    for (const ev of gestureEvents) document.removeEventListener(ev, block);
    document.removeEventListener('touchend', noDoubleTap);
    document.removeEventListener('touchstart', noPinch);
    style.remove();
    root.innerHTML = '';
  };
}
