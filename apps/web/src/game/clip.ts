import { PAL, PLAYER_COLORS } from '@kto/assets';
import { TICK_MS, fmt, makeReplay, worldOf } from '@kto/game-core';
import type { ArenaDef, Dict, Moment, RoundRecording, World } from '@kto/game-core';
import { fitSize, frame, getArt, scaledCanvas, text } from './art';
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
export class ClipPlayerScene {
  readonly c: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private art: Art;
  private hedge: CanvasPattern | null;
  private partDur: number;
  private speed: number;
  readonly duration: number;
  private replay: World | null = null;
  private part = 0;
  private trails = new Map<number, { x: number; y: number }[]>();
  private colors = new Map<number, number>();

  constructor(private inp: ClipInput) {
    const { c, g } = scaledCanvas(LW, LH, CLIP_SCALE);
    this.c = c;
    this.g = g;
    this.art = getArt(inp.arena);
    this.hedge = g.createPattern(this.art.hedge, 'repeat');
    const len = inp.moment.to - inp.moment.from;
    this.speed = Math.max(BASE_SPEED, len / PART_MAX_MS);
    this.partDur = len / this.speed;
    this.duration = this.partDur * 2 + OUTRO_MS;
    for (const p of inp.players) this.colors.set(p.eid, p.color);
  }

