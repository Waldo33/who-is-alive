import * as Phaser from 'phaser';
import { PAL, hexToInt } from '@kto/assets';
import type { ClientView, Dict, SlotMine, SlotOutcome, SlotSymbol } from '@kto/game-core';
import { SLOT_SYMBOLS, isTease } from '@kto/game-core';
import type { Haptic } from '../lib/telegram';
import type { Sfx } from './audio';
import type { FontColor } from './font';
import {
  BODY_H, BODY_W, BTN_H, BTN_PULL, BTN_Y, CANDLE_Y, DECK_H, DECK_Y, PANEL_TOP, REELS_H, REELS_X, REELS_Y,
  REEL_GAP, REEL_W, SYM_K, SYM_W, TOP_H, TOP_Y,
  makeSlotBackdrop, makeSlotBody, makeSlotSymbols,
} from './slot-art';

/**
 * «Крутка» «Казино» (game-core › slots.ts): вместо команды «Море волнуется» лампы мигают, мир замирает,
 * сверху опускается автомат — игрок тянет рычаг вниз пальцем (или жмёт «Крутить»; не успел — автомат
 * дёргает сам), барабаны крутятся, каждый символ — щелчок и толчок вибрации, итог — на табло.
 *
 * Оптимистично: барабаны стартуют от рывка рычага сразу, без сервера. Что выпало, сервер присылает лично
 * (MeView.slot), как только замигали лампы, — задолго до остановки; если не успел, барабаны просто
 * крутятся дольше. Время «Крутки» — из мира (World.crowd со `slot`), одинаковое у всех.
 *
 * Звук: щелчки, рычаг и барабаны слышны у всех (крутят все разом). Исходы, видимые на поле (молния,
 * гиря, прожектор), — без своего звука: соседи по комнате не должны узнать, чей человечек побежал.
 */

/** Падение автомата сверху и подъём обратно, мс. */
const DROP_MS = 400;
const RISE_MS = 300;
/** Сколько ждать рычага после падения автомата, мс мира; потом автомат дёргает сам. */
const AUTO_MS = 2000;
/** Барабаны: от рывка до начала торможения каждого, мс; «чуть-чуть» — третий дольше. */
const STOP_AT = [800, 1250, 1700];
const TEASE_MS = 700;
/** Скорость ленты, px/мс (символ проходит каждые ~80 мс) и разгон. */
const SPEED = 0.5;
const ACCEL_MS = 160;
const ROW = SYM_W * SYM_K + 4; // шаг символов на ленте
const N = SLOT_SYMBOLS.length;
/** Порядок символов на ленте барабана r (у каждого свой): шаг 5 по кругу из 12 — перестановка. */
const strip = (r: number, k: number): number => (((k * 5 + r * 4) % N) + N) % N;

export interface SlotHost {
  scene: Phaser.Scene;
  ay: number;
  txt: (x: number, y: number, s: string, color?: FontColor) => Phaser.GameObjects.BitmapText;
  t: Dict['slot'];
  play: (s: Sfx, step?: number) => void;
  haptic: (k: Haptic) => void;
}

interface Reel {
  /** Положение ленты, px (символ в центре — strip(r, round(p / ROW))). */
  p: number;
  /** Начало торможения (performance.now) и куда встанет; null — ещё не решено. */
  stopAt: number | null;
  from: number;
  to: number;
  dur: number;
  landed: boolean;
  lastK: number;
  /** На этом месте ленты встанет выпавший символ (подменяется за краем окна, пока его не видно). */
  targetK: number;
  target: number;
}

