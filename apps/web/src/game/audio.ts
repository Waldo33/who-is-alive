import { Music } from './music';
import { themePack } from './themes';
import type { MusicMode } from './music';
import { P1, P2, Synth } from './sfx';
import type { Sfx } from './sfx';
import { clipMix, makeNoise } from './clip-audio';
import type { ClipSoundCore } from './clip-audio';

export type { Sfx } from './sfx';

/**
 * Звук: Web Audio API, один AudioContext на всё приложение (getAudio), разблокировка по первому тапу.
 * Эффекты синтезируются кодом; музыка — секвенсор из music.ts (тема, вариации, напряжение, меню).
 * Музыку и эффекты можно выключать по отдельности.
 */
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

/** Звук клипа в браузере: смесь клипа (clip-audio.ts) в поток MediaStream для записи. */
export interface ClipSound extends ClipSoundCore {
  stream: MediaStream;
}

let shared: Audio | null = null;
/** Один звук на всё приложение: музыка меню не обрывается при переходе между экранами. */
export function getAudio(): Audio {
  shared ??= new Audio();
  return shared;
}

/**
 * Громкость музыки относительно эффектов: ×3 (+9,5 дБ). При ×1 музыку на динамике телефона почти
 * не было слышно (жалоба владельца, 23.11.2026). С 24.11 музыка подаётся под телефон (обертоны
 * баса, «тук» бочки, низ тише — music.ts › openBus): в дубле она −40…−44 дБ на динамике, а важные
 * эффекты (P1) — на 10 дБ громче неё. Проверка — `pnpm --filter web sound-check`. Клип пишет свою смесь.
 */
export const MUSIC_GAIN = 3;

/**
 * Музыка дубля на этом телефоне в комнате (настройка режиссёра «Музыка в дубле», RoomClient):
 * full — как обычно; quiet — тихо, −18 дБ (гость при «только у режиссёра»: с наушниками не в
 * тишине, а в комнате песню ведёт телефон режиссёра); off — без музыки. Меню и клип не трогает.
 */
export type RoundMusic = 'full' | 'quiet' | 'off';
const QUIET_GAIN = 0.126;

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
  private synth: Synth | null = null;
  /** Звуки игры (эффекты). */
  enabled = true;
  /** Музыка. */
  musicEnabled = true;
  /** Какая музыка должна звучать сейчас (играет, если музыка включена и звук разблокирован). */
  private want: { mode: MusicMode; theme: number } = { mode: 'off', theme: 0 };
  /** Музыка дубля на этом телефоне (комната); в песочнице — full. */
  private round: RoundMusic = 'full';
  private roundGain: GainNode | null = null;

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
    // ниже ~90 Гц телефон не играет ничего, а выравниватель из-за этого баса зажимал бы всё остальное
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 90;
    hp.Q.value = 0.7;
    hp.connect(comp);
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(hp);
    this.sfx = this.ctx.createGain();
    this.sfx.gain.value = this.enabled ? 1 : 0;
    this.sfx.connect(this.master);
    this.duck = this.ctx.createGain();
    this.muffle = this.ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.duck.connect(this.muffle).connect(this.master);
    this.noiseBuf = makeNoise(this.ctx);
    // музыка отдельной шиной громче эффектов (просьба владельца: «тихо»); выравниватель держит пики
    const musicBus = this.ctx.createGain();
    musicBus.gain.value = MUSIC_GAIN;
    this.roundGain = this.ctx.createGain();
    musicBus.connect(this.roundGain).connect(this.duck);
    this.music = new Music(this.ctx, musicBus, this.noiseBuf);
    this.synth = new Synth(this.ctx, this.sfx, this.noiseBuf);
    // WebKit (iPhone, Telegram) создаёт контекст из жеста приостановленным: запустить в этом же
    // касании и сыграть пустой звук — иначе музыка меню заиграет только со второго касания,
    // а им обычно бывает «Играть»
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => undefined);
    const blip = this.ctx.createBufferSource();
    blip.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    blip.connect(this.ctx.destination);
    blip.start();
    this.apply();
    // открытие игры: звуковой логотип над музыкой меню (раз за запуск)
    if (this.want.mode === 'menu') this.play('logo');
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

  /** Музыка дубля на этом телефоне (комната). Меняется на ходу: сменился режиссёр — меняется и звук. */
  setRoundMusic(r: RoundMusic): void {
    if (r === this.round) return;
    this.round = r;
    this.apply();
  }

  get roundMusic(): RoundMusic {
    return this.round;
  }

  private apply(force = false): void {
    const m = this.music;
    if (!m || !this.ctx) return;
    const { mode, theme } = this.want;
    const inRound = mode === 'play' || mode === 'accuse';
    if (this.roundGain) {
      const g = inRound && this.round === 'quiet' ? QUIET_GAIN : 1;
      this.roundGain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.15);
    }
    if (!this.musicEnabled || mode === 'off' || (inRound && this.round === 'off')) {
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

  play(name: Sfx, step = 0): void {
    if (!this.ctx || !this.enabled) return;
    if (name === 'knockedOut') this.concuss();
    else if (name === 'cut') this.cutOut();
    else if (P1.has(name)) this.duckMusic(0.355, 0.6);
    else if (P2.has(name)) this.duckMusic(0.63, 0.4);
    this.synth?.play(name, step);
  }

  /** Стрёкот проектора на sec секунд через when (разоблачение, стоп-кадр «Море волнуется»). Тихий фон. */
  projector(sec: number, vol = 0.07, when = 0): void {
    if (!this.ctx || !this.enabled || sec <= 0) return;
    this.synth?.projector(when, sec, vol, vol);
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

  /**
   * Звук для записи клипа: своя музыка темы и эффекты момента — в отдельный поток (MediaStream),
   * не в динамики, поэтому клип можно писать в фоне, пока идёт игра. null — звук ещё не
   * разблокирован (iOS) или браузер не умеет: тогда клип будет без звука.
   */
  clipSound(): ClipSound | null {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuf || typeof ctx.createMediaStreamDestination !== 'function') return null;
    const dest = ctx.createMediaStreamDestination();
    const core = clipMix(ctx, dest, this.noiseBuf);
    return {
      ...core,
      stream: dest.stream,
      stop: () => {
        core.stop();
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
