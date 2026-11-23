import { DEFAULT_CONFIG, DICTS, THEME_RULES } from '@kto/game-core';
import { detectLang } from '../lib/lang';
import { download, shareContent, withLang } from '../lib/share';
import { setTrackContext, shareKind, track } from '../lib/analytics';
import { tutorialDone } from './tutorial';
import { mountTopBar } from '../ui/topbar';
import type { TopBarOptions } from '../ui/topbar';
import type { Dict, GameConfig, Lang } from '@kto/game-core';
import { PAL } from '@kto/assets';
import { getAudio } from './audio';
import { bootGame } from './boot';
import type { RunningGame } from './boot';
import { newYearSeason } from './newyear';

/**
 * Оболочка песочницы: стартовый экран, «рамка автомата», заглушка горизонтали, дев-панель (?dev).
 * Используется и страницей Next.js, и автономным HTML-билдом.
 */
const CSS = `
.kto-root,.kto-root *{touch-action:manipulation}
.kto-stage,.kto-stage *{touch-action:none}
.kto-root{position:fixed;inset:0;-webkit-text-size-adjust:100%;text-size-adjust:100%;background:${PAL.ink};color:${PAL.sand};font-family:var(--kto-font);
  padding:var(--sat, env(safe-area-inset-top)) env(safe-area-inset-right) var(--sab, env(safe-area-inset-bottom)) env(safe-area-inset-left);
  overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;
  overscroll-behavior:none;
  background-image:repeating-linear-gradient(0deg,${PAL.ink} 0 6px,${PAL.plum} 6px 7px);}
.kto-stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;}
.kto-stage canvas{image-rendering:pixelated;image-rendering:crisp-edges;
  box-shadow:0 0 0 2px ${PAL.night},0 0 0 4px ${PAL.ink},0 0 0 6px ${PAL.grape},0 0 0 8px ${PAL.ink};}
.kto-start{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;
  gap:16px;padding:calc(68px + var(--sat, env(safe-area-inset-top))) 16px calc(24px + var(--sab, env(safe-area-inset-bottom)));text-align:center;z-index:5;
  background:${PAL.ink}ee;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;touch-action:pan-y}
.kto-start>:first-child{margin-top:auto}.kto-start>:last-child{margin-bottom:auto}
.kto-root .kto-topbar{padding-bottom:12px;background:linear-gradient(${PAL.ink} 75%, transparent)}
.kto-logo{font-size:22px;line-height:1.35;color:${PAL.yellow};text-shadow:3px 3px 0 ${PAL.rust},6px 6px 0 ${PAL.ink};margin:0;max-width:12ch}
.kto-tag{font-size:10px;color:${PAL.coral};margin:0}
/* подпись над полем: поле во всю ширину вмещает имя целиком (14 знаков пиксельным шрифтом 16px) */
.kto-row{display:flex;flex-direction:column;gap:8px;align-items:center;font-size:9px;width:100%}
.kto-input{font:inherit;font-size:16px;line-height:1.2;max-width:100%;background:${PAL.night};color:${PAL.white};border:2px solid ${PAL.dusk};
  padding:10px 12px;min-height:44px;width:calc(14ch + 32px);text-align:center;outline:none;border-radius:0;-webkit-appearance:none;appearance:none}
.kto-input:focus-visible,.kto-btn:focus-visible{outline:2px solid ${PAL.yellow};outline-offset:2px}
.kto-btn{font:inherit;font-size:12px;color:${PAL.ink};background:${PAL.amber};border:0;padding:16px 22px;min-height:56px;
  box-shadow:0 4px 0 ${PAL.rust},0 0 0 2px ${PAL.ink};cursor:pointer;border-radius:0}
.kto-btn:active{transform:translateY(3px);box-shadow:0 1px 0 ${PAL.rust},0 0 0 2px ${PAL.ink}}
.kto-small{font-size:8px;color:${PAL.slate};max-width:36ch;line-height:1.8;margin:0}
.kto-check{display:flex;align-items:center;gap:8px;min-height:44px;margin:-9px 0;font-size:9px;color:${PAL.mist}}
.kto-hint{font-size:8px;line-height:1.8;color:${PAL.slate};max-width:34ch;margin:-10px 0 0;text-align:center}
.kto-check input{width:20px;height:20px;accent-color:${PAL.amber}}
/* переключатель из трёх сегментов — тот же вид, что «RU / EN» в листе настроек */
.kto-seg3{display:flex;box-shadow:0 0 0 2px ${PAL.dusk}}
.kto-seg3 button{font:inherit;font-size:10px;min-width:84px;min-height:44px;padding:0 8px;border:0;border-radius:0;background:${PAL.ink};color:${PAL.slate};cursor:pointer}
.kto-seg3 button[aria-checked='true']{background:${PAL.dusk};color:${PAL.yellow};box-shadow:inset 0 -3px 0 ${PAL.amber}}
.kto-seg3 button:focus-visible{outline:2px solid ${PAL.yellow};outline-offset:2px}
.kto-diff-hint{margin-top:-8px}
.kto-rotate{position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:16px;
  background:${PAL.ink};z-index:20;font-size:11px;color:${PAL.sand};text-align:center;padding:24px}
@media (orientation:landscape) and (max-height:500px){.kto-rotate{display:flex}}
.kto-toast{position:absolute;left:50%;bottom:calc(16px + var(--sab, env(safe-area-inset-bottom)));transform:translateX(-50%);
  background:${PAL.night};color:${PAL.sand};font-size:9px;padding:10px 14px;box-shadow:0 0 0 2px ${PAL.ink};z-index:30;display:none}
.kto-dev{position:absolute;top:0;right:0;z-index:40;background:${PAL.night}f2;color:${PAL.mist};font:11px/1.4 ui-monospace,monospace;
  max-height:100%;overflow:auto;padding:8px;width:min(320px,90vw);display:none}
.kto-dev label{display:flex;justify-content:space-between;gap:6px;margin:2px 0}
.kto-dev input,.kto-dev select{width:90px;font:inherit;background:${PAL.ink};color:${PAL.white};border:1px solid ${PAL.dusk}}
.kto-dev-toggle{position:absolute;top:calc(4px + var(--sat, env(safe-area-inset-top)));right:4px;z-index:41;font:10px ui-monospace,monospace;
  background:${PAL.grape};color:${PAL.white};border:0;padding:6px 8px}
@media (prefers-reduced-motion:reduce){.kto-btn:active{transform:none}}
`;

