import { fmt } from '@kto/game-core';
import type { Dict } from '@kto/game-core';
import type { WireFilm } from '@kto/net';
import { ClipPlayerScene, pickClipMime, recordClip } from './clip';
import { loadTheme } from './themes';
import { getAudio } from './audio';
import { videoOff } from './video-switch';
import type { ClipInput, ClipResult } from './clip';
import { shareableClip } from '../lib/clips';
import type { SharedClip } from '../lib/clips';
import { inTelegram, telegramClipCaps, telegramClipSave, telegramClipStory, telegramShareCard } from '../lib/telegram';

/** Подпись клипа и учёт действий внутри Telegram (сторис, видео в чат, «Сохранить»). */
export interface ClipShareOpts {
  text: string;
  onTelegram?: (what: 'story' | 'chat' | 'save', ok: boolean) => void;
  /** Надпись монтажа вместо «Монтируем клип… {n}%» (фильм матча). */
  making?: string;
}

/** Что можно записать в видео: клип или фильм матча. */
type Recordable = Parameters<typeof recordClip>[0];

/** «Фильм матча» с игрового сервера (packages/net › ServerLink.film). */
export interface FilmFeed {
  /** Что с фильмом этого матча; null — сервер ничего не прислал (монтирует телефон). */
  current(): WireFilm | null;
  on(h: (f: WireFilm) => void): () => void;
  /** Ссылка на файл в хранилище клипов игрового сервера. */
  url(id: string, ext: string): string;
  /** Комната матча: под фильмом в чате — кнопка «Реванш» туда же (метка карточки бота или код). */
  rematch?: { code: string; invite?: string };
  /** Код загадки «Найди актёра» из этого фильма (сервер вырезал её из дублей); null — загадки нет. */
  puzzle?(): string | null;
}

/**
 * Экран монтажа поверх игры: превью клипа вживую, прогресс, затем «Отправить / Сохранить / Закрыть».
 * Отправка — отдельным нажатием: системное меню открывается только по свежему жесту пользователя.
 */