export class SlotScreen {
  private objs: { o: Phaser.GameObjects.GameObject & { y: number; setVisible: (v: boolean) => unknown }; y: number }[] = [];
  private g: Phaser.GameObjects.Graphics;
  /** Лампы и надпись «Крутка!» над полем (до того, как опустится автомат). */
  private warnG: Phaser.GameObjects.Graphics;
  private warnT: Phaser.GameObjects.BitmapText;
  private reelsTex: Phaser.Textures.CanvasTexture;
  private symImg: HTMLCanvasElement;
  private line1: Phaser.GameObjects.BitmapText;
  private line2: Phaser.GameObjects.BitmapText;
  private pullT: Phaser.GameObjects.BitmapText;
  private shown = false;
  private readonly bx = 4;
  private readonly by: number;
  /** Текущая «Крутка» (warnAt) и её ход. */
  private key = -1;
  private pullAt = 0;
  private auto = false;
  private reels: Reel[] = [];
  private result: SlotMine | null = null;
  private revealed = false;
  private resultText: [string, FontColor] = ['', 'white'];
  private flash: { color: number; at: number } | null = null;
  /** Рычаг: 0 — вверху, 1 — внизу; тянут пальцем (drag) или он ходит сам (анимация после рывка). */
  private drag: { id: number; y0: number; k: number } | null = null;
  private leverK = 0;
  private pressAt = 0;
  private lastTickSfx = 0;
  private lastTickBuzz = 0;
  private oy = 0;
  private kids = false;

  constructor(private h: SlotHost) {
    const s = h.scene;
    const tex = s.textures;
    if (!tex.exists('slotbg')) tex.addCanvas('slotbg', makeSlotBackdrop());
    if (!tex.exists('slotbody')) tex.addCanvas('slotbody', makeSlotBody());
    this.symImg = makeSlotSymbols();
    if (!tex.exists('slotsyms')) tex.addSpriteSheet('slotsyms', makeSlotSymbols() as unknown as HTMLImageElement, { frameWidth: SYM_W, frameHeight: SYM_W });
    const rw = REEL_W * 3 + REEL_GAP * 2;
    this.reelsTex = tex.exists('slotreels') ? (tex.get('slotreels') as Phaser.Textures.CanvasTexture) : tex.createCanvas('slotreels', rw, REELS_H)!;
    this.by = h.ay + 3;
    // поверх подсказок и тостов сцены: пока автомат на экране, он главный
    const D = 1700;
    const add = <T extends Phaser.GameObjects.GameObject & { y: number; setVisible: (v: boolean) => unknown }>(o: T, d = D): T => {
      (o as unknown as { setDepth: (n: number) => void }).setDepth(d);
      this.objs.push({ o, y: o.y });
      return o;
    };
    add(s.add.image(0, h.ay, 'slotbg').setOrigin(0, 0).setAlpha(0.85));
    add(s.add.image(this.bx, this.by, 'slotbody').setOrigin(0, 0), D + 1);
    add(s.add.image(this.bx + REELS_X, this.by + REELS_Y, 'slotreels').setOrigin(0, 0), D + 2);
    this.g = s.add.graphics().setDepth(D + 3).setVisible(false);
    const px0 = this.by + PANEL_TOP;
    const cxm = this.bx + BODY_W / 2;
    this.line1 = add(h.txt(cxm, px0 + 16, '', 'mist').setOrigin(0.5, 0), D + 4);
    this.line2 = add(h.txt(cxm, px0 + 34, '', 'yellow').setOrigin(0.5, 0), D + 4);
    for (const o of [this.line1, this.line2]) o.setLetterSpacing(-3);
    this.pullT = add(h.txt(this.bx + BTN_PULL.x + BTN_PULL.w / 2, this.by + BTN_Y + 3, h.t.pull, 'ink').setOrigin(0.5, 0), D + 4);
    this.warnG = s.add.graphics().setDepth(D - 2).setVisible(false);
    this.warnT = h.txt(90, h.ay + 40, '', 'yellow').setOrigin(0.5, 0).setDepth(D - 1).setVisible(false).setScale(2);
    this.shown = true;
    this.setVisible(false);
  }

  get visible(): boolean {
    return this.shown;
  }

  private setVisible(on: boolean): void {
    if (on === this.shown) return;
    this.shown = on;
    for (const { o } of this.objs) o.setVisible(on);
    this.g.setVisible(on);
  }

