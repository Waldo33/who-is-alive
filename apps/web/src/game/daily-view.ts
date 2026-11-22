import { PAL } from '@kto/assets';
import { TICK_MS, makeReplay } from '@kto/game-core';
import type { ArenaDef, CrowdKind, World } from '@kto/game-core';
import { frame, getArt } from './art';
import type { Art } from './art';
import { frameFor } from './frames';
import { CH_H, CH_W, OL_H, OL_W } from './sprites';

/**
 * Экран загадки дня: повтор дубля на canvas 2D (тот же арт, что в игре и клипе) и выбор
 * «кто живой» по тапу. Сцена Phaser не нужна: здесь только смотреть и тыкать.
 */
export interface DailyViewOpts {
  canvas: HTMLCanvasElement;
  arena: ArenaDef;
  world: World;
  theme: number;
  from: number;
  to: number;
  /** Во время стоп-кадра «Море волнуется» — какая команда (null — команды нет). */
  onCrowd?: (c: { kind: CrowdKind; vote: boolean } | null) => void;
}

export class DailyView {
  private g: CanvasRenderingContext2D;
  private art: Art;
  private replay: World | null = null;
  private raf = 0;
  private spots: { x: number; y: number; r: number; until: number }[] = [];
  private crowdShown: string | null = null;
  /** Последний кадр — на нём выбирают. */
  private last: World | null = null;
  /** Ошибочные выборы (крестик) и правильный ответ (рамка). */
  wrong = new Set<number>();
  answer: number | null = null;

  constructor(private o: DailyViewOpts) {
    o.canvas.width = o.arena.width;
    o.canvas.height = o.arena.height;
    this.g = o.canvas.getContext('2d')!;
    this.g.imageSmoothingEnabled = false;
    this.art = getArt(o.arena);
  }

  /** Проиграть дубль с начала; по окончании — стоп-кадр и onEnd. */
  play(onEnd: () => void): void {
    cancelAnimationFrame(this.raf);
    const w = makeReplay(this.o.world, this.o.from, this.o.to);
    if (!w) return;
    this.replay = w;
    this.spots = [];
    w.listeners.push((ev) => {
      if (ev.t === 'spot') this.spots.push({ x: ev.x, y: ev.y, r: ev.r, until: ev.until });
    });
    const t0 = performance.now();
    let acc = 0;
    let prev = t0;
    const loop = (now: number) => {
      acc += Math.min(250, now - prev);
      prev = now;
      while (acc >= TICK_MS && w.time < this.o.to) {
        w.step();
        acc -= TICK_MS;
      }
      const alpha = w.time >= this.o.to ? 1 : acc / TICK_MS;
      this.draw(w, alpha, now - t0);
      const c = w.crowd && w.isFrozen() ? `${w.crowd.kind}:${w.crowd.showAt}` : null;
      if (c !== this.crowdShown) {
        this.crowdShown = c;
        this.o.onCrowd?.(c && w.crowd ? { kind: w.crowd.kind, vote: !!w.crowd.vote } : null);
      }
      if (w.time >= this.o.to) {
        this.last = w;
        onEnd();
        return;
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Перерисовать стоп-кадр (после выбора). */
  redraw(): void {
    if (this.last) this.draw(this.last, 1, performance.now());
  }

  /** Сущность под тапом (координаты в пикселях canvas на экране) или null. */
  pick(clientX: number, clientY: number): number | null {
    const w = this.last;
    if (!w) return null;
    const r = this.o.canvas.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * this.o.arena.width;
    const y = ((clientY - r.top) / r.height) * this.o.arena.height;
    let best: number | null = null;
    let bd = 12;
    for (const e of w.entities) {
      if (!e.alive) continue;
      // фигура стоит ногами в (x, y), тело — на 16 пикс. выше: целимся в середину тела
      const d = Math.hypot(e.x - x, e.y - 7 - y);
      if (d < bd) {
        bd = d;
        best = e.eid;
      }
    }
    return best;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
  }

  private draw(w: World, alpha: number, now: number): void {
    const g = this.g;
    const a = this.art;
    const th = this.o.theme;
    const look = w.twist ? 1 : 0;
    const loc = a.loc(th, look);
    const ch = a.chars(th, look);
    const t = w.time - TICK_MS + alpha * TICK_MS;
    g.drawImage(loc.arena, 0, 0);
    type D = { y: number; draw: () => void };
    const list: D[] = [];
    for (const p of this.o.arena.props) {
      const pr = loc.props.get(p.kind)!;
      const f = p.kind === 'fountain' ? Math.floor(now / 180) % pr.frames : p.kind === 'lamp' ? Math.floor(now / 900) % pr.frames : 0;
      list.push({ y: p.y, draw: () => frame(g, pr.c, pr.fw, pr.fh, f, p.x - pr.fw / 2, p.y - pr.fh) });
    }
    for (const [idx, e] of w.entities.entries()) {
      if (!e.alive) continue;
      const x = Math.round(e.px + (e.x - e.px) * alpha);
      const y = Math.round(e.py + (e.y - e.py) * alpha);
      const fr = frameFor(e, t, ch.acts);
      const ce = a.charsFor(th, look, idx);
      const isAnswer = this.answer === e.eid;
      const isWrong = this.wrong.has(e.eid);
      list.push({
        y,
        draw: () => {
          g.drawImage(a.shadow, x - 5, y - 2);
          if (isAnswer) frame(g, ce.outline[3], OL_W, OL_H, fr.frame, x - 7, y + fr.yoff - 17, fr.flip);
          g.globalAlpha = isWrong ? 0.45 : 1;
          frame(g, ce.body, CH_W, CH_H, fr.frame, x - 6, y + fr.yoff - CH_H, fr.flip);
          g.globalAlpha = 1;
          if (e.act === 'stun' && t < e.actEnd) frame(g, a.stun, 12, 5, Math.floor(t / 120) % 3, x - 6, y - CH_H - 6);
          if (e.markUntil > t) g.drawImage(a.mark, x - 2, y - CH_H - 12 - (Math.floor(t / 150) % 2));
          if (isWrong) {
            // крестик над головой: «это массовка»
            g.fillStyle = PAL.red;
            for (let k = 0; k < 5; k++) {
              g.fillRect(x - 2 + k, y - CH_H - 7 + k, 1, 1);
              g.fillRect(x + 2 - k, y - CH_H - 7 + k, 1, 1);
            }
          }
        },
      });
    }
    for (const st of w.stars.values()) {
      const bob = Math.floor((now + st.id * 300) / 300) % 2;
      list.push({ y: st.y - 1, draw: () => frame(g, a.star, 10, 10, Math.floor(now / 140) % 4, st.x - 5, st.y - 8 - bob) });
    }
    list.sort((p, q) => p.y - q.y);
    for (const d of list) d.draw();
    // прожектор режиссёра: кто-то в круге сбился с жеста
    g.fillStyle = PAL.yellow;
    for (const s of this.spots) {
      if (w.time > s.until) continue;
      for (let k = 0; k < 48; k++) {
        const ang = (k / 48) * Math.PI * 2;
        g.fillRect(Math.round(s.x + Math.cos(ang) * s.r), Math.round(s.y + Math.sin(ang) * s.r * 0.75), 1, 1);
      }
    }
    // стоп-кадр: мир сереет
    if (w.isFrozen()) {
      g.fillStyle = PAL.ink;
      g.globalAlpha = 0.25;
      g.fillRect(0, 0, this.o.arena.width, this.o.arena.height);
      g.globalAlpha = 1;
    }
  }
}
