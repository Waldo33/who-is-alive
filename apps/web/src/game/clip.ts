import { PAL, PLAYER_COLORS } from '@kto/assets';
import { TICK_MS, fmt, makeReplay, worldOf } from '@kto/game-core';
import type { ArenaDef, Dict, Moment, RoundRecording, World, WorldEvent } from '@kto/game-core';
import qrcode from 'qrcode-generator';
import type { ClipSoundCore } from './clip-audio';
import { frame, getArt, scaledCanvas, text } from './art';
import { canvas } from './pixels';
import type { Art } from './art';
import { frameFor } from './frames';
import { CH_H, CH_W, F, OL_H, OL_W } from './sprites';
import { aim, armed, armsOf, bodyPose, drawAir, drawFloor, killsFromLog, weaponSfx } from './gore';
import type { Holder, Kill, Px } from './gore';
import { isThemeLoaded, themeLook, themePack } from './themes';

/**
 * Клип «Лучший момент» (раздел 11 ТЗ) и куски «Фильма матча» (film.ts): 1080×1920.
 * Рисуется на обычном canvas теми же спрайтами, что игра, целым масштабом без сглаживания.
 * В браузере пишется в видео через MediaRecorder в реальном времени, на сервере —
 * кадрами в ffmpeg (apps/server/src/film.ts). Режимы:
 *   clip    — момент как его видели игроки («Найдёшь живых?») → разбор с подсветкой → концовка с адресом и QR;
 *   segment — кусок фильма: хлопушка «Дубль N» → разбор (быстрее и короче);
 *   hook    — крючок фильма: почти стоп-кадр за миг до развязки, крупно, без подсказок.
 *
 * Вёрстка — под интерфейс TikTok, Reels и Shorts: всё, что надо прочесть, — в безопасной зоне
 * (x 10…153, y 37…208 из 180×320); нижняя полоса — только счёт и декор, её закрывает подпись поста.
 */
/** Тишина перед ударом в клипе, мс. */
const HUSH_MS = 120;
const LW = 180;
const LH = 320;
const AY = 24;
const PANEL_Y = 284;
export const CLIP_SCALE = 6;
/** Безопасная зона: плашка подписи и водяной знак. */
const SAFE_L = 6;
const SAFE_R = 156;
const PLATE_Y = 38;
/** Водяной знак — у нижнего края безопасной зоны: вверху его закрывали бы плашки с именами. */
const WM_Y = 198;
const PART_MAX_MS = 5000;
const OUTRO_MS = 2600;
const FLASH_MS = 220;
const FPS = 30;
/** Живые загораются по одному (герой — последним), чтобы зритель успел сверить свою догадку. */
const REVEAL_STEP = 140;
/** Хлопушка перед куском фильма и крючок фильма. */
export const CLAP_MS = 450;
export const HOOK_MS = 1300;
/**
 * «Ирис» — круг затемнения, как в старом кино: сужается на герое в конце куска фильма и раскрывается
 * в начале следующего. Края — ступенями по логическим пикселям (палитра и чёткость сохраняются).
 */
export function drawIris(g: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  g.fillStyle = PAL.ink;
  for (let y = 0; y < LH; y++) {
    const dy = y + 0.5 - cy;
    if (Math.abs(dy) >= r) {
      g.fillRect(0, y, LW, 1);
      continue;
    }
    const half = Math.sqrt(r * r - dy * dy);
    const x0 = Math.round(cx - half);
    const x1 = Math.round(cx + half);
    if (x0 > 0) g.fillRect(0, y, x0, 1);
    if (x1 < LW) g.fillRect(x1, y, LW - x1, 1);
  }
}

/** Радиус, при котором ирис с центром (cx, cy) открывает весь кадр. */
export function irisFull(cx: number, cy: number): number {
  return Math.hypot(Math.max(cx, LW - cx), Math.max(cy, LH - cy)) + 1;
}

/** Кусок фильма: сколько мира до и после главного события. */
const SEG_PRE = 2600;
const SEG_POST = 900;
const SEG_PLAIN = 4000;

/**
 * clip — клип выбывшего: загадка → разбор → концовка; feature — главный момент фильма: загадка с отсчётом
 * и дробью → разбор в полном темпе клипа; segment — короткий кусок фильма; hook — крючок фильма;
 * blooper — «неудачный дубль» для окошка в титрах: удар по массовке общим планом, все живые подписаны сразу.
 */
export type ClipMode = 'clip' | 'segment' | 'hook' | 'feature' | 'blooper';
/** Загадка главного момента фильма — не дольше этого: зритель успевает поискать, но не заскучать. */
const FEATURE_PUZZLE_MAX = 4200;
/** Отсчёт «3, 2, 1» в конце загадки; дробь — за секунду до раскрытия (её удар совпадает со вспышкой). */
const COUNT_FROM = 3;
const DRUM_LEAD_MS = 980;
/**
 * Короткий кусок фильма тоже начинается «скрыто»: до SEG_HIDDEN мс мира без подсветки, затем вспышка
 * и живые загораются прямо перед ударом (вкус загадки без лишней длины). До удара остаётся не меньше
 * SEG_REVEAL_LEAD мира — успеть увидеть, кто есть кто.
 */
const SEG_HIDDEN = 1300;
const SEG_REVEAL_LEAD = 400;

export interface ClipPlayer {
  eid: number;
  name: string;
  color: number;
}

export interface ClipInput {
  rec: RoundRecording;
  moment: Moment;
  arena: ArenaDef;
  players: ClipPlayer[];
  t: Dict;
  font: string;
  site: string;
  /** Подписи вместо стандартных (клип выбывшего посреди раунда: «Найдёшь меня?» → «Это был я!»). */
  captions?: { find: string; findSub?: string; reveal: string; kind: string };
  /** Без крови (детский режим): выбивание — «поф» и в теме с оружием. */
  noGore?: boolean;
  /** Победитель матча (клип из итогов матча): на заставке — его имя и корона над его цветом. */
  winner?: { name: string; color: number };
  /** Герой ролика — автор клипа или главный участник момента в фильме: сильная подсветка. */
  hero?: number;
  /** Масштаб холста: 6 — 1080×1920 (телефон), 2 — 360×640 (сервер, до 1080 растягивает ffmpeg). */
  scale?: number;
  mode?: ClipMode;
  /** Счёт матча после этого дубля (кусок фильма): цвет игрока → очки, в нижней полосе. */
  score?: { color: number; points: number }[];
  /** Счёт до этого дубля: виден до удара, потом сменяется счётом после (изменившиеся вспыхивают). */
  scoreBefore?: { color: number; points: number }[];
  /** Ссылка в QR концовки (по умолчанию https://site). */
  link?: string;
  /**
   * Музыку ведёт фильм (одна песня на весь ролик): сцена её не перезапускает, только продолжает
   * после паузы «Море волнуется» и переключает изнанку.
   */
  keepMusic?: boolean;
}

export interface ClipResult {
  blob: Blob;
  ext: 'mp4' | 'webm';
  mime: string;
}

