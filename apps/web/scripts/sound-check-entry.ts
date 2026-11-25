/**
 * Замер звука «как на телефоне» (см. sound-check.mjs): настоящий код Audio и Music рендерится
 * в OfflineAudioContext через ту же цепочку, что в игре (шины, выравниватель), затем
 * считается громкость полностью и после полосы динамика телефона 350 Гц – 7 кГц.
 */
import { THEME_COUNT, THEME_RULES } from '@kto/game-core';
import { Audio } from '../src/game/audio';
import type { Sfx } from '../src/game/audio';
import type { MusicMode } from '../src/game/music';
import { loadTheme } from '../src/game/themes';

const SR = 48000;
const G = globalThis as unknown as { __out?: string; __err?: string; __only?: string };

/** Все эффекты игры (Sfx). Новый эффект — добавить сюда, иначе замер его не увидит. */
const SFX: Sfx[] = [
  'step', 'hitPlayer', 'hitBot', 'poof', 'starTake', 'starSpawn', 'crowd', 'tick', 'click', 'ready',
  'accuseRight', 'accuseWrong', 'fanfare', 'sad', 'hedge', 'pigeon', 'drum', 'denied', 'count', 'swing',
  'flicker', 'dusk', 'siren', 'whack', 'clang', 'stab', 'knockedOut', 'hitOther', 'cut', 'clap', 'logo', 'wrap', 'unmask', 'rewind',
  'leshyStep', 'leshyBreath', 'leshyStinger', 'leshyTake', 'leshyCall', 'snap', 'whisper', 'scream',
];

// ── поддельные часы: Music планирует ноты по setInterval, в офлайне его крутим сами ──
const timers = new Map<number, () => void>();
let nextTimer = 1;
(window as unknown as { setInterval: unknown }).setInterval = (fn: () => void) => {
  const id = nextTimer++;
  timers.set(id, fn);
  return id;
};
(window as unknown as { clearInterval: unknown }).clearInterval = (id: number) => timers.delete(id);
(window as unknown as { setTimeout: unknown }).setTimeout = () => 0; // отключение шин после обрыва — не нужно

let renderLen = 1;
class FakeCtx extends OfflineAudioContext {
  constructor() {
    super(2, Math.ceil(SR * renderLen), SR);
  }
}
(window as unknown as { AudioContext: unknown }).AudioContext = FakeCtx;

interface Run {
  /** Что сделать до рендера (в момент 0). */
  setup(a: Audio): void;
  /** Действия по ходу: [время, функция]. */
  at?: [number, (a: Audio) => void][];
}

async function render(len: number, run: Run): Promise<Float32Array> {
  renderLen = len;
  timers.clear();
  const a = new Audio();
  a.enabled = true;
  a.musicEnabled = true;
  a.unlock();
  const ctx = (a as unknown as { ctx: OfflineAudioContext }).ctx;
  run.setup(a);
  const step = 0.025;
  const acts = [...(run.at ?? [])].sort((x, y) => x[0] - y[0]);
  for (let t = step; t < len - step; t += step) {
    const tt = t;
    void ctx.suspend(tt).then(() => {
      while (acts.length && acts[0][0] <= tt + 1e-9) acts.shift()![1](a);
      for (const fn of [...timers.values()]) fn();
      void ctx.resume();
    });
  }
  const buf = await ctx.startRendering();
  const l = buf.getChannelData(0);
  const r = buf.getChannelData(1);
  const mono = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) mono[i] = (l[i] + r[i]) / 2;
  return mono;
}

