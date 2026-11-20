import { Music } from './music';
import { themePack } from './themes';
import type { MusicMode } from './music';

/**
 * Звук: Web Audio API, один AudioContext на всё приложение (getAudio), разблокировка по первому тапу.
 * Эффекты синтезируются кодом; музыка — секвенсор из music.ts (тема, вариации, напряжение, меню).
 * Музыку и эффекты можно выключать по отдельности.
 */
export type Sfx =
  | 'step' | 'hitPlayer' | 'hitBot' | 'poof' | 'starTake' | 'starSpawn' | 'crowd' | 'tick'
  | 'click' | 'ready' | 'accuseRight' | 'accuseWrong' | 'fanfare' | 'sad' | 'hedge' | 'pigeon' | 'drum' | 'denied' | 'count' | 'swing' | 'flicker';

const STORAGE_KEY = 'kto:sound';
const MUSIC_KEY = 'kto:music';

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* приватный режим */
  }
}

let shared: Audio | null = null;
/** Один звук на всё приложение: музыка меню не обрывается при переходе между экранами. */
export function getAudio(): Audio {
  shared ??= new Audio();
  return shared;
}

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private duck: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private music: Music | null = null;
  private twist = false;
  /** Звуки игры (эффекты). */
  enabled = true;
  /** Музыка. */
  musicEnabled = true;
  /** Какая музыка должна звучать сейчас (играет, если музыка включена и звук разблокирован). */
  private want: { mode: MusicMode; theme: number } = { mode: 'off', theme: 0 };

  constructor() {
    this.enabled = stored(STORAGE_KEY) !== 'off';
    const m = stored(MUSIC_KEY);
    // раньше был один переключатель: выключенный звук выключает и музыку
    this.musicEnabled = m ? m !== 'off' : this.enabled;
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend().catch(() => undefined);
      else if (this.enabled) void this.ctx.resume().catch(() => undefined);
    });
    // iOS разрешает запуск звука только из «настоящего» жеста: touchend или click, но не touchstart
    // (а ввод Phaser идёт по touchstart). После блокировки экрана, звонка или ухода в другое
    // приложение контекст встаёт в suspended/interrupted, и вернуть его можно только так же.
    const onGesture = () => this.unlock();
    for (const ev of ['touchend', 'click', 'pointerup', 'keydown']) {
      document.addEventListener(ev, onGesture, { capture: true, passive: true });
    }
  }

  /** Состояние контекста: 'running' — звук идёт. Для отладки и подсказок. */
  get state(): string {
    return this.ctx?.state ?? 'none';
  }

  /** Вызывать из обработчика тапа. Безопасно вызывать сколько угодно раз. */
  unlock(): void {
    if (this.ctx && this.ctx.state === 'closed') this.ctx = null; // iOS иногда закрывает контекст после долгого фона
    if (this.ctx) {
      // 'suspended' и iOS-овый 'interrupted' — оба лечатся resume() из жеста
      if (this.ctx.state !== 'running' && this.enabled) void this.ctx.resume().catch(() => undefined);
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    // общий выравниватель: на динамике телефона ничего не хрипит, когда всё звучит разом
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.connect(this.ctx.destination);
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(comp);
    this.sfx = this.ctx.createGain();
    this.sfx.gain.value = this.enabled ? 1 : 0;
    this.sfx.connect(this.master);
    this.duck = this.ctx.createGain();
    this.duck.connect(this.master);
    const len = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.music = new Music(this.ctx, this.duck, this.noiseBuf);
    this.apply();
  }

  /** Эффекты вкл/выкл. */
  setSfxEnabled(on: boolean): void {
    this.enabled = on;
    store(STORAGE_KEY, on ? 'on' : 'off');
    if (this.sfx) this.sfx.gain.value = on ? 1 : 0;
    if (on) this.unlock();
  }

  /** Музыка вкл/выкл (эффекты не трогает). */
  setMusicEnabled(on: boolean): void {
    this.musicEnabled = on;
    store(MUSIC_KEY, on ? 'on' : 'off');
    if (on) this.unlock();
    this.apply(true);
  }

  /** Старая кнопка «звук» (автономная песочница): выключает и включает всё сразу. */
  toggle(): boolean {
    const on = !(this.enabled || this.musicEnabled);
    this.setSfxEnabled(on);
    this.setMusicEnabled(on);
    return on;
  }

  /**
   * Какая музыка нужна сейчас. Повторный вызов с тем же режимом и темой не перезапускает песню
   * (музыка меню течёт через переходы между экранами); restart — начать заново (новый раунд).
   */
  setMusic(mode: MusicMode, theme = 0, restart = false): void {
    const same = this.want.mode === mode && this.want.theme === theme;
    this.want = { mode, theme };
    this.apply(restart || !same);
  }

  private apply(force = false): void {
    const m = this.music;
    if (!m || !this.ctx) return;
    const { mode, theme } = this.want;
    if (!this.musicEnabled || mode === 'off') {
      m.stop();
      return;
    }
    if (force || m.mode !== mode || (!m.running && !m.paused)) {
      m.start(mode, themePack(theme).music);
      m.setTwist(this.twist);
    }
  }

  /** Изнанка темы (офис → подвал): песня темы меняет подачу. */
  setTwist(on: boolean): void {
    this.twist = on;
    this.music?.setTwist(on);
  }

  /** «Море волнуется»: оборвать музыку (зажёванная плёнка). */
  cutMusic(): void {
    this.music?.tapeStop();
  }

  /** Продолжить после паузы с того же места песни. */
  resumeMusic(): void {
    if (this.musicEnabled) this.music?.resume();
  }

  /** Напряжение раунда 0–2. */
  setIntensity(level: number): void {
    this.music?.setIntensity(level);
  }

  /** Важный звук — музыку на миг приглушить, чтобы его было слышно. */
  private duckMusic(): void {
    const ctx = this.ctx;
    const g = this.duck?.gain;
    if (!ctx || !g) return;
    const t = ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.45, t);
    g.linearRampToValueAtTime(1, t + 0.45);
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, when = 0, out?: AudioNode): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out ?? this.sfx!);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noise(dur: number, vol: number, freq: number, when = 0, out?: AudioNode): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noiseBuf) return;
    const t = ctx.currentTime + when;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(out ?? this.sfx!);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.02);
  }

  play(name: Sfx): void {
    if (!this.ctx || !this.enabled) return;
    if (name === 'hitPlayer' || name === 'hitBot' || name === 'starTake' || name === 'accuseRight' || name === 'accuseWrong') this.duckMusic();
    switch (name) {
      case 'step': this.noise(0.03, 0.05, 1800); break;
      case 'hitPlayer': this.noise(0.18, 0.5, 900); this.tone('square', 420, 60, 0.25, 0.25); break;
      case 'hitBot': this.tone('square', 300, 520, 0.08, 0.2); this.tone('square', 520, 90, 0.35, 0.2, 0.08); break;
      case 'poof': this.noise(0.3, 0.3, 2400); break;
      case 'starTake': [660, 880, 1320].forEach((f, i) => this.tone('square', f, f, 0.08, 0.16, i * 0.06)); break;
      case 'starSpawn': this.tone('triangle', 1200, 1800, 0.12, 0.12); this.tone('triangle', 1800, 2400, 0.1, 0.08, 0.08); break;
      case 'crowd': this.tone('square', 880, 880, 0.12, 0.25); this.tone('square', 660, 660, 0.18, 0.25, 0.14); break;
      case 'tick': this.tone('square', 1500, 1500, 0.03, 0.12); break;
      case 'count': this.tone('square', 520, 520, 0.12, 0.2); break;
      case 'click': this.tone('square', 900, 700, 0.05, 0.12); break;
      case 'ready': this.tone('square', 520, 520, 0.07, 0.15); this.tone('square', 780, 780, 0.1, 0.15, 0.08); break;
      case 'accuseRight': [523, 659, 784].forEach((f, i) => this.tone('triangle', f, f, 0.25, 0.2, i * 0.07)); break;
      case 'accuseWrong': this.tone('sawtooth', 220, 110, 0.4, 0.18); this.tone('sawtooth', 233, 100, 0.4, 0.12); break;
      case 'fanfare': [523, 659, 784, 1047, 784, 1047].forEach((f, i) => this.tone('square', f, f, 0.16, 0.16, i * 0.12)); break;
      // «Слишком живые!» — грустный тромбон: три ступени вниз и долгая нота с вибрато
      case 'sad': [392, 370, 349].forEach((f, i) => this.tone('sawtooth', f, f * 0.98, 0.32, 0.12, i * 0.36)); this.sadTail(1.08); break;
      case 'hedge': this.noise(0.4, 0.06, 600); break;
      case 'pigeon': for (let i = 0; i < 4; i++) this.noise(0.04, 0.12, 3000, i * 0.05); break;
      case 'drum': for (let i = 0; i < 14; i++) this.noise(0.05, 0.12 + i * 0.015, 300, i * 0.07); break;
      case 'denied': this.tone('square', 200, 160, 0.12, 0.15); break;
      // замах: короткий свист — звучит сразу по нажатию, итог удара приходит следом
      case 'swing': this.noise(0.07, 0.2, 1500); this.noise(0.06, 0.12, 3400, 0.03); break;
      // свет мигает: щелчки выключателя и гудение лампы
      case 'flicker': [0, 0.09, 0.2].forEach((d) => this.noise(0.03, 0.22, 2600, d)); this.tone('sawtooth', 100, 100, 0.35, 0.05, 0.05); break;
    }
  }

  private sadTail(when: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfx) return;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(330, t);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 6;
    const depth = ctx.createGain();
    depth.gain.value = 9;
    lfo.connect(depth).connect(o.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    o.connect(g).connect(this.sfx);
    o.start(t);
    lfo.start(t);
    o.stop(t + 1.15);
    lfo.stop(t + 1.15);
  }

  // ───────────── совместимость со старыми вызовами ─────────────

  startMusic(): void {
    this.setMusic('play', this.want.theme);
  }

  stopMusic(): void {
    this.setMusic('off');
  }

  get musicPlaying(): boolean {
    return !!this.music?.running;
  }
}
