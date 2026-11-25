import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Сверка монтажа на Rust (apps/server/native) со старым рендером через Skia: те же сцены фильма,
 * кадры почти пиксель в пиксель. Нужен собранный модуль (`pnpm --filter @kto/server build:native`) —
 * в CI его собирает отдельная задача `native`; без модуля тест пропускается.
 */
const native = join(import.meta.dirname, '../dist/massovka-film.node');

describe.skipIf(!existsSync(native))('фильм матча: Rust против Skia', () => {
  it('кадры совпадают (кроме дробных координат)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'film-frames-'));
    try {
      const run = (mode: string) => {
        const out = join(dir, `${mode}.rgba`);
        execFileSync('npx', ['tsx', 'scripts/film-frames.ts', mode, out, '12'], { cwd: join(import.meta.dirname, '..'), stdio: 'pipe', env: { ...process.env, FILM_NATIVE_PATH: native } });
        return readFileSync(out);
      };
      const a = run('skia');
      const b = run('rust');
      expect(b.length).toBe(a.length);
      const px = a.length / 4;
      const frame = 540 * 960;
      let bad = 0;
      let worst = 0;
      let inFrame = 0;
      for (let i = 0; i < px; i++) {
        const o = i * 4;
        const d = Math.max(Math.abs(a[o] - b[o]), Math.abs(a[o + 1] - b[o + 1]), Math.abs(a[o + 2] - b[o + 2]));
        if (d > 8) {
          bad++;
          inFrame++;
        }
        if ((i + 1) % frame === 0) {
          worst = Math.max(worst, inFrame / frame);
          inFrame = 0;
        }
      }
      // сейчас: в среднем 0,03% пикселей, в худшем кадре 0,3% (конфетти на дробных координатах)
      expect(bad / px).toBeLessThan(0.002);
      expect(worst).toBeLessThan(0.01);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