/** Формат записи; withAudio — сначала форматы со звуком (AAC в mp4, Opus в webm). */
export function pickClipMime(withAudio = false): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement === 'undefined') return null;
  if (!('captureStream' in HTMLCanvasElement.prototype)) return null;
  const audio = withAudio
    ? [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4;codecs=avc1,mp4a.40.2',
        // Chrome/Android: mp4 со звуком Opus — сторис и видео в Telegram берут только mp4, не webm
        'video/mp4;codecs=avc1.42E01E,opus',
        'video/mp4;codecs=avc1,opus',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
      ]
    : [];
  const list = [
    ...audio,
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return list.find((m) => MediaRecorder.isTypeSupported?.(m)) ?? null;
}

/** Часть повтора: отрезок клипа [c0, c1) показывает мир [w0, w1] (стоп-кадр — w0 = w1). */
interface Seg {
  c0: number;
  c1: number;
  w0: number;
  w1: number;
}

/** Части ролика по порядку. */
type PartKind = 'puzzle' | 'reveal' | 'clap' | 'outro';

/** Темп разбора: обычная скорость, замедление вокруг удара, стоп-кадр, наезд камеры. */
interface Timing {
  base: number;
  slow: number;
  slowPre: number;
  slowPost: number;
  hold: number;
  cutBefore: number;
  wideMin: number;
}
const CLIP_T: Timing = { base: 1.25, slow: 0.4, slowPre: 700, slowPost: 500, hold: 450, cutBefore: 1600, wideMin: 900 };
const SEG_T: Timing = { base: 1.4, slow: 0.5, slowPre: 500, slowPost: 400, hold: 400, cutBefore: 1400, wideMin: 700 };
/** Главный момент фильма: темп клипа, но короче замедление и хвост — чтобы в фильм влез ещё момент. */
const FEAT_T: Timing = { base: 1.35, slow: 0.45, slowPre: 600, slowPost: 350, hold: 450, cutBefore: 1500, wideMin: 900 };
/** Хвост мира после удара у главного момента фильма (дальше — ирис на герое). */
const FEAT_POST = 1000;
const BLOOP_T: Timing = { base: 1.1, slow: 0.5, slowPre: 300, slowPost: 300, hold: 250, cutBefore: 0, wideMin: 0 };

/** Камера разбора: целое увеличение (пиксели остаются чёткими), видна четверть арены. */
const ZOOM = 2;
/**
 * Наезд камеры — не скачком, а за ZOOM_MS ступенями целого числа выходных пикселей на пиксель мира
 * (на сервере ×3 → ×4 → ×5 → ×6, на телефоне ×6 … ×12): каждый пиксель мира остаётся ровным квадратом,
 * а центр кадра плавно уходит от середины площади к участникам.
 */
const ZOOM_MS = 600;
/** Камера догоняет цель с этой постоянной времени, мс (не зависит от частоты кадров). */
const CAM_TAU = 140;
const PART1_SPEED = 1.5;
const PART1_MAX_MS = 4500;

/** QR-код ссылки: модули чёрным по белому с полем 2 модуля, 1 модуль = 1 игровой пиксель. */
export function drawQr(g: CanvasRenderingContext2D, link: string, x: number, y: number): number {
  const q = qrcode(0, 'M');
  q.addData(link);
  q.make();
  const n = q.getModuleCount();
  const size = n + 4;
  g.fillStyle = PAL.white;
  g.fillRect(x, y, size, size);
  g.fillStyle = PAL.ink;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) g.fillRect(x + 2 + c, y + 2 + r, 1, 1);
  return size;
}

/** Плашка с именем: у героя — залита его цветом, у остальных — тёмная с цветной полоской. */
export function namePlate(g: CanvasRenderingContext2D, name: string, cx: number, y: number, color: string, font: string, hero: boolean): void {
  const w = name.length * 8 + 6;
  const x = Math.round(Math.max(1, Math.min(LW - w - 1, cx - w / 2)));
  g.globalAlpha = hero ? 1 : 0.85;
  g.fillStyle = hero ? color : PAL.ink;
  g.fillRect(x, Math.round(y), w, 10);
  g.globalAlpha = 1;
  if (!hero) {
    g.fillStyle = color;
    g.fillRect(x, Math.round(y), 2, 10);
  }
  text(g, name, x + 4, Math.round(y) + 1, hero ? PAL.ink : color, font, { align: 'left', outline: null });
}

/** Сцена клипа: состояние повтора и отрисовка любого момента времени. */
export class ClipPlayerScene {
  readonly c: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  /** Мир рисуется сюда в масштабе 1:1, а на экран — целым увеличением камеры. */
  private wc: HTMLCanvasElement;
  private wg: CanvasRenderingContext2D;
  private art: Art;
  private hedges = new Map<number, CanvasPattern | null>();
  readonly mode: ClipMode;
  private tm: Timing;
  /** Показываемое окно мира (у куска фильма — уже окна момента). */
  private win: { from: number; to: number };
  /** С какого времени мира начинается разбор (у куска фильма — после скрытой части). */
  private revealFrom = 0;
  private parts: { kind: PartKind; dur: number }[] = [];
  private speed1: number;
  private segs: Seg[];
  private revealDur = 0;
  /** Момент клипа (в разборе), когда камера наезжает; Infinity — без наезда. */
  private cutAt = Infinity;
  /** Момент клипа (в разборе), когда случился удар. */
  private hitClip = Infinity;
  /** Тишина перед ударом уже была. */
  private hushed = false;
  /** Отсчёт загадки: сейчас на экране (0 — нет), какие уже прозвучали; дробь перед раскрытием. */
  private count = 0;
  private counted = new Set<number>();
  private drummed = false;
  /** Кого из живых уже «раскрыли» звуком. */
  private litSounded = new Set<number>();
  private hit: { x: number; y: number } | null = null;
  readonly duration: number;
  private replay: World | null = null;
  private part = -1;
  private trails = new Map<number, { x: number; y: number }[]>();
  private colors = new Map<number, number>();
  /** Когда (мс разбора) загорается каждый живой; герой — последним. */
  private litAt = new Map<number, number>();
  private cam = { x: 0, y: 0 };
  private camInit = false;
  private camT = -1;
  /** Где на экране герой (логические пиксели) — центр «ириса» при переходе в фильме. */
  private heroAt: { x: number; y: number } | null = null;
  private readonly scale: number;
  /** Звук клипа (музыка темы и эффекты момента); без него клип немой. */
  sound: (ClipSoundCore & { stream?: MediaStream }) | null = null;
  private musicResumeAt = 0;
  private lastLook = -1;
  private lookAt = -Infinity;
  private faded = false;
  private clapped = false;
  /** Удары оружием (ночь Майами) по журналу дубля: eid жертвы → удар. */
  private kills = new Map<number, Kill>();
  /** Удар момента: в стоп-кадре брызги ещё летят (замедленно). */
  private focusKill: Kill | null = null;
  /** Кто бил (известно после разоблачения) → его удары. */
  private byAttacker = new Map<number, Kill[]>();
  /** Соперник героя в главном событии: на нём сжимается прицел. */
  private opp: number | undefined;

