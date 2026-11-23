import { Music } from './music';
import { P1, Synth } from './sfx';
import type { Sfx } from './sfx';
import { themePack } from './themes';

/** Подъём громкости звука клипа после компрессора. */
const CLIP_GAIN = 2.5;

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
  play(name: Sfx): void;
  fadeOut(sec: number): void;
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
  // мягкий ограничитель: редкие пики после подъёма скругляются, а не хрипят
  const soft = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x); // тихое — как есть, громкое — скругляется к 0,76
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
    start: (theme, twist) => {
      music.start('play', themePack(theme).music);
      music.setTwist(twist);
    },
    setTwist: (on, smooth) => music.setTwist(on, smooth),
    pause: () => music.tapeStop(),
    resume: () => music.resume(),
    play: (name) => {
      // важное (P1, sfx.ts) пробивается через музыку
      if (P1.has(name)) {
        const t = ctx.currentTime;
        duck.gain.cancelScheduledValues(t);
        duck.gain.setValueAtTime(0.4, t);
        duck.gain.linearRampToValueAtTime(1, t + 0.5);
      }
      synth.play(name);
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
    },
    pump: () => {
      if (opts.manual) music.pump();
    },
  };
}