export function openClipOverlay(
  parent: HTMLElement,
  input: ClipInput | (() => Recordable),
  t: Dict,
  share: (file: File) => Promise<void>,
  save: (file: File) => void,
  opts?: ClipShareOpts,
): () => void {
  const root = document.createElement('div');
  root.className = 'clip-overlay';
  root.innerHTML = `
    <div class="clip-box">
      <div class="clip-frame"></div>
      <p class="clip-status" role="status"></p>
      <div class="clip-progress"><i></i></div>
      <div class="clip-actions" hidden>
        <button class="btn clip-send">${t.clip.send}</button>
        <button class="btn clip-story" hidden>${t.clip.story}</button>
        <button class="btn clip-save">${t.clip.save}</button>
      </div>
      <button class="btn clip-close">${t.clip.close}</button>
    </div>`;
  parent.appendChild(root);
  const status = root.querySelector<HTMLElement>('.clip-status')!;
  const bar = root.querySelector<HTMLElement>('.clip-progress i')!;
  const actions = root.querySelector<HTMLElement>('.clip-actions')!;
  // клики по экрану монтажа не должны доходить до игры под ним
  for (const ev of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click']) root.addEventListener(ev, (e) => e.stopPropagation());

  let closed = false;
  const close = () => {
    closed = true;
    root.remove();
  };
  root.querySelector('.clip-close')!.addEventListener('click', close);

  const mime = pickClipMime();
  if (!mime) {
    status.textContent = t.clip.noClip;
    root.querySelector<HTMLElement>('.clip-progress')!.hidden = true;
    return close;
  }
  const scene = typeof input === 'function' ? input() : new ClipPlayerScene(input);
  scene.sound = getAudio().clipSound(); // музыка темы и звуки момента — в видео (не в динамики)
  root.querySelector('.clip-frame')!.appendChild(scene.c);
  const making = (n: number) => (opts?.making ? `${opts.making} ${n}%` : fmt(t.clip.making, { n }));
  status.textContent = making(0);

  void recordClip(scene, mime, (p) => {
    if (closed) return;
    status.textContent = making(Math.round(p * 100));
    bar.style.width = `${Math.round(p * 100)}%`;
  })
    .then((res: ClipResult) => {
      if (closed) return;
      const file = new File([res.blob], `kto-tut-zhivoy.${res.ext}`, { type: res.mime });
      // Telegram: файл из встроенного браузера не отдать — клип уходит на игровой сервер сразу,
      // пока человек смотрит превью (к нажатию ссылка обычно готова); обложка — последний кадр
      const caps = inTelegram() ? telegramClipCaps(res.mime) : null;
      const tgClip = caps && (caps.story || caps.chat || caps.save) ? shareableClip(file, thumbOf(scene.c)) : null;
      let tgReady = false;
      void tgClip?.then(() => (tgReady = true));
      status.textContent = t.clip.ready;
      root.querySelector<HTMLElement>('.clip-progress')!.hidden = true;
      actions.hidden = false;
      // превью: готовое видео по кругу вместо холста
      const v = document.createElement('video');
      v.src = URL.createObjectURL(file);
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.autoplay = true;
      v.addEventListener('error', () => v.remove());
      scene.c.replaceWith(v);
      void v.play().catch(() => undefined);
      // Одно действие за раз: пока клип догружается, кнопки ждут — «Готовлю видео…»; нажали ещё —
      // выполнится только последнее нажатие и один раз (раньше каждое открывало своё окно)
      let next: ((c: SharedClip | null) => Promise<void>) | null = null;
      let running = false;
      const act = async (run: (c: SharedClip | null) => Promise<void>): Promise<void> => {
        next = run;
        if (running) return;
        running = true;
        if (!tgReady) {
          actions.classList.add('busy');
          status.textContent = t.clip.preparingLong;
        }
        const c = tgClip ? await tgClip : null;
        actions.classList.remove('busy');
        status.textContent = c || !tgClip ? t.clip.ready : t.clip.failed;
        const go = next;
        next = null;
        try {
          await go(c);
        } finally {
          running = false;
        }
      };
      const tg = async (what: 'story' | 'chat' | 'save', c: SharedClip | null, run: (c: SharedClip) => Promise<boolean> | boolean): Promise<boolean> => {
        const ok = !!c && (await run(c));
        opts?.onTelegram?.(what, ok);
        return ok;
      };
      const text = opts?.text ?? t.meta.title;
      root.querySelector('.clip-send')!.addEventListener('click', () => {
        // не Telegram — сразу системное меню (ему нужен свежий жест, без ожиданий)
        if (!caps?.chat) return void share(file);
        void act(async (c) => {
          if (!(await tg('chat', c, (x) => telegramShareCard({ kind: 'clip', clip: x.id, text, thumb: x.thumb })))) await share(file);
        });
      });
      const story = root.querySelector<HTMLButtonElement>('.clip-story')!;
      if (caps?.story) {
        story.hidden = false;
        story.addEventListener('click', () => {
          void act(async (c) => {
            if (!(await tg('story', c, (x) => telegramClipStory(x, text, t.meta.title)))) status.textContent = t.clip.failed;
          });
        });
      }
      root.querySelector('.clip-save')!.addEventListener('click', () => {
        if (!caps?.save) return save(file);
        void act(async (c) => {
          if (!(await tg('save', c, telegramClipSave))) save(file);
        });
      });
    })
    .catch(() => {
      if (!closed) status.textContent = t.clip.failed;
    });
  return close;
}

/** Файл готового фильма с сервера — один раз на ссылку (для системного «Поделиться» нужен сам файл). */
const filmFiles = new Map<string, Promise<File | null>>();
function filmFile(url: string): Promise<File | null> {
  let p = filmFiles.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b ? new File([b], 'massovka-film.mp4', { type: 'video/mp4' }) : null))
      .catch(() => null);
    filmFiles.set(url, p);
    void p.then((f) => !f && filmFiles.delete(url));
  }
  return p;
}

/**
 * «Фильм матча» с сервера: пока монтируется — «Монтируем фильм…», готов — видео по ссылке и
 * «Отправить / В сторис / Сохранить». В Telegram файл с телефона не грузится вовсе — он уже на сервере.
 * Сервер не смог — fallback (монтаж на телефоне).
 */