  constructor(private inp: ClipInput) {
    this.scale = inp.scale ?? CLIP_SCALE;
    const { c, g } = scaledCanvas(LW, LH, this.scale);
    this.c = c;
    this.g = g;
    const wc = canvas(inp.arena.width, inp.arena.height);
    this.wc = wc.c;
    this.wg = wc.g;
    this.art = getArt(inp.arena);
    this.mode = inp.mode ?? 'clip';
    const full = this.mode === 'clip' || this.mode === 'feature';
    this.tm = this.mode === 'feature' ? FEAT_T : full ? CLIP_T : this.mode === 'blooper' ? BLOOP_T : SEG_T;
    const m = inp.moment;
    const focused = m.kind === 'knockout' || m.kind === 'hit_bot' || m.kind === 'star3';
    if (this.mode === 'hook') this.win = { from: Math.max(m.from, m.at - 450), to: Math.max(m.from, m.at - 120) };
    else if (this.mode === 'segment') {
      this.win = focused
        ? { from: Math.max(m.from, m.at - SEG_PRE), to: Math.min(m.to, m.at + SEG_POST) }
        : { from: Math.max(m.from, m.to - SEG_PLAIN), to: m.to };
    } else if (this.mode === 'feature' && focused) this.win = { from: m.from, to: Math.max(m.from, Math.min(m.to, m.at + FEAT_POST)) };
    else this.win = { from: m.from, to: m.to };
    const len = this.win.to - this.win.from;
    this.speed1 = Math.max(PART1_SPEED, len / (this.mode === 'feature' ? FEATURE_PUZZLE_MAX : PART1_MAX_MS));
    const speed2 = full ? Math.max(this.tm.base, len / PART_MAX_MS) : this.tm.base;
    for (const p of inp.players) this.colors.set(p.eid, p.color);
    const hero = inp.hero;
    this.opp = m.attacker === hero ? m.victim : m.victim === hero ? m.attacker : undefined;

    // разбор: обычная скорость → замедление → стоп-кадр на ударе → замедление → обычная
    const pieces: [number, number, number][] = []; // [w0, w1, скорость] (скорость 0 — стоп-кадр)
    const { from, to } = this.win;
    // кусок фильма: сначала скрытая часть мира, разбор продолжает с того же места (без повтора)
    let rf = from;
    if (this.mode === 'segment' && focused && m.at > from) rf = from + Math.max(0, Math.min(SEG_HIDDEN, m.at - this.tm.slowPre - SEG_REVEAL_LEAD - from));
    this.revealFrom = rf;
    if (this.mode === 'hook') pieces.push([from, to, (to - from) / HOOK_MS]);
    else if (focused && m.at > from && m.at <= to) {
      const s0 = Math.max(rf, m.at - this.tm.slowPre);
      const s1 = Math.min(to, m.at + this.tm.slowPost);
      pieces.push([rf, s0, speed2], [s0, m.at, this.tm.slow], [m.at, m.at, 0], [m.at, s1, this.tm.slow], [s1, to, speed2]);
    } else pieces.push([from, to, speed2]);
    const ev = inp.rec.log.find((e) => (e.t === 'hit' && e.at === m.at && (m.victim === undefined || e.target === m.victim)) || (e.t === 'star_taken' && e.at === m.at));
    if (ev?.t === 'hit') this.hit = { x: ev.x, y: ev.y };
    this.segs = [];
    let cms = 0;
    for (const [w0, w1, sp] of pieces) {
      // крючок без движения (событие у самого начала дубля) — просто стоп-кадр на HOOK_MS
      const d = this.mode === 'hook' ? HOOK_MS : sp === 0 ? this.tm.hold : (w1 - w0) / sp;
      if (d <= 0) continue;
      this.segs.push({ c0: cms, c1: cms + d, w0, w1 });
      if (sp === 0 && this.mode !== 'hook') this.hitClip = cms;
      cms += d;
    }
    this.revealDur = cms;
    const th = inp.rec.theme;
    if (!inp.noGore) {
      for (const k of killsFromLog(inp.rec.log, (tw) => isThemeLoaded(th) && themeLook(th, tw ? 1 : 0).kill === 'weapon')) {
        this.kills.set(k.eid, k);
        if (k.by !== undefined) this.byAttacker.set(k.by, [...(this.byAttacker.get(k.by) ?? []), k]);
      }
    }
    const fk = m.victim !== undefined ? this.kills.get(m.victim) : undefined;
    if (fk && fk.at === m.at && this.hitClip !== Infinity) this.focusKill = fk;

    if (full) this.parts.push({ kind: 'puzzle', dur: len / this.speed1 });
    if (this.mode === 'segment') {
      this.parts.push({ kind: 'clap', dur: CLAP_MS });
      this.speed1 = speed2;
      if (rf > from) this.parts.push({ kind: 'puzzle', dur: (rf - from) / speed2 });
    }
    this.parts.push({ kind: 'reveal', dur: this.revealDur });
    if (this.mode === 'clip') this.parts.push({ kind: 'outro', dur: OUTRO_MS });
    this.duration = this.parts.reduce((a, p) => a + p.dur, 0);
    // наезд камеры — если есть на кого: за cutBefore до удара, но сначала дать увидеть всех
    if (this.mode !== 'hook' && this.mode !== 'blooper' && focused && (m.attacker !== undefined || m.victim !== undefined)) this.cutAt = Math.max(this.tm.wideMin, this.clipOf(m.at - this.tm.cutBefore));
    // загораются по одному, герой — последним
    const order = inp.players.map((p) => p.eid).sort((a, b) => (a === hero ? 1 : b === hero ? -1 : 0));
    order.forEach((eid, i) => this.litAt.set(eid, this.mode === 'blooper' ? 0 : i * REVEAL_STEP));
  }

  /** Время мира для момента разбора. */
  private worldOf2(local: number): number {
    for (const s of this.segs) {
      if (local < s.c1) return s.w0 + ((Math.max(local, s.c0) - s.c0) / (s.c1 - s.c0)) * (s.w1 - s.w0);
    }
    return this.win.to;
  }

  /** Момент разбора, когда мир доходит до w. */
  private clipOf(w: number): number {
    for (const s of this.segs) {
      if (w <= s.w1 && s.w1 > s.w0) return s.c0 + ((Math.max(w, s.w0) - s.w0) / (s.w1 - s.w0)) * (s.c1 - s.c0);
    }
    return this.revealDur;
  }

