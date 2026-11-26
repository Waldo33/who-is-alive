import * as Phaser from 'phaser';
import { PAL, hexToInt } from '@kto/assets';
import type { ClientView, Dict, SlotEffect, SlotState, SlotSymbol } from '@kto/game-core';
import { SLOT_SYMBOLS, fmt, hasSlots, isLastLap } from '@kto/game-core';
import type { Sfx } from './audio';
import type { FontColor } from './font';
import {
  BODY_H, BODY_W, REELS_H, REELS_X, REELS_Y, REEL_GAP, REEL_W, SYM_W,
  makeSlotBackdrop, makeSlotBody, makeSlotStars, makeSlotSymbols,
} from './slot-art';

/**
 * Экран автомата «Казино» (game-core › slots.ts) поверх поля на весь дубль: сверху — полоса мест
 * (имена и звёзды всех игроков: стол публичный, а какая фигура чья — нет), посередине — автомат
 * с тремя барабанами, внизу (в панели сцены) — «Крутить» и «Пас».
 *
 * Состояние стола берётся из мира (`World.slot`), поэтому одинаково в песочнице и по сети.
 */

/** Барабаны: от броска до остановки каждого, мс (весь показ укладывается в cfg.slotSpinMs). */
const STOP_MS = [650, 1000, 1400];
const ROW = 26; // шаг символов на ленте барабана (символ ×2 = 24 + зазор)

export interface SlotHost {
  scene: Phaser.Scene;
  ay: number;
  txt: (x: number, y: number, s: string, color?: FontColor) => Phaser.GameObjects.BitmapText;
  t: Dict['slot'];
  play: (s: Sfx) => void;
  haptic: (k: 'select' | 'success' | 'error') => void;
}

/** Имя в строке автомата — до 6 знаков (i18n.test.ts проверяет строки с таким именем). */
function short(name: string): string {
  return name.length > 6 ? name.slice(0, 5) + '…' : name;
}

export class SlotScreen {
  private objs: Phaser.GameObjects.GameObject[] = [];
  private g: Phaser.GameObjects.Graphics;
  private reelsTex: Phaser.Textures.CanvasTexture;
  private symImg: HTMLCanvasElement;
  private title: Phaser.GameObjects.BitmapText;
  private turnT: Phaser.GameObjects.BitmapText;
  private line1: Phaser.GameObjects.BitmapText;
  private line2: Phaser.GameObjects.BitmapText;
  private line3: Phaser.GameObjects.BitmapText;
  private names: Phaser.GameObjects.BitmapText[] = [];
  private stars: Phaser.GameObjects.Image[][] = [];
  private shown = false;
  private lastTurn = -1;
  /** Своё вращение: когда начато, что выпадет (null — не крутил). */
  private spinAt = 0;
  private result: [SlotSymbol, SlotSymbol, SlotSymbol] = ['star', 'popcorn', 'camera'];
  private spinning = false;
  private revealed = true;
  private pending: SlotState | null = null;
  /** Выбор на этот круг уже сделан (номер круга) и какой. */
  private picked = -1;
  private pickedPull = false;
  private leverAt = 0;
  private flashSeat = new Map<number, number>();
  private bigFlash: { color: number; at: number } | null = null;
  private readonly bx = 20;
  private readonly by: number;

