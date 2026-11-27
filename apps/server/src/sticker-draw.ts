/**
 * Рисование своего стикера внутри процесса film-worker (--sticker): Skia, шрифт игры, ffmpeg. Отдельно от
 * sticker-render.ts, чтобы игровой сервер не тянул холсты в свою сборку.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { myDef } from '../../web/src/game/skins/my-sticker';
import { stickerFile } from '../../web/src/game/skins/stickers';
import { warmRender } from './film-render';
import type { MyLook } from './sticker-render';

const MAX_BYTES = 256 * 1024;
const FRAMES = 20;

/** Нарисовать и закодировать: 20 кадров 512×512 → WEBM VP9 с прозрачностью, ≤ 256 КБ. */
export async function renderMyWebm(s: MyLook, o: { fonts: string; ffmpeg?: string; tmp?: string }): Promise<Buffer> {
  await warmRender({ fonts: o.fonts });
  const dir = await mkdtemp(join(o.tmp ?? tmpdir(), 'my-sticker-'));
  try {
    const def = myDef(s);
    for (let t = 0; t < FRAMES; t++) {
      const c = stickerFile(def, t, 'ru') as unknown as { encode(f: 'png'): Promise<Buffer> };
      await writeFile(join(dir, `${String(t).padStart(2, '0')}.png`), await c.encode('png'));
    }
    const file = join(dir, 'out.webm');
    // пиксель-арт жмётся хорошо; не влез в 256 КБ — грубее
    for (const crf of [24, 32, 40, 48]) {
      await run(o.ffmpeg ?? 'ffmpeg', ['-v', 'error', '-y', '-framerate', '10', '-i', join(dir, '%02d.png'), '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', String(crf), '-an', '-auto-alt-ref', '0', file]);
      if ((await stat(file)).size <= MAX_BYTES) return await readFile(file);
    }
    throw new Error('sticker_too_big');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** ffmpeg без shell, аргументы списком. */
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-600)));
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg ${code}: ${err}`))));
  });
}