  /** Нарисовать кадр клипа в момент ms от начала. Вызывать с неубывающим ms. */
  draw(ms: number): void {
    let idx = 0;
    let start = 0;
    while (idx < this.parts.length - 1 && ms >= start + this.parts[idx].dur) start += this.parts[idx++].dur;
    const kind = this.parts[idx].kind;
    const local = ms - start;
    if (idx !== this.part) {
      this.part = idx;
      this.trails.clear();
      // разбор куска фильма продолжает мир со скрытой части (revealFrom), у клипа — повторяет окно заново
      this.replay = kind === 'puzzle' || kind === 'reveal' ? makeReplay(worldOf(this.inp.rec), kind === 'reveal' ? this.revealFrom : this.win.from, this.win.to) : null;
      const r = this.replay;
      if (r && this.sound) {
        if (this.musicResumeAt) this.sound.resume();
        this.musicResumeAt = 0;
        // клип: музыка темы стартует с первой части с миром; фильм ведёт одну песню сам (keepMusic)
        if (this.inp.keepMusic) {
          this.sound.resume();
          this.sound.setTwist(r.twist);
        } else if (idx === 0 || this.parts[idx - 1].kind === 'clap') this.sound.start(this.inp.rec.theme, r.twist);
        else this.sound.setTwist(r.twist);
        // загадка — напряжение в музыке, разбор — спокойнее
        this.sound.intensity(kind === 'puzzle' ? 2 : 1);
        r.listeners.push((ev) => this.onEvent(ev));
      }
    }
    if (kind === 'clap') {
      if (!this.clapped) {
        this.clapped = true;
        this.sound?.play('clap');
      }
      this.drawClap(local);
      this.sound?.pump();
      return;
    }
    if (kind === 'outro') {
      if (this.sound && !this.faded) {
        // заставка в конце: музыка плавно уходит к концу клипа
        this.faded = true;
        this.sound.fadeOut(Math.max(0.3, (this.duration - ms) / 1000));
        // подпись в конце: звуковой логотип — клип узнают в ленте и без картинки
        this.sound.play('logo');
      }
      this.drawOutro(local);
      this.sound?.pump();
      return;
    }
    const reveal = kind === 'reveal' && this.mode !== 'hook';
    // отсчёт и дробь — у полной загадки; у короткого куска фильма скрытая часть — секунда, без отсчёта
    if (kind === 'puzzle' && this.mode !== 'segment') this.countdown(this.parts[idx].dur - local);
    else this.count = 0;
    // живые загораются по одному — и на каждого удар, всё выше (как в разоблачении в игре)
    if (reveal && this.sound && this.mode !== 'blooper') {
      for (const [eid, at] of this.litAt) {
        if (local < at || this.litSounded.has(eid)) continue;
        this.litSounded.add(eid);
        this.sound.play('unmask', this.litSounded.size);
      }
    }
    const target = kind === 'puzzle' ? this.win.from + local * this.speed1 : this.worldOf2(local);
    const w = this.replay!;
    while (w.time + TICK_MS <= target && w.time < this.win.to) {
      w.step();
      if (reveal) this.recordTrails(w);
    }
    if (this.musicResumeAt && w.time >= this.musicResumeAt) {
      this.musicResumeAt = 0;
      this.sound?.resume();
    }
    // перед ударом — 120 мс тишины: удар после «провала» звучит громче всего клипа
    if (reveal && this.sound && !this.hushed && this.hitClip !== Infinity && local >= this.hitClip - HUSH_MS) {
      this.hushed = true;
      this.sound.hush(HUSH_MS / 1000);
    }
    this.sound?.pump();
    const alpha = Math.max(0, Math.min(1, (target - w.time) / TICK_MS));
    // наезд: 0 — общий план, 1 — крупно (крючок фильма — крупно сразу)
    const zp = this.mode === 'hook' ? 1 : reveal ? Math.max(0, Math.min(1, (local - this.cutAt) / ZOOM_MS)) : 0;
    this.drawWorld(w, alpha, reveal, ms, zp, local);
    this.drawBands(kind, local, target);
    const g = this.g;
    if (reveal && local < FLASH_MS && this.mode !== 'blooper') {
      g.fillStyle = PAL.white;
      g.globalAlpha = 1 - local / FLASH_MS;
      g.fillRect(0, 0, LW, LH);
      g.globalAlpha = 1;
    }
    // вспышка на самом ударе (оружием — красная)
    const sinceHit = local - this.hitClip;
    // в коротком куске фильма вспышка раскрытия только что была — на ударе хватает встряски и искр
    if (reveal && sinceHit >= 0 && sinceHit < 140 && (this.mode === 'clip' || this.mode === 'feature')) {
      g.fillStyle = this.focusKill ? PAL.red : PAL.white;
      g.globalAlpha = (this.focusKill ? 0.4 : 0.6) * (1 - sinceHit / 140);
      g.fillRect(0, AY, LW, PANEL_Y - AY);
      g.globalAlpha = 1;
    }
  }

  /** Звук того, что случилось в повторе: удары, звёзды, «Море волнуется» (музыка на паузе), свет. */
  private onEvent(ev: WorldEvent): void {
    const s = this.sound;
    if (!s) return;
    switch (ev.t) {
      case 'hit': {
        const k = this.kills.get(ev.target);
        if (k && k.at === ev.at) {
          s.play(weaponSfx(k));
          s.play('hitPlayer');
          break;
        }
        s.play(ev.result === 'player' ? 'hitPlayer' : 'hitBot');
        s.play('poof');
        break;
      }
      case 'star_taken':
        s.play('starTake');
        if (themePack(this.inp.rec.theme).starSiren) s.play('siren');
        break;
      case 'crowd':
        s.play('crowd');
        s.pause();
        this.musicResumeAt = ev.resumeAt;
        break;
      case 'twist': {
        const smooth = themePack(this.inp.rec.theme).transition === 'dusk';
        s.play(smooth ? 'dusk' : 'flicker');
        s.setTwist(ev.on, smooth);
        break;
      }
      case 'zone':
        s.play('hedge');
        break;
      default:
        break;
    }
  }

  private recordTrails(w: World): void {
    for (const p of this.inp.players) {
      const e = w.get(p.eid);
      if (!e || !e.alive) continue;
      let tr = this.trails.get(p.eid);
      if (!tr) this.trails.set(p.eid, (tr = []));
      const last = tr[tr.length - 1];
      if (!last || Math.hypot(last.x - e.x, last.y - e.y) >= 2) tr.push({ x: Math.round(e.x), y: Math.round(e.y) });
    }
  }