  constructor(private h: SlotHost) {
    const s = h.scene;
    const tex = s.textures;
    if (!tex.exists('slotbg')) tex.addCanvas('slotbg', makeSlotBackdrop());
    if (!tex.exists('slotbody')) tex.addCanvas('slotbody', makeSlotBody());
    if (!tex.exists('slotstars')) {
      const c = makeSlotStars();
      tex.addSpriteSheet('slotstars', c as unknown as HTMLImageElement, { frameWidth: 7, frameHeight: 7 });
    }
    this.symImg = makeSlotSymbols();
    const rw = REEL_W * 3 + REEL_GAP * 2;
    this.reelsTex = tex.exists('slotreels') ? (tex.get('slotreels') as Phaser.Textures.CanvasTexture) : tex.createCanvas('slotreels', rw, REELS_H)!;
    this.by = h.ay + 42;
    const D = 1050;
    const add = <T extends Phaser.GameObjects.GameObject>(o: T, d = D): T => {
      (o as unknown as { setDepth: (n: number) => void }).setDepth(d);
      this.objs.push(o);
      return o;
    };
    add(s.add.image(0, h.ay, 'slotbg').setOrigin(0, 0));
    add(s.add.image(this.bx, this.by, 'slotbody').setOrigin(0, 0), D + 1);
    add(s.add.image(this.bx + REELS_X, this.by + REELS_Y, 'slotreels').setOrigin(0, 0), D + 2);
    this.g = add(s.add.graphics(), D + 3);
    this.title = add(h.txt(90, this.by + 19, h.t.title, 'yellow').setOrigin(0.5, 0), D + 4);
    this.turnT = add(h.txt(90, this.by + 96, '', 'mist').setOrigin(0.5, 0), D + 4);
    this.line1 = add(h.txt(90, this.by + 108, '', 'white').setOrigin(0.5, 0), D + 4);
    this.line2 = add(h.txt(90, this.by + 120, '', 'yellow').setOrigin(0.5, 0), D + 4);
    this.line3 = add(h.txt(90, this.by + 132, '', 'sand').setOrigin(0.5, 0), D + 4);
    for (let i = 0; i < 4; i++) {
      const x = i % 2 ? 92 : 4;
      const y = h.ay + 5 + Math.floor(i / 2) * 17;
      this.names.push(add(h.txt(x + 3, y, '', 'white'), D + 4));
      this.stars.push([0, 1, 2].map((k) => add(s.add.image(x + 60 + k * 8, y + 1, 'slotstars', 0).setOrigin(0, 0), D + 4)));
    }
    this.setVisible(false);
    this.drawReels(performance.now());
  }

  get visible(): boolean {
    return this.shown;
  }

  private setVisible(on: boolean): void {
    if (on === this.shown && this.objs[0] && (this.objs[0] as Phaser.GameObjects.Image).visible === on) return;
    this.shown = on;
    for (const o of this.objs) (o as unknown as { setVisible: (v: boolean) => void }).setVisible(on);
  }

  private seatOf(v: ClientView): number {
    return v.players.findIndex((p) => p.pid === v.selfPid);
  }

  /** Можно ли сейчас выбрать «Крутить» / «Пас». */
  canChoose(v: ClientView): boolean {
    const st = v.world.slot;
    const seat = this.seatOf(v);
    if (!this.shown || !st || st.over || seat < 0 || this.picked === st.turn) return false;
    const me = st.seats[seat];
    return !!me && me.alive && me.skip === 0 && v.world.time >= st.openAt;
  }

  pick(v: ClientView, pull: boolean): boolean {
    const st = v.world.slot;
    if (!st || !this.canChoose(v)) return false;
    this.picked = st.turn;
    this.pickedPull = pull;
    if (pull) {
      this.leverAt = performance.now();
      this.h.play('swing');
    }
    return true;
  }

  update(v: ClientView): void {
    const on = hasSlots(v.theme) && v.phase === 'play' && !!v.world.slot;
    this.setVisible(on);
    if (!on) {
      this.lastTurn = -1;
      this.picked = -1;
      return;
    }
    const st = v.world.slot!;
    const now = performance.now();
    if (st.turn !== this.lastTurn) this.onTurn(v, st, now);
    if (this.spinning && now - this.spinAt >= STOP_MS[2]) this.spinning = false;
    // остановка барабана — щелчок
    if (this.spinning) for (const ms of STOP_MS) if (now - this.spinAt >= ms && now - this.spinAt < ms + 17) this.h.play('tick');
    if (!this.spinning && !this.revealed && this.pending) this.reveal(v, this.pending);
    this.drawReels(now);
    this.drawStrip(v, st, now);
    this.drawInfo(v, st, now);
  }

  private onTurn(v: ClientView, st: SlotState, now: number): void {
    const first = this.lastTurn < 0;
    this.lastTurn = st.turn;
    const seat = this.seatOf(v);
    const mine = seat >= 0 ? st.spins[seat] : null;
    this.pending = st;
    this.revealed = false;
    if (first && st.turn > 0) {
      // вошли посреди дубля (переподключение): без анимации
      if (mine) this.result = [...mine.reels];
      this.spinning = false;
      return;
    }
    if (mine) {
      this.result = [...mine.reels];
      this.spinAt = now;
      this.spinning = true;
    } else {
      this.spinning = false;
      this.spinAt = now - STOP_MS[2];
    }
  }