/** Имена — до 14 знаков: длиннее в итогах и подписях клипа не помещаются целиком. */
function randomName(t: Dict): string {
  for (let i = 0; i < 20; i++) {
    const a = t.names.adj[Math.floor(Math.random() * t.names.adj.length)];
    const n = t.names.noun[Math.floor(Math.random() * t.names.noun.length)];
    if (a.length + 1 + n.length <= 14) return `${a} ${n}`;
  }
  return t.names.noun[0];
}

export interface ShellOptions {
  /** CSS font-family пиксельного шрифта, например '"Press Start 2P"'. */
  fontFamily: string;
}

export function mountSandbox(root: HTMLElement, opts: ShellOptions): () => void {
  // новичок играет сразу: обучение — по желанию («Как играть»), в первом матче — подсказки сцены
  setTrackContext({ mode: 'sandbox' });
  if (!tutorialDone()) track('page_view', { page: 'sandbox', first: true });
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
      <h1 class="kto-logo"></h1>
      <p class="kto-tag"></p>
      <label class="kto-row"><span class="kto-name-label"></span> <input class="kto-input" maxlength="14"></label>
      <div class="kto-row"><span class="kto-diff-label"></span>
        <div class="kto-seg3" role="radiogroup">
          <button type="button" role="radio" data-d="easy"></button><button type="button" role="radio" data-d="normal"></button><button type="button" role="radio" data-d="hard"></button>
        </div>
      </div>
      <p class="kto-hint kto-diff-hint"></p>
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
  // Сложность одним переключателем: лёгкая = kidsMode, жёсткая = strictCrowd, обычная — оба выкл.
  // Запоминается (kto:diff; старый флажок kto:strict = жёсткая): «Играть» с главной (?go) пропускает этот экран
  type Diff = 'easy' | 'normal' | 'hard';
  let diff: Diff = 'normal';
  try {
    const d = localStorage.getItem('kto:diff');
    diff = d === 'easy' || d === 'hard' ? d : d === 'normal' ? 'normal' : localStorage.getItem('kto:strict') === '1' ? 'hard' : 'normal';
  } catch {
    /* приватный режим */
  }
  const diffBtns = [...root.querySelectorAll<HTMLButtonElement>('.kto-seg3 button')];
  const kids = { get checked() { return diff === 'easy'; } };
  const strict = { get checked() { return diff === 'hard'; } };
  const showDiff = () => {
    for (const b of diffBtns) b.setAttribute('aria-checked', String(b.dataset.d === diff));
    $('.kto-diff-hint').textContent = t.start.levelHints[diff];
  };
  for (const b of diffBtns) {
    b.addEventListener('click', () => {
      diff = b.dataset.d as Diff;
      try {
        localStorage.setItem('kto:diff', diff);
        localStorage.setItem('kto:strict', diff === 'hard' ? '1' : '0');
      } catch {
        /* приватный режим */
      }
      showDiff();
    });
  }
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
    $('.kto-logo').textContent = t.meta.title;
    $('.kto-tag').textContent = t.meta.tagline;
    $('.kto-name-label').textContent = t.start.name;
    nameInput.setAttribute('aria-label', t.start.nameAria);
    $('.kto-diff-label').textContent = t.start.difficulty;
    for (const b of diffBtns) b.textContent = t.start.levels[b.dataset.d as Diff];
    showDiff();
    $('.kto-play').textContent = t.start.play;
    $('.kto-small').textContent = t.start.note;
    $('.kto-rotate').textContent = t.start.rotate;
    if (nameIsRandom) nameInput.value = randomName(t);
    const devBtn = root.querySelector<HTMLButtonElement>('.kto-dev .kto-btn');
    if (devBtn) devBtn.textContent = t.start.devApply;
  };
  applyLang();
  track('page_view', { page: 'sandbox' });

  const audio = getAudio();
  // музыка меню на стартовом экране (заиграет после первого касания — так требуют браузеры)
  audio.setMusic('menu');
  let running: RunningGame | null = null;

  // «← Назад» на главную и шестерёнка (язык, звук, правила). В игре — только лист по шестерёнке на холсте.
  const standalone = location.protocol === 'file:';
  const menuOpts = (): TopBarOptions => ({
    lang,
    onLang: (l: Lang) => {
      lang = l;
      applyLang();
    },
    onBack: standalone ? undefined : () => location.assign('/'),
    onExit: undefined,
    noGear: false,
  });
  const bar = mountTopBar(root, menuOpts());
  const exitToMenu = () => {
    track('match_exit');
    running?.destroy();
    running = null;
    stage.innerHTML = '';
    start.style.display = '';
    bar.update(menuOpts());
    audio.setMusic('menu');
  };
  const gameOpts = (): Partial<TopBarOptions> => ({ onLang: undefined, onBack: undefined, onExit: exitToMenu, noGear: true });
  let overrides: Partial<GameConfig> = {};
  // ?dev&theme=N — все дубли в одной теме (посмотреть новую площадку)
  const themeQ = dev ? new URLSearchParams(location.search).get('theme') : null;
  if (themeQ !== null && Number.isInteger(Number(themeQ))) overrides = { fixedTheme: Number(themeQ) };
  // под Новый год матч открывается «Корпоративом» (как на сервере; ?season=ny — посмотреть вне сезона)
  else if (newYearSeason()) overrides = { leadTheme: THEME_RULES.findIndex((r) => r.id === 'party') };

  const toast = (s: string) => {
    toastEl.textContent = s;
    toastEl.style.display = 'block';
    setTimeout(() => (toastEl.style.display = 'none'), 2200);
  };

  const onShare = async (text: string, files?: File[]) => {
    const kind = shareKind(files);
    const res = await shareContent({ text, url: withLang(location.origin + '/', kind), files });
    track('share', { what: kind, result: res });
    if (res === 'copied') toast(t.start.copied);
    if (res === 'failed') toast(text);
  };
  const onSave = (file: File) => download(file);

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
    // прокрутка разрешена только в дев-панели и на стартовом экране (если он не помещается)
    if (!(e.target instanceof Element && e.target.closest('.kto-dev, .kto-start'))) e.preventDefault();
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
    bar.update(gameOpts());
    const cfg = { ...overrides, kidsMode: kids.checked, strictCrowd: strict.checked };
    if (running) running.restart({ playerName, cfg, lang });
    else {
      const speed = dev ? Number(new URLSearchParams(location.search).get('speed')) || 1 : 1;
      // ?dev&watch — стенд зрителя без сети: хост с четырьмя ИИ на петле в памяти, ты смотришь с задержкой
      const watch = dev && new URLSearchParams(location.search).has('watch') ? await devSpectator(cfg) : undefined;
      running = await bootGame(stage, {
        ...watch,
        playerName,
        fontFamily: opts.fontFamily,
        audio,
        cfg,
        onShare,
        onSave,
        onSettings: () => bar.openSettings(),
        onEvent: track,
        // на сайте (не в автономном файле): после матча с ИИ — «С друзьями», создать комнату на главной
        onInvite: standalone ? undefined : () => location.assign('/?create=1'),
        timeScale: speed,
        lang,
      });
      if (dev) (window as unknown as { __kto: RunningGame }).__kto = running;
    }
  });

  // «Играть» на главной (?go): сразу в матч, без стартового экрана. Звук включится с первым касанием.
  if (new URLSearchParams(location.search).has('go')) {
    track('quick_play');
    root.querySelector<HTMLButtonElement>('.kto-play')!.click();
  }

  if (dev) {
    const form = root.querySelector<HTMLFormElement>('.kto-dev')!;
    root.querySelector('.kto-dev-toggle')!.addEventListener('click', () => {
      form.style.display = form.style.display === 'block' ? 'none' : 'block';
    });
    const keys = Object.entries(DEFAULT_CONFIG).filter(([, v]) => typeof v === 'number') as [keyof GameConfig, number][];
    form.innerHTML =
      keys.map(([k, v]) => `<label>${k}<input name="${k}" type="number" step="any" value="${overrides[k] ?? v}"></label>`).join('') +
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
      running?.restart({ cfg: { ...overrides, kidsMode: kids.checked, strictCrowd: strict.checked }, lang });
      toast(t.start.devApplied);
    });
  }

  return () => {
    running?.destroy();
    bar.destroy();
    for (const ev of gestureEvents) document.removeEventListener(ev, block);
    document.removeEventListener('touchend', noDoubleTap);
    document.removeEventListener('touchstart', noPinch);
    style.remove();
    root.innerHTML = '';
  };
}

