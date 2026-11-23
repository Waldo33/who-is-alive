import { PAL, PLAYER_COLORS } from '@kto/assets';
import { filmHook, findBestMoment, pickFilmMoments, tp } from '@kto/game-core';
import type { ArenaDef, Dict, Lang, MatchSummary, Moment, RoundRecording, RoundSummary } from '@kto/game-core';
import type { ClipSoundCore } from './clip-audio';
import { CLIP_SCALE, ClipPlayerScene, drawQr } from './clip';
import type { ClipPlayer } from './clip';
import { frame, getArt, scaledCanvas, text } from './art';
import { CH_H, CH_W, F, OL_H, OL_W } from './sprites';

/**
 * «Фильм матча» — один ролик на матч (~20–23 с) для всех игроков комнаты. Держит интригу, как старый клип:
 *   крючок (1,5 с: почти стоп-кадр самого яркого момента, «Один из них — живой. Найдёшь?»)
 *   → загадка этого момента: общий план без подсказок, отсчёт «3, 2, 1», дробь
 *   → раскрытие: вспышка, живые загораются по одному с ударом на каждого, наезд, замедление, стоп-кадр
 *   → «а ещё в этом матче»: остальные лучшие моменты коротко (хлопушка «Дубль N», разбор, счёт)
 *   → «Звезда фильма»: победитель крупно в луче прожектора, корона, конфетти, «Снято!»; QR и адрес
 *   → титры как в кино: «В главной роли — Енот», роли-награды («Каскадёр — Батон»), «В эпизоде»,
 *     «Массовка — 28 ботов», под ними окошко «Неудачные дубли» (удары по массовке за матч).
 * Музыка — одна песня темы главного момента на весь ролик (раньше начиналась заново в каждом куске —
 * песня не успевала развернуться), в загадке — с напряжением.
 * Последний кадр повторяет первый — ролик в ленте зацикливается без шва.
 * Моменты выбирает game-core (`pickFilmMoments`, `filmHook`); рисует тот же ClipPlayerScene, что и клип.
 * Один код — для записи на телефоне (песочница, запасной путь) и для монтажа на сервере (apps/server/src/film.ts).
 */
const LW = 180;
const LH = 320;
const SAFE_L = 6;
const SAFE_R = 156;
export const TRIUMPH_MS = 2400;
export const CREDITS_MS = 4200;
/** Длиннее фильм не досматривают в ленте: лишние короткие моменты (самые слабые) выпадают. */
export const FILM_CAP_MS = 24_500;
/** Окошко «Неудачные дубли» в титрах: кусок поля 1:1 вокруг удара по массовке. */
const BLOOP_W = 150;
const BLOOP_H = 50;
const BLOOP_Y = 145;
/** Фильм с отсчётом, дробью и ударами на каждого живого громче клипа — подравнять к −14 LUFS лент. */
const FILM_LEVEL_DB = -5.5;

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
  /** Язык (множественное число в титрах). */
  lang?: Lang;
  /** Сколько ботов в кадре — строка «Массовка — 28 ботов». */
  bots?: number;
  /** «Неудачные дубли»: удары по массовке за матч (до двух) — окошко в титрах. */
  bloopers?: FilmRound[];
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

