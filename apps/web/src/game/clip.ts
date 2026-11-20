import { PAL, PLAYER_COLORS } from '@kto/assets';
import { TICK_MS, fmt, makeReplay, worldOf } from '@kto/game-core';
import type { ArenaDef, Dict, Moment, RoundRecording, World } from '@kto/game-core';
import { fitSize, frame, getArt, scaledCanvas, text } from './art';
import { canvas } from './pixels';
import type { Art } from './art';
import { frameFor } from './frames';
import { CH_H, CH_W, F, OL_H, OL_W } from './sprites';

/**
 * Клип «Лучший момент» (раздел 11 ТЗ): 1080×1920, ~11 с.
 *   1) момент как его видели игроки — «Найдёшь живых?»;
 *   2) тот же момент с подсветкой живых, именами и следами;
 *   3) заставка с названием и адресом.
 * Рисуется на обычном canvas теми же спрайтами, что игра, ×6 без сглаживания,
 * и пишется в видео через MediaRecorder в реальном времени.
 */
const LW = 180;
const LH = 320;
const AY = 24;
const PANEL_Y = 284;
export const CLIP_SCALE = 6;
/** Скорость повтора: окно 6 с идёт ~4,8 с; длинное окно (до 8 с) — чуть быстрее, чтобы клип оставался ~11–12 с. */
const BASE_SPEED = 1.25;
const PART_MAX_MS = 5000;
const OUTRO_MS = 1800;
const FLASH_MS = 220;
const FPS = 30;

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
}

export interface ClipResult {
  blob: Blob;
  ext: 'mp4' | 'webm';
  mime: string;
}

export function pickClipMime(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement === 'undefined') return null;
  if (!('captureStream' in HTMLCanvasElement.prototype)) return null;
  const list = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return list.find((m) => MediaRecorder.isTypeSupported?.(m)) ?? null;
}

/** Сцена клипа: состояние повтора и отрисовка любого момента времени. */
/** Часть повтора: отрезок клипа [c0, c1) показывает мир [w0, w1] (стоп-кадр — w0 = w1). */
interface Seg {
  c0: number;
  c1: number;
  w0: number;
  w1: number;
}

/** Камера разбора: целое увеличение (пиксели остаются чёткими), видна четверть арены. */
const ZOOM = 2;
/** Замедление вокруг удара (доля обычной скорости) и стоп-кадр на самом ударе. */
const SLOW = 0.4;
const SLOW_PRE = 700;
const SLOW_POST = 500;
const HOLD_MS = 450;
/** За сколько (мира) до удара камера наезжает на схватку. */
const CUT_BEFORE = 1600;
/** Сначала показываем всех живых целиком — не меньше этого (мс клипа). */
const WIDE_MIN_MS = 900;
const PART1_SPEED = 1.5;
const PART1_MAX_MS = 4500;


/** Сцена клипа: состояние повтора и отрисовка любого момента времени. */
export class ClipPlayerScene {
  readonly c: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  /** Мир рисуется сюда в масштабе 1:1, а на экран — целым увеличением камеры. */
  private wc: HTMLCanvasElement;
  private wg: CanvasRenderingContext2D;
  private art: Art;
  private hedges = new Map<number, CanvasPattern | null>();
  private part1Dur: number;
  private part2Dur: number;
  private speed1: number;
  private segs: Seg[];
  /** Момент клипа (во второй части), когда камера наезжает; Infinity — без наезда. */
  private cutAt = Infinity;
  /** Момент клипа (во второй части), когда случился удар. */
  private hitClip = Infinity;
  private hit: { x: number; y: number } | null = null;
  readonly duration: number;
  private replay: World | null = null;
  private part = 0;
  private trails = new Map<number, { x: number; y: number }[]>();
  private colors = new Map<number, number>();
  private cam = { x: -1, y: 0 };