/** Стенд зрителя (?dev&watch): матч ИИ на хосте в этой же вкладке, зритель подключается посреди дубля. */
async function devSpectator(cfg: Partial<GameConfig>) {
  const [net, core] = await Promise.all([import('@kto/net'), import('@kto/game-core')]);
  const hub = new net.LoopbackHub(3);
  hub.latency = [40, 90];
  const players = ['h', 'a', 'b', 'c'].map((pid, i) => ({ pid, name: ['Режиссёр', 'Батон', 'Пиксель', 'Кот'][i], color: i }));
  const tHost = hub.join({ userId: 'h', name: 'h', color: 0, joinedAt: 0 });
  cfg = { ...cfg, roundSec: 30 }; // короткие дубли — быстрее дождаться следующего
  const host = new net.HostSession({ transport: tHost, players, cfg, seed: 11, hostPid: 'h' });
  players.forEach((p, i) => host.sim.addAgent(new core.AiPlayer(p.pid, 100 + i)));
  setInterval(() => host.tick(), core.TICK_MS);
  // дубль уже идёт
  await new Promise((r) => setTimeout(r, 6000));
  const raw = hub.join({ userId: 'spy', name: 'spy', color: 9, joinedAt: 9 });
  const delay = 4000;
  const spy = new net.RemoteSession({ transport: new net.DelayedTransport(raw, delay), selfPid: 'spy', hostPid: 'h', players, cfg, spectator: true });
  return {
    createSession: () => spy,
    spectator: { delaySec: delay / 1000, watching: () => spy.watching },
    onRematch: () => false,
  };
}