  // ───────────── ввод: рычаг и кнопка ─────────────

  /** Зона рычага (экранные координаты): правый край корпуса от верха барабанов до табло. */
  private onLever(x: number, y: number): boolean {
    return x >= this.bx + BODY_W - 40 && y >= this.by + this.oy + REELS_Y - 20 && y <= this.by + this.oy + PANEL_TOP + 20;
  }

  private onButton(x: number, y: number): boolean {
    const y0 = this.by + this.oy + DECK_Y;
    return y >= y0 && y < y0 + DECK_H + 4;
  }

  private canPull(): boolean {
    return this.shown && this.key >= 0 && !this.pullAt && this.oy === 0;
  }

  /** Касание: true — автомат забрал его себе (на поле не уходит). */
  down(id: number, x: number, y: number): boolean {
    if (!this.shown) return false;
    if (!this.canPull()) return true;
    if (this.onButton(x, y)) {
      this.pressAt = performance.now();
      this.pull(false);
    } else if (this.onLever(x, y) || y >= this.by + REELS_Y) this.drag = { id, y0: y, k: 0 };
    return true;
  }

  move(id: number, y: number): void {
    const d = this.drag;
    if (!d || d.id !== id || !this.canPull()) return;
    // ход рычага — 60 px пальцем; дотянул до низа — рывок сразу, не дожидаясь, пока отпустят
    const k = Math.max(0, Math.min(1, (y - d.y0) / 60));
    if (Math.floor(k * 5) > Math.floor(d.k * 5)) this.h.haptic('tick'); // храповик под пальцем
    d.k = k;
    this.leverK = k;
    if (k >= 1) this.pull(false);
  }

  up(id: number): void {
    const d = this.drag;
    if (!d || d.id !== id) return;
    this.drag = null;
    if (!this.pullAt && d.k >= 0.45) this.pull(false);
  }

  /** Рывок: рычаг до низа и обратно, барабаны пошли. */
  private pull(auto: boolean): void {
    if (this.pullAt) return;
    this.pullAt = performance.now();
    this.auto = auto;
    this.drag = null;
    this.h.play('slotLever');
    this.h.haptic('medium');
    for (const r of this.reels) r.lastK = Math.round(r.p / ROW);
  }

  // ───────────── кадр ─────────────

  update(v: ClientView): void {
    const c = v.world.crowd;
    const wt = v.world.time;
    const now = performance.now();
    const me = v.me();
    const on = v.phase === 'play' && !!c?.slot && wt >= c.warnAt && wt < c.resumeAt + RISE_MS;
    if (!on || !c) {
      this.warnG.setVisible(false).clear();
      this.warnT.setVisible(false);
      this.setVisible(false);
      this.key = -1;
      return;
    }
    if (c.warnAt !== this.key) this.begin(c.warnAt);
    const alive = !!me?.alive;
    // лампы: от звонка до падения автомата (у вырезанных — всю «Крутку»: им крутить нечего)
    const warn = wt < c.showAt || !alive;
    this.drawWarn(warn, wt < c.showAt ? this.h.t.warn : this.h.t.ghost, now);
    if (!alive || wt < c.showAt) {
      this.setVisible(false);
      return;
    }
    // падение сверху (ease-out с отскоком) и подъём после стоп-кадра
    const td = wt - c.showAt;
    let oy = 0;
    if (td < DROP_MS) {
      const k = td / DROP_MS;
      oy = -Math.round((BODY_H + 10) * (1 - k) * (1 - k)) + (k > 0.8 ? Math.round(Math.sin((k - 0.8) * 5 * Math.PI) * 4) : 0);
    }
    if (wt >= c.resumeAt) oy = -Math.round((BODY_H + 10) * Math.min(1, (wt - c.resumeAt) / RISE_MS));
    this.oy = oy;
    this.setVisible(true);
    for (const { o, y } of this.objs) o.y = y + (o === this.objs[0].o ? 0 : oy);
    (this.objs[0].o as unknown as Phaser.GameObjects.Image).setAlpha(0.85 * Math.max(0, Math.min(1, td / DROP_MS)) * (wt >= c.resumeAt ? 1 - Math.min(1, (wt - c.resumeAt) / RISE_MS) : 1));

    // своё вращение пришло (личное сообщение) — запоминаем, барабаны встанут на него
    if (me?.slot && me.slot.at === c.warnAt && !this.result) this.result = me.slot;
    // не дёрнул за AUTO_MS — автомат дёргает сам (рычаг всё равно опускается)
    if (!this.pullAt && td >= DROP_MS + AUTO_MS && !this.drag) this.pull(true);
    if (this.pullAt) this.spin(now, wt, c.resumeAt);
    if (!this.pullAt && !this.drag) this.leverK = 0;
    else if (this.pullAt && !this.drag) {
      // рычаг сам доходит до низа и пружинит обратно
      const k = (now - this.pullAt) / 380;
      this.leverK = k < 0.35 ? Math.max(this.leverK, k / 0.35) : Math.max(0, 1 - (k - 0.35) / 0.65);
    }
    this.drawReels(now);
    this.drawPanel(now, td);
  }

