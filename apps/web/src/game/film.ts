import { PAL, PLAYER_COLORS } from '@kto/assets';
import { filmHook, findBestMoment, fmt, matchStory, pickFilmMoments, tp } from '@kto/game-core';
import type { ArenaDef, Dict, Lang, MatchSummary, Moment, RoundRecording, RoundSummary, StoryKind, StoryRound } from '@kto/game-core';
import type { ClipSoundCore } from './clip-audio';
import { CLAP_MS, CLIP_SCALE, ClipPlayerScene, drawIris, drawQr, irisFull, namePlate } from './clip';
import type { ClipPlayer } from './clip';
import { frame, getArt, scaledCanvas, text } from './art';
import { CH_H, CH_W, F, OL_H, OL_W } from './sprites';

/**
 * «Фильм матча» — один ролик на матч (~20–24 с) для всех игроков комнаты. Сценарий — история матча:
 *   крючок (1,3 с: почти стоп-кадр самого яркого момента крупно, «Один из них — живой. Найдёшь?»)
 *   → перемотка (0,5 с: плёнка дёргается, музыку «зажёвывает» — «смотрим, как это было»)
 *   → загадка этого момента: общий план без подсказок, отсчёт «3, 2, 1», дробь
 *   → раскрытие: вспышка, живые загораются по одному, камера плавно наезжает на участников, замедление,
 *     стоп-кадр; конец куска — «ирис» сужается на герое
 *   → «а ещё в этом матче»: хлопушка «Дубль N», ирис раскрывается, момент коротко (счёт до → после)
 *   → финал-сюжет (story.ts): «Камбэк матча», «Фотофиниш», «Дуэль матча», «Гроза площадки», «Невидимка»,
 *     «Без шансов» или просто «Звезда фильма» — заголовок, доказательство (пьедестал, дуэль, толпа под
 *     прожектором…), корона победителю, вызов зрителю под сюжет + QR и адрес
 *   → титры как в кино: «В главной роли», роли-награды, «Соперник», «Массовка — 28 ботов», окошко
 *     «Неудачные дубли».
 * Музыка — одна песня темы главного момента на весь ролик, в загадке — с напряжением.
 * Моменты выбирает game-core (`pickFilmMoments` с учётом сюжета, `filmHook`); рисует тот же
 * ClipPlayerScene, что и клип. Один код — для записи на телефоне (песочница, запасной путь) и для
 * монтажа на сервере (apps/server/src/film.ts).
 */
const LW = 180;
const LH = 320;
const SAFE_L = 6;
const SAFE_R = 156;
const REWIND_MS = 500;
export const FINALE_MS = 4600;
export const CREDITS_MS = 3200;
/** Ирис: сужение в конце куска и раскрытие после хлопушки. */
const IRIS_CLOSE_MS = 380;
const IRIS_OPEN_MS = 320;
/** Финал: когда победитель получает корону (и звучит «Снято!»), когда появляется вызов. */
const CROWN_AT = 2500;
const CTA_AT = 2900;
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
  /** Счёт матча после этого дубля и до него. */
  score: { color: number; points: number }[];
  scoreBefore?: { color: number; points: number }[];
}

export interface FilmCastLine {
  name: string;
  color: number;
  points: number;
  /** Награда матча («Каскадёр», «Параноик»), если есть. */
  award?: string;
}

/** Сюжет финала (story.ts) с именами и цветами вместо pid. */
export interface FilmStory {
  kind: StoryKind;
  hero: { name: string; color: number };
  rival?: { name: string; color: number };
  /** Очки каждого после каждого дубля (с нулём в начале) — график «гонки». */
  lines: { color: number; pts: number[] }[];
  lowRound?: number;
  /** Цвета вырезанных героем (по порядку). */
  victims: number[];
  value: number;
  value2?: number;
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
  /** Ссылка в QR финала. */
  link?: string;
  noGore?: boolean;
  scale?: number;
  /** Титры: по убыванию очков. */
  cast: FilmCastLine[];
  winner?: { name: string; color: number };
  tooAlive?: boolean;
  /** Цвет того, чья это копия фильма, — его строка в титрах выделена (на сервере фильм общий — без неё). */
  self?: number;
  /** Сюжет матча для финала; нет — «Звезда фильма». */
  story?: FilmStory;
  /**
   * Как показать очки в финале (камбэк, фотофиниш, отрыв, «Звезда фильма»): пьедестал (по умолчанию,
   * выбор владельца 24.11.2026), прежний график-гонка, табло или забег по дорожкам.
   */
  finale?: FinaleStyle;
}

export type FinaleStyle = 'chart' | 'board' | 'race' | 'podium';

type Piece =
  | { kind: 'scene'; scene: ClipPlayerScene; dur: number }
  | { kind: 'rewind'; dur: number }
  | { kind: 'finale'; dur: number }
  | { kind: 'credits'; dur: number };


const smooth = (p: number) => {
  const x = Math.max(0, Math.min(1, p));
  return x * x * (3 - 2 * x);
};