  /** Нарисовать кадр клипа в момент ms от начала. Вызывать с неубывающим ms. */
  draw(ms: number): void {
    const part = ms < this.partDur ? 1 : ms < this.partDur * 2 ? 2 : 3;
    if (part !== this.part) {
      this.part = part;
      this.trails.clear();
      this.replay = part < 3 ? makeReplay(worldOf(this.inp.rec), this.inp.moment.from, this.inp.moment.to) : null;
    }
    if (part === 3) {
      this.drawOutro(ms - this.partDur * 2);
      return;
    }
    const local = ms - (part === 1 ? 0 : this.partDur);
    const target = this.inp.moment.from + local * this.speed;
    const w = this.replay!;
    while (w.time + TICK_MS <= target && w.time < this.inp.moment.to) {
      w.step();
      if (part === 2) this.recordTrails(w);
    }
    const alpha = Math.max(0, Math.min(1, (target - w.time) / TICK_MS));
    this.drawWorld(w, alpha, part === 2, ms);
    this.drawBands(part, local);
    if (part === 2 && local < FLASH_MS) {
      this.g.fillStyle = PAL.white;
      this.g.globalAlpha = 1 - local / FLASH_MS;
      this.g.fillRect(0, 0, LW, LH);
      this.g.globalAlpha = 1;
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

  private drawWorld(w: World, alpha: number, reveal: boolean, now: number): void {
    const g = this.g;
    const a = this.art;
    const theme = Math.min(this.inp.rec.theme, a.body.length - 1);
    const t = w.time - TICK_MS + alpha * TICK_MS;
    g.fillStyle = PAL.ink;
    g.fillRect(0, 0, LW, LH);
    g.drawImage(a.arena, 0, AY);

    // следы живых во второй части
    if (reveal) {
      for (const [eid, tr] of this.trails) {
        g.fillStyle = PLAYER_COLORS[this.colors.get(eid)!];
        tr.forEach((p, i) => i % 2 === 0 && g.fillRect(p.x, AY + p.y, 1, 1));
      }
    }

    type D = { y: number; draw: () => void };
    const list: D[] = [];
    for (const p of this.inp.arena.props) {
      const pr = a.props.get(p.kind)!;
      const f = p.kind === 'fountain' ? Math.floor(now / 180) % pr.frames : p.kind === 'lamp' ? Math.floor(now / 900) % pr.frames : 0;
      list.push({ y: p.y, draw: () => frame(g, pr.c, pr.fw, pr.fh, f, p.x - pr.fw / 2, AY + p.y - pr.fh) });
    }
    for (const e of w.entities) {
      const x = Math.round(e.px + (e.x - e.px) * alpha);
      const y = Math.round(e.py + (e.y - e.py) * alpha);
      const sy = AY + y;
      if (!e.alive) {
        const since = w.time - e.removedAt;
        if (since >= 0 && since < 360) list.push({ y: y + 1, draw: () => frame(g, a.poof, 24, 24, Math.min(5, Math.floor(since / 60)), x - 12, sy - 20) });
        continue;
      }
      const fr = frameFor(e, t);
      const col = this.colors.get(e.eid);
      const lit = reveal && col !== undefined;
      const dim = reveal && !lit;
      list.push({
        y,
        draw: () => {
          g.globalAlpha = dim ? 0.4 : 1;
          g.drawImage(a.shadow, x - 5, sy - 2);
          if (lit) frame(g, a.outline[theme][1 + col!], OL_W, OL_H, fr.frame, x - 7, sy + fr.yoff - 17, fr.flip);
          g.globalAlpha = dim ? 0.45 : 1;
          frame(g, a.body[theme], CH_W, CH_H, fr.frame, x - 6, sy + fr.yoff - CH_H, fr.flip);
          g.globalAlpha = 1;
          if (e.act === 'stun' && t < e.actEnd) frame(g, a.stun, 12, 5, Math.floor(t / 120) % 3, x - 6, sy - CH_H - 6);
          if (e.markUntil > t) g.drawImage(a.mark, x - 2, sy - CH_H - 12 - (Math.floor(t / 150) % 2));
        },
      });
    }
    for (const s of w.stars.values()) {
      const bob = Math.floor((now + s.id * 300) / 300) % 2;
      list.push({ y: s.y - 1, draw: () => frame(g, a.star, 10, 10, Math.floor(now / 140) % 4, s.x - 5, AY + s.y - 8 - bob) });
    }
    list.sort((p, q) => p.y - q.y);
    for (const d of list) d.draw();

    // изгородь сжимающейся зоны
    const z = w.zoneRect();
    const full = this.inp.arena.walk;
    if (z && this.hedge && z.w < full.w - 1) {
      const x0 = Math.round(z.x) - 4;
      const y0 = Math.round(z.y) - 6;
      const x1 = Math.round(z.x + z.w) + 4;
      const y1 = Math.round(z.y + z.h) + 2;
      const W = this.inp.arena.width;
      const H = this.inp.arena.height;
      g.fillStyle = this.hedge;
      for (const [rx, ry, rw, rh] of [
        [0, 0, W, y0],
        [0, y1, W, H - y1],
        [0, y0, x0, y1 - y0],
        [x1, y0, W - x1, y1 - y0],
      ]) {
        if (rw > 0 && rh > 0) g.fillRect(rx, AY + ry, rw, rh);
      }
    }

    // имена живых над головами
    if (reveal) {
      for (const p of this.inp.players) {
        const e = w.get(p.eid);
        if (!e || !e.alive) continue;
        const x = Math.round(e.px + (e.x - e.px) * alpha);
        const y = Math.round(e.py + (e.y - e.py) * alpha);
        const name = p.name.length > 10 ? p.name.slice(0, 9) + '…' : p.name;
        const half = (name.length * 8) / 2;
        const cx = Math.max(half + 1, Math.min(LW - half - 1, x));
        text(g, name, cx, AY + y - CH_H - 13, PLAYER_COLORS[p.color], this.inp.font);
      }
    }

    if (w.isFrozen()) {
      g.fillStyle = PAL.slate;
      g.globalAlpha = 0.35;
      g.fillRect(0, AY, LW, PANEL_Y - AY);
      g.globalAlpha = 1;
    }
    g.globalAlpha = 0.35;
    g.drawImage(a.vignette, 0, AY);
    g.globalAlpha = 1;
  }

  private drawBands(part: number, local: number): void {
    const g = this.g;
    const t = this.inp.t;
    const font = this.inp.font;
    g.fillStyle = PAL.ink;
    g.fillRect(0, 0, LW, AY);
    g.fillRect(0, PANEL_Y, LW, LH - PANEL_Y);
    text(g, t.meta.title, LW / 2, 8, PAL.yellow, font, { outline: null });
    const cap = this.inp.captions;
    if (part === 1) {
      text(g, cap?.find ?? t.clip.find, LW / 2, PANEL_Y + 8, PAL.white, font, { outline: null });
      text(g, cap?.findSub ?? fmt(t.clip.round, { n: this.inp.rec.round }), LW / 2, PANEL_Y + 21, PAL.mist, font, { outline: null });
    } else {
      const blink = Math.floor(local / 400) % 2 === 0;
      text(g, cap?.reveal ?? t.clip.reveal, LW / 2, PANEL_Y + 8, PAL.white, font, { outline: null });
      text(g, cap?.kind ?? t.clip.kinds[this.inp.moment.kind], LW / 2, PANEL_Y + 21, blink ? PAL.yellow : PAL.amber, font, { outline: null });
      // «повтор» в углу — как в спортивной трансляции
      g.fillStyle = PAL.red;
      if (blink) g.fillRect(LW - 9, AY + 4, 4, 4);
    }
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
    const theme = Math.min(this.inp.rec.theme, a.body.length - 1);
    g.save();
    g.scale(2, 2);
    const cols = [0, 1, -1, 2, 3];
    cols.forEach((col, i) => {
      const x = 15 + i * 15;
      const y = 82 + ((i + Math.floor(ms / 320)) % 2);
      const fr = F.DANCE + (Math.floor((ms + i * 90) / 160) % 4);
      g.drawImage(a.shadow, x - 5, y - 2);
      if (col >= 0) frame(g, a.outline[theme][1 + col], OL_W, OL_H, fr, x - 7, y - 17);
      frame(g, a.body[theme], CH_W, CH_H, fr, x - 6, y - CH_H);
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