  private begin(key: number): void {
    this.key = key;
    this.pullAt = 0;
    this.auto = false;
    this.result = null;
    this.revealed = false;
    this.resultText = ['', 'white'];
    this.flash = null;
    this.drag = null;
    this.leverK = 0;
    // лента стоит на случайном месте (до рывка видно три произвольных символа)
    this.reels = [0, 1, 2].map(() => {
      const p = Math.floor(Math.random() * N) * ROW;
      return { p, stopAt: null, from: p, to: p, dur: 0, landed: false, lastK: Math.round(p / ROW), targetK: -1, target: 0 };
    });
    this.h.play('slotBell');
    this.h.haptic('warning');
  }

  /** Лента крутится; торможение каждого барабана — как только известен итог и подошло его время. */
  private spin(now: number, wt: number, resumeAt: number): void {
    const t = now - this.pullAt;
    // сколько времени осталось до конца стоп-кадра (по часам мира) — все барабаны должны успеть встать
    const left = resumeAt - wt;
    const res = this.result;
    const tease = !!res && isTease(res.reels);
    this.reels.forEach((r, i) => {
      if (r.landed) return;
      if (r.stopAt === null && res) {
        let at = this.pullAt + STOP_AT[i] + (i === 2 && tease ? TEASE_MS : 0);
        // итог пришёл поздно — встаём по очереди от «сейчас»
        const prev = this.reels[i - 1];
        if (prev && prev.stopAt !== null) at = Math.max(at, prev.stopAt + 300);
        at = Math.max(at, now);
        // не успеть до конца стоп-кадра нельзя: сжимаем
        at = Math.min(at, now + Math.max(0, left - 900 - (2 - i) * 150));
        if (now >= at - 1) this.brake(r, res.reels[i], now);
      }
      if (r.stopAt === null) {
        // разгон с места и ровный ход
        const run = t < ACCEL_MS ? (SPEED * t * t) / (2 * ACCEL_MS) : SPEED * (t - ACCEL_MS / 2);
        r.p = r.from + run;
      } else {
        const k = Math.min(1, (now - r.stopAt) / r.dur);
        // равнозамедленно: путь v·τ − v·τ²/(2d), в конце — на месте
        const tau = k * r.dur;
        r.p = Math.min(r.to, r.from + SPEED * tau - (SPEED * tau * tau) / (2 * r.dur));
        if (k >= 1) {
          r.p = r.to;
          r.landed = true;
          this.h.play('slotStop', i);
          this.h.haptic('light');
        }
      }
      // символ прошёл под стеклом — щелчок и толчок вибрации
      const kk = Math.floor(r.p / ROW + 0.5);
      if (kk !== r.lastK) {
        r.lastK = kk;
        if (now - this.lastTickBuzz >= 45) {
          this.lastTickBuzz = now;
          this.h.haptic('tick');
        }
        if (now - this.lastTickSfx >= 70) {
          this.lastTickSfx = now;
          this.h.play('slotTick');
        }
      }
    });
    if (!this.revealed && this.reels.length && this.reels.every((r) => r.landed) && res) this.reveal(res, now);
  }

