/**
 * «Поделиться» для текста, картинки и видео. Порядок попыток:
 *  1) системное меню с файлом (iOS, Android, часть десктопов);
 *  2) без поддержки файлов — скачать файл и скопировать текст;
 *  3) только текст — системное меню или буфер обмена.
 * Вызывать прямо из обработчика нажатия: браузеры пускают в меню только по жесту пользователя.
 */
export type ShareResult = 'shared' | 'cancelled' | 'downloaded' | 'copied' | 'failed';

export interface ShareInput {
  text: string;
  url: string;
  files?: File[];
}

export async function shareContent({ text, url, files }: ShareInput): Promise<ShareResult> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  const full = `${text} ${url}`;
  if (files?.length) {
    if (nav.share && nav.canShare?.({ files })) {
      try {
        // с файлом часть мессенджеров теряет поле url — кладём ссылку в текст
        await nav.share({ files, text: full });
        return 'shared';
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return 'cancelled';
        // NotAllowedError (истёк жест) и прочее — скачиваем
      }
    }
    for (const f of files) download(f);
    await copy(full);
    return 'downloaded';
  }
  if (nav.share) {
    try {
      await nav.share({ text, url });
      return 'shared';
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return 'cancelled';
    }
  }
  return (await copy(full)) ? 'copied' : 'failed';
}

export function download(f: Blob & { name?: string }, name = f.name ?? 'kto-tut-zhivoy'): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(f);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

async function copy(s: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch {
    return false;
  }
}

/** Адрес игры для подписи на клипе и карточке: без протокола. */
export function siteLabel(): string {
  return typeof location === 'undefined' ? 'who-is-alive.vercel.app' : location.host;
}
