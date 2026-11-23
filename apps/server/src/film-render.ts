/**
 * Монтаж «Фильма матча» на сервере: те же сцены, что на телефоне (apps/web/src/game/film.ts),
 * рисуются через @napi-rs/canvas в 540×960, звук — офлайн через node-web-audio-api,
 * кодирует ffmpeg: растягивает ×2 без сглаживания до 1080×1920, H.264 + AAC, mp4 с faststart.
 * Работает в отдельном процессе (film-worker.ts): нативные модули и ffmpeg не мешают матчам.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DICTS, NavGrid } from '@kto/game-core';
import type { MatchSummary } from '@kto/game-core';
import { FilmScene, filmInput } from '../../web/src/game/film';
import type { FilmPlayer, FilmTake } from '../../web/src/game/film';
import { clipMix, makeNoise } from '../../web/src/game/clip-audio';
import { setCanvasFactory } from '../../web/src/game/pixels';
import { loadAllThemes } from '../../web/src/game/themes';

/** Что нужно для фильма (передаётся в процесс монтажа целиком). */
export interface FilmJob {
  takes: FilmTake[];
  players: FilmPlayer[];
  match: MatchSummary;
  lang: 'ru' | 'en';
  site: string;
  link: string;
}

export interface FilmRenderOpts {
  /** Папка со шрифтами Press Start 2P (woff кириллица и латиница). */
  fonts: string;
  /** Куда класть временные файлы. */
  tmp: string;
  ffmpeg?: string;
  /** Пресет x264 (по умолчанию ultrafast). */
  preset?: string;
}

export interface FilmRendered {
  /** Готовый mp4 во временной папке. */
  video: string;
  /** Обложка: первый кадр (крючок), JPEG 540×960. */
  thumb: Buffer;
  durationMs: number;
  renderMs: number;
}

/**
 * Холст 540×960 (×3 к игровым 180×320), ffmpeg растягивает ×2. При ×2 у пиксельного шрифта
 * только два чётких кегля (16 и 8 пикс.) — длинная подпись ужималась до нечитаемой; при ×3 есть 24 и 16.
 */
const W = 540;
const H = 960;
const SCALE = 3;
/**
 * 24 кадра в секунду — «киношные» и на пятую часть дешевле 30: vCPU сервера в Москве втрое медленнее
 * рабочего ядра, а фильм должен успеть за разоблачение и итоги последнего дубля (~22 с).
 */
const FPS = 24;
const RATE = 48000;
const FONT = '"Press Start 2P", "Press Start 2P Latin"';

type NapiCanvas = { encode(f: 'jpeg', q: number): Promise<Buffer>; getContext(k: '2d'): CanvasRenderingContext2D };

let ready: Promise<typeof import('@napi-rs/canvas')> | null = null;

/** Холсты и шрифт — один раз на процесс. */
function setup(fonts: string): Promise<typeof import('@napi-rs/canvas')> {
  ready ??= (async () => {
    const napi = await import('@napi-rs/canvas');
    // шрифт игры — два куска (кириллица и латиница с цифрами и знаками); Skia берёт недостающие буквы
    // из следующего семейства в списке FONT, а одно семейство из двух файлов не склеивает
    napi.GlobalFonts.registerFromPath(join(fonts, 'press-start-2p-cyrillic-400-normal.woff'), 'Press Start 2P');
    napi.GlobalFonts.registerFromPath(join(fonts, 'press-start-2p-latin-400-normal.woff'), 'Press Start 2P Latin');
    setCanvasFactory(() => napi.createCanvas(1, 1) as unknown as HTMLCanvasElement);
    await loadAllThemes();
    return napi;
  })();
  return ready;
}

