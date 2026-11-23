import { PAL, PLAYER_COLORS } from '@kto/assets';
import { filmHook, findBestMoment, pickFilmMoments } from '@kto/game-core';
import type { ArenaDef, Dict, MatchSummary, Moment, RoundRecording, RoundSummary } from '@kto/game-core';
import type { ClipSoundCore } from './clip-audio';
import { CLIP_SCALE, ClipPlayerScene, drawQr } from './clip';
import type { ClipPlayer } from './clip';
import { getArt, scaledCanvas, text } from './art';

/**
 * «Фильм матча» — один ролик на матч (18–20 с) для всех игроков комнаты:
 *   крючок (1,5 с: почти стоп-кадр самого яркого момента, «Один из них — живой.»)
 *   → до трёх лучших моментов по порядку дублей (хлопушка «Дубль N», разбор с подсветкой, счёт матча)
 *   → титры «В ролях» на фоне замершего крючка: звезда фильма, имена цветами, очки, награды, QR и адрес.
 * Последний кадр повторяет первый — ролик в ленте зацикливается без шва.
 * Моменты выбирает game-core (`pickFilmMoments`, `filmHook`); рисует тот же ClipPlayerScene, что и клип.
 * Один код — для записи на телефоне (песочница, запасной путь) и для монтажа на сервере (apps/server/src/film.ts).
 */
const LW = 180;
const LH = 320;
const SAFE_L = 6;
const SAFE_R = 156;
export const CREDITS_MS = 3600;

export interface FilmRound {
  rec: RoundRecording;
  moment: Moment;
  arena: ArenaDef;
  players: ClipPlayer[];
  /** Герой момента (сущность): сильная подсветка. */
  hero?: number;
  /** Счёт матча после этого дубля. */
  score: { color: number; points: number }[];
}

export interface FilmCastLine {
  name: string;
  color: number;
  points: number;
  /** Награда матча («Каскадёр», «Параноик»), если есть. */
  award?: string;
}

export interface FilmInput {
  /** Моменты фильма по порядку дублей. */
  rounds: FilmRound[];
  /** Момент для крючка (обычно самый сильный из rounds). */
  hook: FilmRound;
  t: Dict;
  font: string;
  site: string;
  /** Ссылка в QR титров. */
  link?: string;
  noGore?: boolean;
  scale?: number;
  /** Титры: по убыванию очков. */
  cast: FilmCastLine[];
  winner?: { name: string; color: number };
  tooAlive?: boolean;
  /** Цвет того, чья это копия фильма, — его строка в титрах выделена (на сервере фильм общий — без неё). */
  self?: number;
}

type Piece = { kind: 'scene'; scene: ClipPlayerScene; dur: number } | { kind: 'credits'; dur: number };

export class FilmScene {
  readonly c: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  readonly duration: number;
  private pieces: Piece[] = [];
  /** Последний кадр крючка — фон титров (и первый кадр ролика: зацикливание без шва). */
  private bg: { c: HTMLCanvasElement; g: CanvasRenderingContext2D };
  private bgReady = false;
  private cur = -1;
  private creditsStarted = false;
  sound: (ClipSoundCore & { stream?: MediaStream }) | null = null;

  constructor(private inp: FilmInput) {
    const scale = inp.scale ?? CLIP_SCALE;
    const { c, g } = scaledCanvas(LW, LH, scale);
    this.c = c;
    this.g = g;
    this.bg = scaledCanvas(LW, LH, scale);
    const base = { t: inp.t, font: inp.font, site: inp.site, noGore: inp.noGore, scale, link: inp.link };
    const h = inp.hook;
    this.pieces.push(scenePiece(new ClipPlayerScene({ ...base, ...h, mode: 'hook' })));
    for (const r of inp.rounds) this.pieces.push(scenePiece(new ClipPlayerScene({ ...base, ...r, mode: 'segment' })));
    this.pieces.push({ kind: 'credits', dur: CREDITS_MS });
    this.duration = this.pieces.reduce((a, p) => a + p.dur, 0);
  }