  constructor(private inp: ClipInput) {
    const { c, g } = scaledCanvas(LW, LH, CLIP_SCALE);
    this.c = c;
    this.g = g;
    const wc = canvas(inp.arena.width, inp.arena.height);
    this.wc = wc.c;
    this.wg = wc.g;
    this.art = getArt(inp.arena);
    const m = inp.moment;
    const len = m.to - m.from;
    this.speed1 = Math.max(PART1_SPEED, len / PART1_MAX_MS);
    const speed2 = Math.max(BASE_SPEED, len / PART_MAX_MS);
    for (const p of inp.players) this.colors.set(p.eid, p.color);

    // разбор: обычная скорость → замедление → стоп-кадр на ударе → замедление → обычная
    const focused = m.kind === 'knockout' || m.kind === 'hit_bot' || m.kind === 'star3';
    const pieces: [number, number, number][] = []; // [w0, w1, скорость] (скорость 0 — стоп-кадр HOLD_MS)
    if (focused && m.at > m.from && m.at <= m.to) {
      const s0 = Math.max(m.from, m.at - SLOW_PRE);
      const s1 = Math.min(m.to, m.at + SLOW_POST);
      pieces.push([m.from, s0, speed2], [s0, m.at, SLOW], [m.at, m.at, 0], [m.at, s1, SLOW], [s1, m.to, speed2]);
      const ev = inp.rec.log.find((e) => (e.t === 'hit' && e.at === m.at && (m.victim === undefined || e.target === m.victim)) || (e.t === 'star_taken' && e.at === m.at));
      if (ev?.t === 'hit') this.hit = { x: ev.x, y: ev.y };
    } else pieces.push([m.from, m.to, speed2]);
    this.segs = [];
    let cms = 0;
    for (const [w0, w1, sp] of pieces) {
      const d = sp === 0 ? HOLD_MS : (w1 - w0) / sp;
      if (d <= 0) continue;
      this.segs.push({ c0: cms, c1: cms + d, w0, w1 });
      if (sp === 0) this.hitClip = cms;
      cms += d;
    }
    this.part2Dur = cms;
    this.part1Dur = len / this.speed1;
    this.duration = this.part1Dur + this.part2Dur + OUTRO_MS;
    // наезд камеры — если есть на кого: за CUT_BEFORE до удара, но сначала дать увидеть всех
    if (focused && (m.attacker !== undefined || m.victim !== undefined)) this.cutAt = Math.max(WIDE_MIN_MS, this.clipOf(m.at - CUT_BEFORE));
  }

  /** Время мира для момента второй части. */
  private worldOf2(local: number): number {
    for (const s of this.segs) {
      if (local < s.c1) return s.w0 + ((Math.max(local, s.c0) - s.c0) / (s.c1 - s.c0)) * (s.w1 - s.w0);
    }
    return this.inp.moment.to;
  }

  /** Момент второй части, когда мир доходит до w. */
  private clipOf(w: number): number {
    for (const s of this.segs) {
      if (w <= s.w1 && s.w1 > s.w0) return s.c0 + ((Math.max(w, s.w0) - s.w0) / (s.w1 - s.w0)) * (s.c1 - s.c0);
    }
    return this.part2Dur;
  }

