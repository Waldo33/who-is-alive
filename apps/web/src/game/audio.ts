import { Music } from './music';
import { themePack } from './themes';
import type { MusicMode, Orchestra } from './music';
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
  private kids = false;
  /** Когда последний раз звучал каждый эффект и когда начались последние важные (P1). */
  private lastAt = new Map<Sfx, number>();
  private p1At: number[] = [];
  /** Звуки игры (эффекты). */
  enabled = true;
  /** Музыка. */
  musicEnabled = true;
  /** Какая музыка должна звучать сейчас (играет, если музыка включена и звук разблокирован). */
  private want: { mode: MusicMode; theme: number } = { mode: 'off', theme: 0 };
  /** Музыка дубля на этом телефоне (комната); в песочнице — full. */
  private round: RoundMusic = 'full';
  private orch: Orchestra | null = null;
  private roundGain: GainNode | null = null;
  /** Что сейчас задано музыке: после пересоздания контекста вернуть как было. */
  private mood = { hush: false, dread: -1, intensity: 0 };
  /**
   * Игра уходила в фон (свернули, экран погас, звонок, Telegram свернул Mini App). Пока звук
   * после этого не подтвердил, что жив, каждое касание его проверяет и чинит (wake).
   */
  private away = false;
  /** Контекст сломан насовсем (iOS: застрял в interrupted или «running», но часы стоят) — пересоздать при касании. */
  private broken = false;
  private probe: number | null = null;

  constructor() {
    this.enabled = stored(STORAGE_KEY) !== 'off';
    const m = stored(MUSIC_KEY);
    // раньше был один переключатель: выключенный звук выключает и музыку
    this.musicEnabled = m ? m !== 'off' : this.enabled;
    // Уход в фон и возврат. Свернуть игру можно по-разному, и браузеры сообщают об этом по-разному:
    // visibilitychange (вкладка), pagehide/pageshow (iOS при блокировке и из кэша), blur/focus
    // (шторка, звонок) и свои события Telegram (Mini App свернули — страница может остаться «видимой»).
    const away = () => {
      this.away = true;
      if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend().catch(() => undefined);
    };
    const back = () => {
      this.away = true; // подтвердит только касание: до него звук мог «ожить» лишь на вид
      // вернуть звук, если играет хоть что-то: музыка без эффектов тоже должна вернуться.
      // Без жеста iOS может не пустить — тогда вернёт первое касание (unlock)
      if (this.ctx && (this.enabled || this.musicEnabled)) void this.ctx.resume().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', () => (document.hidden ? away() : back()));
    window.addEventListener('pagehide', away);
    window.addEventListener('pageshow', (e) => {
      if ((e as PageTransitionEvent).persisted) back();
    });
    window.addEventListener('blur', () => {
      if (!document.hasFocus()) this.away = true; // не глушим: blur бывает и от фрейма внутри страницы
    });
    window.addEventListener('focus', () => {
      if (this.away) back();
    });
    window.addEventListener('kto:away', away);
    window.addEventListener('kto:back', back);
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

  /**
   * Вызывать из обработчика тапа (и так уже зовётся на каждое касание). Безопасно вызывать сколько
   * угодно раз. Будит звук после фона, а если контекст не оживает — пересоздаёт его.
   */
  unlock(): void {
    const ctx = this.ctx;
    if (!ctx) return this.build();
    if (!this.enabled && !this.musicEnabled) return; // звук выключен — будить нечего
    // iOS иногда закрывает контекст после долгого фона или оставляет мёртвым
    if (ctx.state === 'closed' || this.broken) return this.rebuild();
    if (ctx.state === 'running' && !this.away) return;
    // 'suspended' и iOS-овый 'interrupted' лечатся resume() из жеста, но не всегда: бывает, что
    // контекст навсегда застрял в 'interrupted' или пишет 'running', а часы стоят и звука нет.
    // Тогда спасает только новый контекст: первое касание даёт шанс resume и проверяет (check),
    // не помогло — следующее касание пересоздаёт контекст (broken).
    if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
    this.kick(ctx);
    this.check(ctx);
  }

  /** Пустой звук прямо в жесте: на iOS это «включает» вывод, даже если контекст уже running. */
  private kick(ctx: AudioContext): void {
    try {
      const blip = ctx.createBufferSource();
      blip.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      blip.connect(ctx.destination);
      blip.start();
    } catch {
      /* контекст в плохом состоянии — разберётся проверка */
    }
  }

  /**
   * Через 300 мс после касания: если звук идёт (running и часы контекста двигаются) — всё хорошо,
   * больше не проверяем до следующего ухода в фон. Иначе — следующее касание пересоздаст контекст.
   */
  private check(ctx: AudioContext): void {
    if (this.probe !== null) return;
    const t0 = ctx.currentTime;
    this.probe = window.setTimeout(() => {
      this.probe = null;
      if (ctx !== this.ctx || document.hidden) return;
      if (ctx.state === 'running' && ctx.currentTime > t0) this.away = false;
      // не ожил или «работает», а часы стоят
      else this.broken = true;
    }, 300);
  }

  /** Новый контекст вместо сломанного: та же музыка с начала, те же настройки. */
  private rebuild(): void {
    const old = this.ctx;
    this.music?.stop();
    this.ctx = null;
    this.music = null;
    this.synth = null;
    this.broken = false;
    // часы нового контекста начинаются с нуля — старые отметки глушили бы все эффекты
    this.lastAt.clear();
    this.p1At = [];
    if (old && old.state !== 'closed') void old.close().catch(() => undefined);
    this.build(false);
  }

  private build(fresh = true): void {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    let ctx: AudioContext;
    try {
      ctx = new AC();
    } catch {
      return; // iOS: слишком много контекстов — попробуем на следующем касании
    }
    this.ctx = ctx;
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
    this.synth.kids = this.kids;
    // WebKit (iPhone, Telegram) создаёт контекст из жеста приостановленным: запустить в этом же
    // касании и сыграть пустой звук — иначе музыка меню заиграет только со второго касания,
    // а им обычно бывает «Играть»
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => undefined);
    this.kick(this.ctx);
    this.apply(true);
    const { hush, dread, intensity } = this.mood;
    if (hush) this.music.setHush(true);
    if (dread >= 0) this.music.setDread(dread);
    if (intensity) this.music.setIntensity(intensity);
    // проверить, что звук действительно пошёл (iOS после фона создаёт и «мёртвые» контексты)
    this.check(ctx);
    // открытие игры: звуковой логотип над музыкой меню (раз за запуск)
    if (fresh && this.want.mode === 'menu') this.play('logo');
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

  /**
   * Оркестр из телефонов в лобби (музыка меню): одна песня по часам сервера, своя партия у каждого
   * телефона. null — обычная музыка меню. Смена партии — песня встаёт заново на следующий такт.
   */
  setOrchestra(o: Orchestra | null): void {
    const same = (a: Orchestra | null, b: Orchestra | null) => (!a && !b) || (!!a && !!b && a.part === b.part && a.parts === b.parts);
    if (same(o, this.orch)) {
      this.orch = o;
      return;
    }
    this.orch = o;
    if (this.want.mode === 'menu') this.apply(true);
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
      m.start(mode, themePack(theme).music, false, mode === 'menu' ? this.orch : null);
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

  /** Леший рядом: песня темы замолкает (у всех одинаково). */
  setHush(on: boolean): void {
    this.mood.hush = on;
    this.music?.setHush(on);
  }

  /** Ночь темы с рассудком 0–1 (общая для всех, не свой рассудок). */
  setDread(v: number): void {
    this.mood.dread = v;
    this.music?.setDread(v);
  }

  /** Напряжение раунда 0–2. */
  setIntensity(level: number): void {
    this.mood.intensity = level;
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

  /**
   * Сыграть эффект. Правила смеси (звуковой гайд): одинаковый звук не чаще раза в 120 мс; важных
   * (P1) одновременно не больше двух — третий ждёт 80 мс, чтобы не слиться в кашу.
   */
  play(name: Sfx, step = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const now = ctx.currentTime;
    if (now - (this.lastAt.get(name) ?? -1) < 0.12) return;
    this.lastAt.set(name, now);
    let delay = 0;
    if (P1.has(name)) {
      this.p1At = this.p1At.filter((t) => t > now - 0.15);
      if (this.p1At.length >= 2) delay = 0.08;
      this.p1At.push(now + delay);
    }
    if (name === 'knockedOut') this.concuss();
    else if (name === 'cut') this.cutOut();
    else if (P1.has(name)) this.duckMusic(0.355, 0.6);
    else if (P2.has(name)) this.duckMusic(0.63, 0.4);
    this.synth?.playAt(delay, name, step);
  }

  /** Детский режим комнаты: мягкие тембры, без звона в ушах и оружия (sfx.ts › KIDS). */
  setKids(on: boolean): void {
    this.kids = on;
    if (this.synth) this.synth.kids = on;
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