  /**
   * Начать торможение: барабан проходит ровно три символа и встаёт. Выпавший символ кладётся на ленту
   * тремя местами выше окна — там его ещё не видно, — так торможение всегда одной длины (~0,5 с).
   */
  private brake(r: Reel, sym: SlotSymbol, now: number): void {
    const t = now - this.pullAt;
    const run = t < ACCEL_MS ? (SPEED * t * t) / (2 * ACCEL_MS) : SPEED * (t - ACCEL_MS / 2);
    const p = r.from + run;
    const k = Math.ceil(p / ROW) + 3;
    r.targetK = k;
    r.target = SLOT_SYMBOLS.indexOf(sym);
    r.from = p;
    r.to = k * ROW;
    r.dur = (2 * (r.to - p)) / SPEED;
    r.stopAt = now;
  }

  private reveal(res: SlotMine, now: number): void {
    this.revealed = true;
    const t = this.h.t;
    const TEXT: Record<SlotOutcome, [string, FontColor, Haptic | null, Sfx | null]> = {
      seven: [t.seven, 'yellow', 'success', 'slotJackpot'],
      star: [t.star, 'yellow', 'success', 'slotCoins'],
      fist: [t.fist, 'amber', 'success', 'slotCoins'],
      peek: [t.peek, 'blue', 'success', 'slotCoins'],
      // видимые на поле — без своего звука (соседи по комнате не узнают, чей человечек побежал)
      bolt: [t.bolt, 'yellow', 'medium', null],
      spot: [t.spot, 'coral', 'warning', null],
      weight: [t.weight, 'mist', 'warning', null],
      reel: [t.reel, 'coral', 'warning', null],
      skull: this.kids ? [t.skullKids, 'coral', 'error', 'sad'] : [t.skull, 'red', 'error', 'slotSkull'],
      miss: [isTease(res.reels) ? t.tease : t.miss, 'mist', null, isTease(res.reels) ? 'slotTease' : null],
    };
    const [s, color, buzz, sfx] = TEXT[res.outcome];
    this.resultText = [s, color];
    if (buzz) this.h.haptic(buzz);
    if (sfx) this.h.play(sfx);
    if (res.outcome === 'seven' || res.outcome === 'star') this.flash = { color: hexToInt(PAL.yellow), at: now };
    if (res.outcome === 'skull') this.flash = { color: hexToInt(PAL.red), at: now };
  }

  /** Лёгкая сложность: череп не вырезает, а сжигает звезду — подпись и звук другие. */
  setKids(kids: boolean): void {
    this.kids = kids;
  }

  // ───────────── рисование ─────────────

  /** Лампы по краю поля бегут по кругу, над полем — «Крутка!» (у вырезанных — «Крутят живые…»). */
  private drawWarn(on: boolean, label: string, now: number): void {
    const g = this.warnG;
    g.clear();
    g.setVisible(on);
    this.warnT.setVisible(on);
    if (!on) return;
    const ay = this.h.ay;
    const step = Math.floor(now / 110);
    const pts: [number, number][] = [];
    for (let x = 4; x < 178; x += 10) pts.push([x, ay + 2]);
    for (let y = ay + 12; y < ay + 256; y += 10) pts.push([176, y]);
    for (let x = 174; x > 2; x -= 10) pts.push([x, ay + 256]);
    for (let y = ay + 246; y > ay + 2; y -= 10) pts.push([2, y]);
    pts.forEach(([x, y], k) => {
      const lit = (k + step) % 3 === 0;
      g.fillStyle(hexToInt(PAL.ink)).fillRect(x - 1, y - 1, 4, 4);
      g.fillStyle(hexToInt(lit ? PAL.yellow : PAL.amber)).fillRect(x, y, 2, 2);
    });
    if (this.warnT.text !== label) this.warnT.setText(label);
    // «Крутка!» — крупно, длинная подпись вырезанным — обычным кеглем (иначе не влезет в ширину)
    this.warnT.setScale(label.length * 16 <= 170 ? 2 : 1);
    const blink = Math.floor(now / 220) % 2 === 0;
    this.warnT.setFont(blink ? 'px-yellow' : 'px-amber');
    this.warnT.x = Math.round(90 - this.warnT.width / 2);
    this.warnT.setOrigin(0, 0);
    const w = this.warnT.width + 10;
    g.fillStyle(hexToInt(PAL.ink), 0.7).fillRect(Math.round(90 - w / 2), this.warnT.y - 3, w, this.warnT.height + 5);
  }