  /** Нарисовать кадр клипа в момент ms от начала. Вызывать с неубывающим ms. */
  draw(ms: number): void {
    const part = ms < this.part1Dur ? 1 : ms < this.part1Dur + this.part2Dur ? 2 : 3;
    if (part !== this.part) {
      this.part = part;
      this.trails.clear();
      this.replay = part < 3 ? makeReplay(worldOf(this.inp.rec), this.inp.moment.from, this.inp.moment.to) : null;
    }
    if (part === 3) {
      this.drawOutro(ms - this.part1Dur - this.part2Dur);
      return;
    }
    const local = ms - (part === 1 ? 0 : this.part1Dur);
    const target = part === 1 ? this.inp.moment.from + local * this.speed1 : this.worldOf2(local);
    const w = this.replay!;
    while (w.time + TICK_MS <= target && w.time < this.inp.moment.to) {
      w.step();
      if (part === 2) this.recordTrails(w);
    }
    const alpha = Math.max(0, Math.min(1, (target - w.time) / TICK_MS));
    const zoomed = part === 2 && local >= this.cutAt;
    this.drawWorld(w, alpha, part === 2, ms, zoomed, local);
    this.drawBands(part, local, target);
    const g = this.g;
    if (part === 2 && local < FLASH_MS) {
      g.fillStyle = PAL.white;
      g.globalAlpha = 1 - local / FLASH_MS;
      g.fillRect(0, 0, LW, LH);
      g.globalAlpha = 1;
    }
    // вспышка на самом ударе
    const sinceHit = local - this.hitClip;
    if (part === 2 && sinceHit >= 0 && sinceHit < 140) {
      g.fillStyle = PAL.white;
      g.globalAlpha = 0.6 * (1 - sinceHit / 140);
      g.fillRect(0, AY, LW, PANEL_Y - AY);
      g.globalAlpha = 1;
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

  private drawWorld(w: World, alpha: number, reveal: boolean, now: number, zoomed: boolean, local: number): void {
    const g = this.wg;
    const a = this.art;
    const m = this.inp.moment;
    const t = w.time - TICK_MS + alpha * TICK_MS;
    const W = this.inp.arena.width;
    const H = this.inp.arena.height;
    // облик темы — как в кадре: в изнанке (подвал) и толпа, и локация другие
    const look = w.twist ? 1 : 0;
    const loc = a.loc(this.inp.rec.theme, look);
    const ch = a.chars(this.inp.rec.theme, look);
    g.drawImage(loc.arena, 0, 0);

    // следы живых во второй части
    if (reveal) {
      for (const [eid, tr] of this.trails) {
        g.fillStyle = PLAYER_COLORS[this.colors.get(eid)!];
        tr.forEach((p, i) => i % 2 === 0 && g.fillRect(p.x, p.y, 1, 1));
      }
    }

    type D = { y: number; draw: () => void };
    const list: D[] = [];
    for (const p of this.inp.arena.props) {
      const pr = loc.props.get(p.kind)!;
      const f = p.kind === 'fountain' ? Math.floor(now / 180) % pr.frames : p.kind === 'lamp' ? Math.floor(now / 900) % pr.frames : 0;
      list.push({ y: p.y, draw: () => frame(g, pr.c, pr.fw, pr.fh, f, p.x - pr.fw / 2, p.y - pr.fh) });
    }
    const pos = new Map<number, { x: number; y: number }>();
    for (const e of w.entities) {
      const x = Math.round(e.px + (e.x - e.px) * alpha);
      const y = Math.round(e.py + (e.y - e.py) * alpha);
      pos.set(e.eid, { x, y });
      if (!e.alive) {
        const since = w.time - e.removedAt;
        if (since >= 0 && since < 360) list.push({ y: y + 1, draw: () => frame(g, a.poof, 24, 24, Math.min(5, Math.floor(since / 60)), x - 12, y - 20) });
        continue;
      }
      const fr = frameFor(e, t);
      const col = this.colors.get(e.eid);
      const lit = reveal && col !== undefined;
      // на разборе тусклые все, кроме участников события и живых игроков
      const actor = e.eid === m.attacker || e.eid === m.victim;
      const dim = reveal && !lit && !(zoomed && actor);
      list.push({
        y,
        draw: () => {
          g.globalAlpha = dim ? 0.4 : 1;
          g.drawImage(a.shadow, x - 5, y - 2);
          if (lit) frame(g, ch.outline[1 + col!], OL_W, OL_H, fr.frame, x - 7, y + fr.yoff - 17, fr.flip);
          else if (zoomed && actor) frame(g, ch.outline[0], OL_W, OL_H, fr.frame, x - 7, y + fr.yoff - 17, fr.flip);
          g.globalAlpha = dim ? 0.45 : 1;
          frame(g, ch.body, CH_W, CH_H, fr.frame, x - 6, y + fr.yoff - CH_H, fr.flip);
          g.globalAlpha = 1;
          if (e.act === 'stun' && t < e.actEnd) frame(g, a.stun, 12, 5, Math.floor(t / 120) % 3, x - 6, y - CH_H - 6);
          if (e.markUntil > t) g.drawImage(a.mark, x - 2, y - CH_H - 12 - (Math.floor(t / 150) % 2));
        },
      });
    }
    for (const st of w.stars.values()) {
      const bob = Math.floor((now + st.id * 300) / 300) % 2;
      list.push({ y: st.y - 1, draw: () => frame(g, a.star, 10, 10, Math.floor(now / 140) % 4, st.x - 5, st.y - 8 - bob) });
    }
    list.sort((p, q) => p.y - q.y);
    for (const d of list) d.draw();

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
    const sinceHit = local - this.hitClip;
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
    let zoom = 1;
    let cx = 0;
    let cy = 0;
    if (zoomed) {
      zoom = ZOOM;
      const vw = W / zoom;
      const vh = H / zoom;
      const f = this.focus(w) ?? { x: W / 2, y: H / 2 };
      const tx = Math.max(0, Math.min(W - vw, f.x - vw / 2));
      const ty = Math.max(0, Math.min(H - vh, f.y - 8 - vh / 2));
      const first = this.cam.x < 0;
      this.cam.x = first ? tx : this.cam.x + (tx - this.cam.x) * 0.18;
      this.cam.y = first ? ty : this.cam.y + (ty - this.cam.y) * 0.18;
      cx = Math.round(this.cam.x);
      cy = Math.round(this.cam.y);
      // встряска в стоп-кадре удара
      if (sinceHit >= 0 && sinceHit < HOLD_MS) cx = Math.max(0, Math.min(W - vw, cx + (Math.floor(sinceHit / 60) % 2 ? 1 : -1)));
      out.drawImage(this.wc, cx, cy, vw, vh, 0, AY, W, H);
    } else {
      this.cam.x = -1;
      out.drawImage(this.wc, 0, AY);
    }
    const toScreen = (p: { x: number; y: number }) => ({ x: (p.x - cx) * zoom, y: AY + (p.y - cy) * zoom });

    // имена: на общем плане — всех живых игроков, на разборе — только участников; не налезают друг на друга
    if (reveal) {
      const labels: { x: number; y: number; name: string; color: string }[] = [];
      for (const p of this.inp.players) {
        const e = w.get(p.eid);
        if (!e || !e.alive) continue;
        if (zoomed && p.eid !== m.attacker && p.eid !== m.victim) continue;
        const sp = toScreen(pos.get(p.eid)!);
        if (sp.x < 0 || sp.x > LW || sp.y < AY || sp.y > PANEL_Y + 10) continue;
        const name = p.name;
        const half = (name.length * 8) / 2;
        labels.push({ x: Math.max(half + 1, Math.min(LW - half - 1, sp.x)), y: Math.max(AY + 1, sp.y - (CH_H + 13) * (zoomed ? 1.6 : 1)), name, color: PLAYER_COLORS[p.color] });
      }
      labels.sort((p, q) => p.y - q.y);
      for (let i = 1; i < labels.length; i++) {
        for (let j = 0; j < i; j++) {
          const A = labels[i];
          const B = labels[j];
          const overlapX = Math.abs(A.x - B.x) < (A.name.length + B.name.length) * 4 + 2;
          if (overlapX && Math.abs(A.y - B.y) < 11) A.y = B.y + 11;
        }
      }
      for (const l of labels) text(this.g, l.name, l.x, Math.round(l.y), l.color, this.inp.font);
      // стрелка над тем, за кем следить, пока удар не случился
      if (zoomed && sinceHit < 0 && m.attacker !== undefined && this.colors.has(m.attacker)) {
        const e = w.get(m.attacker);
        if (e?.alive) {
          const sp = toScreen(pos.get(m.attacker)!);
          const bob = Math.floor(now / 200) % 2;
          out.fillStyle = PLAYER_COLORS[this.colors.get(m.attacker)!];
          const ay = Math.round(sp.y - (CH_H + 6) * zoom - 4 + bob);
          for (let k = 0; k < 4; k++) out.fillRect(Math.round(sp.x) - 3 + k, ay + k, 7 - 2 * k, 1);
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

  private drawBands(part: number, local: number, world: number): void {
    const g = this.g;
    const t = this.inp.t;
    const font = this.inp.font;
    const m = this.inp.moment;
    g.fillStyle = PAL.ink;
    g.fillRect(0, 0, LW, AY);
    g.fillRect(0, PANEL_Y, LW, LH - PANEL_Y);
    text(g, t.meta.title, LW / 2, 8, PAL.yellow, font, { outline: null });
    const cap = this.inp.captions;
    const line = (s: string, y: number, color: string) => text(g, s, LW / 2, PANEL_Y + y, color, font, { outline: null, maxWidth: LW - 6 });
    if (part === 1) {
      line(cap?.find ?? t.clip.find, 8, PAL.white);
      line(cap?.findSub ?? fmt(t.clip.round, { n: this.inp.rec.round }), 21, PAL.mist);
      return;
    }
    const blink = Math.floor(local / 400) % 2 === 0;
    const atk = this.player(m.attacker);
    const vic = this.player(m.victim);
    const after = world >= m.at && local >= this.hitClip;
    if (after && atk) {
      // итог по именам: «Енот / выбил Батона»
      line(atk.name, 8, PLAYER_COLORS[atk.color]);
      if (m.kind === 'knockout' && vic) line(fmt(t.clip.koOf, { name: vic.name }), 21, PLAYER_COLORS[vic.color]);
      else line(m.kind === 'star3' ? t.clip.star3Of : m.kind === 'hit_bot' ? t.clip.botOf : t.clip.kinds[m.kind], 21, blink ? PAL.yellow : PAL.amber);
    } else {
      line(cap?.reveal ?? t.clip.reveal, 8, PAL.white);
      if (atk && !after && local >= this.cutAt) line(fmt(t.clip.watch, { name: atk.name }), 21, PLAYER_COLORS[atk.color]);
      else line(cap?.kind ?? (m.kind === 'knockout' && m.selfRole === 'victim' ? t.clip.gotMe : t.clip.kinds[m.kind]), 21, blink ? PAL.yellow : PAL.amber);
    }
    // «повтор» в углу — как в спортивной трансляции
    g.fillStyle = PAL.red;
    if (blink) g.fillRect(LW - 9, AY + 4, 4, 4);
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
    text(g, t.meta.title, LW / 2, 92, PAL.yellow, font, { size: 1.25 });
    // хоровод вдвое крупнее: живые в цветах игроков, между ними бот
    const ch = a.chars(this.inp.rec.theme);
    g.save();
    g.scale(2, 2);
    const cols = [0, 1, -1, 2, 3];
    cols.forEach((col, i) => {
      const x = 15 + i * 15;
      const y = 82 + ((i + Math.floor(ms / 320)) % 2);
      const fr = F.DANCE + (Math.floor((ms + i * 90) / 160) % 4);
      g.drawImage(a.shadow, x - 5, y - 2);
      if (col >= 0) frame(g, ch.outline[1 + col], OL_W, OL_H, fr, x - 7, y - 17);
      frame(g, ch.body, CH_W, CH_H, fr, x - 6, y - CH_H);
    });
    g.restore();
    text(g, t.clip.cta, LW / 2, 196, PAL.white, font);
    // адрес бывает длинным (who-is-alive.vercel.app — 23 знака): уменьшаем, чтобы влез с полями
    text(g, this.inp.site, LW / 2, 212, PAL.cyan, font, { size: fitSize(this.inp.site, LW - 12, CLIP_SCALE), maxWidth: LW - 12 });
    g.globalAlpha = 1;
  }
}

/**
 * Записать клип в видео. Идёт в реальном времени (~11 с): MediaRecorder пишет то,
 * что появляется на холсте. onFrame получает долю готовности 0..1.
 */
export async function recordClip(
  scene: ClipPlayerScene,
  mime: string,
  onFrame?: (progress: number) => void,
): Promise<ClipResult> {
  const stream = scene.c.captureStream(FPS);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
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
  const type = mime.split(';')[0];
  return { blob: new Blob(chunks, { type }), ext: type === 'video/mp4' ? 'mp4' : 'webm', mime: type };
}
