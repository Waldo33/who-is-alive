import { Music } from './music';
import { P1, Synth } from './sfx';
import type { Sfx } from './sfx';
import { themePack } from './themes';

/**
 * Подъём громкости звука клипа после компрессора. Цель — −14 LUFS в среднем и пики не выше −1 дБ:
 * к этому уровню выравнивают Reels, TikTok и Shorts (тише — клип проигрывает соседям в ленте).
 * Проверка: `pnpm --filter web clip-video <зерно> out.webm [тема]` печатает громкость.
 */
const CLIP_GAIN = 3.2;
/** Потолок мягкого ограничителя клипа: −3,5 дБ (кодек видео добавляет к пикам до 2,5 дБ). */
const CLIP_CEIL = 0.67;

/**
 * Звук клипа и фильма матча: своя музыка темы и эффекты повтора. Без DOM — работает и в браузере
 * (выход — MediaStreamDestination для записи, audio.ts › clipSound), и на сервере
 * (OfflineAudioContext из node-web-audio-api, музыка в ручном режиме — `pump()` каждый кадр).
 */
export interface ClipSoundCore {
  start(theme: number, twist: boolean): void;
  setTwist(on: boolean, smooth?: boolean): void;
  pause(): void;
  resume(): void;
  /** step — ступень для звуков с нарастанием (живые по одному, звезда). */
  play(name: Sfx, step?: number): void;
  /** Напряжение музыки 0–2 (как в дубле): загадка фильма — 2, разбор — 1. */
  intensity(level: number): void;
  /** Общий уровень после компрессора, дБ (0 — как клип): фильм с дробью и отсчётом громче — его подравнивают. */
  level(db: number): void;
  fadeOut(sec: number): void;
  /** Тишина перед ударом: музыка пропадает на sec, удар (P1) возвращает её сам. */
  hush(sec: number): void;
  stop(): void;
  /** Ручной режим (офлайн-рендер): спланировать музыку до текущего времени контекста. */
  pump(): void;
}

/** Секунда белого шума — для шагов, ударов и хэтов. */
export function makeNoise(ctx: BaseAudioContext): AudioBuffer {
  const len = ctx.sampleRate;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** Смесь звука клипа в узел out. manual — музыка без таймера (офлайн-рендер на сервере). */
export function clipMix(ctx: BaseAudioContext, out: AudioNode, noiseBuf: AudioBuffer, opts: { manual?: boolean } = {}): ClipSoundCore {
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
  // мягкий ограничитель: редкие пики после подъёма скругляются, а не хрипят; тихое — почти как
  // есть, громкое — к CLIP_CEIL (запас на кодек: пики в видео ≤ −1 дБ)
  const soft = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = (CLIP_CEIL * Math.tanh(1.6 * x)) / Math.tanh(1.6);
  }
  soft.curve = curve;
  // ниже ~90 Гц телефон не играет ничего, а компрессор из-за этого баса зажимал бы всё остальное
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 90;
  hp.Q.value = 0.7;
  master.connect(hp).connect(comp).connect(makeup).connect(soft).connect(out);
  const duck = ctx.createGain();
  duck.connect(master);
  const sfxBus = ctx.createGain();
  sfxBus.connect(master);
  const music = new Music(ctx, duck, noiseBuf);
  music.manual = !!opts.manual;
  const synth = new Synth(ctx, sfxBus, noiseBuf);
  return {
    // клип начинается сразу с темы песни и с напряжением, а не с тихого вступления
    start: (theme, twist) => {
      music.start('play', themePack(theme).music, true);
      music.setTwist(twist);
    },
    setTwist: (on, smooth) => music.setTwist(on, smooth),
    pause: () => music.tapeStop(),
    resume: () => music.resume(),
    play: (name, step = 0) => {
      // важное (P1, sfx.ts) пробивается через музыку
      if (P1.has(name)) {
        const t = ctx.currentTime;
        duck.gain.cancelScheduledValues(t);
        duck.gain.setValueAtTime(0.4, t);
        duck.gain.linearRampToValueAtTime(1, t + 0.5);
      }
      synth.play(name, step);
    },
    intensity: (level) => music.setIntensity(level),
    level: (db) => {
      makeup.gain.value = CLIP_GAIN * Math.pow(10, db / 20);
    },
    // уходит музыка, а не всё: подпись-логотип в конце звучит поверх
    fadeOut: (sec) => {
      const t = ctx.currentTime;
      duck.gain.cancelScheduledValues(t);
      duck.gain.setValueAtTime(duck.gain.value, t);
      duck.gain.linearRampToValueAtTime(0.0001, t + sec);
    },
    hush: (sec) => {
      const t = ctx.currentTime;
      duck.gain.cancelScheduledValues(t);
      duck.gain.setValueAtTime(duck.gain.value, t);
      duck.gain.linearRampToValueAtTime(0.0001, t + 0.02);
      duck.gain.setValueAtTime(0.0001, t + sec);
      duck.gain.linearRampToValueAtTime(1, t + sec + 0.3);
    },
    stop: () => {
      music.stop();
      master.disconnect();
    },
    pump: () => {
      if (opts.manual) music.pump();
    },
  };
}