/** Контекст с «виртуальными часами»: звук планируется по времени кадра, а рендерится потом целиком. */
function clocked<T extends object>(ctx: T, now: () => number): T {
  return new Proxy(ctx, {
    get(t, p) {
      if (p === 'currentTime') return now();
      const v = Reflect.get(t, p, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

/** WAV 16 бит стерео из буфера офлайн-рендера. */
function wav(buf: { numberOfChannels: number; length: number; getChannelData(c: number): Float32Array }): Buffer {
  const ch = Math.min(2, buf.numberOfChannels);
  const n = buf.length;
  const out = Buffer.alloc(44 + n * ch * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + n * ch * 2, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(ch, 22);
  out.writeUInt32LE(RATE, 24);
  out.writeUInt32LE(RATE * ch * 2, 28);
  out.writeUInt16LE(ch * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(n * ch * 2, 40);
  const data = [0, 1].slice(0, ch).map((c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      out.writeInt16LE(Math.round(s * 32767), o);
      o += 2;
    }
  }
  return out;
}

function run(ffmpeg: string, args: string[], input?: (stdin: NodeJS.WritableStream) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr!.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err}`))));
    if (input) {
      input(p.stdin!)
        .then(() => p.stdin!.end())
        .catch((e) => {
          p.kill('SIGKILL');
          reject(e);
        });
    }
  });
}

/** Смонтировать фильм. null — в матче нечего показать. */
export async function renderFilm(job: FilmJob, o: FilmRenderOpts): Promise<FilmRendered | null> {
  const t0 = performance.now();
  await setup(o.fonts);
  const { OfflineAudioContext } = await import('node-web-audio-api');
  // сетка навигации — класс; через границу процесса пришли только поля: собрать заново
  for (const tk of job.takes) tk.rec.nav = new NavGrid(tk.arena, (tk.rec.nav as unknown as { cell: number }).cell);
  const inp = filmInput(job.takes, job.players, job.match, {
    t: DICTS[job.lang],
    lang: job.lang,
    font: FONT,
    site: job.site,
    link: job.link,
    // фильм уходит в ленты соцсетей: удар — «поф», без крови (детский режим)
    noGore: true,
    scale: SCALE,
  });
  if (!inp) return null;
  const film = new FilmScene(inp);
  const frames = Math.ceil((film.duration / 1000) * FPS);
  const octx = new OfflineAudioContext(2, Math.ceil(((frames + 2) / FPS) * RATE), RATE);
  let now = 0;
  const ctx = clocked(octx as unknown as BaseAudioContext, () => now);
  film.sound = clipMix(ctx, octx.destination as unknown as AudioNode, makeNoise(ctx), { manual: true });

  const ffmpeg = o.ffmpeg ?? 'ffmpeg';
  const id = `${process.pid}-${Date.now()}`;
  const silent = join(o.tmp, `film-${id}-v.mp4`);
  const audio = join(o.tmp, `film-${id}.wav`);
  const out = join(o.tmp, `film-${id}.mp4`);
  let thumb: Buffer | null = null;
  try {
    // кадры → ffmpeg; заодно планируется звук (по часам кадра)
    await run(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', 'pipe:0',
        '-vf', 'scale=1080:1920:flags=neighbor,format=yuv420p', '-c:v', 'libx264', '-preset', o.preset ?? 'ultrafast',
        // ultrafast вдвое быстрее veryfast, на пиксельной картинке разницы не видно; crf 26 держит файл ~6 МБ
        '-crf', '26', '-threads', '1', '-an', silent],
      async (stdin) => {
        for (let k = 0; k < frames; k++) {
          now = k / FPS;
          const c = film.frame(Math.min((k * 1000) / FPS, film.duration)) as unknown as NapiCanvas;
          if (k === 0) thumb = await c.encode('jpeg', 85);
          const px = c.getContext('2d').getImageData(0, 0, W, H).data;
          if (!stdin.write(Buffer.from(px.buffer, px.byteOffset, px.byteLength))) await once(stdin, 'drain');
        }
      },
    );
    // звук целиком запланирован по часам кадров — теперь отрисовать его разом (stop() не зовём: он отключил бы смесь)
    const rendered = await octx.startRendering();
    await writeFile(audio, wav(rendered as unknown as Parameters<typeof wav>[0]));
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', silent, '-i', audio, '-c:v', 'copy',
      // громкость лент (Reels, TikTok, Shorts выравнивают к −14 LUFS) и пики с запасом под AAC — у каждого фильма одинаково
      '-af', 'volume=-4dB,loudnorm=I=-14:TP=-2:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', out]);
  } finally {
    await rm(silent, { force: true });
    await rm(audio, { force: true });
  }
  return { video: out, thumb: thumb!, durationMs: film.duration, renderMs: Math.round(performance.now() - t0) };
}