  /** Куда смотреть: середина между участниками события (выбывший — там, где его выбили). */
  private focus(w: World): { x: number; y: number } | null {
    const m = this.inp.moment;
    const pts: { x: number; y: number }[] = [];
    for (const eid of [m.attacker, m.victim]) {
      if (eid === undefined) continue;
      const e = w.get(eid);
      if (e) pts.push({ x: e.x, y: e.y });
    }
    if (!pts.length) return this.hit;
    // оба не влезают в кадр — ведём нападавшего: его подход и есть история, жертва появится, когда он дойдёт
    if (pts.length === 2 && (Math.abs(pts[0].x - pts[1].x) > 80 || Math.abs(pts[0].y - pts[1].y) > 110)) return pts[0];
    return { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
  }

  /** Горит ли подсветка живого в этот момент разбора. */
  private lit(eid: number, local: number): boolean {
    const at = this.litAt.get(eid);
    return at !== undefined && local >= at;
  }

  private drawWorld(w: World, alpha: number, reveal: boolean, now: number, zp: number, local: number): void {
    const zoomed = zp > 0;
    const g = this.wg;
    const a = this.art;
    const m = this.inp.moment;
    const hero = this.inp.hero;
    const t = w.time - TICK_MS + alpha * TICK_MS;
    const W = this.inp.arena.width;
    const H = this.inp.arena.height;
    // облик темы — как в кадре: в изнанке (подвал) и толпа, и локация другие
    const look = w.twist ? 1 : 0;
    const loc = a.loc(this.inp.rec.theme, look);
    const ch = a.chars(this.inp.rec.theme, look);
    g.drawImage(loc.arena, 0, 0);

    // следы живых в разборе
    if (reveal) {
      for (const [eid, tr] of this.trails) {
        if (!this.lit(eid, local)) continue;
        g.fillStyle = PLAYER_COLORS[this.colors.get(eid)!];
        tr.forEach((p, i) => i % 2 === 0 && g.fillRect(p.x, p.y, 1, 1));
      }
    }

    // кровь и оружие: время удара момента в стоп-кадре идёт дальше — замедленно
    const hold = reveal && this.focusKill ? Math.max(0, Math.min(local - this.hitClip, this.tm.hold)) * 0.3 : 0;
    const gt = (k: Kill) => t - k.at + (k === this.focusKill ? hold : 0);
    const px: Px = (x, y, pw, ph, c, al = 1) => {
      g.globalAlpha = al;
      g.fillStyle = c;
      g.fillRect(x, y, pw, ph);
      g.globalAlpha = 1;
    };
    for (const k of this.kills.values()) drawFloor(px, k, gt(k));

    type D = { y: number; draw: () => void };
    const list: D[] = [];
    for (const p of this.inp.arena.props) {
      const pr = loc.props.get(p.kind)!;
      const f = p.kind === 'fountain' ? Math.floor(now / 180) % Math.min(4, pr.frames) : p.kind === 'lamp' ? Math.floor(now / 900) % pr.frames : 0;
      list.push({ y: p.y, draw: () => frame(g, pr.c, pr.fw, pr.fh, f, p.x - pr.fw / 2, p.y - pr.fh) });
    }
    const pos = new Map<number, { x: number; y: number }>();
    const pulse = Math.floor(now / 400) % 3 !== 2;
    for (const [idx, e] of w.entities.entries()) {
      const x = Math.round(e.px + (e.x - e.px) * alpha);
      const y = Math.round(e.py + (e.y - e.py) * alpha);
      pos.set(e.eid, { x, y });
      const kill = this.kills.get(e.eid);
      if (!e.alive && kill && w.time >= kill.at) {
        // выбит оружием — лежит на месте удара
        const ce = a.charsFor(this.inp.rec.theme, look, idx);
        const b = bodyPose(kill);
        list.push({
          y: kill.y - 6,
          draw: () => {
            g.save();
            g.translate(b.x, b.y);
            g.rotate((b.angle * Math.PI) / 180);
            frame(g, ce.body, CH_W, CH_H, F.D, -6, -8);
            g.restore();
          },
        });
        continue;
      }
      if (!e.alive) {
        const since = w.time - e.removedAt;
        if (since >= 0 && since < 360) list.push({ y: y + 1, draw: () => frame(g, a.poof, 24, 24, Math.min(5, Math.floor(since / 60)), x - 12, y - 20) });
        continue;
      }
      let fr = frameFor(e, t, ch.acts);
      // бьёт оружием: стоит боком к жертве, пока замахивается
      const sw = this.byAttacker.get(e.eid)?.find((k) => armed(gt(k)));
      if (sw) fr = { frame: F.S, flip: e.x > sw.x, yoff: 0 };
      const ce = a.charsFor(this.inp.rec.theme, look, idx); // свой костюм фигуры
      const col = this.colors.get(e.eid);
      const lit = reveal && col !== undefined && this.lit(e.eid, local);
      const isHero = lit && e.eid === hero;
      // на разборе тусклые все, кроме участников события и живых игроков
      const actor = e.eid === m.attacker || e.eid === m.victim;
      const dim = reveal && !lit && !(zoomed && actor);
      list.push({
        y,
        draw: () => {
          const ox = x - 7;
          const oy = y + fr.yoff - 17;
          g.globalAlpha = dim ? 0.4 : 1;
          g.drawImage(a.shadow, x - 5, y - 2);
          if (isHero) {
            // герой: толстый контур своего цвета и белый внутри, вспыхивает
            const oc = ce.outline[1 + col!];
            for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) frame(g, oc, OL_W, OL_H, fr.frame, ox + dx, oy + dy, fr.flip);
            frame(g, pulse ? ce.outline[0] : oc, OL_W, OL_H, fr.frame, ox, oy, fr.flip);
          } else if (lit) frame(g, ce.outline[1 + col!], OL_W, OL_H, fr.frame, ox, oy, fr.flip);
          else if (zoomed && actor && reveal) frame(g, ce.outline[0], OL_W, OL_H, fr.frame, ox, oy, fr.flip);
          g.globalAlpha = dim ? 0.45 : 1;
          frame(g, ce.body, CH_W, CH_H, fr.frame, x - 6, y + fr.yoff - CH_H, fr.flip);
          g.globalAlpha = 1;
          if (e.act === 'stun' && t < e.actEnd) frame(g, a.stun, 12, 5, Math.floor(t / 120) % 3, x - 6, y - CH_H - 6);
          if (e.markUntil > t) g.drawImage(a.mark, x - 2, y - CH_H - 12 - (Math.floor(t / 150) % 2));
        },
      });
    }
    // кто бил — замахивается он (известен в самом событии удара)
    const holders = new Map<Kill, Holder | null>();
    for (const k of this.kills.values()) {
      const by = k.by !== undefined ? w.get(k.by) : undefined;
      if (by && gt(k) <= 0) aim(k, by.x);
      holders.set(k, by ? (pos.get(by.eid) ?? { x: Math.round(by.x), y: Math.round(by.y) }) : null);
    }
    for (const st of w.stars.values()) {
      const bob = Math.floor((now + st.id * 300) / 300) % 2;
      list.push({ y: st.y - 1, draw: () => frame(g, a.star, 10, 10, Math.floor(now / 140) % 4, st.x - 5, st.y - 8 - bob) });
    }
    list.sort((p, q) => p.y - q.y);
    for (const d of list) d.draw();
    const arms = armsOf(themeLook(this.inp.rec.theme, look).chars.map);
    for (const k of this.kills.values()) drawAir(px, k, gt(k), holders.get(k) ?? null, arms);

    // прицел на сопернике героя: красные уголки сжимаются к удару
    const sinceHit = local - this.hitClip;
    const opp = this.opp !== undefined ? w.get(this.opp) : undefined;
    if (reveal && opp?.alive && sinceHit < 0 && this.lit(this.opp!, local)) {
      const p = pos.get(opp.eid)!;
      const k = 1 + Math.max(0, Math.min(4, Math.round((-sinceHit / 1500) * 4)));
      const x0 = p.x - 7 - k;
      const x1 = p.x + 7 + k;
      const y0 = p.y - CH_H - 3 - k;
      const y1 = p.y + 2 + k;
      g.fillStyle = PAL.red;
      for (const [cx, cy, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
        g.fillRect(sx > 0 ? cx : cx - 2, cy, 3, 1);
        g.fillRect(cx, sy > 0 ? cy : cy - 2, 1, 3);
      }
    }

    // плавная тема (закат): после смены облика лиловые сумерки тают ~0,9 с
    if (look !== this.lastLook) {
      if (this.lastLook !== -1) this.lookAt = w.time;
      this.lastLook = look;
    }
    const since = w.time - this.lookAt;
    if (themePack(this.inp.rec.theme).transition === 'dusk' && since >= 0 && since < 900) {
      g.fillStyle = look ? PAL.grape : PAL.amber;
      g.globalAlpha = 0.6 * (1 - since / 900);
      g.fillRect(0, 0, W, H);
      g.globalAlpha = 1;
    }

    // изгородь сжимающейся зоны
    const z = w.zoneRect();
    const full = this.inp.arena.walk;
    if (!this.hedges.has(look)) this.hedges.set(look, g.createPattern(loc.hedge, 'repeat'));
    const hedge = this.hedges.get(look);
    if (z && hedge && z.w < full.w - 1) {
      const x0 = Math.round(z.x) - 4;
      const y0 = Math.round(z.y) - 6;
      const x1 = Math.round(z.x + z.w) + 4;
      const y1 = Math.round(z.y + z.h) + 2;
      g.fillStyle = hedge;
      for (const [rx, ry, rw, rh] of [
        [0, 0, W, y0],
        [0, y1, W, H - y1],
        [0, y0, x0, y1 - y0],
        [x1, y0, W - x1, y1 - y0],
      ]) {
        if (rw > 0 && rh > 0) g.fillRect(rx, ry, rw, rh);
      }
    }

    // удар: искры расходятся от места удара (по времени клипа — видны и в стоп-кадре)
    if (reveal && this.hit && sinceHit >= 0 && sinceHit < 700) {
      const r = 4 + Math.floor(sinceHit / 70) * 2;
      g.fillStyle = sinceHit < 210 ? PAL.white : PAL.yellow;
      for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * Math.PI * 2;
        g.fillRect(Math.round(this.hit.x + Math.cos(ang) * r), Math.round(this.hit.y - 8 + Math.sin(ang) * r), 2, 2);
      }
    }
    if (w.isFrozen()) {
      g.fillStyle = PAL.slate;
      g.globalAlpha = 0.35;
      g.fillRect(0, 0, W, H);
      g.globalAlpha = 1;
    }

    // камера: на разборе — целое увеличение на участников, плавно за ними
    const out = this.g;
    out.fillStyle = PAL.ink;
    out.fillRect(0, 0, LW, LH);
    // наезд ступенями: k выходных пикселей на пиксель мира — всегда целое (пиксели не плывут)
    const sc = this.scale;
    const ease = zp * zp * (3 - 2 * zp);
    const k = sc + Math.round(ease * sc * (ZOOM - 1));
    const zoom = k / sc;
    const vw = W / zoom;
    const vh = H / zoom;
    const clampX = (x: number) => Math.max(0, Math.min(W - vw, x));
    const clampY = (y: number) => Math.max(0, Math.min(H - vh, y));
    const f = zoomed ? (this.focus(w) ?? { x: W / 2, y: H / 2 }) : { x: W / 2, y: H / 2 };
    const fy = f.y - 8;
    const dt = this.camT < 0 ? 0 : Math.max(0, now - this.camT);
    this.camT = now;
    if (zp < 1) {
      // во время наезда центр кадра идёт от середины площади к участникам вместе с увеличением
      this.cam.x = clampX(W / 2 + (f.x - W / 2) * ease - vw / 2);
      this.cam.y = clampY(H / 2 + (fy - H / 2) * ease - vh / 2);
      this.camInit = true;
    } else {
      const tx = clampX(f.x - vw / 2);
      const ty = clampY(fy - vh / 2);
      const kk = this.camInit ? 1 - Math.exp(-dt / CAM_TAU) : 1;
      this.cam.x += (tx - this.cam.x) * kk;
      this.cam.y += (ty - this.cam.y) * kk;
      this.camInit = true;
    }
    // встряска: в стоп-кадре удара и на крючке фильма — на пиксель мира
    const shake = zoomed && (this.mode === 'hook' ? local % 240 < 120 : sinceHit >= 0 && sinceHit < this.tm.hold);
    const cx = clampX(this.cam.x + (shake ? (Math.floor((this.mode === 'hook' ? local : sinceHit) / 60) % 2 ? 1 : -1) : 0));
    const cy = this.cam.y;
    out.save();
    out.setTransform(1, 0, 0, 1, 0, 0);
    out.drawImage(this.wc, Math.round(-cx * k), Math.round(AY * sc - cy * k), W * k, H * k);
    out.restore();
    const toScreen = (p: { x: number; y: number }) => ({ x: (p.x - cx) * zoom, y: AY + (p.y - cy) * zoom });
    const hp = hero !== undefined ? pos.get(hero) : undefined;
    if (hp) this.heroAt = toScreen(hp);
    else if (this.hit && !this.heroAt) this.heroAt = toScreen(this.hit);

    // имена на плашках над головами (герой — залитая плашка и стрелка); кто вне кадра — стрелка у края
    if (reveal) {
      const labels: { x: number; y: number; name: string; color: string; hero: boolean }[] = [];
      const edge: { x: number; y: number; dir: 'l' | 'r' | 'u' | 'd'; color: string }[] = [];
      for (const p of this.inp.players) {
        const e = w.get(p.eid);
        if (!e || !e.alive || !this.lit(p.eid, local)) continue;
        const sp = toScreen(pos.get(p.eid)!);
        const color = PLAYER_COLORS[p.color];
        if (sp.x < 0 || sp.x > LW || sp.y < AY || sp.y > PANEL_Y + 10) {
          const dx = sp.x < 0 ? -1 : sp.x > LW ? 1 : 0;
          const dy = sp.y < AY ? -1 : sp.y > PANEL_Y ? 1 : 0;
          edge.push({
            x: Math.max(6, Math.min(LW - 7, sp.x)),
            y: Math.max(AY + 6, Math.min(PANEL_Y - 7, sp.y - 8)),
            dir: Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'l' : 'r') : dy < 0 ? 'u' : 'd',
            color,
          });
          continue;
        }
        const isHero = p.eid === hero;
        // на крупном плане подписаны только участники события: иначе плашки закрывают схватку
        if (zoomed && !isHero && p.eid !== m.attacker && p.eid !== m.victim) continue;
        // неудачный дубль в окошке титров: подписан только «виновник»
        if (this.mode === 'blooper' && !isHero) continue;
        const head = sp.y - (CH_H + 1) * zoom;
        labels.push({ x: sp.x, y: Math.max(AY + 1, head - (isHero ? 18 : 12)), name: p.name, color, hero: isHero });
        if (isHero) {
          // стрелка над героем
          const bob = Math.floor(now / 200) % 2;
          const ay = Math.round(head - 7 + bob);
          for (let k = 0; k < 4; k++) {
            out.fillStyle = PAL.ink;
            out.fillRect(Math.round(sp.x) - 4 + k, ay + k - 1, 9 - 2 * k, 1);
            out.fillStyle = color;
            out.fillRect(Math.round(sp.x) - 3 + k, ay + k, 7 - 2 * k, 1);
          }
        }
      }
      labels.sort((p, q) => p.y - q.y);
      for (let i = 1; i < labels.length; i++) {
        for (let j = 0; j < i; j++) {
          const A = labels[i];
          const B = labels[j];
          const overlapX = Math.abs(A.x - B.x) < (A.name.length + B.name.length) * 4 + 8;
          if (overlapX && Math.abs(A.y - B.y) < 11) A.y = B.y + 11;
        }
      }
      for (const l of labels) namePlate(out, l.name, l.x, l.y, l.color, this.inp.font, l.hero);
      for (const e of edge) {
        // треугольник у края, смотрит туда, где игрок
        for (let k = 0; k < 4; k++) {
          const len = 7 - 2 * k;
          out.fillStyle = e.color;
          if (e.dir === 'l') out.fillRect(Math.round(e.x) - 3 + k, Math.round(e.y) - 3 + k, 1, len);
          else if (e.dir === 'r') out.fillRect(Math.round(e.x) + 3 - k, Math.round(e.y) - 3 + k, 1, len);
          else if (e.dir === 'u') out.fillRect(Math.round(e.x) - 3 + k, Math.round(e.y) - 3 + k, len, 1);
          else out.fillRect(Math.round(e.x) - 3 + k, Math.round(e.y) + 3 - k, len, 1);
        }
      }
    }
    out.globalAlpha = 0.35;
    out.drawImage(a.vignette, 0, AY);
    out.globalAlpha = 1;
  }

  private player(eid: number | undefined): ClipPlayer | undefined {
    return eid === undefined ? undefined : this.inp.players.find((p) => p.eid === eid);
  }

  /** Где герой на экране сейчас (для «ириса» фильма); не видно — середина поля. */
  heroPoint(): { x: number; y: number } {
    const h = this.heroAt;
    if (!h) return { x: LW / 2, y: (AY + PANEL_Y) / 2 };
    return { x: Math.max(8, Math.min(LW - 8, h.x)), y: Math.max(AY + 8, Math.min(PANEL_Y - 8, h.y - 8)) };
  }

  /** Точка события на экране (неудачный дубль в окошке титров кадрируется вокруг неё). */
  focusPoint(): { x: number; y: number } | null {
    return this.hit ? { x: this.hit.x, y: AY + this.hit.y - 8 } : null;
  }

  /** Плашка подписи в безопасной зоне: две строки по центру безопасной ширины. */
  private caption(l1: string, c1: string, l2?: string, c2?: string): void {
    const g = this.g;
    g.globalAlpha = 0.8;
    g.fillStyle = PAL.ink;
    g.fillRect(SAFE_L, PLATE_Y - 2, SAFE_R - SAFE_L, l2 ? 23 : 12);
    g.globalAlpha = 1;
    const cx = (SAFE_L + SAFE_R) / 2;
    const maxWidth = SAFE_R - SAFE_L - 4;
    text(g, l1, cx, PLATE_Y, c1, this.inp.font, { outline: null, maxWidth });
    if (l2) text(g, l2, cx, PLATE_Y + 11, c2 ?? PAL.mist, this.inp.font, { outline: null, maxWidth });
  }

  private drawBands(kind: PartKind, local: number, world: number): void {
    const g = this.g;
    const t = this.inp.t;
    const font = this.inp.font;
    const m = this.inp.moment;
    g.fillStyle = PAL.ink;
    g.fillRect(0, 0, LW, AY);
    g.fillRect(0, PANEL_Y, LW, LH - PANEL_Y);
    // неудачный дубль показывают окошком (кусок поля) — подписи и водяной знак не нужны
    if (this.mode === 'blooper') return;
    text(g, t.meta.title, LW / 2, 8, PAL.yellow, font, { outline: null });
    // водяной знак: адрес игры весь ролик, в безопасной зоне (ролик обрезают и перезаливают)
    g.globalAlpha = 0.85;
    text(g, this.inp.site, SAFE_L + 2, WM_Y, PAL.white, font, { align: 'left', maxWidth: SAFE_R - SAFE_L });
    g.globalAlpha = 1;
    this.drawScore(kind === 'reveal' && this.mode !== 'hook' && (this.hitClip === Infinity || local >= this.hitClip) ? local - (this.hitClip === Infinity ? 0 : this.hitClip) : -1);
    const cap = this.inp.captions;
    const blink = Math.floor(local / 400) % 2 === 0;
    if (this.mode === 'hook') {
      this.caption(t.clip.hook, PAL.white, t.clip.hookSub, blink ? PAL.yellow : PAL.amber);
      this.rec(blink);
      return;
    }
    if (kind === 'puzzle') {
      this.caption(cap?.find ?? t.clip.find, PAL.white, cap?.findSub ?? fmt(t.clip.round, { n: this.inp.rec.round }), PAL.mist);
      this.drawCount(local);
      return;
    }
    const atk = this.player(m.attacker);
    const vic = this.player(m.victim);
    const after = world >= m.at && local >= this.hitClip;
    if (after && atk) {
      // итог по именам: «Енот / вырезает: Батон»
      const l2 =
        m.kind === 'knockout' && vic ? fmt(t.clip.koOf, { name: vic.name }) : m.kind === 'star3' ? t.clip.star3Of : m.kind === 'hit_bot' ? t.clip.botOf : t.clip.kinds[m.kind];
      this.caption(atk.name, PLAYER_COLORS[atk.color], l2, vic && m.kind === 'knockout' ? PLAYER_COLORS[vic.color] : blink ? PAL.yellow : PAL.amber);
    } else {
      const l1 = this.mode === 'segment' ? fmt(t.clip.round, { n: this.inp.rec.round }) : (cap?.reveal ?? t.clip.reveal);
      if (atk && !after && local >= this.cutAt) this.caption(l1, PAL.white, fmt(t.clip.watch, { name: atk.name }), PLAYER_COLORS[atk.color]);
      else this.caption(l1, PAL.white, cap?.kind ?? (m.kind === 'knockout' && m.selfRole === 'victim' ? t.clip.gotMe : t.clip.kinds[m.kind]), blink ? PAL.yellow : PAL.amber);
    }
    this.rec(blink);
  }

  /** Конец загадки: «3, 2, 1» с тиком на каждую секунду и дробь — её удар приходится на вспышку раскрытия. */
  private countdown(left: number): void {
    const n = left <= COUNT_FROM * 1000 ? Math.max(1, Math.ceil(left / 1000)) : 0;
    this.count = n;
    if (n && !this.counted.has(n)) {
      this.counted.add(n);
      this.sound?.play('count');
    }
    if (left <= DRUM_LEAD_MS && !this.drummed) {
      this.drummed = true;
      this.sound?.play('drum');
    }
  }

  /** Большая цифра отсчёта над полем (в безопасной зоне), в начале секунды — крупнее. */
  private drawCount(local: number): void {
    if (!this.count) return;
    const g = this.g;
    const left = this.parts.find((p) => p.kind === 'puzzle')!.dur - local;
    // первые 160 мс секунды цифра крупнее — «удар» отсчёта
    const size = this.count * 1000 - left < 160 ? 4 : 3;
    text(g, String(this.count), (SAFE_L + SAFE_R) / 2, 92 - (size - 3) * 4, PAL.yellow, this.inp.font, { size });
  }

  /** «Повтор» в углу — как в спортивной трансляции. */
  private rec(on: boolean): void {
    this.g.fillStyle = PAL.red;
    if (on) this.g.fillRect(LW - 9, 9, 4, 4);
  }

  /**
   * Счёт матча в нижней полосе цветными квадратиками (кусок фильма): до удара — счёт до дубля,
   * после (since ≥ 0 — мс после удара) — после дубля; изменившиеся очки мигают жёлтым.
   */
  private drawScore(since = -1): void {
    const after = this.inp.score;
    const before = this.inp.scoreBefore ?? after;
    const sc = since >= 0 ? after : before;
    if (!sc?.length) return;
    const g = this.g;
    const cell = 26;
    let x = Math.round(LW / 2 - (sc.length * cell) / 2);
    sc.forEach((s, i) => {
      const changed = since >= 0 && before && before[i] && before[i].points !== s.points;
      const blink = changed && since < 900 && Math.floor(since / 150) % 2 === 0;
      g.fillStyle = PLAYER_COLORS[s.color];
      g.fillRect(x + 2, 297, 7, 7);
      text(g, String(s.points), x + 11, 296, blink ? PAL.yellow : PAL.white, this.inp.font, { align: 'left', outline: null });
      x += cell;
    });
  }

  /** Хлопушка перед куском фильма: «Дубль N» на чёрном, планка хлопает. */
  private drawClap(ms: number): void {
    const g = this.g;
    g.fillStyle = PAL.ink;
    g.fillRect(0, 0, LW, LH);
    const x0 = 40;
    const w = 100;
    const y0 = 96;
    // доска
    g.fillStyle = PAL.night;
    g.fillRect(x0, y0 + 14, w, 46);
    g.fillStyle = PAL.white;
    g.fillRect(x0, y0 + 14, w, 1);
    // планка: открыта, к середине — хлопок
    const shut = ms > CLAP_MS * 0.35;
    const lift = shut ? 0 : 6;
    for (let i = 0; i < 10; i++) {
      g.fillStyle = i % 2 ? PAL.ink : PAL.white;
      g.fillRect(x0 + i * 10, y0 + 4 - lift + Math.floor((i * lift) / 10), 10, 8);
    }
    text(g, fmt(this.inp.t.clip.round, { n: this.inp.rec.round }), LW / 2, y0 + 30, PAL.white, this.inp.font, { outline: null });
    this.drawScore();
  }

  private drawOutro(ms: number): void {
    const g = this.g;
    const a = this.art;
    const t = this.inp.t;
    const font = this.inp.font;
    g.fillStyle = PAL.ink;
    g.fillRect(0, 0, LW, LH);
    const appear = Math.min(1, ms / 300);
    g.globalAlpha = appear;
    const cx = (SAFE_L + SAFE_R) / 2;
    text(g, t.meta.title, cx, 40, PAL.yellow, font, { size: 2, maxWidth: SAFE_R - SAFE_L });
    // победитель матча — момент триумфа: «Звезда фильма» и имя его цветом
    const win = this.inp.winner;
    if (win) {
      text(g, t.card.winner, cx, 62, PAL.mist, font);
      text(g, win.name, cx, 73, PLAYER_COLORS[win.color], font, { maxWidth: SAFE_R - SAFE_L });
    }
    // хоровод вдвое крупнее: живые в цветах игроков, между ними бот; над победителем — корона
    const ch = a.chars(this.inp.rec.theme);
    const crownAt = a.icons.names.indexOf('crown');
    g.save();
    g.scale(2, 2);
    const cols = [0, 1, -1, 2, 3];
    cols.forEach((col, i) => {
      const x = 11 + i * 15;
      const y = 61 + ((i + Math.floor(ms / 320)) % 2);
      const fr = F.DANCE + (Math.floor((ms + i * 90) / 160) % 4);
      g.drawImage(a.shadow, x - 5, y - 2);
      if (col >= 0) frame(g, ch.outline[1 + col], OL_W, OL_H, fr, x - 7, y - 17);
      frame(g, ch.body, CH_W, CH_H, fr, x - 6, y - CH_H);
      if (win && col === win.color && crownAt >= 0) frame(g, a.icons.canvas, 8, 8, crownAt, x - 4, y - CH_H - 8);
    });
    g.restore();
    text(g, t.clip.cta, cx, 132, PAL.white, font, { maxWidth: SAFE_R - SAFE_L });
    // QR и адрес: на чужом экране — сканировать, на своём — запомнить
    const qr = drawQr(g, this.inp.link ?? `https://${this.inp.site}`, SAFE_L + 4, 146);
    text(g, t.clip.play1, SAFE_L + qr + 10, 152, PAL.white, font, { align: 'left', outline: null });
    text(g, t.clip.play2, SAFE_L + qr + 10, 162, PAL.white, font, { align: 'left', outline: null });
    text(g, this.inp.site, SAFE_L + qr + 10, 174, PAL.cyan, font, { align: 'left', outline: null, maxWidth: SAFE_R - SAFE_L - qr - 10 });
    g.globalAlpha = 1;
  }
}