  private drawReels(now: number): void {
    const c = this.reelsTex.getContext();
    c.imageSmoothingEnabled = false;
    const rw = REEL_W * 3 + REEL_GAP * 2;
    c.fillStyle = PAL.ink;
    c.fillRect(0, 0, rw, REELS_H);
    const sz = SYM_W * SYM_K;
    this.reels.forEach((r, i) => {
      const x0 = i * (REEL_W + REEL_GAP);
      c.fillStyle = PAL.white;
      c.fillRect(x0, 0, REEL_W, REELS_H);
      // отскок на остановке: лента чуть проскакивает и возвращается
      const settle = r.landed && r.stopAt !== null ? now - (r.stopAt + r.dur) : Infinity;
      const bounce = settle < 160 ? Math.round(Math.sin((settle / 160) * Math.PI) * 3) : 0;
      const p = r.p + bounce;
      const k0 = Math.floor(p / ROW);
      const frac = p - k0 * ROW;
      for (let d = -2; d <= 2; d++) {
        const idx = k0 + d === r.targetK ? r.target : strip(i, k0 + d);
        // лента идёт сверху вниз: больший номер — выше
        const y = Math.round(REELS_H / 2 - sz / 2 - d * ROW + frac);
        c.drawImage(this.symImg, idx * SYM_W, 0, SYM_W, SYM_W, x0 + (REEL_W - sz) / 2, y, sz, sz);
      }
      // круглый барабан: к верху и низу темнеет полосами
      const band = (y: number, col: string, stepX: number) => {
        c.fillStyle = col;
        for (let x = y % 2; x < REEL_W; x += stepX) {
          c.fillRect(x0 + x, y, 1, 1);
          c.fillRect(x0 + x, REELS_H - 1 - y, 1, 1);
        }
      };
      for (let y = 0; y < 4; y++) band(y, PAL.dusk, 1);
      for (let y = 4; y < 8; y++) band(y, PAL.steel, 1 + (y - 4));
      for (let y = 8; y < 12; y++) band(y, PAL.slate, 2 + (y - 8) * 2);
      c.fillStyle = PAL.slate;
      c.fillRect(x0, 3, 1, REELS_H - 6);
      c.fillRect(x0 + REEL_W - 1, 3, 1, REELS_H - 6);
    });
    c.fillStyle = PAL.white;
    for (const sx of [12, 22, 92]) {
      for (let y = 4; y < REELS_H - 4; y++) {
        const x = sx + Math.floor((REELS_H - y) / 2);
        if (y % 2 === 0) c.fillRect(x, y, sx === 22 ? 1 : 2, 1);
      }
    }
    this.reelsTex.refresh();
  }