  /** Барабаны остановились — показать, что выпало у себя и у других. */
  private reveal(v: ClientView, st: SlotState): void {
    this.revealed = true;
    const seat = this.seatOf(v);
    const t = this.h.t;
    const name = (i: number) => short(v.players[i]?.name ?? '?');
    let main = '';
    let mainColor: FontColor = 'yellow';
    let other = '';
    let sfx: Sfx | null = null;
    const mine = seat >= 0 ? st.spins[seat] : null;
    if (mine?.outcome === 'tease') {
      main = t.tease;
      mainColor = 'mist';
      sfx = 'denied';
    } else if (mine?.outcome === 'miss') {
      main = t.miss;
      mainColor = 'mist';
    }
    const now = performance.now();
    for (const ef of st.effects as SlotEffect[]) {
      const me = ef.seat === seat;
      if (ef.k === 'star' || ef.k === 'half') this.flashSeat.set(ef.seat, now);
      switch (ef.k) {
        case 'star':
          if (me) [main, mainColor, sfx] = [t.jackpot, 'yellow', 'starTake'];
          else other = fmt(t.otherStar, { name: name(ef.seat) });
          if (me) this.bigFlash = { color: hexToInt(PAL.yellow), at: now };
          break;
        case 'half':
          if (me) [main, mainColor, sfx] = [t.half, 'amber', 'starSpawn'];
          break;
        case 'mask':
          if (me) [main, mainColor, sfx] = [t.mask, 'blue', 'ready'];
          break;
        case 'saved':
          if (me) [main, mainColor, sfx] = [t.saved, 'blue', 'unmask'];
          break;
        case 'clap':
          if (me) [main, mainColor, sfx] = [t.clap, 'amber', 'clap'];
          break;
        case 'spot':
          if (me) [main, mainColor, sfx] = [fmt(t.spot, { name: name(ef.target) }), 'amber', 'flicker'];
          else if (ef.target === seat) [main, mainColor, sfx] = [t.spotMe, 'coral', 'flicker'];
          break;
        case 'steal':
          if (me) [main, mainColor, sfx] = [fmt(t.steal, { name: name(ef.from) }), 'amber', 'starSpawn'];
          else if (ef.from === seat) [main, mainColor, sfx] = [t.stolen, 'coral', 'hitOther'];
          break;
        case 'reel':
          if (me) [main, mainColor, sfx] = [t.reel, 'mist', 'rewind'];
          break;
        case 'cut':
          this.flashSeat.set(ef.seat, now);
          if (me) {
            [main, mainColor, sfx] = [t.cut, 'red', 'cut'];
            this.bigFlash = { color: hexToInt(PAL.red), at: now };
            this.h.haptic('error');
          } else other = fmt(t.otherCut, { name: name(ef.seat) });
          break;
        case 'burn':
          if (me) [main, mainColor, sfx] = [t.burn, 'coral', 'sad'];
          break;
      }
    }
    if (st.over) {
      const w = st.over.winners;
      if (w.includes(seat)) [main, mainColor, sfx] = [t.win, 'yellow', 'fanfare'];
      else if (w.length && st.over.reason === 'stars') other = fmt(t.otherWin, { name: name(w[0]) });
    }
    this.line2.setText(main).setFont('px-' + mainColor);
    this.line3.setText(other);
    if (sfx) this.h.play(sfx);
    if (sfx === 'starTake' || sfx === 'fanfare') this.h.haptic('success');
  }

  private drawReels(now: number): void {
    const c = this.reelsTex.getContext();
    c.imageSmoothingEnabled = false;
    const rw = REEL_W * 3 + REEL_GAP * 2;
    c.fillStyle = PAL.ink;
    c.fillRect(0, 0, rw, REELS_H);
    const dt = now - this.spinAt;
    for (let r = 0; r < 3; r++) {
      const x0 = r * (REEL_W + REEL_GAP);
      c.fillStyle = PAL.white;
      c.fillRect(x0, 0, REEL_W, REELS_H);
      c.fillStyle = PAL.mist;
      c.fillRect(x0, 0, REEL_W, 3);
      c.fillRect(x0, REELS_H - 3, REEL_W, 3);
      const running = this.spinning && dt < STOP_MS[r];
      // лента: свой порядок символов у каждого барабана; при остановке в центре — итог
      const off = running ? Math.floor(dt * 0.32) % (ROW * SLOT_SYMBOLS.length) : 0;
      const centerIdx = SLOT_SYMBOLS.indexOf(this.result[r]);
      for (let k = running ? -2 : 0; k <= (running ? 2 : 0); k++) {
        const idx = running
          ? (((Math.floor(off / ROW) - k + r * 3) % SLOT_SYMBOLS.length) + SLOT_SYMBOLS.length) % SLOT_SYMBOLS.length
          : k === 0 ? centerIdx : (centerIdx + k * 3 + r + 8) % SLOT_SYMBOLS.length;
        const y = Math.round(REELS_H / 2 - SYM_W + k * ROW + (running ? off % ROW : 0));
        c.drawImage(this.symImg, idx * SYM_W, 0, SYM_W, SYM_W, x0 + (REEL_W - SYM_W * 2) / 2, y, SYM_W * 2, SYM_W * 2);
      }
      // тень по краям — барабан круглый
      c.fillStyle = PAL.ink;
      for (let y = 0; y < 5; y++) for (let x = (y % 2); x < REEL_W; x += 2) {
        c.fillRect(x0 + x, y, 1, 1);
        c.fillRect(x0 + x, REELS_H - 1 - y, 1, 1);
      }
    }
    this.reelsTex.refresh();
  }

