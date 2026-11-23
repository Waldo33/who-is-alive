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
  | 'click' | 'ready' | 'accuseRight' | 'accuseWrong' | 'fanfare' | 'sad' | 'hedge' | 'pigeon' | 'drum' | 'denied' | 'count' | 'swing' | 'flicker' | 'dusk' | 'siren' | 'whack' | 'clang' | 'stab' | 'knockedOut'
  | 'hitOther' | 'cut';

/**
 * Приоритет эффекта (звуковой гайд, план звука): P1 — меняет решение игрока, обязан пробиться
 * через музыку (на динамике телефона −30…−33 дБ, музыку глушит на 9 дБ на 0,6 с); P2 — событие
 * на поле (−35…−39 дБ, глушит на 4 дБ); остальное — фон. Уровни проверяет `pnpm --filter web sound-check`.
 */
const P1: ReadonlySet<Sfx> = new Set<Sfx>(['hitPlayer', 'hitBot', 'starTake', 'crowd', 'ready', 'knockedOut', 'cut', 'drum', 'accuseRight', 'accuseWrong']);
const P2: ReadonlySet<Sfx> = new Set<Sfx>(['hitOther', 'whack', 'clang', 'stab', 'starSpawn', 'flicker', 'dusk']);

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

/** Подъём громкости звука клипа после компрессора. */
const CLIP_GAIN = 2.5;

/** Звук клипа: музыка темы и эффекты в отдельный поток для записи (Audio.clipSound). */
export interface ClipSound {
  stream: MediaStream;
  start(theme: number, twist: boolean): void;
  setTwist(on: boolean, smooth?: boolean): void;
  pause(): void;
  resume(): void;
  play(name: Sfx): void;
  fadeOut(sec: number): void;
  stop(): void;
}

let shared: Audio | null = null;
/** Один звук на всё приложение: музыка меню не обрывается при переходе между экранами. */
export function getAudio(): Audio {
  shared ??= new Audio();
  return shared;
}

/**
 * Громкость музыки относительно эффектов: ×3 (+9,5 дБ). При ×1 музыка в дубле шла на 8 дБ тише
 * эффектов (−47 дБ RMS против −38), в меню — около −49 дБ: на динамике телефона её почти не было
 * слышно (жалоба владельца, 23.11.2026). Пики в дубле остаются ниже −12 дБ. Клип пишет свою смесь.
 */