  private drawPanel(now: number, td: number): void {
    const g = this.g;
    g.clear();
    const t = this.h.t;
    const bx = this.bx;
    const by = this.by + this.oy;
    // лампочки короба бегут; пока барабаны крутятся — быстрее
    const fast = this.pullAt && !this.revealed;
    const step = Math.floor(now / (fast ? 70 : 160));
    const bulbs: [number, number][] = [];
    for (let x = 10; x <= BODY_W - 12; x += 8) bulbs.push([x, TOP_Y]);
    for (let y = TOP_Y + 9; y <= TOP_Y + TOP_H - 9; y += 9) bulbs.push([BODY_W - 8, y]);
    for (let x = BODY_W - 12; x >= 10; x -= 8) bulbs.push([x, TOP_Y + TOP_H - 2]);
    for (let y = TOP_Y + TOP_H - 9; y >= TOP_Y + 9; y -= 9) bulbs.push([6, y]);
    bulbs.forEach(([x, y], k) => {
      const lit = (k + step) % 3 === 0;
      g.fillStyle(hexToInt(PAL.ink)).fillRect(bx + x - 1, by + y - 1, 4, 4);
      g.fillStyle(hexToInt(lit ? PAL.white : PAL.amber)).fillRect(bx + x, by + y, 2, 2);
    });
    this.drawCandle(g, now, bx, by);
    this.drawButton(g, now, bx, by);
    this.drawLever(g, now, bx, by, td);

    // табло: что делать сейчас и что выпало
    let l1 = '';
    let l1c: FontColor = 'mist';
    if (!this.pullAt) [l1, l1c] = [t.pullHint, Math.floor(now / 300) % 2 ? 'white' : 'yellow'];
    else if (!this.revealed) [l1, l1c] = [this.auto ? t.auto : t.spinning, 'mist'];
    else if (this.auto) [l1, l1c] = [t.auto, 'mist'];
    if (this.line1.text !== l1) this.line1.setText(l1);
    this.line1.setFont('px-' + l1c);
    const [l2, l2c] = this.resultText;
    if (this.line2.text !== l2) this.line2.setText(l2);
    this.line2.setFont('px-' + l2c);
    // вспышка экрана: 777 и звезда — золотом, череп — красным
    const f = this.flash;
    if (f && now - f.at < 600) g.fillStyle(f.color, 0.45 * (1 - (now - f.at) / 600)).fillRect(0, this.h.ay, 180, 296);
  }

  /** Фонарь-«свеча»: в покое тлеет, пока крутятся барабаны — мигает, на 777 и звезде — салют. */
  private drawCandle(g: Phaser.GameObjects.Graphics, now: number, bx: number, by: number): void {
    const x = bx + BODY_W / 2 - 4;
    const y = by + CANDLE_Y - 13;
    const f = this.flash;
    const party = !!f && f.color === hexToInt(PAL.yellow) && now - f.at < 2400;
    const blink = Math.floor(now / 120) % 2 === 0;
    const spin = this.pullAt && !this.revealed && Math.floor(now / 250) % 2 === 0;
    const topC = party ? (blink ? PAL.white : PAL.red) : spin ? PAL.red : PAL.wine;
    const botC = party ? (blink ? PAL.red : PAL.white) : PAL.slate;
    g.fillStyle(hexToInt(PAL.ink)).fillRect(x, y, 8, 11);
    g.fillStyle(hexToInt(PAL.mist)).fillRect(x + 1, y, 6, 1);
    g.fillStyle(hexToInt(topC)).fillRect(x + 1, y + 1, 6, 4);
    g.fillStyle(hexToInt(PAL.ink)).fillRect(x + 1, y + 5, 6, 1);
    g.fillStyle(hexToInt(botC)).fillRect(x + 1, y + 6, 6, 4);
    g.fillStyle(hexToInt(PAL.white), 0.7).fillRect(x + 2, y + 2, 1, 2).fillRect(x + 2, y + 7, 1, 2);
    if (party || spin) g.fillStyle(hexToInt(topC), 0.25).fillRect(x - 3, y - 2, 14, 14);
  }

