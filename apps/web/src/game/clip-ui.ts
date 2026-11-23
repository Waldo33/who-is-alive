import { fmt } from '@kto/game-core';
import type { Dict } from '@kto/game-core';
import { ClipPlayerScene, pickClipMime, recordClip } from './clip';
import { loadTheme } from './themes';
import { getAudio } from './audio';
import type { ClipInput, ClipResult } from './clip';
import { shareableClip } from '../lib/clips';
import type { SharedClip } from '../lib/clips';
import { inTelegram, telegramClipCaps, telegramClipSave, telegramClipStory, telegramShareCard } from '../lib/telegram';

/** Подпись клипа и учёт действий внутри Telegram (сторис, видео в чат, «Сохранить»). */
export interface ClipShareOpts {
  text: string;
  onTelegram?: (what: 'story' | 'chat' | 'save', ok: boolean) => void;
}

/**
 * Экран монтажа поверх игры: превью клипа вживую, прогресс, затем «Отправить / Сохранить / Закрыть».
 * Отправка — отдельным нажатием: системное меню открывается только по свежему жесту пользователя.
 */
export function openClipOverlay(
  parent: HTMLElement,
  input: ClipInput,
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
  const scene = new ClipPlayerScene(input);
  scene.sound = getAudio().clipSound(); // музыка темы и звуки момента — в видео (не в динамики)
  root.querySelector('.clip-frame')!.appendChild(scene.c);
  status.textContent = fmt(t.clip.making, { n: 0 });

  void recordClip(scene, mime, (p) => {
    if (closed) return;
    status.textContent = fmt(t.clip.making, { n: Math.round(p * 100) });
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
  return clipViaTelegram(file) ? shareableClip(file) : null;
}

/** Клип видео-карточкой в чат Telegram (ждёт загрузку, если она ещё идёт). false — нужен обычный путь. */
export async function shareClipInTelegram(file: File, text: string): Promise<boolean> {
  if (!clipViaTelegram(file)) return false;
  const c = await shareableClip(file);
  return !!c && (await telegramShareCard({ kind: 'clip', clip: c.id, text, thumb: c.thumb }));
}

/** Можно ли записать клип в этом браузере. */
export function clipSupported(): boolean {
  return !!pickClipMime();
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
