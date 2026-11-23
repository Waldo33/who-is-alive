import { fmt } from '@kto/game-core';
import type { Dict } from '@kto/game-core';
import { ClipPlayerScene, pickClipMime, recordClip } from './clip';
import { loadTheme } from './themes';
import { getAudio } from './audio';
import type { ClipInput, ClipResult } from './clip';
import { inTelegram, telegramClipCaps, telegramClipSave, telegramClipStory, telegramShareCard, telegramUploadClip } from '../lib/telegram';
import type { TgClip } from '../lib/telegram';

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
      // Telegram: файл из встроенного браузера не отдать — клип уходит на сервер бота сразу,
      // пока человек смотрит превью; обложка — последний кадр (заставка с итогом)
      const caps = inTelegram() ? telegramClipCaps(res.mime) : null;
      const tgClip: Promise<TgClip | null> | null =
        caps && (caps.story || caps.chat || caps.save) ? thumbOf(scene.c).then((th) => telegramUploadClip(file, th)) : null;
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
      const viaTg = async (what: 'story' | 'chat' | 'save', run: (c: TgClip) => Promise<boolean> | boolean): Promise<boolean> => {
        // пока клип грузится на сервер — кнопки ждут (нажатие не теряется)
        actions.classList.add('busy');
        const c = tgClip && (await tgClip);
        actions.classList.remove('busy');
        const ok = !!c && (await run(c));
        opts?.onTelegram?.(what, ok);
        return ok;
      };
      const text = opts?.text ?? t.meta.title;
      root.querySelector('.clip-send')!.addEventListener('click', () => {
        void (async () => {
          if (caps?.chat && (await viaTg('chat', (c) => telegramShareCard({ kind: 'clip', clip: c.id, text })))) return;
          await share(file);
        })();
      });
      const story = root.querySelector<HTMLButtonElement>('.clip-story')!;
      if (caps?.story) {
        story.hidden = false;
        story.addEventListener('click', () => {
          void viaTg('story', (c) => telegramClipStory(c, text, t.meta.title)).then((ok) => {
            if (!ok) status.textContent = t.clip.failed;
          });
        });
      }
      root.querySelector('.clip-save')!.addEventListener('click', () => {
        void (async () => {
          if (caps?.save && (await viaTg('save', telegramClipSave))) return;
          save(file);
        })();
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

/** Клип видео-карточкой в чат Telegram (загрузка — по нажатию). false — не вышло, нужен обычный путь. */
export async function shareClipInTelegram(file: File, text: string): Promise<boolean> {
  if (!inTelegram() || !telegramClipCaps(file.type).chat) return false;
  const c = await telegramUploadClip(file);
  return !!c && (await telegramShareCard({ kind: 'clip', clip: c.id, text }));
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
