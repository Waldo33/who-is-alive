import { fmt } from '@kto/game-core';
import type { Dict } from '@kto/game-core';
import { ClipPlayerScene, pickClipMime, recordClip } from './clip';
import { loadTheme } from './themes';
import { getAudio } from './audio';
import type { ClipInput, ClipResult } from './clip';

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
      root.querySelector('.clip-send')!.addEventListener('click', () => void share(file));
      root.querySelector('.clip-save')!.addEventListener('click', () => save(file));
    })
    .catch(() => {
      if (!closed) status.textContent = t.clip.failed;
    });
  return close;
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
