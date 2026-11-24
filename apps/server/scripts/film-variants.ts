/**
 * Перемонтаж записей реальных матчей (src/recordings.ts) во всех вариантах финала:
 *   tsx scripts/film-variants.ts <папка-выхода> <запись.match.json.gz | папка с записями>...
 * На каждую запись — mp4 на вариант (<имя>-chart.mp4, -board, -race, -podium) и сетка 2×2
 * <имя>-grid.mp4: слева вверху график, справа табло, внизу забег и пьедестал (звук — от графика).
 * Гоняет .github/workflows/film-variants.yml; локально нужен ffmpeg.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { renderFilm } from '../src/film-render';
import { readRecordingFile } from '../src/recordings';
import type { FinaleStyle } from '../../web/src/game/film';

const STYLES: { id: FinaleStyle; label: string }[] = [
  { id: 'chart', label: '1 График' },
  { id: 'board', label: '2 Табло' },
  { id: 'race', label: '3 Забег' },
  { id: 'podium', label: '4 Пьедестал' },
];
const FONT_TTF = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

const [out, ...inputs] = process.argv.slice(2);
if (!out || !inputs.length) {
  console.error('tsx scripts/film-variants.ts <папка-выхода> <запись | папка>...');
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const files = inputs.flatMap((p) =>
  statSync(p).isDirectory()
    ? readdirSync(p)
        .filter((n) => n.endsWith('.match.json.gz'))
        .map((n) => join(p, n))
    : [p],
);
const fonts = join(import.meta.dirname, '../../web/assets/og');
for (const file of files) {
  const name = basename(file).replace(/\.match\.json\.gz$/, '');
  const rec = await readRecordingFile(file);
  const made: string[] = [];
  for (const st of STYLES) {
    const t0 = Date.now();
    const r = await renderFilm({ ...rec.job, site: 'benobody.app', link: 'https://benobody.app/?src=film', finale: st.id }, { fonts, tmp: tmpdir() });
    if (!r) {
      console.log(`${name}: в матче нечего показать`);
      break;
    }
    const dst = join(out, `${name}-${st.id}.mp4`);
    renameSync(r.video, dst);
    made.push(dst);
    console.log(`${name} ${st.id}: ${(r.durationMs / 1000).toFixed(1)} с, монтаж ${Date.now() - t0} мс`);
  }
  if (made.length !== STYLES.length) continue;
  const label = (i: number) => (existsSync(FONT_TTF) ? `,drawtext=fontfile=${FONT_TTF}:text='${STYLES[i].label}':x=16:y=16:fontsize=34:fontcolor=white:box=1:boxcolor=black@0.6` : '');
  const fc = made.map((_, i) => `[${i}:v]scale=540:960:flags=neighbor${label(i)}[p${i}]`).join(';') + ';[p0][p1]hstack[a];[p2][p3]hstack[b];[a][b]vstack,format=yuv420p[v]';
  const grid = join(out, `${name}-grid.mp4`);
  const res = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...made.flatMap((f) => ['-i', f]), '-filter_complex', fc, '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-crf', '22', '-preset', 'veryfast', '-c:a', 'copy', '-shortest', '-movflags', '+faststart', grid], { stdio: 'inherit' });
  if (res.status !== 0) console.error(`${name}: сетка не собралась`);
}