  private drawStrip(v: ClientView, st: SlotState, now: number): void {
    const g = this.g;
    g.clear();
    const seat = this.seatOf(v);
    for (let i = 0; i < 4; i++) {
      const s = st.seats[i];
      const n = this.names[i];
      const x = i % 2 ? 92 : 4;
      const y = this.h.ay + 3 + Math.floor(i / 2) * 17;
      if (!s) {
        n.setText('');
        this.stars[i].forEach((im) => im.setVisible(false));
        continue;
      }
      const fl = this.flashSeat.get(i);
      const flashing = fl !== undefined && now - fl < 1200 && Math.floor((now - fl) / 150) % 2 === 0;
      g.fillStyle(hexToInt(PAL.ink)).fillRect(x, y, 84, 15);
      g.fillStyle(hexToInt(flashing ? PAL.grape : i === seat ? PAL.dusk : PAL.night)).fillRect(x + 1, y + 1, 82, 13);
      if (i === seat) g.fillStyle(hexToInt(PAL.amber)).fillRect(x + 1, y + 1, 82, 1);
      const name = short(v.players[i]?.name ?? '?');
      n.setText(name).setFont(s.alive ? 'px-white' : 'px-mist');
      this.stars[i].forEach((im, k) => {
        const h = s.halves - k * 2;
        im.setVisible(s.alive).setFrame(h >= 2 ? 2 : h === 1 ? 1 : 0);
      });
      if (!s.alive) {
        // вырезан: имя перечёркнуто, череп вместо звёзд
        g.fillStyle(hexToInt(PAL.coral)).fillRect(x + 3, y + 8, n.width, 1);
        this.drawSym(g, 'skull', x + 64, y + 2);
      } else {
        // метки: маска, прожектор, плёнка
        let mx = x + 52;
        if (s.mask) {
          this.dot(g, mx, y + 4, PAL.amber);
          mx -= 4;
        }
        if (s.spot) {
          this.dot(g, mx, y + 4, PAL.yellow);
          mx -= 4;
        }
        if (s.skip > 0) this.dot(g, mx, y + 4, PAL.steel);
      }
    }
  }

  private dot(g: Phaser.GameObjects.Graphics, x: number, y: number, c: string): void {
    g.fillStyle(hexToInt(PAL.ink)).fillRect(x - 1, y - 1, 4, 4);
    g.fillStyle(hexToInt(c)).fillRect(x, y, 2, 2);
  }

  /** Маленький символ 6×6 (каждый второй пиксель символа) — для полосы мест. */
  private drawSym(g: Phaser.GameObjects.Graphics, s: SlotSymbol, x: number, y: number): void {
    const ctx = this.symImg.getContext('2d')!;
    const i = SLOT_SYMBOLS.indexOf(s);
    const data = ctx.getImageData(i * SYM_W, 0, SYM_W, SYM_W).data;
    for (let yy = 0; yy < SYM_W; yy += 2) for (let xx = 0; xx < SYM_W; xx += 2) {
      const p = (yy * SYM_W + xx) * 4;
      if (data[p + 3] < 128) continue;
      g.fillStyle((data[p] << 16) | (data[p + 1] << 8) | data[p + 2]).fillRect(x + xx / 2, y + yy / 2, 1, 1);
    }
  }