export function openFilmOverlay(
  parent: HTMLElement,
  feed: FilmFeed,
  t: Dict,
  share: (file: File) => Promise<void>,
  save: (file: File) => void,
  opts: ClipShareOpts & { fallback: () => void },
): () => void {
  const root = document.createElement('div');
  root.className = 'clip-overlay';
  root.innerHTML = `
    <div class="clip-box">
      <div class="clip-frame"></div>
      <p class="clip-status" role="status"></p>
      <div class="clip-progress"><i></i></div>
      <div class="clip-actions" hidden>
        <button class="btn clip-send">${t.clip.send}</button>
        <button class="btn clip-story" hidden>${t.clip.story}</button>
        <button class="btn clip-save">${t.clip.save}</button>
      </div>
      <button class="btn clip-close">${t.clip.close}</button>
    </div>`;
  parent.appendChild(root);
  const status = root.querySelector<HTMLElement>('.clip-status')!;
  const progress = root.querySelector<HTMLElement>('.clip-progress')!;
  const bar = progress.querySelector<HTMLElement>('i')!;
  const actions = root.querySelector<HTMLElement>('.clip-actions')!;
  for (const ev of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click']) root.addEventListener(ev, (e) => e.stopPropagation());
  let closed = false;
  let shown = false;
  // монтаж на сервере идёт ~10–15 с: полоска ползёт к 90%, пока не придёт готовый фильм
  let fake = 0;
  const timer = setInterval(() => {
    fake += (90 - fake) * 0.06;
    bar.style.width = `${Math.round(fake)}%`;
  }, 250);
  const close = () => {
    closed = true;
    clearInterval(timer);
    off();
    root.remove();
  };
  root.querySelector('.clip-close')!.addEventListener('click', close);
  const text = opts.text;

  const show = (f: Extract<WireFilm, { state: 'ready' }>) => {
    if (shown || closed) return;
    shown = true;
    clearInterval(timer);
    progress.hidden = true;
    status.textContent = t.clip.ready;
    const url = feed.url(f.id, f.ext);
    const shared: SharedClip = { id: f.id, ext: f.ext, url, thumb: f.thumb };
    const caps = inTelegram() ? telegramClipCaps('video/mp4') : null;
    // файл качаем сразу, пока смотрят: к «Отправить» он уже в памяти (меню «Поделиться» — только из свежего жеста)
    const file = caps?.chat && caps.save ? null : filmFile(url);
    let ready: File | null = null;
    void file?.then((x) => (ready = x));
    const v = document.createElement('video');
    v.src = url;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.autoplay = true;
    v.addEventListener('error', () => v.remove());
    root.querySelector('.clip-frame')!.appendChild(v);
    void v.play().catch(() => undefined);
    actions.hidden = false;
    const tg = async (what: 'story' | 'chat' | 'save', run: () => Promise<boolean> | boolean): Promise<boolean> => {
      const ok = await run();
      opts.onTelegram?.(what, ok);
      return ok;
    };
    /** Файл для системного меню: уже скачан — сразу (свежий жест), иначе дождаться. */
    const withFile = async (use: (x: File) => void | Promise<void>) => {
      const x = ready ?? (await (file ?? filmFile(url)));
      if (x) await use(x);
      else status.textContent = t.clip.failed;
    };
    root.querySelector('.clip-send')!.addEventListener('click', () => {
      if (caps?.chat) {
        void tg('chat', () => telegramShareCard({ kind: 'clip', clip: f.id, text, thumb: f.thumb, ...feed.rematch, ...filmPuzzle(feed) })).then(async (ok) => {
          if (!ok) await withFile(share);
        });
        return;
      }
      void withFile(share);
    });
    const story = root.querySelector<HTMLButtonElement>('.clip-story')!;
    if (caps?.story) {
      story.hidden = false;
      story.addEventListener('click', () => {
        void tg('story', () => telegramClipStory(shared, text, t.meta.title)).then((ok) => {
          if (!ok) status.textContent = t.clip.failed;
        });
      });
    }
    root.querySelector('.clip-save')!.addEventListener('click', () => {
      if (caps?.save) {
        void tg('save', () => telegramClipSave(shared)).then(async (ok) => {
          if (!ok) await withFile(save);
        });
        return;
      }
      void withFile(save);
    });
  };

  const onFilm = (f: WireFilm) => {
    if (closed) return;
    if (f.state === 'ready') show(f);
    else if (f.state === 'failed' && !shown) {
      // сервер не смог — смонтируем на телефоне
      close();
      opts.fallback();
    }
  };
  const off = feed.on(onFilm);
  status.textContent = t.clip.filmMaking;
  const cur = feed.current();
  if (cur) onFilm(cur);
  return close;
}

/** Обложка клипа для карточки в чате: кадр холста шириной 360 (×2 от пикселя клипа) в JPEG. */
function thumbOf(c: HTMLCanvasElement): Promise<Blob | null> {
  try {
    const o = document.createElement('canvas');
    o.width = 360;
    o.height = Math.round((c.height * 360) / c.width);
    const g = o.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.drawImage(c, 0, 0, o.width, o.height);
    return new Promise((r) => o.toBlob((b) => r(b), 'image/jpeg', 0.85));
  } catch {
    return Promise.resolve(null);
  }
}

/** Клип пойдёт в Telegram видео-карточкой (мы в Telegram, и он это умеет). */
export function clipViaTelegram(file: File): boolean {
  return inTelegram() && telegramClipCaps(file.type).chat;
}

/** Начать загрузку заранее (тот же файл второй раз не грузится). */
export function preloadClipForTelegram(file: File): Promise<SharedClip | null> | null {
  return clipViaTelegram(file) ? shareableClip(file, thumbFromVideo(file)) : null;
}

/**
 * Обложка из кадра середины видео (JPEG 360 px) — без неё карточка в чате пустая: Telegram берёт
 * обложку только в JPEG. Не вышло за 4 с (бывает в iOS) — без обложки.
 */
function thumbFromVideo(file: File): Promise<Blob | null> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    let over = false;
    const done = (b: Blob | null) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
      URL.revokeObjectURL(url);
      resolve(b);
    };
    const timer = setTimeout(() => done(null), 4000);
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.addEventListener('loadeddata', () => {
      v.currentTime = Number.isFinite(v.duration) && v.duration > 0 ? v.duration / 2 : 1;
    });
    v.addEventListener('seeked', () => {
      try {
        const c = document.createElement('canvas');
        c.width = 360;
        c.height = v.videoWidth ? Math.round((v.videoHeight * 360) / v.videoWidth) : 640;
        const g = c.getContext('2d')!;
        g.imageSmoothingEnabled = false;
        g.drawImage(v, 0, 0, c.width, c.height);
        c.toBlob((b) => done(b), 'image/jpeg', 0.85);
      } catch {
        done(null);
      }
    });
    v.addEventListener('error', () => done(null));
    v.src = url;
  });
}