  /** Нарисовать кадр фильма в момент ms от начала (на свой холст `c`). Вызывать с неубывающим ms. */
  draw(ms: number): void {
    const c = this.frame(ms);
    if (c === this.c) return;
    this.g.save();
    this.g.setTransform(1, 0, 0, 1, 0, 0);
    this.g.drawImage(c, 0, 0);
    this.g.restore();
  }

  /**
   * Нарисовать кадр и вернуть холст, где он лежит: у кусков — холст их сцены, у титров — свой.
   * Сервер читает пиксели прямо оттуда — без лишнего копирования кадра (vCPU сервера медленный).
   */
  frame(ms: number): HTMLCanvasElement {
    let i = 0;
    let start = 0;
    while (i < this.pieces.length - 1 && ms >= start + this.pieces[i].dur) start += this.pieces[i++].dur;
    const p = this.pieces[i];
    const local = ms - start;
    if (i !== this.cur) {
      // крючок закончился — его кадр становится фоном титров
      if (this.cur === 0) this.keepBg();
      this.cur = i;
      if (p.kind === 'scene') p.scene.sound = this.sound;
    }
    if (p.kind === 'scene') {
      p.scene.draw(Math.min(local, p.dur));
      return p.scene.c;
    }
    if (!this.creditsStarted) {
      this.creditsStarted = true;
      this.sound?.play('fanfare');
      this.sound?.fadeOut(Math.max(0.3, (this.duration - ms) / 1000));
    }
    this.sound?.pump();
    this.drawCredits(local);
    return this.c;
  }

  private keepBg(): void {
    const hook = this.pieces[0];
    if (this.bgReady || hook.kind !== 'scene') return;
    this.bgReady = true;
    const g = this.bg.g;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(hook.scene.c, 0, 0);
    g.restore();
  }

  private drawCredits(ms: number): void {
    const g = this.g;
    const t = this.inp.t;
    const font = this.inp.font;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.bg.c, 0, 0);
    g.restore();
    // фон — замерший крючок под тёмной вуалью; надписи проявляются
    g.globalAlpha = 0.86;
    g.fillStyle = PAL.ink;
    g.fillRect(0, 0, LW, LH);
    g.globalAlpha = Math.min(1, ms / 250);
    const cx = (SAFE_L + SAFE_R) / 2;
    const win = this.inp.winner;
    const art = getArt(this.inp.hook.arena);
    const crownAt = art.icons.names.indexOf('crown');
    if (this.inp.tooAlive) text(g, t.card.tooAlive, cx, 40, PAL.amber, font, { maxWidth: SAFE_R - SAFE_L });
    else if (win) {
      text(g, t.card.winner, cx, 40, PAL.mist, font, { maxWidth: SAFE_R - SAFE_L });
      const w = text(g, win.name, cx, 52, PLAYER_COLORS[win.color], font, { maxWidth: SAFE_R - SAFE_L - 12 });
      if (crownAt >= 0) g.drawImage(art.icons.canvas, crownAt * 8, 0, 8, 8, Math.round(cx - w / 2 - 11), 51, 8, 8);
    }
    text(g, t.clip.cast, cx, 68, PAL.yellow, font);
    // строки «В ролях» появляются по одной
    const awards = this.inp.cast.some((c) => c.award);
    const step = awards ? 19 : 12;
    let y = 81;
    this.inp.cast.forEach((c, i) => {
      if (ms < 250 + i * 180) return;
      if (this.inp.self === c.color) {
        g.fillStyle = PAL.night;
        g.fillRect(SAFE_L, y - 2, SAFE_R - SAFE_L, step - 2);
      }
      g.fillStyle = PLAYER_COLORS[c.color];
      g.fillRect(SAFE_L + 2, y + 1, 5, 5);
      text(g, c.name, SAFE_L + 10, y, PLAYER_COLORS[c.color], font, { align: 'left', outline: null, maxWidth: SAFE_R - SAFE_L - 34 });
      text(g, String(c.points), SAFE_R - 2, y, PAL.white, font, { align: 'right', outline: null });
      if (c.award) text(g, c.award, SAFE_L + 10, y + 9, PAL.mist, font, { align: 'left', outline: null, size: 1, maxWidth: SAFE_R - SAFE_L - 12 });
      y += step;
    });
    y = Math.max(y + 4, 136);
    const qr = drawQr(g, this.inp.link ?? `https://${this.inp.site}`, SAFE_L + 2, y);
    const tx = SAFE_L + 2 + qr + 6;
    text(g, t.clip.play1, tx, y + 4, PAL.white, font, { align: 'left', outline: null });
    text(g, t.clip.play2, tx, y + 14, PAL.white, font, { align: 'left', outline: null });
    text(g, this.inp.site, tx, y + 25, PAL.cyan, font, { align: 'left', outline: null, maxWidth: SAFE_R - tx });
    g.globalAlpha = 1;
  }
}