export class FilmScene {
  readonly c: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  readonly duration: number;
  private pieces: Piece[] = [];
  /** Последний кадр крючка — фон перемотки, финала и титров (и первый кадр ролика: зацикливание без шва). */
  private bg: { c: HTMLCanvasElement; g: CanvasRenderingContext2D };
  private bgReady = false;
  private cur = -1;
  /** Какие звуковые метки финала и титров уже прозвучали. */
  private cues = new Set<string>();
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
    this.pieces.push({ kind: 'rewind', dur: REWIND_MS });
    this.pieces.push(scenePiece(new ClipPlayerScene({ ...base, ...h, mode: 'feature', keepMusic: true })));
    // остальные моменты — коротко, по порядку дублей; не влезают в FILM_CAP_MS — уходят самые слабые
    let extra = inp.rounds.filter((r) => r !== h).map((r) => ({ r, scene: new ClipPlayerScene({ ...base, ...r, mode: 'segment', keepMusic: true }) }));
    const fixed = this.pieces.reduce((a, p) => a + p.dur, 0) + FINALE_MS + CREDITS_MS;
    while (extra.length && fixed + extra.reduce((a, x) => a + x.scene.duration, 0) > FILM_CAP_MS) {
      const weakest = extra.reduce((a, x) => (x.r.moment.score < a.r.moment.score ? x : a));
      extra = extra.filter((x) => x !== weakest);
    }
    for (const x of extra) this.pieces.push(scenePiece(x.scene));
    // титры, потом финал: триумф победителя (корона, «Снято!») — один и последним кадром фильма,
    // с вызовом и QR (просьба владельца: «момент триумфа в конце», и только один)
    this.pieces.push({ kind: 'credits', dur: CREDITS_MS });
    this.pieces.push({ kind: 'finale', dur: FINALE_MS });
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