/** Клип видео-карточкой в чат Telegram (ждёт загрузку, если она ещё идёт). false — нужен обычный путь. */
export async function shareClipInTelegram(file: File, text: string): Promise<boolean> {
  if (!clipViaTelegram(file)) return false;
  const c = await shareableClip(file, thumbFromVideo(file));
  return !!c && (await telegramShareCard({ kind: 'clip', clip: c.id, text, thumb: c.thumb }));
}

/** Можно ли записать клип в этом браузере (и не выключено ли видео аварийно). */
export function clipSupported(): boolean {
  return !videoOff() && !!pickClipMime();
}

/**
 * Записать клип в фоне, не закрывая игру: холст прячется в невидимый блок (часть браузеров
 * пишет видео только с холста, который есть в документе). Возвращает файл или null.
 */
export async function recordClipInBackground(input: ClipInput, onProgress?: (p: number) => void): Promise<File | null> {
  const mime = pickClipMime();
  if (!mime) return null;
  await loadTheme(input.rec.theme); // облик темы — до первого кадра
  const holder = document.createElement('div');
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1';
  const scene = new ClipPlayerScene(input);
  scene.sound = getAudio().clipSound();
  scene.c.style.width = '1px';
  scene.c.style.height = '1px';
  holder.appendChild(scene.c);
  document.body.appendChild(holder);
  try {
    const res = await recordClip(scene, mime, onProgress);
    return new File([res.blob], `kto-tut-zhivoy.${res.ext}`, { type: res.mime });
  } catch {
    return null;
  } finally {
    holder.remove();
  }
}

/**
 * Загадка из фильма — кнопкой «Найди актёра» под карточкой (бот ведёт её в игру внутри Telegram, а ссылку
 * на сайт из подписи убирает: в Telegram она открывалась в браузере).
 */
function filmPuzzle(feed: { puzzle?(): string | null }): { puzzle?: string } {
  const p = feed.puzzle?.() ?? null;
  return p && /^[A-Z2-9]{5}$/.test(p) ? { puzzle: p } : {};
}