  /** Кнопка «Крутить» на наклонной панели: горит и мигает, пока ждём рывка; нажата — проседает. */
  private drawButton(g: Phaser.GameObjects.Graphics, now: number, bx: number, by: number): void {
    const open = !this.pullAt;
    const down = now - this.pressAt < 160 ? 3 : this.pullAt && !this.auto && this.pressAt >= this.pullAt - 5 ? 2 : 0;
    const x = bx + BTN_PULL.x;
    const y = by + BTN_Y + down;
    const side = 4 - Math.min(down, 3);
    g.fillStyle(hexToInt(PAL.ink)).fillRect(x - 1, y - 1, BTN_PULL.w + 2, BTN_H + side + 2);
    g.fillStyle(hexToInt(open ? PAL.orange : PAL.plum)).fillRect(x, y + BTN_H, BTN_PULL.w, side);
    g.fillStyle(hexToInt(open ? PAL.amber : PAL.umber)).fillRect(x, y, BTN_PULL.w, BTN_H);
    g.fillStyle(hexToInt(open ? PAL.yellow : PAL.brick)).fillRect(x, y, BTN_PULL.w, 2).fillRect(x, y, 1, BTN_H);
    if (open && Math.floor(now / 500) % 2 === 0) g.fillStyle(hexToInt(PAL.yellow), 0.45).fillRect(x + 3, y + 3, BTN_PULL.w - 6, BTN_H - 5);
    this.pullT.setY(y + 3).setFont(open ? 'px-ink' : 'px-sand').setAlpha(open ? 1 : 0.5);
  }

  /**
   * Рычаг справа от корпуса: шар на штанге, ходит от верха барабанов вниз на 34 px. Пока ждём рывка —
   * рядом мигает стрелка вниз.
   */
  private drawLever(g: Phaser.GameObjects.Graphics, now: number, bx: number, by: number, td: number): void {
    const lx = bx + BODY_W;
    const piv = by + REELS_Y + REELS_H / 2 + 6;
    const top = by + REELS_Y + 2 + Math.round(this.leverK * 34);
    g.fillStyle(hexToInt(PAL.ink)).fillRect(lx, piv - 2, 9, 16);
    g.fillStyle(hexToInt(PAL.steel)).fillRect(lx + 1, piv - 1, 7, 14);
    g.fillStyle(hexToInt(PAL.mist)).fillRect(lx + 1, piv - 1, 7, 1);
    g.fillStyle(hexToInt(PAL.ink)).fillRect(lx + 3, Math.min(top, piv), 3, Math.abs(piv + 2 - top) + 1);
    g.fillStyle(hexToInt(PAL.mist)).fillRect(lx + 4, Math.min(top, piv), 1, Math.abs(piv + 2 - top));
    g.fillStyle(hexToInt(PAL.ink)).fillRect(lx + 1, top - 4, 7, 9).fillRect(lx, top - 3, 9, 7);
    g.fillStyle(hexToInt(PAL.wine)).fillRect(lx + 1, top - 3, 7, 7);
    g.fillStyle(hexToInt(PAL.red)).fillRect(lx + 1, top - 3, 5, 5);
    g.fillStyle(hexToInt(PAL.coral)).fillRect(lx + 2, top - 3, 2, 2);
    g.fillStyle(hexToInt(PAL.white)).fillRect(lx + 2, top - 2, 1, 1);
    // подсказка: стрелка вниз у рычага, бежит сверху вниз
    if (!this.pullAt && td >= DROP_MS) {
      const k = (now % 700) / 700;
      const ay = by + REELS_Y + 14 + Math.round(k * 22);
      const ax = lx - 10;
      g.fillStyle(hexToInt(PAL.ink)).fillRect(ax - 1, ay - 1, 9, 6);
      g.fillStyle(hexToInt(PAL.yellow)).fillRect(ax, ay, 7, 1).fillRect(ax + 1, ay + 1, 5, 1).fillRect(ax + 2, ay + 2, 3, 1).fillRect(ax + 3, ay + 3, 1, 1);
    }
  }

  destroy(): void {
    for (const { o } of this.objs) o.destroy();
    this.objs = [];
    this.g.destroy();
    this.warnG.destroy();
    this.warnT.destroy();
  }
}