  /** Сыграть звуковую метку один раз. */
  private cue(id: string, play: () => void): void {
    if (this.cues.has(id)) return;
    this.cues.add(id);
    play();
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
      // крючок закончился — его кадр становится фоном перемотки, финала и титров
      if (this.cur === 0) this.keepBg();
      this.cur = i;
      if (p.kind === 'scene') p.scene.sound = this.sound;
    }
    if (p.kind === 'scene') {
      const sc = p.scene;
      sc.draw(Math.min(local, p.dur));
      const g = sc.c.getContext('2d')!;
      // ирис раскрывается после хлопушки куска («Дубль N» на чёрном)
      if (sc.mode === 'segment' && local >= CLAP_MS && local < CLAP_MS + IRIS_OPEN_MS) {
        const cx = LW / 2;
        const cy = 154;
        drawIris(g, cx, cy, irisFull(cx, cy) * smooth((local - CLAP_MS) / IRIS_OPEN_MS));
      }
      // в конце куска (кроме крючка — за ним перемотка) ирис сужается на герое
      const left = p.dur - local;
      if (i > 0 && left < IRIS_CLOSE_MS) {
        const h = sc.heroPoint();
        drawIris(g, h.x, h.y, irisFull(h.x, h.y) * smooth(left / IRIS_CLOSE_MS));
      }
      return sc.c;
    }
    if (p.kind === 'rewind') {
      this.cue('rewind', () => {
        // «плёнку зажевало»: музыка проседает и замолкает, загадка запустит её снова
        this.sound?.pause();
        this.sound?.play('rewind');
      });
      this.sound?.pump();
      this.drawRewind(local);
      return this.c;
    }
    if (p.kind === 'finale') {
      // «Снято!» и корона — музыка уходит к концу фильма, эффекты звучат поверх
      if (local >= CROWN_AT) this.cue('end', () => this.sound?.fadeOut(Math.max(0.3, (this.duration - ms) / 1000)));
      this.sound?.pump();
      this.drawFinale(local);
      return this.c;
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

  /**
   * Перемотка после крючка: кадр крючка «едет» полосами, бегут строки помех, значок ◀◀ —
   * зритель понимает, что сейчас покажут, как всё было (загадка начинается раньше крючка).
   */
  private drawRewind(ms: number): void {
    const g = this.g;
    const sc = (this.c.width / LW) | 0;
    const p = ms / REWIND_MS;
    const amp = Math.round(Math.sin(p * Math.PI) * 9);
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = PAL.ink;
    g.fillRect(0, 0, this.c.width, this.c.height);
    const band = 6;
    for (let y = 0; y < LH; y += band) {
      const dx = Math.round(Math.sin(y * 0.37 + ms / 35) * amp + (y % 4 === 0 ? amp / 2 : 0));
      g.drawImage(this.bg.c, 0, y * sc, LW * sc, band * sc, dx * sc, y * sc, LW * sc, band * sc);
    }
    g.restore();
    g.globalAlpha = 0.35;
    g.fillStyle = PAL.ink;
    g.fillRect(0, 0, LW, LH);
    g.globalAlpha = 1;
    // строки помех бегут вверх
    for (let k = 0; k < 3; k++) {
      const y = Math.round(LH - ((ms * 0.9 + k * 117) % LH));
      g.fillStyle = k === 1 ? PAL.mist : PAL.white;
      for (let x = (k * 7) % 11; x < LW; x += 9 + k) g.fillRect(x, y, 5 + k, 1);
    }
    // ◀◀ и подпись
    const cx = LW / 2;
    const cy = 100;
    if (Math.floor(ms / 160) % 2 === 0 || ms < 160) {
      for (const ox of [-10, 2]) {
        for (let k = 0; k < 8; k++) {
          g.fillStyle = PAL.ink;
          g.fillRect(cx + ox + k - 1, cy - k - 1, 1, k * 2 + 3);
          g.fillStyle = PAL.white;
          g.fillRect(cx + ox + k, cy - k, 1, k * 2 + 1);
        }
      }
    }
    text(g, this.inp.t.clip.rewind, cx, cy + 14, PAL.white, this.inp.font);
  }

  /** QR, «Сыграй с друзьями» и адрес — блок призыва в финале. */
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

  /** Сюжет финала: из входа или запасной — «Звезда фильма». */
  private story(): FilmStory | null {
    const s = this.inp.story;
    if (s && !this.inp.tooAlive) return s;
    return null;
  }

  /**
   * Финал — сюжет матча: заголовок ударом хлопушки, имя героя и доказательство (печатается),
   * сцена-доказательство, корона победителю («Снято!»), вызов зрителю под сюжет, QR и адрес.
   * Последний кусок фильма — он и есть триумф: после него ничего не уезжает.
   */
  private drawFinale(ms: number): void {
    const g = this.g;
    const t = this.inp.t;
    const font = this.inp.font;
    const story = this.story();
    const kind: StoryKind = story?.kind ?? 'star';
    const st = t.clip.stories[kind];
    this.backdrop(0.93);
    g.save();
    const cx = (SAFE_L + SAFE_R) / 2;
    const W = SAFE_R - SAFE_L;
    this.cue('title', () => this.sound?.play('clap'));
    // заголовок: первые 110 мс — крупнее (удар), дальше ×2 (длинный — сколько влезет)
    const title = this.inp.tooAlive ? t.card.tooAlive : st.title;
    text(g, title, cx, ms < 110 ? 34 : 36, PAL.yellow, font, { size: ms < 110 ? 3 : 2, maxWidth: W });
    // имя героя и доказательство — печатаются
    const hero = story?.hero ?? this.inp.winner;
    const typed = (s: string, at: number) => s.slice(0, Math.max(0, Math.floor((ms - at) / 32)));
    if (hero && !this.inp.tooAlive) text(g, typed(hero.name, 200), cx, 54, PLAYER_COLORS[hero.color], font, { maxWidth: W });
    const fact = this.factLine(kind, story);
    if (fact) text(g, typed(fact, 520), cx, 63, PAL.mist, font, { outline: null, maxWidth: W + 4 });
    // сцена-доказательство
    const art = getArt(this.inp.hook.arena);
    // «Звезда фильма» без яркого сюжета — тоже с доказательством: очки по дублям
    if (story && (kind === 'comeback' || kind === 'photo' || kind === 'runaway' || (kind === 'star' && story.lines[0]?.pts.length > 2))) {
      const style = this.inp.finale ?? 'podium';
      if (style === 'board') this.drawBoard(ms, story);
      else if (style === 'race') this.drawRace(ms, story, art);
      else if (style === 'podium') this.drawPodium(ms, art);
      else this.drawChart(ms, story);
    }
    else if (story && kind === 'duel') this.drawDuel(ms, story, art);
    else if (story && kind === 'hunter') this.drawHunter(ms, story, art);
    else if (story && kind === 'ghost') this.drawGhost(ms, story, art);
    else this.drawStar(ms, art);
    if (ms >= CROWN_AT) {
      this.cue('crown', () => this.sound?.play('wrap'));
      this.confetti(ms - CROWN_AT);
    }
    // вызов зрителю — под сюжет, и QR
    if (ms >= CTA_AT) {
      const cta = this.inp.tooAlive ? t.clip.stories.star.cta : st.cta;
      text(g, typed(cta, CTA_AT), cx, 158, PAL.yellow, font, { maxWidth: W + 4 });
      this.callToPlay(170);
    }
    g.restore();
  }

  private factLine(kind: StoryKind, s: FilmStory | null): string {
    const t = this.inp.t.clip;
    if (this.inp.tooAlive) return '';
    if (!s) return '';
    if (kind === 'photo' && s.value === 0) return t.photoTie;
    if (kind === 'star') {
      const me = this.inp.cast.find((c) => c.color === s.hero.color);
      return me ? fmt(t.stories.star.fact, { n: me.points }) : '';
    }
    return fmt(t.stories[kind].fact, { n: s.value, a: s.value, b: s.value2 ?? 0 });
  }

  /** Корона ×2 падает на точку (x, y — низ короны) за 180 мс после CROWN_AT. */
  private crown(ms: number, x: number, y: number, art: ReturnType<typeof getArt>): void {
    if (ms < CROWN_AT) return;
    const at = art.icons.names.indexOf('crown');
    if (at < 0) return;
    const drop = Math.max(0, 6 - Math.floor((ms - CROWN_AT) / 25));
    const g = this.g;
    g.save();
    g.scale(2, 2);
    frame(g, art.icons.canvas, 8, 8, at, Math.round(x / 2) - 4, Math.round((y - drop) / 2) - 8);
    g.restore();
  }

  /** Фигура ×k: ноги в (x, floor), контур цветом игрока (или без), кадр fr. */
  private figure(art: ReturnType<typeof getArt>, idx: number, x: number, floor: number, k: number, fr: number, color: number | null, flip = false): void {
    const g = this.g;
    const ch = art.charsFor(this.inp.hook.rec.theme, 0, idx);
    g.save();
    g.scale(k, k);
    const sx = Math.round(x / k);
    const sy = Math.round(floor / k);
    g.drawImage(art.shadow, sx - 5, sy - 2);
    if (color !== null) frame(g, ch.outline[1 + color], OL_W, OL_H, fr, sx - 7, sy - 17, flip);
    frame(g, ch.body, CH_W, CH_H, fr, sx - 6, sy - CH_H, flip);
    g.restore();
  }

  private dance(ms: number, phase = 0): number {
    return F.DANCE + (Math.floor((ms + phase) / 160) % 4);
  }

  /**
   * «Табло дублей»: строка на игрока — имя на полоске очков и число справа. Дубль за дублем
   * («Дубль 1, 2, 3…» сверху) полоски растут, а строки меняются местами при обгоне — видно,
   * кто вёл и кто кого догнал. Полоска лидера доходит до флажка финиша; герой — в жёлтой рамке.
   * Камбэк — красное «−N» у героя в дубль, когда он был ниже всех; фотофиниш — скобка между первыми двумя.
   */
  private drawBoard(ms: number, s: FilmStory): void {
    const g = this.g;
    const t = this.inp.t;
    const font = this.inp.font;
    const n = s.lines[0].pts.length - 1;
    if (n < 1) return;
    const names = new Map(this.inp.cast.map((c) => [c.color, c.name]));
    const maxP = Math.max(1, ...s.lines.flatMap((l) => l.pts));
    const X0 = SAFE_L + 2;
    const X1 = SAFE_R - 16;
    const Y0 = 88;
    const ROW = 15;
    const BAR = 11;
    // шаги табло: по дублю, всё табло — до короны
    const start = 700;
    const step = Math.max(450, Math.min(900, (CROWN_AT - 150 - start) / n));
    const k = Math.max(0, Math.min(n, (ms - start) / step));
    const i = Math.min(n - 1, Math.floor(k));
    const e = smooth((k - i) * 1.6);
    const cur = ms < start ? 0 : Math.min(n, i + 1);
    // счётчик дублей с ударом на каждый шаг
    if (ms >= start) {
      this.cue(`board${cur}`, () => this.sound?.play('count'));
      text(g, fmt(t.clip.round, { n: cur }), (SAFE_L + SAFE_R) / 2, 76, PAL.mist, font, { outline: null });
    }
    // места до и после текущего шага: больше очков — выше, при равенстве — герой, потом итог матча
    const fin = (l: FilmStory['lines'][number]) => l.pts[n];
    const rank = (j: number) => {
      const order = [...s.lines].sort((a, b) => b.pts[j] - a.pts[j] || (b.color === s.hero.color ? 1 : 0) - (a.color === s.hero.color ? 1 : 0) || fin(b) - fin(a) || a.color - b.color);
      return new Map(order.map((l, r) => [l.color, r]));
    };
    const from = rank(ms < start ? 0 : i);
    const to = rank(ms < start ? 0 : i + 1);
    // флажок финиша
    g.fillStyle = PAL.slate;
    for (let y = Y0 - 2; y < Y0 + s.lines.length * ROW - 2; y += 3) g.fillRect(X1 + 1, y, 1, 2);
    g.fillRect(X1 + 1, Y0 - 9, 1, 7);
    for (let q = 0; q < 8; q++) {
      g.fillStyle = (q + Math.floor(q / 4)) % 2 ? PAL.ink : PAL.white;
      g.fillRect(X1 + 2 + (q % 4) * 2, Y0 - 9 + Math.floor(q / 4) * 2, 2, 2);
    }
    const rows = s.lines.map((l) => {
      const ra = from.get(l.color)!;
      const rb = to.get(l.color)!;
      const y = Math.round(Y0 + (ra + (rb - ra) * e) * ROW);
      const a = ms < start ? 0 : l.pts[i];
      const b = ms < start ? 0 : l.pts[i + 1];
      const v = a + (b - a) * e;
      return { l, y, v, shown: e > 0.5 ? b : a, hero: l.color === s.hero.color };
    });
    // герой рисуется последним — поверх обгоняемых
    rows.sort((a, b) => Number(a.hero) - Number(b.hero));
    let heroTip = { x: X0, y: Y0 };
    for (const r of rows) {
      const w = Math.max(2, Math.round(((X1 - X0) * r.v) / maxP));
      g.fillStyle = PAL.night;
      g.fillRect(X0, r.y, X1 - X0, BAR);
      g.fillStyle = PLAYER_COLORS[r.l.color];
      g.fillRect(X0, r.y, w, BAR);
      if (r.hero) {
        g.fillStyle = PAL.yellow;
        g.fillRect(X0 - 1, r.y - 1, X1 - X0 + 2, 1);
        g.fillRect(X0 - 1, r.y + BAR, X1 - X0 + 2, 1);
        g.fillRect(X0 - 1, r.y, 1, BAR);
        g.fillRect(X1, r.y, 1, BAR);
        heroTip = { x: X0 + w, y: r.y };
      }
      text(g, names.get(r.l.color) ?? '', X0 + 2, r.y + 2, PAL.white, font, { align: 'left', maxWidth: X1 - X0 - 4 });
      text(g, String(r.shown), SAFE_R, r.y + 2, r.hero ? PAL.yellow : PAL.white, font, { align: 'right', outline: null });
    }
    // камбэк: «−N» у героя, пока табло стоит на его худшем дубле
    if (s.kind === 'comeback' && s.lowRound !== undefined && cur === s.lowRound && ms >= start) {
      const hr = rows.find((r) => r.hero)!;
      text(g, `-${s.value}`, Math.min(X1 - 14, heroTip.x + 3), hr.y + 2, PAL.red, font, { align: 'left' });
    }
    // фотофиниш: скобка между героем и соперником на финише
    if (s.kind === 'photo' && s.rival && k >= n) {
      const ya = rows.find((r) => r.hero)!.y;
      const yb = rows.find((r) => r.l.color === s.rival!.color)?.y ?? ya;
      const x = SAFE_R + 3;
      g.fillStyle = PAL.yellow;
      g.fillRect(x, Math.min(ya, yb) + 5, 1, Math.abs(yb - ya) + 1);
      g.fillRect(x - 2, ya + 5, 2, 1);
      g.fillRect(x - 2, yb + 5, 2, 1);
    }
    if (k >= n) this.crown(ms, Math.min(X1 - 6, heroTip.x - 6), heroTip.y + 1, getArt(this.inp.hook.arena));
  }

  /**
   * «Гонка очков»: линии игроков по дублям рисуются слева направо, герой — толще и последним.
   * Камбэк — красная метка на самом низком месте героя; фотофиниш — скобка между первым и вторым.
   */
  private drawChart(ms: number, s: FilmStory): void {
    const g = this.g;
    const n = s.lines[0].pts.length - 1;
    const maxP = Math.max(1, ...s.lines.map((l) => l.pts[n]), ...s.lines.flatMap((l) => l.pts));
    const X0 = 18;
    const X1 = 146;
    const Y0 = 148;
    const HY = 54;
    const xOf = (i: number) => X0 + (i * (X1 - X0)) / n;
    const yOf = (v: number) => Y0 - (v * HY) / maxP;
    // ось и деления дублей
    g.fillStyle = PAL.slate;
    g.fillRect(X0 - 2, Y0 + 2, X1 - X0 + 4, 1);
    for (let i = 0; i <= n; i++) g.fillRect(Math.round(xOf(i)), Y0 + 3, 1, 2);
    const pr = smooth((ms - 700) / 1600) * n;
    const order = [...s.lines].sort((a, b) => (a.color === s.hero.color ? 1 : b.color === s.hero.color ? -1 : 0));
    for (const l of order) {
      const isHero = l.color === s.hero.color;
      const w = isHero ? 2 : 1;
      g.fillStyle = PLAYER_COLORS[l.color];
      let tip = { x: xOf(0), y: yOf(0) };
      for (let i = 0; i < n && i < pr; i++) {
        const f = Math.min(1, pr - i);
        const xa = xOf(i);
        const xb = xOf(i) + (xOf(i + 1) - xOf(i)) * f;
        const ya = yOf(l.pts[i]);
        const yb = ya + (yOf(l.pts[i + 1]) - ya) * f;
        let py = Math.round(ya);
        for (let x = Math.round(xa); x <= Math.round(xb); x++) {
          const y = Math.round(ya + ((yb - ya) * (x - xa)) / Math.max(1, xb - xa));
          // вертикальный шаг — сплошной столбик, без дыр
          const y0 = Math.min(py, y);
          g.fillRect(x, y0, w, Math.abs(y - py) + w);
          py = y;
        }
        tip = { x: xb, y: yb };
      }
      g.fillRect(Math.round(tip.x) - 1, Math.round(tip.y) - 1, 2 + w, 2 + w);
      if (isHero && pr >= n) {
        this.crown(ms, Math.round(tip.x) + 1, Math.round(tip.y) - 2, getArt(this.inp.hook.arena));
      }
    }
    // камбэк: «дно» героя — красная стрелка вниз и −N
    if (s.kind === 'comeback' && s.lowRound !== undefined && pr >= s.lowRound) {
      const hl = s.lines.find((l) => l.color === s.hero.color)!;
      const x = Math.round(xOf(s.lowRound));
      const y = Math.round(yOf(hl.pts[s.lowRound])) + 4;
      g.fillStyle = PAL.red;
      for (let k = 0; k < 4; k++) g.fillRect(x - 3 + k, y + k, 7 - 2 * k, 1);
      text(g, `-${s.value}`, x, y + 5, PAL.red, this.inp.font, { size: 1 });
    }
    // фотофиниш: скобка между первым и вторым на финише
    if (s.kind === 'photo' && s.rival && pr >= n) {
      const a = s.lines.find((l) => l.color === s.hero.color)!.pts[n];
      const b = s.lines.find((l) => l.color === s.rival!.color)!.pts[n];
      const x = X1 + 6;
      const ya = Math.round(yOf(a));
      const yb = Math.round(yOf(b));
      g.fillStyle = PAL.yellow;
      g.fillRect(x, Math.min(ya, yb), 1, Math.abs(yb - ya) + 1);
      g.fillRect(x - 2, ya, 2, 1);
      g.fillRect(x - 2, yb, 2, 1);
    }
  }


  /**
   * «Забег к финишу»: дорожка на игрока (победитель — сверху), имя у старта, очки — у флажка.
   * Каждый дубль — рывок: человечек бежит вперёд на свои очки; лидер добегает до флажка.
   */
  private drawRace(ms: number, s: FilmStory, art: ReturnType<typeof getArt>): void {
    const g = this.g;
    const t = this.inp.t;
    const font = this.inp.font;
    const n = s.lines[0].pts.length - 1;
    if (n < 1) return;
    const names = new Map(this.inp.cast.map((c) => [c.color, c.name]));
    const maxP = Math.max(1, ...s.lines.flatMap((l) => l.pts));
    const X0 = SAFE_L + 8;
    const X1 = SAFE_R - 18;
    const Y0 = 84;
    const LANE = 18;
    const start = 700;
    const step = Math.max(450, Math.min(900, (CROWN_AT - 150 - start) / n));
    const k = Math.max(0, Math.min(n, (ms - start) / step));
    const i = Math.min(n - 1, Math.floor(k));
    const e = smooth((k - i) * 1.4);
    const cur = ms < start ? 0 : Math.min(n, i + 1);
    if (ms >= start) {
      this.cue(`race${cur}`, () => this.sound?.play('count'));
      text(g, fmt(t.clip.round, { n: cur }), (SAFE_L + SAFE_R) / 2, 74, PAL.mist, font, { outline: null });
    }
    const lanes = [...s.lines].sort((a, b) => b.pts[n] - a.pts[n] || (b.color === s.hero.color ? 1 : 0) - (a.color === s.hero.color ? 1 : 0) || a.color - b.color);
    // финишная черта — шашечки во всю высоту дорожек
    for (let y = Y0; y < Y0 + lanes.length * LANE; y += 2) {
      g.fillStyle = (y / 2) % 2 ? PAL.white : PAL.ink;
      g.fillRect(X1 + 6, y, 2, 2);
      g.fillStyle = (y / 2) % 2 ? PAL.ink : PAL.white;
      g.fillRect(X1 + 8, y, 2, 2);
    }
    lanes.forEach((l, li) => {
      const floor = Y0 + li * LANE + LANE - 2;
      const isHero = l.color === s.hero.color;
      // дорожка
      g.fillStyle = PAL.night;
      g.fillRect(X0 - 6, floor - 1, X1 - X0 + 12, 2);
      text(g, names.get(l.color) ?? '', X0 - 4, floor - 13, PLAYER_COLORS[l.color], font, { align: 'left', maxWidth: X1 - X0 });
      const a = ms < start ? 0 : l.pts[i];
      const b = ms < start ? 0 : l.pts[i + 1];
      const v = a + (b - a) * e;
      const x = X0 + ((X1 - X0) * v) / maxP;
      const moving = ms >= start && k < n && b !== a && e > 0 && e < 1;
      const done = k >= n && l.pts[n] === maxP;
      const fr = done ? this.dance(ms, li * 90) : moving ? F.S + 2 + (Math.floor(ms / 90) % 4) : F.S;
      this.figure(art, li, x, floor, 1, fr, l.color);
      text(g, String(e > 0.5 || k >= n ? b : a), SAFE_R, floor - 9, isHero ? PAL.yellow : PAL.white, font, { align: 'right', outline: null });
      if (isHero && k >= n) this.crown(ms, Math.round(x), floor - CH_H - 1, art);
    });
  }

  /**
   * «Пьедестал»: ступени 2-1-3 поднимаются по очереди (третье место — первым), на них спрыгивают
   * человечки в цветах игроков, очки — на ступенях; сверху — места списком «1 Имя», в цвете игрока
   * (длинное имя не налезает на соседей). Корону заменяет сама верхняя ступень и танец победителя.
   */
  private drawPodium(ms: number, art: ReturnType<typeof getArt>): void {
    const g = this.g;
    const font = this.inp.font;
    const cast = this.inp.cast.slice(0, 3);
    const cx = (SAFE_L + SAFE_R) / 2;
    const base = 154;
    const W = 44;
    // место → x центра ступени, высота, когда встаёт
    const spot = [
      { x: cx, h: 22, at: 1500 },
      { x: cx - W - 2, h: 16, at: 1100 },
      { x: cx + W + 2, h: 10, at: 700 },
    ];
    cast.forEach((c, i) => {
      const sp = spot[i];
      if (ms < sp.at) return;
      const rise = smooth((ms - sp.at) / 260);
      const h = Math.round(sp.h * rise);
      g.fillStyle = PAL.night;
      g.fillRect(Math.round(sp.x - W / 2), base - h, W, h);
      g.fillStyle = PLAYER_COLORS[c.color];
      g.fillRect(Math.round(sp.x - W / 2), base - h, W, 2);
      // место в списке сверху
      const ly = 71 + i * 9;
      text(g, String(i + 1), SAFE_L + 2, ly, i === 0 ? PAL.yellow : PAL.mist, font, { align: 'left', outline: null });
      text(g, c.name, SAFE_L + 14, ly, PLAYER_COLORS[c.color], font, { align: 'left', maxWidth: SAFE_R - SAFE_L - 14 });
      if (rise < 1) return;
      this.cue(`pod${i}`, () => this.sound?.play('count'));
      text(g, String(c.points), sp.x, base - sp.h + 3, i === 0 ? PAL.yellow : PAL.white, font, { outline: null });
      const drop = Math.max(0, 12 - Math.floor((ms - sp.at - 260) / 20));
      this.figure(art, i, sp.x, base - sp.h - drop, 2, i === 0 && ms >= CROWN_AT ? this.dance(ms) : F.D, c.color);
    });
  }

  /** Дуэль: двое в стойке в двух лучах, счёт дуэли между ними; герой бьёт — соперник исчезает. */
  private drawDuel(ms: number, s: FilmStory, art: ReturnType<typeof getArt>): void {
    const g = this.g;
    const floor = 146;
    const hx = 46;
    const rx = 114;
    this.beam(hx, floor, 16);
    this.beam(rx, floor, 16);
    // счёт дуэли — над головами, между лучами
    text(g, `${s.value}:${s.value2 ?? 0}`, LW / 2, 80, PAL.white, this.inp.font, { size: 2 });
    const HIT = 1700;
    const jab = ms >= HIT - 120 && ms < HIT + 160;
    this.figure(art, 3, hx, floor, 3, ms >= HIT + 160 ? this.dance(ms) : jab ? F.JAB : F.GUARD, s.hero.color);
    if (ms < HIT) this.figure(art, 7, rx, floor, 3, F.GUARD, s.rival?.color ?? null, true);
    else {
      this.cue('duelHit', () => {
        this.sound?.play('hitPlayer');
        this.sound?.play('poof');
      });
      const since = ms - HIT;
      if (since < 360) {
        g.save();
        g.scale(3, 3);
        frame(g, art.poof, 24, 24, Math.min(5, Math.floor(since / 60)), Math.round(rx / 3) - 12, Math.round(floor / 3) - 20);
        g.restore();
      }
    }
    if (s.rival && ms < HIT) namePlate(g, s.rival.name, rx, 151, PLAYER_COLORS[s.rival.color], this.inp.font, false);
    this.crown(ms, hx, floor - CH_H * 3 - 2, art);
  }

  /** Гроза площадки: вырезанные выстроены в ряд и исчезают по одному; герой в центре. */
  private drawHunter(ms: number, s: FilmStory, art: ReturnType<typeof getArt>): void {
    const g = this.g;
    const v = s.victims.slice(0, 8);
    const step = Math.min(18, Math.floor(140 / Math.max(1, v.length)));
    const x0 = Math.round(LW / 2 - 4 - ((v.length - 1) * step) / 2);
    v.forEach((col, i) => {
      const at = 700 + i * 200;
      const x = x0 + i * step;
      if (ms < at) this.figure(art, 5 + i, x, 104, 2, F.D, col);
      else {
        this.cue(`cut${i}`, () => this.sound?.play('poof'));
        const since = ms - at;
        if (since < 360) frame(g, art.poof, 24, 24, Math.min(5, Math.floor(since / 60)), x - 12, 104 - 20);
      }
    });
    const floor = 152;
    this.beam(LW / 2 - 4, floor, 18);
    this.figure(art, 2, LW / 2 - 4, floor, 3, ms > 700 + v.length * 200 ? this.dance(ms) : F.GUARD, s.hero.color);
    this.crown(ms, LW / 2 - 4, floor - CH_H * 3 - 2, art);
  }

  /** Невидимка: толпа в ряд, прожектор ищет и дважды проходит мимо; останавливается — герой загорается. */
  private drawGhost(ms: number, s: FilmStory, art: ReturnType<typeof getArt>): void {
    const n = 7;
    const hi = 4;
    const xs = Array.from({ length: n }, (_, i) => 20 + i * 20);
    const floor = 140;
    // путь луча: вправо, влево, к герою
    const path: [number, number, number][] = [
      [300, 20, 140],
      [1100, 140, 30],
      [1800, 30, xs[hi]],
    ];
    let bx = 20;
    for (const [t0, a, b] of path) if (ms >= t0) bx = a + (b - a) * smooth((ms - t0) / 700);
    const FOUND = 2500 - 300;
    this.beam(bx, floor, 14);
    xs.forEach((x, i) => {
      const lit = Math.abs(x - bx) < 10;
      const g = this.g;
      if (!lit && ms < FOUND) g.globalAlpha = 0.55;
      const isHero = i === hi && ms >= FOUND;
      this.figure(art, i, x, floor, 2, isHero ? this.dance(ms) : F.D, isHero ? s.hero.color : null);
      g.globalAlpha = 1;
    });
    if (ms >= FOUND) {
      this.cue('found', () => this.sound?.play('unmask', 4));
      namePlate(this.g, s.hero.name, xs[hi], 78, PLAYER_COLORS[s.hero.color], this.inp.font, true);
    }
    this.crown(ms, xs[hi], floor - CH_H * 2 - 2, art);
  }

  /** «Звезда фильма» (или «Слишком заметные»): победитель ×4 танцует в луче, двое лидеров — ×3. */
  private drawStar(ms: number, art: ReturnType<typeof getArt>): void {
    const g = this.g;
    const cx = (SAFE_L + SAFE_R) / 2;
    const floor = 146;
    this.beam(cx, floor, 30);
    const win = this.inp.winner;
    if (this.inp.tooAlive || !win) {
      this.inp.cast.slice(0, 2).forEach((c, i) => {
        this.figure(art, i, cx + (i ? 24 : -24), floor, 3, this.dance(ms, i * 90), c.color);
        text(g, c.name, cx + (i ? 38 : -38), 84, PLAYER_COLORS[c.color], this.inp.font, { maxWidth: 70 });
      });
      return;
    }
    this.figure(art, 0, cx, floor, 3, this.dance(ms), win.color);
    this.crown(ms, cx, floor - CH_H * 3 - 2, art);
  }

  /** Луч прожектора сверху и пятно света на полу. */
  private beam(x: number, floor: number, half: number): void {
    const g = this.g;
    const top = 76;
    g.globalAlpha = 0.1;
    g.fillStyle = PAL.white;
    for (let y = top; y < floor; y += 2) {
      const h = Math.round(4 + ((y - top) / (floor - top)) * half);
      g.fillRect(Math.round(x) - h, y, h * 2, 2);
    }
    g.globalAlpha = 0.22;
    g.fillStyle = PAL.yellow;
    for (let dy = -4; dy <= 4; dy++) {
      const h = Math.round((half + 4) * Math.sqrt(1 - (dy / 5) ** 2));
      g.fillRect(Math.round(x) - h, floor + dy, h * 2, 1);
    }
    g.globalAlpha = 1;
  }

  /** Конфетти: цвета игроков и жёлтый, сыплются после короны. */
  private confetti(ms: number): void {
    const g = this.g;
    const colors = [...PLAYER_COLORS, PAL.yellow, PAL.white];
    for (let i = 0; i < 36; i++) {
      const h = Math.sin(i * 12.9898) * 43758.5453;
      const r = h - Math.floor(h);
      const x = SAFE_L + Math.floor(r * (SAFE_R - SAFE_L));
      const speed = 0.05 + r * 0.05;
      const y = 26 + ((Math.floor(r * 997) % 60) + ms * speed) % 170;
      g.fillStyle = colors[i % colors.length];
      g.fillRect(x + Math.round(Math.sin((ms + i * 200) / 180) * 2), Math.round(y), 2, (i + Math.floor(ms / 120)) % 2 ? 2 : 1);
    }
  }

  /**
   * Титры как в кино: роль и имя — «В главной роли / Енот», «Соперник» из сюжета, награда матча как роль,
   * «В эпизоде», «Массовка / 28 ботов»; под ними окошко «Неудачные дубли» — удары по массовке за матч.
   */
  private drawCredits(ms: number): void {
    const g = this.g;
    const t = this.inp.t;
    const font = this.inp.font;
    const lang = this.inp.lang ?? 'ru';
    this.backdrop(0.9);
    const cx = (SAFE_L + SAFE_R) / 2;
    const win = this.inp.tooAlive ? undefined : this.inp.winner;
    const rival = this.story()?.rival;
    const rows: { role: string; name: string; color: string; points?: number; self?: boolean }[] = this.inp.cast.map((c) => ({
      role: win && c.color === win.color ? t.clip.lead : rival && c.color === rival.color ? t.clip.rival : (c.award ?? t.clip.cameo),
      name: c.name,
      color: PLAYER_COLORS[c.color],
      points: c.points,
      self: this.inp.self === c.color,
    }));
    if (this.inp.bots) rows.push({ role: t.clip.extrasRole, name: tp(lang, t.clip.bots, this.inp.bots), color: PAL.mist });
    // строки поднимаются по одной снизу — как бегущие титры
    let y = 38;
    rows.forEach((r, i) => {
      const at = i * 140;
      if (ms < at) return;
      const rise = Math.max(0, 8 - Math.floor((ms - at) / 25));
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
          // неудачный дубль в титрах — только эффекты: его части не трогают музыку фильма
          // (раньше тишина перед ударом и возобновление обрывали затухание и возвращали песню)
          sc.sound = this.sound ? sfxOnly(this.sound) : null;
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

/** Звук без управления музыкой: только эффекты и планирование. */
function sfxOnly(s: ClipSoundCore): ClipSoundCore {
  const no = () => {};
  return { ...s, start: no, setTwist: no, pause: no, resume: no, intensity: no, level: no, fadeOut: no, hush: no, stop: no, play: (n, k) => s.play(n, k), pump: () => s.pump() };
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
  const scoreOf = () => [...players].sort((a, b) => a.color - b.color).map((p) => ({ color: p.color, points: total.get(p.pid) ?? 0 }));
  // итоги дублей для сюжета финала: очки, кто кого вырезал, удары по массовке (по pid)
  const storyRounds: StoryRound[] = [];
  for (const tk of takes) {
    const s = tk.summary;
    const scoreBefore = scoreOf();
    for (const [pid, line] of Object.entries(s.points)) total.set(pid, (total.get(pid) ?? 0) + line.total);
    const pidOf = new Map(s.reveal.map((r) => [r.eid, r.pid]));
    const botHits: Record<string, number> = {};
    for (const ev of tk.rec.log) {
      const by = ev.t === 'hit' && ev.result === 'bot' && ev.attacker !== undefined ? pidOf.get(ev.attacker) : undefined;
      if (by) botHits[by] = (botHits[by] ?? 0) + 1;
    }
    storyRounds.push({
      points: Object.fromEntries(Object.entries(s.points).map(([pid, l]) => [pid, l.total])),
      kills: (s.kills ?? []).flatMap((k) => {
        const by = pidOf.get(k.by);
        const victim = pidOf.get(k.victim);
        return by && victim ? [{ by, victim }] : [];
      }),
      botHits,
    });
    const moment = findBestMoment({ ...tk.rec, kills: s.kills });
    if (!moment) continue;
    const byEid = new Map(s.reveal.map((r) => [r.eid, r.pid]));
    const heroEid = moment.attacker ?? moment.victim;
    const clipPlayers: ClipPlayer[] = s.reveal.flatMap((r) => {
      const p = info.get(r.pid);
      return p ? [{ eid: r.eid, name: p.name, color: p.color }] : [];
    });
    const score = scoreOf();
    cands.push({
      round: tk.rec.round,
      moment,
      hero: heroEid !== undefined ? byEid.get(heroEid) : undefined,
      film: { rec: tk.rec, moment, arena: tk.arena, players: clipPlayers, hero: heroEid !== undefined && byEid.has(heroEid) ? heroEid : undefined, score, scoreBefore },
    });
  }
  const ms = matchStory(storyRounds, players.map((p) => p.pid), match.winners, match.tooAlive);
  const who = (pid: string | undefined) => {
    const p = pid !== undefined ? info.get(pid) : undefined;
    return p ? { name: p.name, color: p.color } : undefined;
  };
  const storyHero = ms ? who(ms.hero) : undefined;
  const story: FilmStory | undefined =
    ms && storyHero
      ? {
          kind: ms.kind,
          hero: storyHero,
          rival: who(ms.rival),
          lines: [...players].sort((a, b) => a.color - b.color).map((p) => ({ color: p.color, pts: ms.history[p.pid] ?? [] })),
          lowRound: ms.lowRound,
          victims: ms.victims.flatMap((pid) => (info.has(pid) ? [info.get(pid)!.color] : [])),
          value: ms.value,
          value2: ms.value2,
        }
      : undefined;
  // моменты подбираются под сюжет: соперник дуэли или фотофиниша тоже получает свой момент
  const picked = pickFilmMoments(cands, { winner: match.winners[0], rival: ms?.rival });
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
    story,
  };
}