/**
 * Записать клип (или фильм) в видео в браузере. Идёт в реальном времени: MediaRecorder пишет то,
 * что появляется на холсте. onFrame получает долю готовности 0..1.
 */
export async function recordClip(
  scene: { c: HTMLCanvasElement; duration: number; draw(ms: number): void; sound: (ClipSoundCore & { stream?: MediaStream }) | null },
  mime: string,
  onFrame?: (progress: number) => void,
): Promise<ClipResult> {
  const stream = scene.c.captureStream(FPS);
  // звук клипа — дорожкой в тот же поток; если браузер не примет запись со звуком — пишем без него
  const sound = scene.sound;
  let rec: MediaRecorder;
  if (sound?.stream) {
    const withAudio = pickClipMime(true) ?? mime;
    try {
      for (const tr of sound.stream.getAudioTracks()) stream.addTrack(tr);
      rec = new MediaRecorder(stream, { mimeType: withAudio, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 128_000 });
      mime = withAudio;
    } catch {
      for (const tr of stream.getAudioTracks()) stream.removeTrack(tr);
      sound.stop();
      scene.sound = null;
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    }
  } else rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((res) => (rec.onstop = () => res()));
  scene.draw(0);
  rec.start(500);
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    const loop = () => {
      const ms = performance.now() - t0;
      scene.draw(Math.min(ms, scene.duration));
      onFrame?.(Math.min(1, ms / scene.duration));
      if (ms >= scene.duration + 150) resolve();
      // setTimeout, а не rAF: так кадры идут и при слабом телефоне, и при скрытой вкладке (медленнее)
      else setTimeout(loop, 1000 / FPS);
    };
    loop();
  });
  rec.stop();
  await stopped;
  for (const tr of stream.getTracks()) tr.stop();
  scene.sound?.stop();
  const type = mime.split(';')[0];
  return { blob: new Blob(chunks, { type }), ext: type === 'video/mp4' ? 'mp4' : 'webm', mime: type };
}