function scenePiece(scene: ClipPlayerScene): Piece {
  return { kind: 'scene', scene, dur: scene.duration };
}

/** Сыгранный дубль для фильма: запись мира (снята на разоблачении) и итоги дубля. */
export interface FilmTake {
  rec: RoundRecording;
  summary: RoundSummary;
  arena: ArenaDef;
}

export interface FilmPlayer {
  pid: string;
  name: string;
  color: number;
}

/**
 * Собрать фильм из дублей матча: лучший момент каждого дубля (без «своего» бонуса — фильм общий),
 * выбор трёх (`pickFilmMoments`), счёт после каждого дубля, титры с наградами. null — дублей нет.
 */
export function filmInput(
  takes: readonly FilmTake[],
  players: readonly FilmPlayer[],
  match: MatchSummary,
  base: Omit<FilmInput, 'rounds' | 'hook' | 'cast' | 'winner' | 'tooAlive' | 'self'> & { self?: string },
): FilmInput | null {
  const info = new Map(players.map((p) => [p.pid, p]));
  const win = (pid: string) => (match.winners.includes(pid) ? 1 : 0);
  const total = new Map<string, number>();
  type Cand = { round: number; moment: Moment; hero?: string; film: FilmRound };
  const cands: Cand[] = [];
  for (const tk of takes) {
    const s = tk.summary;
    for (const [pid, line] of Object.entries(s.points)) total.set(pid, (total.get(pid) ?? 0) + line.total);
    const moment = findBestMoment({ ...tk.rec, kills: s.kills });
    if (!moment) continue;
    const byEid = new Map(s.reveal.map((r) => [r.eid, r.pid]));
    const heroEid = moment.attacker ?? moment.victim;
    const clipPlayers: ClipPlayer[] = s.reveal.flatMap((r) => {
      const p = info.get(r.pid);
      return p ? [{ eid: r.eid, name: p.name, color: p.color }] : [];
    });
    const score = [...players].sort((a, b) => a.color - b.color).map((p) => ({ color: p.color, points: total.get(p.pid) ?? 0 }));
    cands.push({
      round: tk.rec.round,
      moment,
      hero: heroEid !== undefined ? byEid.get(heroEid) : undefined,
      film: { rec: tk.rec, moment, arena: tk.arena, players: clipPlayers, hero: heroEid !== undefined && byEid.has(heroEid) ? heroEid : undefined, score },
    });
  }
  const picked = pickFilmMoments(cands, { winner: match.winners[0] });
  const hook = filmHook(picked);
  if (!hook) return null;
  const cast: FilmCastLine[] = [...players]
    // по очкам, при равенстве — победитель выше (у него больше звёзд или выбиваний)
    .sort((a, b) => (match.scores[b.pid] ?? 0) - (match.scores[a.pid] ?? 0) || win(b.pid) - win(a.pid) || a.color - b.color)
    .map((p) => {
      const aw = match.awards.find((x) => x.pids.includes(p.pid));
      return { name: p.name, color: p.color, points: match.scores[p.pid] ?? 0, award: aw ? base.t.awards[aw.id].title : undefined };
    });
  const w = match.tooAlive ? undefined : info.get(match.winners[0] ?? '');
  const { self, ...rest } = base;
  return {
    ...rest,
    rounds: picked.map((c) => c.film),
    hook: hook.film,
    cast,
    winner: w ? { name: w.name, color: w.color } : undefined,
    tooAlive: match.tooAlive,
    self: self !== undefined ? info.get(self)?.color : undefined,
  };
}