export const MUSIC_GAIN = 3;

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private duck: GainNode | null = null;
  /** Музыка «как из-под воды» после удара по голове. */
  private muffle: BiquadFilterNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private music: Music | null = null;
  private twist = false;
  /** Куда идут эффекты при записи клипа (иначе — в обычный канал эффектов). */
  private route: AudioNode | null = null;
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
      // вернуться из фона, если играет хоть что-то: музыка без эффектов тоже должна вернуться
      else if (this.enabled || this.musicEnabled) void this.ctx.resume().catch(() => undefined);
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
      if (this.ctx.state !== 'running' && (this.enabled || this.musicEnabled)) void this.ctx.resume().catch(() => undefined);
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
    this.muffle = this.ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.duck.connect(this.muffle).connect(this.master);
    const len = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // музыка отдельной шиной громче эффектов (просьба владельца: «тихо»); выравниватель держит пики
    const musicBus = this.ctx.createGain();
    musicBus.gain.value = MUSIC_GAIN;
    musicBus.connect(this.duck);
    this.music = new Music(this.ctx, musicBus, this.noiseBuf);
    // WebKit (iPhone, Telegram) создаёт контекст из жеста приостановленным: запустить в этом же
    // касании и сыграть пустой звук — иначе музыка меню заиграет только со второго касания,
    // а им обычно бывает «Играть»
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => undefined);
    const blip = this.ctx.createBufferSource();
    blip.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    blip.connect(this.ctx.destination);
    blip.start();
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
  setTwist(on: boolean, smooth = false): void {
    this.twist = on;
    this.music?.setTwist(on, smooth);
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

  /** Сотрясение: музыка глохнет и «уходит под воду», потом постепенно возвращается. */
  private concuss(): void {
    const ctx = this.ctx;
    if (!ctx || !this.duck || !this.muffle) return;
    const t = ctx.currentTime;
    const g = this.duck.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.15, t);
    g.linearRampToValueAtTime(1, t + 2.8);
    const f = this.muffle.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(260, t);
    f.setValueAtTime(260, t + 0.6);
    f.exponentialRampToValueAtTime(20000, t + 3.2);
  }

  /** Важный звук — музыку на миг приглушить до level, чтобы его было слышно. */
  private duckMusic(level: number, sec: number): void {
    const ctx = this.ctx;
    const g = this.duck?.gain;
    if (!ctx || !g) return;
    const t = ctx.currentTime;
    // уже приглушено сильнее (сотрясение, «вырезан») — не поднимать
    if (g.value < level) return;
    g.cancelScheduledValues(t);
    g.setValueAtTime(level, t);
    g.setValueAtTime(level, t + sec * 0.4);
    g.linearRampToValueAtTime(1, t + sec);
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
    o.connect(g).connect(out ?? this.route ?? this.sfx!);
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
    s.connect(f).connect(g).connect(out ?? this.route ?? this.sfx!);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.02);
  }

  /**
   * Сыграть эффект. step — ступень для звуков с нарастанием: звезда (1-я, 2-я, 3-я своя —
   * каждая на тон выше).
   */
  play(name: Sfx, step = 0): void {
    if (!this.ctx || !this.enabled) return;
    if (name === 'knockedOut') this.concuss();
    else if (name === 'cut') this.cutOut();
    else if (P1.has(name)) this.duckMusic(0.355, 0.6);
    else if (P2.has(name)) this.duckMusic(0.63, 0.4);
    this.sfxNow(name, step);
  }

  /**
   * Сыграть эффект в текущий канал (обычный или канал клипа — `route`).
   * Телефон не играет ниже ~350 Гц: всё важное звучит обертонами 1–5 кГц, бас — только опора.
   */
  private sfxNow(name: Sfx, step = 0): void {
    switch (name) {
      case 'step': this.noise(0.03, 0.05, 1800); break;
      // ты выбил живого — самый яркий звук игры: треск, удар и мажорная квинта вверх
      case 'hitPlayer':
        this.noise(0.035, 1, 3800);
        this.noise(0.14, 0.75, 1400);
        this.tone('square', 520, 140, 0.16, 0.3);
        this.tone('square', 1047, 1047, 0.1, 0.3, 0.05);
        this.tone('square', 1568, 1568, 0.26, 0.3, 0.14);
        this.tone('triangle', 3136, 3136, 0.22, 0.15, 0.14);
        break;
      // чужой удар по живому: тот же треск и удар, но без мажора — событие, не награда
      case 'hitOther':
        this.noise(0.03, 0.9, 3400);
        this.noise(0.18, 0.8, 1200);
        this.tone('square', 480, 120, 0.24, 0.3);
        break;
      // ударил бота: нисходящее «бум» и глухой зуммер — смешно, не тревожно
      case 'hitBot':
        this.tone('square', 760, 220, 0.3, 0.36);
        this.tone('sawtooth', 156, 150, 0.32, 0.16, 0.08);
        this.tone('square', 466, 456, 0.3, 0.1, 0.08);
        break;
      case 'poof': this.noise(0.3, 0.3, 2400); break;
      // ночь Майами: бита — треск дерева, труба — звон металла, нож — свист и тычок;
      // бас — опора, слышно на телефоне то, что сверху
      case 'whack':
        this.noise(0.05, 1, 2600);
        this.noise(0.12, 1, 1100);
        this.tone('square', 760, 340, 0.1, 0.5);
        this.tone('triangle', 1520, 900, 0.06, 0.2);
        this.tone('sine', 170, 50, 0.16, 0.25);
        break;
      case 'clang':
        this.noise(0.05, 0.6, 3600);
        [1180, 1770, 2360, 3540].forEach((f, i) => this.tone('square', f, f * 0.97, 0.42 - i * 0.08, 0.17 - i * 0.025));
        this.tone('sine', 140, 60, 0.12, 0.35);
        break;
      case 'stab':
        this.noise(0.12, 0.7, 4600);
        this.noise(0.08, 0.9, 1300, 0.06);
        this.tone('square', 520, 200, 0.08, 0.28, 0.06);
        this.tone('sine', 120, 70, 0.08, 0.25, 0.06);
        break;
      // звезда: арпеджио вверх; своя — каждая следующая на тон выше
      case 'starTake': {
        const k = Math.pow(2, (Math.max(1, step) - 1) * 2 / 12);
        [784, 1047, 1568].forEach((f, i) => {
          this.tone('square', f * k, f * k, 0.09, 0.22, i * 0.055);
          this.tone('triangle', f * k * 2, f * k * 2, 0.08, 0.08, i * 0.055);
        });
        break;
      }
      // звезда появилась: звоночек сверху, музыку не перебивает
      case 'starSpawn': this.tone('sine', 2093, 2093, 0.18, 0.22); this.tone('triangle', 3136, 3136, 0.14, 0.12, 0.06); break;
      case 'crowd': this.tone('square', 880, 880, 0.12, 0.28); this.tone('square', 660, 660, 0.18, 0.28, 0.14); break;
      case 'tick': this.tone('square', 1500, 1500, 0.03, 0.12); break;
      case 'count': this.tone('square', 520, 520, 0.12, 0.2); break;
      case 'click': this.tone('square', 900, 700, 0.05, 0.12); break;
      // старт дубля: хлопушка (щелчок и деревянный резонанс) и два сигнала
      case 'ready':
        this.clapper();
        this.tone('square', 784, 784, 0.08, 0.3, 0.12);
        this.tone('square', 1175, 1175, 0.16, 0.32, 0.2);
        break;
      case 'accuseRight': [523, 659, 784].forEach((f, i) => this.tone('triangle', f, f, 0.25, 0.2, i * 0.07)); break;
      case 'accuseWrong': this.tone('sawtooth', 220, 110, 0.4, 0.18); this.tone('sawtooth', 233, 100, 0.4, 0.12); break;
      case 'fanfare': [523, 659, 784, 1047, 784, 1047].forEach((f, i) => this.tone('square', f, f, 0.16, 0.16, i * 0.12)); break;
      // «Слишком живые!» — грустный тромбон: три ступени вниз и долгая нота с вибрато
      case 'sad': [392, 370, 349].forEach((f, i) => this.tone('sawtooth', f, f * 0.98, 0.32, 0.12, i * 0.36)); this.sadTail(1.08); break;
      case 'hedge': this.noise(0.4, 0.06, 600); break;
      case 'pigeon': for (let i = 0; i < 4; i++) this.noise(0.04, 0.12, 3000, i * 0.05); break;
      // разоблачение: дробь малого с треском пружин, нарастает (слышно и на телефоне — 2–6 кГц)
      case 'drum':
        for (let i = 0; i < 14; i++) {
          this.noise(0.05, 0.34 + i * 0.04, 2200, i * 0.07);
          this.noise(0.04, 0.15 + i * 0.02, 5200, i * 0.07 + 0.035);
        }
        this.noise(0.25, 0.9, 1800, 0.98);
        this.tone('square', 392, 196, 0.2, 0.25, 0.98);
        break;
      case 'denied': this.tone('square', 200, 160, 0.12, 0.15); break;
      // тебя вырезали оружием: удар с треском, звон в ушах, стук сердца с «туком» сверху
      case 'knockedOut':
        this.noise(0.05, 1, 3000);
        this.noise(0.3, 0.9, 700);
        this.tone('square', 700, 160, 0.25, 0.3);
        this.tone('sine', 90, 35, 0.45, 0.4);
        this.tone('sine', 3100, 3000, 2.4, 0.2, 0.08);
        this.tone('sine', 3117, 3010, 2.4, 0.14, 0.08);
        [0.55, 0.78, 1.45, 1.68].forEach((d, i) => {
          this.tone('sine', 72, 42, 0.2, i % 2 ? 0.25 : 0.35, d);
          this.noise(0.04, i % 2 ? 0.6 : 0.9, 1100, d);
          this.tone('square', 220, 120, 0.08, i % 2 ? 0.12 : 0.18, d);
        });
        break;
      // тебя вырезали (без оружия): удар, щелчок монтажных ножниц, звон в ушах
      case 'cut':
        this.noise(0.05, 1, 3200);
        this.noise(0.15, 0.7, 1100);
        this.tone('square', 560, 130, 0.22, 0.3);
        this.scissors(0.24);
        this.tone('sine', 3100, 3000, 1.5, 0.2, 0.38);
        this.tone('sine', 3117, 3010, 1.5, 0.14, 0.38);
        break;
      // замах — только у бьющего, поэтому тихий (сосед по комнате не должен слышать, кто бил)
      case 'swing': this.noise(0.07, 0.2, 1500); this.noise(0.06, 0.12, 3400, 0.03); break;
      // свет мигает: щелчки выключателя и гудение лампы (гул — обертонами, его слышно и на телефоне)
      case 'flicker':
        [0, 0.09, 0.2].forEach((d) => { this.noise(0.03, 0.8, 3000, d); this.tone('square', 1400, 900, 0.025, 0.2, d); });
        this.tone('sawtooth', 100, 100, 0.35, 0.1, 0.05);
        this.tone('square', 400, 400, 0.3, 0.04, 0.05);
        break;
      // закат/рассвет: мягкий синтовый «вздох» вверх и шорох волны
      case 'dusk':
        this.tone('triangle', 440, 880, 1.4, 0.12);
        this.tone('triangle', 660, 1320, 1.4, 0.08, 0.1);
        this.noise(1.2, 0.1, 1800);
        break;
      // мигалка: две ноты сирены туда-обратно
      case 'siren': [0, 0.18, 0.36, 0.54].forEach((d, i) => this.tone('square', i % 2 ? 770 : 960, i % 2 ? 770 : 960, 0.17, 0.09, d)); break;
    }
  }

  /** Хлопушка: сухой щелчок и короткий деревянный резонанс. */
  private clapper(when = 0): void {
    this.noise(0.025, 0.9, 3200, when);
    this.noise(0.06, 0.5, 1400, when + 0.004);
    this.tone('triangle', 1250, 1050, 0.07, 0.3, when);
    this.tone('square', 640, 600, 0.04, 0.12, when);
  }

  /** Монтажные ножницы: два коротких металлических щелчка — «чик-чик». */
  private scissors(when = 0): void {
    for (const d of [0, 0.11]) {
      this.noise(0.035, 0.9, 5200, when + d);
      this.tone('square', 2600, 2100, 0.05, 0.2, when + d);
    }
  }

  /** «Вырезан»: звук его мира обрывается на полсекунды, потом медленно возвращается. */
  private cutOut(): void {
    const ctx = this.ctx;
    const g = this.duck?.gain;
    if (!ctx || !g) return;
    const t = ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.0001, t + 0.03);
    g.setValueAtTime(0.0001, t + 0.5);
    g.linearRampToValueAtTime(1, t + 1.6);
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
    o.connect(g).connect(this.route ?? this.sfx);
    o.start(t);
    lfo.start(t);
    o.stop(t + 1.15);
    lfo.stop(t + 1.15);
  }

  /**
   * Звук для записи клипа: своя музыка темы и эффекты момента — в отдельный поток (MediaStream),
   * не в динамики, поэтому клип можно писать в фоне, пока идёт игра. null — звук ещё не
   * разблокирован (iOS) или браузер не умеет: тогда клип будет без звука.
   */
  clipSound(): ClipSound | null {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuf || typeof ctx.createMediaStreamDestination !== 'function') return null;
    const dest = ctx.createMediaStreamDestination();
    // видео смотрят в ленте с телефона: громче и ровнее, чем игра, — сжать и поднять (как на радио)
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -26;
    comp.knee.value = 8;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    const makeup = ctx.createGain();
    makeup.gain.value = CLIP_GAIN;
    const master = ctx.createGain();
    master.gain.value = 1;
    // мягкий ограничитель: редкие пики после подъёма скругляются, а не хрипят
    const soft = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x); // тихое — как есть, громкое — скругляется к 0,76
    }
    soft.curve = curve;
    master.connect(comp).connect(makeup).connect(soft).connect(dest);
    const duck = ctx.createGain();
    duck.connect(master);
    const sfx = ctx.createGain();
    sfx.connect(master);
    const music = new Music(ctx, duck, this.noiseBuf);
    return {
      stream: dest.stream,
      start: (theme, twist) => {
        music.start('play', themePack(theme).music);
        music.setTwist(twist);
      },
      setTwist: (on, smooth) => music.setTwist(on, smooth),
      pause: () => music.tapeStop(),
      resume: () => music.resume(),
      play: (name) => {
        if (P1.has(name)) {
          const t = ctx.currentTime;
          duck.gain.cancelScheduledValues(t);
          duck.gain.setValueAtTime(0.4, t);
          duck.gain.linearRampToValueAtTime(1, t + 0.5);
        }
        const prev = this.route;
        this.route = sfx;
        try {
          this.sfxNow(name);
        } finally {
          this.route = prev;
        }
      },
      fadeOut: (sec) => {
        const t = ctx.currentTime;
        master.gain.cancelScheduledValues(t);
        master.gain.setValueAtTime(master.gain.value, t);
        master.gain.linearRampToValueAtTime(0.0001, t + sec);
      },
      stop: () => {
        music.stop();
        master.disconnect();
        for (const tr of dest.stream.getTracks()) tr.stop();
      },
    };
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