// ── фильтры (биквады RBJ), Баттерворт 4-го порядка = два звена ──
function biquad(x: Float32Array, type: 'hp' | 'lp', f: number, q: number): Float32Array {
  const w = (2 * Math.PI * f) / SR;
  const cs = Math.cos(w);
  const al = Math.sin(w) / (2 * q);
  const b0 = type === 'lp' ? (1 - cs) / 2 : (1 + cs) / 2;
  const b1 = type === 'lp' ? 1 - cs : -(1 + cs);
  const b2 = b0;
  const a0 = 1 + al;
  const a1 = -2 * cs;
  const a2 = 1 - al;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
const Q1 = 0.5412;
const Q2 = 1.3066;
function phone(x: Float32Array): Float32Array {
  let y = biquad(x, 'hp', 350, Q1);
  y = biquad(y, 'hp', 350, Q2);
  y = biquad(y, 'lp', 7000, Q1);
  return biquad(y, 'lp', 7000, Q2);
}
const lowShare = (x: Float32Array): number => {
  let y = biquad(x, 'lp', 350, Q1);
  y = biquad(y, 'lp', 350, Q2);
  return energy(y) / Math.max(1e-12, energy(x));
};
function energy(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return s;
}
const db = (v: number) => (v > 0 ? Math.round(10 * Math.log10(v) * 10) / 10 : -120);

/** Где звук: от начала до последнего сэмпла громче −60 дБ (по полной полосе). */
function activeEnd(x: Float32Array): number {
  for (let i = x.length - 1; i >= 0; i--) if (Math.abs(x[i]) > 0.001) return i + 1;
  return 1;
}

/** Громкость звука: RMS по звучащей части; «пик 50 мс» — самое громкое окно в 50 мс. */
function measure(x: Float32Array, from = 0, to?: number) {
  const end = to ?? activeEnd(x);
  const p = phone(x);
  const n = Math.max(1, end - from);
  let peak = 0;
  for (let i = from; i < end; i++) peak = Math.max(peak, Math.abs(x[i]));
  const win = Math.round(0.05 * SR);
  let best = 0;
  for (let i = from; i + win <= end; i += win / 2) best = Math.max(best, energy(p, i, i + win) / win);
  return {
    len: Math.round(((end - from) / SR) * 100) / 100,
    full: db(energy(x, from, end) / n),
    phone: db(energy(p, from, end) / n),
    phonePeak50: db(best),
    peak: db(peak * peak),
    low: Math.round(lowShare(x.subarray(from, end)) * 100),
  };
}

void (async () => {
  try {
    const out: Record<string, unknown> = {};
    const only = G.__only ? G.__only.split(',') : null;
    const want = (k: string) => !only || only.some((o) => k.startsWith(o));
    for (const s of SFX) {
      if (!want('sfx:' + s)) continue;
      const x = await render(3.5, { setup: (a) => a.play(s, s === 'leshyStep' ? 10 : 0) });
      out['sfx:' + s] = measure(x);
    }
    // детский режим: мягкие удары вместо треска и звона
    for (const s of ['hitPlayer', 'hitOther', 'hitBot', 'cut', 'knockedOut', 'whack'] as Sfx[]) {
      if (!want('kids:' + s)) continue;
      const x = await render(3.5, { setup: (a) => (a.setKids(true), a.play(s)) });
      out['kids:' + s] = measure(x);
    }
    for (let th = 0; th < THEME_COUNT; th++) await loadTheme(th);
    const music = (key: string, len: number, mode: MusicMode, theme: number, opts: { twist?: boolean; intensity?: number; from?: number; dread?: number } = {}) =>
      render(len, {
        setup: (a) => {
          a.setMusic(mode, theme, true);
          if (opts.twist) a.setTwist(true);
          if (opts.intensity) a.setIntensity(opts.intensity);
          if (opts.dread) a.setDread(opts.dread);
        },
      }).then((x) => {
        out[key] = measure(x, Math.round((opts.from ?? 0) * SR), x.length - SR / 4);
      });
    for (let th = 0; th < THEME_COUNT; th++) {
      if (!want('music:' + th)) continue;
      // вступление (первые 2 с), спокойная часть, пик напряжения, изнанка
      await music(`music:${th}:intro2s`, 2.3, 'play', th);
      await music(`music:${th}:calm`, 20, 'play', th, { from: 4 });
      await music(`music:${th}:tense`, 16, 'play', th, { intensity: 2, from: 4 });
      await music(`music:${th}:twist`, 16, 'play', th, { twist: true, from: 4 });
      // тема с рассудком: глухая ночь — песня ломается, не должна стать громче
      if (THEME_RULES[th].sanity) await music(`music:${th}:night`, 20, 'play', th, { dread: 1, from: 4 });
    }
    // «свет вырубили» в Корпоративе: после щелчка света — провал тишины (0,4–0,95 с)
    const party = 6;
    if (want('music:6:blackout')) {
      const x = await render(7, { setup: (a) => a.setMusic('play', party, true), at: [[4, (a) => a.setTwist(true)]] });
      out['music:6:blackout-gap'] = measure(x, Math.round(4.45 * SR), Math.round(4.95 * SR));
    }
    if (want('music:menu')) await music('music:menu', 16, 'menu', 0, { from: 1 });
    if (want('music:accuse')) await music('music:accuse', 12, 'accuse', 0, { from: 1 });
    G.__out = JSON.stringify(out);
  } catch (e) {
    G.__err = String(e instanceof Error ? e.stack : e);
  }
})();
