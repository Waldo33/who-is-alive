/**
 * Звук: Web Audio API, один AudioContext, разблокировка по первому тапу.
 * Эффекты синтезируются кодом (заглушка вместо ZzFX до этапа 7, интерфейс тот же: play(name)).
 * Музыка — короткий чиптюн-луп ~120 BPM, который резко обрывается на «Море волнуется».
 */
export type Sfx =
  | 'step' | 'hitPlayer' | 'hitBot' | 'poof' | 'starTake' | 'starSpawn' | 'crowd' | 'tick'
  | 'click' | 'ready' | 'accuseRight' | 'accuseWrong' | 'fanfare' | 'hedge' | 'pigeon' | 'drum' | 'denied' | 'count';

const STORAGE_KEY = 'kto:sound';

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  enabled = true;
  private musicOn = false;
  private musicTimer: number | null = null;
  private nextNoteTime = 0;
  private step = 0;

  constructor() {
    try {
      this.enabled = localStorage.getItem(STORAGE_KEY) !== 'off';
    } catch {
      this.enabled = true;
    }
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
    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? 0.5 : 0;
    this.master.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.32;
    this.musicGain.connect(this.master);
    const len = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    try {
      localStorage.setItem(STORAGE_KEY, this.enabled ? 'on' : 'off');
    } catch {
      /* приватный режим */
    }
    if (this.master) this.master.gain.value = this.enabled ? 0.5 : 0;
    if (this.enabled) this.unlock();
    return this.enabled;
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
    o.connect(g).connect(out ?? this.master);
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
    s.connect(f).connect(g).connect(out ?? this.master);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.02);
  }

  play(name: Sfx): void {
    if (!this.ctx || !this.enabled) return;
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
      case 'hedge': this.noise(0.4, 0.06, 600); break;
      case 'pigeon': for (let i = 0; i < 4; i++) this.noise(0.04, 0.12, 3000, i * 0.05); break;
      case 'drum': for (let i = 0; i < 14; i++) this.noise(0.05, 0.12 + i * 0.015, 300, i * 0.07); break;
      case 'denied': this.tone('square', 200, 160, 0.12, 0.15); break;
    }
  }

  // ───────────── музыка ─────────────

  private static BASS = [45, 45, 52, 45, 48, 48, 55, 48, 41, 41, 48, 41, 43, 43, 50, 47];
  private static LEAD = [69, 72, 76, 72, 72, 76, 79, 76, 65, 69, 72, 69, 67, 71, 74, 71];

  startMusic(): void {
    if (!this.ctx || !this.master || this.musicOn) return;
    this.musicOn = true;
    // новый узел громкости: остановка просто отключает старый, и уже запланированные ноты обрываются
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.32;
    this.musicGain.connect(this.master);
    this.nextNoteTime = this.ctx.currentTime + 0.05;
    this.step = 0;
    const schedule = () => {
      if (!this.ctx || !this.musicOn) return;
      const sixteenth = 60 / 120 / 4;
      while (this.nextNoteTime < this.ctx.currentTime + 0.12) {
        const s = this.step % 64;
        const when = this.nextNoteTime - this.ctx.currentTime;
        const bar = Math.floor(s / 16);
        const beat = s % 16;
        const mtf = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
        if (beat % 4 === 0) this.tone('square', mtf(Audio.BASS[bar * 4 + beat / 4]), mtf(Audio.BASS[bar * 4 + beat / 4]), 0.2, 0.18, when, this.musicGain!);
        if (beat % 2 === 0) {
          const n = Audio.LEAD[bar * 4 + ((beat / 2) % 4)];
          this.tone('triangle', mtf(n + (beat >= 8 ? 12 : 0)), mtf(n + (beat >= 8 ? 12 : 0)), 0.1, 0.09, when, this.musicGain!);
        }
        if (beat % 4 === 2) this.noise(0.03, 0.05, 6000, when, this.musicGain!);
        if (beat === 4 || beat === 12) this.noise(0.08, 0.1, 1200, when, this.musicGain!);
        this.nextNoteTime += sixteenth;
        this.step++;
      }
    };
    this.musicTimer = window.setInterval(schedule, 25);
    schedule();
  }

  stopMusic(): void {
    this.musicOn = false;
    if (this.musicTimer !== null) window.clearInterval(this.musicTimer);
    this.musicTimer = null;
    this.musicGain?.disconnect();
  }

  get musicPlaying(): boolean {
    return this.musicOn;
  }
}