type Piece = { kind: 'scene'; scene: ClipPlayerScene; dur: number } | { kind: 'triumph'; dur: number } | { kind: 'credits'; dur: number };

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
  private triumphStarted = false;
  /** Неудачные дубли для окошка в титрах. */
  private bloops: ClipPlayerScene[] = [];
  private bloopSound = new Set<number>();
  sound: (ClipSoundCore & { stream?: MediaStream }) | null = null;

  constructor(private inp: FilmInput) {
    const scale = inp.scale ?? CLIP_SCALE;
    const { c, g } = scaledCanvas(LW, LH, scale);
    this.c = c;
    this.g = g;
    this.bg = scaledCanvas(LW, LH, scale);
    const base = { t: inp.t, font: inp.font, site: inp.site, noGore: inp.noGore, scale, link: inp.link };
    const h = inp.hook;
    this.pieces.push(scenePiece(new ClipPlayerScene({ ...base, ...h, mode: 'hook', keepMusic: true })));
    this.pieces.push(scenePiece(new ClipPlayerScene({ ...base, ...h, mode: 'feature', keepMusic: true })));
    // остальные моменты — коротко, по порядку дублей; не влезают в FILM_CAP_MS — уходят самые слабые
    let extra = inp.rounds.filter((r) => r !== h).map((r) => ({ r, scene: new ClipPlayerScene({ ...base, ...r, mode: 'segment', keepMusic: true }) }));
    const fixed = this.pieces.reduce((a, p) => a + p.dur, 0) + TRIUMPH_MS + CREDITS_MS;
    while (extra.length && fixed + extra.reduce((a, x) => a + x.scene.duration, 0) > FILM_CAP_MS) {
      const weakest = extra.reduce((a, x) => (x.r.moment.score < a.r.moment.score ? x : a));
      extra = extra.filter((x) => x !== weakest);
    }
    for (const x of extra) this.pieces.push(scenePiece(x.scene));
    this.pieces.push({ kind: 'triumph', dur: TRIUMPH_MS });
    this.pieces.push({ kind: 'credits', dur: CREDITS_MS });
    this.bloops = (inp.bloopers ?? []).slice(0, 2).map((b) => new ClipPlayerScene({ ...base, ...b, mode: 'blooper', keepMusic: true }));
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
      // одна песня на весь фильм: тема главного момента, с первого кадра
      if (this.cur === -1) {
        this.sound?.level(FILM_LEVEL_DB);
        this.sound?.start(this.inp.hook.rec.theme, false);
      }
      // крючок закончился — его кадр становится фоном титров
      if (this.cur === 0) this.keepBg();
      this.cur = i;
      if (p.kind === 'scene') p.scene.sound = this.sound;
    }
    if (p.kind === 'scene') {
      p.scene.draw(Math.min(local, p.dur));
      return p.scene.c;
    }
    if (p.kind === 'triumph') {
      if (!this.triumphStarted) {
        this.triumphStarted = true;
        // «Снято!» — хлопушка, звуковой логотип и аккорд (как на конце матча в игре)
        this.sound?.play('wrap');
      }
      this.sound?.pump();
      this.drawTriumph(local);
      return this.c;
    }
    if (!this.creditsStarted) {
      this.creditsStarted = true;
      this.sound?.fadeOut(Math.max(0.3, (this.duration - ms) / 1000));
    }
    this.drawCredits(local);
    this.sound?.pump();
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

  /** Тёмный фон с вуалью поверх замершего крючка. */
  private backdrop(alpha: number): void {
    const g = this.g;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.bg.c, 0, 0);
    g.restore();
    g.globalAlpha = alpha;
    g.fillStyle = PAL.ink;
    g.fillRect(0, 0, LW, LH);
    g.globalAlpha = 1;
  }

  /** QR, «Сыграй с друзьями» и адрес — блок призыва (на «Звезде фильма»). */
  private callToPlay(y: number): void {
    const g = this.g;
    const t = this.inp.t;
    const font = this.inp.font;
    const qr = drawQr(g, this.inp.link ?? `https://${this.inp.site}`, SAFE_L + 2, y);
    const tx = SAFE_L + 2 + qr + 6;
    text(g, t.clip.play1, tx, y + 4, PAL.white, font, { align: 'left', outline: null });
    text(g, t.clip.play2, tx, y + 14, PAL.white, font, { align: 'left', outline: null });
    text(g, this.inp.site, tx, y + 25, PAL.cyan, font, { align: 'left', outline: null, maxWidth: SAFE_R - tx });
  }

  /**
   * «Звезда фильма»: победитель крупно (×4) танцует в луче прожектора, корона, конфетти — как момент
   * триумфа на экране конца матча в игре. «Слишком заметные» — двое лидеров поменьше и без короны.
   */
  private drawTriumph(ms: number): void {
    const g = this.g;
    const t = this.inp.t;
    const font = this.inp.font;
    this.backdrop(0.9);
    const art = getArt(this.inp.hook.arena);
    const ch = art.chars(this.inp.hook.rec.theme);
    const cx = (SAFE_L + SAFE_R) / 2;
    const floor = 146;
    // луч прожектора сверху и пятно света на полу
    g.globalAlpha = 0.1;
    g.fillStyle = PAL.white;
    for (let y = 26; y < floor; y += 2) {
      const half = Math.round(6 + ((y - 26) / (floor - 26)) * 30);
      g.fillRect(Math.round(cx) - half, y, half * 2, 2);
    }
    g.globalAlpha = 0.22;
    g.fillStyle = PAL.yellow;
    for (let dy = -6; dy <= 6; dy++) {
      const half = Math.round(36 * Math.sqrt(1 - (dy / 7) ** 2));
      g.fillRect(Math.round(cx) - half, floor + dy, half * 2, 1);
    }
    g.globalAlpha = 1;
    // конфетти: падают по кругу, цвета игроков и жёлтый
    const colors = [...PLAYER_COLORS, PAL.yellow, PAL.white];
    for (let i = 0; i < 40; i++) {
      const h = Math.sin(i * 12.9898) * 43758.5453;
      const r = h - Math.floor(h);
      const x = SAFE_L + Math.floor(r * (SAFE_R - SAFE_L));
      const speed = 0.04 + r * 0.05;
      const y = 26 + ((Math.floor(r * 997) + ms * speed) % 180);
      g.fillStyle = colors[i % colors.length];
      g.fillRect(x + Math.round(Math.sin((ms + i * 200) / 180) * 2), Math.round(y), 2, (i + Math.floor(ms / 120)) % 2 ? 2 : 1);
    }
    const crownAt = art.icons.names.indexOf('crown');
    const win = this.inp.winner;
    const dancer = (color: number, x: number, k: number, crown: boolean, phase: number) => {
      const fr = F.DANCE + (Math.floor((ms + phase) / 160) % 4);
      g.save();
      g.scale(k, k);
      const sx = Math.round(x / k);
      const sy = Math.round(floor / k) - (Math.floor((ms + phase) / 320) % 2);
      frame(g, ch.outline[1 + color], OL_W, OL_H, fr, sx - 7, sy - 17);
      frame(g, ch.body, CH_W, CH_H, fr, sx - 6, sy - CH_H);
      g.restore();
      if (crown && crownAt >= 0) {
        g.save();
        g.scale(2, 2);
        frame(g, art.icons.canvas, 8, 8, crownAt, Math.round(x / 2) - 4, Math.round((floor - CH_H * k) / 2) - 9);
        g.restore();
      }
    };
    if (this.inp.tooAlive || !win) {
      text(g, t.card.tooAlive, cx, 40, PAL.amber, font, { maxWidth: SAFE_R - SAFE_L });
      const top = this.inp.cast.slice(0, 2);
      top.forEach((c, i) => {
        dancer(c.color, cx + (i ? 24 : -24), 3, false, i * 90);
        text(g, c.name, cx + (i ? 38 : -38), 50, PLAYER_COLORS[c.color], font, { maxWidth: 70 });
      });
    } else {
      text(g, t.card.winner, cx, 38, PAL.mist, font, { maxWidth: SAFE_R - SAFE_L });
      text(g, win.name, cx, 49, PLAYER_COLORS[win.color], font, { size: 2, maxWidth: SAFE_R - SAFE_L });
      dancer(win.color, cx, 4, true, 0);
    }
    this.callToPlay(158);
  }

  /**
   * Титры как в кино: роль и имя — «В главной роли / Енот», награда матча как роль, «В эпизоде»,
   * «Массовка / 28 ботов»; под ними окошко «Неудачные дубли» — удары по массовке за матч.
   */
  private drawCredits(ms: number): void {
    const g = this.g;
    const t = this.inp.t;
    const font = this.inp.font;
    const lang = this.inp.lang ?? 'ru';
    this.backdrop(0.88);
    const cx = (SAFE_L + SAFE_R) / 2;
    const win = this.inp.tooAlive ? undefined : this.inp.winner;
    const rows: { role: string; name: string; color: string; points?: number; self?: boolean }[] = this.inp.cast.map((c) => ({
      role: win && c.color === win.color ? t.clip.lead : (c.award ?? t.clip.cameo),
      name: c.name,
      color: PLAYER_COLORS[c.color],
      points: c.points,
      self: this.inp.self === c.color,
    }));
    if (this.inp.bots) rows.push({ role: t.clip.extrasRole, name: tp(lang, t.clip.bots, this.inp.bots), color: PAL.mist });
    // строки появляются по одной снизу — как бегущие титры
    let y = 38;
    rows.forEach((r, i) => {
      const at = 120 + i * 160;
      if (ms < at) return;
      const rise = Math.max(0, 6 - Math.floor((ms - at) / 30));
      if (r.self) {
        g.fillStyle = PAL.night;
        g.fillRect(SAFE_L, y - 1 + rise, SAFE_R - SAFE_L, 18);
      }
      text(g, r.role, cx, y + rise, PAL.mist, font, { outline: null, maxWidth: SAFE_R - SAFE_L });
      text(g, r.name, cx, y + 9 + rise, r.color, font, { outline: null, maxWidth: SAFE_R - SAFE_L - 20 });
      if (r.points !== undefined) text(g, String(r.points), SAFE_R - 2, y + 9 + rise, PAL.yellow, font, { align: 'right', outline: null });
      y += 19;
    });
    // «Неудачные дубли»: по очереди, кусок поля 1:1 вокруг удара (пиксели без масштабирования)
    const b = this.bloops;
    if (b.length) {
      text(g, t.clip.bloopers, cx, BLOOP_Y - 10, PAL.yellow, font, { outline: null });
      let i = 0;
      let start = 300;
      while (i < b.length - 1 && ms >= start + b[i].duration) start += b[i++].duration;
      const sc = b[i];
      if (ms >= start) {
        if (!this.bloopSound.has(i)) {
          this.bloopSound.add(i);
          sc.sound = this.sound;
        }
        sc.draw(Math.min(ms - start, sc.duration));
      } else sc.draw(0);
      const f = sc.focusPoint() ?? { x: LW / 2, y: LH / 2 };
      const scale = (this.c.width / LW) | 0;
      const sx = Math.max(0, Math.min(LW - BLOOP_W, Math.round(f.x - BLOOP_W / 2)));
      const sy = Math.max(24, Math.min(284 - BLOOP_H, Math.round(f.y - BLOOP_H / 2)));
      const dx = SAFE_L;
      g.fillStyle = PAL.mist;
      g.fillRect(dx - 1, BLOOP_Y - 1, BLOOP_W + 2, BLOOP_H + 2);
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(sc.c, sx * scale, sy * scale, BLOOP_W * scale, BLOOP_H * scale, dx * scale, BLOOP_Y * scale, BLOOP_W * scale, BLOOP_H * scale);
      g.restore();
    }
    text(g, this.inp.site, cx, 200, PAL.cyan, font, { outline: null });
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
  // «Неудачные дубли»: удары игроков по массовке (кто ударил — видно всем: он оглушён и раскрыт);
  // свежие — первыми, разные «виновники», не тот же удар, что уже в фильме
  const bloopers: FilmRound[] = [];
  const culprits = new Set<number>();
  for (const tk of [...takes].reverse()) {
    if (bloopers.length >= 2) break;
    const byEid = new Map(tk.summary.reveal.map((r) => [r.eid, r.pid]));
    const start = tk.rec.keyframes[0]?.time ?? 0;
    const clipPlayers: ClipPlayer[] = tk.summary.reveal.flatMap((r) => {
      const p = info.get(r.pid);
      return p ? [{ eid: r.eid, name: p.name, color: p.color }] : [];
    });
    for (const ev of [...tk.rec.log].reverse()) {
      if (bloopers.length >= 2) break;
      if (ev.t !== 'hit' || ev.result !== 'bot' || ev.attacker === undefined || !byEid.has(ev.attacker) || culprits.has(ev.attacker)) continue;
      if (ev.at < start + 900 || ev.at > tk.rec.playEnd) continue;
      if (picked.some((c) => c.round === tk.rec.round && c.moment.at === ev.at)) continue;
      culprits.add(ev.attacker);
      const moment: Moment = { from: ev.at - 900, to: Math.min(tk.rec.playEnd, ev.at + 1100), score: 0, kind: 'hit_bot', at: ev.at, attacker: ev.attacker, victim: ev.target };
      bloopers.push({ rec: tk.rec, moment, arena: tk.arena, players: clipPlayers, hero: ev.attacker, score: [] });
    }
  }
  const bots = Math.max(0, (takes[0]?.rec.keyframes[0]?.entities.length ?? 0) - players.length);
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
    bloopers,
    bots,
    hook: hook.film,
    cast,
    winner: w ? { name: w.name, color: w.color } : undefined,
    tooAlive: match.tooAlive,
    self: self !== undefined ? info.get(self)?.color : undefined,
  };
}