  private drawInfo(v: ClientView, st: SlotState, now: number): void {
    const g = this.g;
    const t = this.h.t;
    const cfg = v.cfg;
    const seat = this.seatOf(v);
    const me = seat >= 0 ? st.seats[seat] : undefined;
    const bx = this.bx;
    const by = this.by;
    // лампочки вывески бегут по кругу; на «Последнем круге» — красные и быстрее
    const last = isLastLap(cfg, st.turn) && !st.over;
    const step = Math.floor(now / (last ? 90 : 160));
    for (let k = 0; k < 18; k++) {
      const a = Math.PI + (k / 17) * Math.PI;
      const x = Math.round(bx + BODY_W / 2 + Math.cos(a) * 63);
      const y = Math.round(by + 16 + Math.sin(a) * 12);
      const lit = (k + step) % 3 === 0;
      g.fillStyle(hexToInt(lit ? (last ? PAL.red : PAL.yellow) : PAL.umber)).fillRect(x, y, 2, 2);
    }
    // рычаг справа: дёрнули — опускается и возвращается
    const lk = Math.min(1, (now - this.leverAt) / 450);
    const down = lk < 1 ? Math.sin(lk * Math.PI) : 0;
    const lx = bx + BODY_W + 2;
    const top = by + 46 + Math.round(down * 30);
    g.fillStyle(hexToInt(PAL.ink)).fillRect(lx, by + 78, 9, 14);
    g.fillStyle(hexToInt(PAL.steel)).fillRect(lx + 1, by + 79, 7, 12);
    g.fillStyle(hexToInt(PAL.ink)).fillRect(lx + 3, Math.min(top, by + 80), 3, Math.abs(by + 82 - top) + 1);
    g.fillStyle(hexToInt(PAL.mist)).fillRect(lx + 4, Math.min(top, by + 80), 1, Math.abs(by + 82 - top));
    g.fillStyle(hexToInt(PAL.ink)).fillCircle(lx + 4, top, 4);
    g.fillStyle(hexToInt(PAL.red)).fillCircle(lx + 4, top, 3);
    g.fillStyle(hexToInt(PAL.coral)).fillRect(lx + 3, top - 2, 1, 1);

    const turnN = Math.min(cfg.slotTurns, st.turn + 1);
    const turnS = last ? t.lastLap : fmt(t.turn, { n: turnN, m: cfg.slotTurns });
    this.turnT.setText(turnS).setFont(last ? 'px-coral' : 'px-mist');
    let l1 = '';
    let l1c: FontColor = 'white';
    const wt = v.world.time;
    if (st.over) l1 = '';
    else if (!me) l1 = '';
    else if (!me.alive) [l1, l1c] = [t.outSub, 'mist'];
    else if (this.spinning || wt < st.openAt) l1 = '';
    else if (me.skip > 0) [l1, l1c] = [t.skip, 'mist'];
    else if (this.picked === st.turn) [l1, l1c] = [this.pickedPull ? t.wait : t.passed, 'mist'];
    else [l1, l1c] = [t.choose, 'white'];
    this.line1.setText(l1).setFont('px-' + l1c);
    // полоска времени на выбор
    if (me?.alive && !st.over && wt >= st.openAt && this.picked !== st.turn && me.skip === 0) {
      const k = Math.max(0, Math.min(1, (st.deadline - wt) / Math.max(1, st.deadline - st.openAt)));
      const w = Math.round(110 * k);
      g.fillStyle(hexToInt(PAL.ink)).fillRect(35, by + 145, 110, 4);
      g.fillStyle(hexToInt(k < 0.3 ? PAL.coral : PAL.amber)).fillRect(35, by + 146, w, 2);
    }
    // свои метки на панели автомата: маска, хлопушка, прожектор
    if (me?.alive) {
      const marks: SlotSymbol[] = [];
      if (me.mask) marks.push('mask');
      if (me.clap) marks.push('clap');
      if (me.spot) marks.push('spot');
      marks.forEach((m, i) => this.drawSym(g, m, bx + 12 + i * 8, by + 95));
    }
    // вырезан: автомат гаснет
    if (me && !me.alive && !this.spinning) {
      g.fillStyle(hexToInt(PAL.ink), 0.55).fillRect(bx + REELS_X, by + REELS_Y, REEL_W * 3 + REEL_GAP * 2, REELS_H);
      if (!this.line2.text) this.line2.setText(t.out).setFont('px-red');
    }
    // вспышка экрана: джекпот — золотом, череп — красным
    const f = this.bigFlash;
    if (f && now - f.at < 600) {
      const a = 0.45 * (1 - (now - f.at) / 600);
      g.fillStyle(f.color, a).fillRect(0, this.h.ay, 180, 260);
    }
    void BODY_H;
  }

  destroy(): void {
    for (const o of this.objs) o.destroy();
    this.objs = [];
  }
}
