/**
 * Музыка игры: маленький секвенсор на Web Audio. Всё растёт из одной темы — исходного чиптюн-лупа
 * (бас квадратом, мелодия треугольником, хэт и малый на слабые доли). Чтобы не надоедало:
 *  - песня собирается из частей: вступление → тема → вариация → «B» (арпеджио по тем же нотам)
 *    → тема → … с барабанными сбивками на стыках; вариации мелодии случайны в каждом раунде;
 *  - у каждой темы раунда свой характер (тональность, темп, свинг, тембр), но мотив тот же;
 *  - напряжение растёт к концу раунда: бочка, частый хэт, мелодия октавой выше, темп быстрее;
 *  - «Море волнуется» обрывает музыку эффектом зажёванной плёнки, после паузы песня
 *    продолжается с той же ноты, где оборвалась (не с начала и не со следующего такта);
 *  - в фазе обвинения — сердцебиение.
 */

import { NY_ROOTS, NY_TRIADS, newYearSeason, nyMelodyAt } from './newyear';

/** Исходная тема: бас по четвертям, мелодия восьмыми (вторая половина такта — октавой выше). */
const BASS = [45, 45, 52, 45, 48, 48, 55, 48, 41, 41, 48, 41, 43, 43, 50, 47];
const LEAD = [69, 72, 76, 72, 72, 76, 79, 76, 65, 69, 72, 69, 67, 71, 74, 71];
/** Ля минор (натуральный) — для проходящих нот вариаций. */
const SCALE = [0, 2, 3, 5, 7, 8, 10];
const ROOT = 57;

export type MusicMode = 'off' | 'menu' | 'play' | 'accuse';

/**
 * Оркестр из телефонов (план звука, вариант Б; пока — музыка лобби): одна песня по часам сервера,
 * у каждого телефона своя партия. part — номер телефона (0 — режиссёр), parts — сколько телефонов.
 */
export interface Orchestra {
  part: number;
  parts: number;
  /** Время сервера, мс — общее для всех телефонов комнаты. */
  now: () => number;
}

/** Партии оркестра: кто что играет при 1–4 телефонах. Режиссёр — бас и барабаны. */
type Role = 'bass' | 'drums' | 'lead' | 'arp' | 'pad';
const ORCH_ROLES: Role[][][] = [
  [['bass', 'drums', 'lead', 'arp', 'pad']],
  [['bass', 'drums'], ['lead', 'arp', 'pad']],
  [['bass', 'drums'], ['lead'], ['arp', 'pad']],
  [['bass', 'drums'], ['lead'], ['arp'], ['pad']],
];

export interface Flavor {
  /** Сдвиг тональности, полутоны. */
  transpose: number;
  bpm: number;
  /** Свинг: задержка нечётных шестнадцатых (доля шестнадцатой). */
  swing: number;
  lead: OscillatorType | 'pulse';
  bass: OscillatorType | 'pulse';
  /** Тихое арпеджио поверх темы всегда. */
  arp: boolean;
  /** Эхо (звонкость). */
  echo: boolean;
}

/**
 * Характер темы раунда задаёт её пакет (themes/*.ts › music): тембры, темп, свинг общей темы —
 * или своя песня (Song). Кепки в парке — исходник.
 */
const PARK_FLAVOR: Flavor = { transpose: 0, bpm: 120, swing: 0, lead: 'triangle', bass: 'square', arp: false, echo: false };

/** Инструменты секвенсора для своей песни темы. */
export interface SongApi {
  voice(type: OscillatorType | 'pulse', midi: number, when: number, dur: number, vol: number): void;
  kick(when: number, vol?: number, from?: number): void;
  /** Шум через полосовой фильтр: хэт, малый, тарелка. */
  hit(dur: number, vol: number, freq: number, when: number): void;
  /** Перегруженная гитара: по умолчанию квинтаккорд [0, 7, 12]; [0] или [0, 12] — соло одной нотой. */
  power(midi: number, when: number, dur: number, vol: number, iv?: readonly number[]): void;
  rng(): number;
}

/** Шестнадцатая песни: где мы в такте и что творится в игре. */
export interface SongStep {
  /** Шестнадцатая в такте 0–15 и номер такта с начала дубля. */
  s16: number;
  bar: number;
  /** Время ноты (AudioContext) и длина шестнадцатой, с. */
  t: number;
  dt: number;
  /** Напряжение конца раунда 0–2. */
  intensity: number;
  /** Изнанка темы включена (themes.ts › twist) и сколько тактов назад переключилась. */
  twist: boolean;
  barsSinceTwist: number;
}

/** Своя песня темы: вместо общего мотива — свой шаг секвенсора. */
export interface Song {
  step(api: SongApi, st: SongStep): void;
  /**
   * Вход в изнанку «свет вырубили»: песня проседает, как плёнка, секунда тишины — и изнанка
   * начинается с удара (Корпоратив). Иначе изнанка вступает сразу.
   */
  blackout?: boolean;
}

/** Меню и лобби: та же тема «лаунжем» — медленно, мягко, с эхом. */
const MENU: Flavor = { transpose: 0, bpm: 92, swing: 0.18, lead: 'sine', bass: 'triangle', arp: false, echo: true };
/** Меню в новогодний сезон (newyear.ts): бубенцы, колокольчики, мотив «Корпоратива». */
const MENU_NY: Flavor = { transpose: 0, bpm: 104, swing: 0.2, lead: 'triangle', bass: 'triangle', arp: false, echo: true };

type SectionKind = 'intro' | 'A' | 'A2' | 'B' | 'C';
interface Section {
  kind: SectionKind;
  bars: number;
  /** Мутации мелодии для вариации: по одной на восьмую. */
  muts: ('keep' | 'pass' | 'oct' | 'rest' | 'dbl')[];
}

interface Live {
  src: AudioScheduledSourceNode;
  until: number;
}

const mtf = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
/** Ниже этой частоты нота получает обертон октавой выше (телефон не играет ниже ~350 Гц). */
const BASS_HZ = 200;

function rngFrom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Ближайшая нота лада на step ступеней выше/ниже. */
function scaleStep(m: number, step: number): number {
  const deg = (n: number) => SCALE.indexOf((((n - ROOT) % 12) + 12) % 12);
  let n = m;
  let left = Math.abs(step);
  const dir = Math.sign(step);
  while (left > 0) {
    n += dir;
    if (deg(n) >= 0) left--;
  }
  return n;
}

/** Таймер ручного режима (`Music.manual`): музыка «играет», но ноты планирует `pump()`. */
const MANUAL = -1;

export class Music {
  private bus: GainNode | null = null;
  private echo: DelayNode | null = null;
  private timer: number | null = null;
  /**
   * Ручной режим: без таймера, ноты планирует `pump()` — так звук фильма матча рендерится
   * офлайн на сервере (OfflineAudioContext), где время задаёт сам рендер, а не часы.
   */
  manual = false;
  private tickFn: (() => void) | null = null;
  private next = 0;
  private s16 = 0;
  private bar = 0;
  private sec: Section;
  private queue: Section[] = [];
  private rng = rngFrom(1);
  private flavor: Flavor = PARK_FLAVOR;
  private song: Song | null = null;
  /** Музыка меню — новогодняя (сезон проверяется при каждом включении меню). */
  private festive = false;
  private twist = false;
  private twistBar = 0;
  /** Смена изнанки, ждущая начала такта. */
  private pendingTwist: boolean | null = null;
  /** Последние запланированные шестнадцатые: время и место в песне. */
  private sched: { t: number; bar: number; s16: number }[] = [];
  private drive: AudioNode | null = null;
  private readonly api: SongApi = {
    voice: (type, midi, when, dur, vol) => this.voice(type, midi, when, dur, vol),
    kick: (when, vol, from) => this.kick(when, vol, from),
    hit: (dur, vol, freq, when) => this.hit(dur, vol, freq, when),
    power: (midi, when, dur, vol, iv) => this.power(midi, when, dur, vol, iv),
    rng: () => this.rng(),
  };
  private intensity = 0;
  private tempoMul = 1;
  private live: Live[] = [];
  private pulse: PeriodicWave;
  private sinceA = 0;
  /** Когда началась песня (время AudioContext). */
  private startedAt = 0;
  /** Сколько дублей уже начато (с какой части начинать следующий). */
  private static takes = 0;
  /** Оркестр из телефонов (музыка меню): общие часы и партии этого телефона. */
  private orch: Orchestra | null = null;
  private roles: Set<Role> | null = null;
  mode: MusicMode = 'off';
  /** Пауза «Море волнуется»: музыка остановлена, но место в песне помним. */
  paused = false;

  constructor(
    private ctx: BaseAudioContext,
    private out: AudioNode,
    private noiseBuf: AudioBuffer,
  ) {
    // импульс 25% — «носовой» тембр NES для поваров
    const N = 32;
    const real = new Float32Array(N);
    const imag = new Float32Array(N);
    for (let n = 1; n < N; n++) real[n] = (2 * Math.sin(n * Math.PI * 0.25)) / (n * Math.PI);
    this.pulse = ctx.createPeriodicWave(real, imag);
    this.sec = this.make('intro');
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /**
   * Новый раунд (или новая фаза): тема раунда задаёт характер, вариации — новые.
   * hook — сразу с темы (без вступления) и с напряжением: клип в ленте должен зацепить с первой секунды.
   */
  start(mode: MusicMode, style?: { flavor: Flavor; song?: Song }, hook = false, orch: Orchestra | null = null): void {
    this.hardStop();
    this.mode = mode;
    this.paused = false;
    this.twist = false;
    if (mode === 'off') return;
    this.festive = mode === 'menu' && newYearSeason();
    this.flavor = mode === 'menu' ? (this.festive ? MENU_NY : MENU) : (style?.flavor ?? PARK_FLAVOR);
    this.song = mode === 'play' ? (style?.song ?? null) : null;
    this.rng = rngFrom((Math.random() * 2 ** 31) | 0);
    this.intensity = 0;
    this.tempoMul = 1;
    // каждый дубль — с другой части песни (тема, «B», вариация), а не всегда с того же вступления;
    // клип (hook) — сразу с темы
    const v = hook ? 0 : Music.takes++ % 3;
    this.queue = mode === 'play' ? [[this.make('A'), this.make('A2'), this.make('B'), this.make('A')], [this.make('B'), this.make('A'), this.make('A2')], [this.make('A2'), this.make('B'), this.make('A')]][v] : [];
    this.sec = this.queue.shift() ?? this.make('A');
    this.sinceA = 0;
    // своя песня темы — с разных мест круга; клип — со второго круга, где мелодия уже идёт
    this.bar = this.song ? (hook ? 8 : [0, 8, 4][v]) : 0;
    this.twistBar = this.bar;
    if (hook) this.intensity = 1;
    this.s16 = 0;
    this.openBus();
    this.next = this.ctx.currentTime + 0.06;
    this.orch = mode === 'menu' && orch && orch.parts > 1 ? orch : null;
    this.roles = this.orch ? new Set(ORCH_ROLES[Math.min(4, this.orch.parts) - 1][Math.min(this.orch.part, 3)] ?? []) : null;
    if (this.orch) this.alignBar(true);
    this.startedAt = this.next;
    this.run();
  }

  /** Длина такта музыки меню, мс. */
  private barMs(): number {
    return (4 * 60000) / this.flavor.bpm;
  }

  /**
   * Оркестр: следующий такт — по часам сервера, одинаково на всех телефонах. Номер такта от
   * общего начала отсчёта выбирает место в песне (меню повторяется каждые 8 тактов), а задержка
   * вывода звука устройства (Bluetooth, старый Android) вычитается. first — начать песню; иначе
   * подстройка на начале каждого такта, если часы разошлись больше чем на 12 мс.
   */
  private alignBar(first: boolean): void {
    const o = this.orch;
    if (!o) return;
    const ctx = this.ctx as AudioContext;
    const lat = (ctx.outputLatency || ctx.baseLatency || 0) * 1000;
    const bar = this.barMs();
    const sNow = o.now();
    // время сервера, когда прозвучит запланированное на this.next
    const sAtNext = sNow + (this.next - ctx.currentTime) * 1000 + lat;
    if (first) {
      const idx = Math.ceil((sAtNext + 120) / bar);
      this.next += (idx * bar - sAtNext) / 1000;
      this.bar = ((idx % 8) + 8) % 8;
      this.s16 = 0;
      return;
    }
    const idx = Math.round(sAtNext / bar);
    const drift = idx * bar - sAtNext;
    // вкладка спала или часы прыгнули — встать на такт сразу; иначе подтягивать понемногу
    if (Math.abs(drift) > 100) this.next += drift / 1000;
    else if (Math.abs(drift) > 12) this.next += Math.max(-0.05, Math.min(0.05, drift / 1000));
    this.bar = ((idx % 8) + 8) % 8;
  }

  /** Играет ли эту партию наш телефон (оркестр); без оркестра — все. */
  private plays(r: Role): boolean {
    return !this.roles || this.roles.has(r);
  }

  /**
   * Изнанка темы: своя песня меняет подачу (тихий куплет → громкий припев).
   * smooth — со следующего такта (плавный переход темы), иначе сразу.
   */
  setTwist(on: boolean, smooth = false): void {
    if (smooth && this.running) {
      this.pendingTwist = on === this.twist ? null : on;
      return;
    }
    this.pendingTwist = null;
    if (on === this.twist) return;
    this.twist = on;
    this.twistBar = this.bar;
    // не в самом начале песни: клип и новый дубль могут начаться сразу в изнанке
    if (on && this.song?.blackout && this.running && this.mode === 'play' && this.ctx.currentTime - this.startedAt > 0.5) this.blackout();
  }

  /** «Свет вырубили»: звучащее проседает вниз (0,35 с), секунда тишины, потом музыка возвращается. */
  private blackout(): void {
    const bus = this.bus;
    if (!bus) return;
    const now = this.ctx.currentTime;
    const T = 0.35;
    for (const l of this.live) {
      if (l.until < now || !('detune' in l.src)) continue;
      const o = l.src as OscillatorNode;
      o.detune.cancelScheduledValues(now);
      o.detune.setValueAtTime(0, now);
      o.detune.linearRampToValueAtTime(-1200, now + T);
    }
    const full = bus.gain.value;
    bus.gain.cancelScheduledValues(now);
    bus.gain.setValueAtTime(full, now);
    bus.gain.exponentialRampToValueAtTime(0.0001, now + T);
    bus.gain.setValueAtTime(0.0001, now + 1.0);
    bus.gain.exponentialRampToValueAtTime(full, now + 1.04);
  }

  /** Уровень напряжения 0–2 (меняется на следующей доле). */
  setIntensity(level: number): void {
    this.intensity = Math.max(0, Math.min(2, level));
  }

  /** «Море волнуется»: плёнку зажевало — звук проседает вниз и гаснет. Место в песне сохраняется. */
  tapeStop(): void {
    if (!this.running || this.mode !== 'play') {
      this.hardStop();
      return;
    }
    const now = this.ctx.currentTime;
    const T = 0.35;
    for (const l of this.live) {
      if (l.until < now) continue;
      // без instanceof: на сервере (node-web-audio-api) глобальных классов узлов нет
      if ('detune' in l.src) {
        const o = l.src as OscillatorNode;
        o.detune.cancelScheduledValues(now);
        o.detune.setValueAtTime(0, now);
        o.detune.linearRampToValueAtTime(-2400, now + T);
      } else if ('playbackRate' in l.src) {
        const b = l.src as AudioBufferSourceNode;
        b.playbackRate.cancelScheduledValues(now);
        b.playbackRate.setValueAtTime(1, now);
        b.playbackRate.linearRampToValueAtTime(0.25, now + T);
      }
    }
    // ноты планируются чуть вперёд: место паузы — первая ещё не прозвучавшая шестнадцатая
    // (через границу такта — только у своей песни темы: у общей мотив делится на части)
    const pending = this.sched.find((x) => x.t > now);
    if (pending && (pending.bar === this.bar || this.song)) {
      this.bar = pending.bar;
      this.s16 = pending.s16;
    }
    this.sched = [];
    const bus = this.bus;
    if (bus) {
      bus.gain.cancelScheduledValues(now);
      bus.gain.setValueAtTime(bus.gain.value, now);
      bus.gain.exponentialRampToValueAtTime(0.0001, now + T + 0.05);
      // при офлайн-записи (manual) всё планируется заранее: отключить шину по таймеру — потерять хвост звука
      if (!this.manual) setTimeout(() => bus.disconnect(), (T + 0.15) * 1000);
    }
    this.bus = null;
    this.clearTimer();
    this.live = [];
    this.paused = true;
  }

  /** После паузы — песня продолжается с той же ноты, где её оборвало (мягко нарастая). */
  resume(): void {
    if (!this.paused || this.mode !== 'play') return;
    this.paused = false;
    this.openBus();
    const t = this.ctx.currentTime + 0.03;
    const bus = this.bus!;
    const full = bus.gain.value;
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.exponentialRampToValueAtTime(full, t + 0.12);
    this.next = t;
    this.run();
  }

  stop(): void {
    this.hardStop();
    this.mode = 'off';
    this.paused = false;
  }

  // ───────────── внутреннее ─────────────

  private openBus(): void {
    this.bus = this.ctx.createGain();
    this.bus.gain.value = 0.32;
    // подача под динамик телефона: низ тише (его слышно обертонами), середина ярче
    const low = this.ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 180;
    low.gain.value = -7;
    const mid = this.ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 2200;
    mid.Q.value = 0.7;
    mid.gain.value = 4;
    this.bus.connect(low).connect(mid).connect(this.out);
    this.drive = null;
    this.echo = null;
    if (this.flavor.echo) {
      const d = this.ctx.createDelay(1);
      d.delayTime.value = (60 / this.flavor.bpm) * 0.75;
      const fb = this.ctx.createGain();
      fb.gain.value = 0.28;
      const wet = this.ctx.createGain();
      wet.gain.value = 0.35;
      d.connect(fb).connect(d);
      d.connect(wet).connect(this.bus);
      this.echo = d;
    }
  }

  private clearTimer(): void {
    if (this.timer !== null && this.timer !== MANUAL) window.clearInterval(this.timer);
    this.timer = null;
    this.tickFn = null;
  }

  /** Ручной режим: спланировать ноты до «сейчас» + запас (вызывать каждый кадр). */
  pump(): void {
    this.tickFn?.();
  }

  private hardStop(): void {
    this.clearTimer();
    this.bus?.disconnect();
    this.bus = null;
    this.live = [];
  }

  private run(): void {
    const tick = () => {
      if (!this.bus) return;
      const now = this.ctx.currentTime;
      // если вкладка спала — не догонять пропущенные ноты пачкой
      if (this.next < now - 0.2) this.next = now + 0.05;
      while (this.next < now + 0.12) {
        if (this.mode === 'accuse') this.stepAccuse();
        else if (this.mode === 'menu') {
          if (this.festive) this.stepMenuNewYear();
          else this.stepMenu();
        }
        else this.stepPlay();
      }
      this.live = this.live.filter((l) => l.until > now - 0.1);
    };
    this.tickFn = tick;
    this.timer = this.manual ? MANUAL : window.setInterval(tick, 25);
    tick();
  }

  private make(kind: SectionKind): Section {
    const bars = kind === 'intro' ? 2 : kind === 'C' ? 2 : 4;
    const muts: Section['muts'] = [];
    for (let i = 0; i < bars * 8; i++) {
      const r = this.rng();
      muts.push(kind !== 'A2' ? 'keep' : r < 0.18 ? 'pass' : r < 0.3 ? 'oct' : r < 0.36 ? 'rest' : r < 0.46 ? 'dbl' : 'keep');
    }
    return { kind, bars, muts };
  }

  /** Следующая часть песни: тема хотя бы раз в три части, без двух одинаковых подряд. */
  private nextSection(): Section {
    if (this.queue.length) return this.queue.shift()!;
    const prev = this.sec.kind;
    let kind: SectionKind;
    if (this.sinceA >= 2) kind = this.rng() < 0.5 ? 'A' : 'A2';
    else {
      const pool: SectionKind[] = (['A2', 'B', 'C', 'A'] as SectionKind[]).filter((k) => k !== prev);
      kind = pool[Math.floor(this.rng() * pool.length)];
    }
    this.sinceA = kind === 'A' || kind === 'A2' ? 0 : this.sinceA + 1;
    return this.make(kind);
  }

  private advanceBar(): void {
    this.bar++;
    if (this.bar >= this.sec.bars) {
      this.sec = this.nextSection();
      this.bar = 0;
    }
  }

  private sixteenth(): number {
    // темп подтягивается к цели плавно, по шестнадцатым
    const target = 1 + this.intensity * 0.04;
    this.tempoMul += (target - this.tempoMul) * 0.05;
    return 60 / (this.flavor.bpm * this.tempoMul) / 4;
  }

  private stepPlay(): void {
    if (this.pendingTwist !== null && this.s16 === 0) {
      this.twist = this.pendingTwist;
      this.twistBar = this.bar;
      this.pendingTwist = null;
    }
    // где в песне каждая запланированная шестнадцатая — чтобы пауза продолжилась ровно с неё
    this.sched.push({ t: this.next, bar: this.bar, s16: this.s16 });
    if (this.sched.length > 8) this.sched.shift();
    // последние 10 с дубля: «часы тикают» — тик-так на каждую долю, слышно на любом динамике
    if (this.intensity >= 2 && this.s16 % 4 === 0) this.clockTick(this.next, this.s16 % 8 === 0);
    if (this.song) {
      const dt = this.sixteenth();
      this.song.step(this.api, {
        s16: this.s16,
        bar: this.bar,
        t: this.next,
        dt,
        intensity: this.intensity,
        twist: this.twist,
        barsSinceTwist: this.bar - this.twistBar,
      });
      this.next += dt;
      this.s16 = (this.s16 + 1) % 16;
      if (this.s16 === 0) this.bar++;
      return;
    }
    const f = this.flavor;
    const dt = this.sixteenth();
    const s = this.s16;
    const swing = s % 2 === 1 ? f.swing * dt : 0;
    const t = this.next + swing;
    const k = 120 / (f.bpm * this.tempoMul); // длительности исходника заданы для 120 BPM
    const sec = this.sec;
    const motif = this.bar % 4;
    const lastBar = this.bar === sec.bars - 1;
    const fill = lastBar && s >= 12 && sec.kind !== 'intro';
    const I = this.intensity;
    const bassN = BASS[motif * 4 + Math.floor(s / 4)];
    const leadN = (i: number) => LEAD[motif * 4 + (i % 4)];

    // ── ударные (исходный грув + слои напряжения) ──
    const kick = (I >= 1 && (s === 0 || s === 8)) || (I >= 2 && (s === 4 || s === 12)) || (sec.kind === 'B' && s === 0);
    if (kick && sec.kind !== 'C') this.kick(t);
    const hatEvery = I >= 2 ? 1 : I >= 1 || sec.kind === 'B' ? 2 : 4;
    if (sec.kind !== 'C' && (hatEvery === 4 ? s % 4 === 2 : s % hatEvery === 0)) this.hit(0.03, I >= 2 && s % 2 ? 0.03 : 0.05, 6000, t);
    if (fill) this.hit(0.06, 0.06 + (s - 12) * 0.015, 1200, t);
    else if (s === 4 || s === 12) this.hit(0.08, 0.1, 1200, t);
    else if (sec.kind === 'C' && s === 8) this.hit(0.12, 0.08, 900, t);

    // ── бас ──
    if (sec.kind === 'B') {
      if (s % 2 === 0) this.voice(f.bass, bassN + (s % 4 === 2 ? 12 : 0), t, 0.11 * k, 0.15);
    } else if (sec.kind === 'C') {
      if (s === 0 || s === 8) this.voice(f.bass, BASS[motif * 4 + s / 4], t, 0.5 * k, 0.16);
    } else if (s % 4 === 0) this.voice(f.bass, bassN, t, 0.2 * k, 0.18);

    // ── мелодия ──
    if (sec.kind === 'A' || sec.kind === 'A2') {
      if (s % 2 === 0) {
        const i = s / 2;
        let n = leadN(i) + (s >= 8 ? 12 : 0);
        const mut = sec.muts[this.bar * 8 + i];
        if (fill && sec.kind === 'A2') {
          // сбивка в конце вариации: сбег по ладу шестнадцатыми
          n = scaleStep(leadN(3) + 12, -(s - 12));
          this.voice(f.lead, n, t, 0.06 * k, 0.08);
          this.voice(f.lead, scaleStep(n, -1), t + dt, 0.06 * k, 0.07);
        } else if (mut !== 'rest') {
          if (mut === 'pass') n = scaleStep(n, this.rng() < 0.5 ? 1 : -1);
          if (mut === 'oct') n += n > 80 ? -12 : 12;
          this.voice(f.lead, n, t, 0.1 * k, 0.09);
          if (mut === 'dbl') this.voice(f.lead, n, t + dt, 0.06 * k, 0.07);
          if (I >= 2) this.voice(f.lead, n + 12, t, 0.08 * k, 0.04);
        }
      }
    } else if (sec.kind === 'B') {
      // арпеджио по нотам того же такта: гармония та же, ритм другой
      const notes = [0, 1, 2, 3].map((i) => leadN(i)).sort((a, b) => a - b);
      const order = [0, 1, 2, 3, 3, 2, 1, 0];
      this.voice(f.lead, notes[order[s % 8]] + 12, t, 0.07 * k, 0.065);
    } else if (sec.kind === 'C') {
      if (s % 4 === 0) this.voice(f.lead, leadN(s / 4), t, 0.3 * k, 0.08);
    }
    // тихое арпеджио у «звонких» тем и на пике напряжения
    if ((f.arp || I >= 1) && sec.kind !== 'B' && sec.kind !== 'intro' && s % 2 === 1) {
      this.voice('sine', leadN(Math.floor(s / 2) + 1) + 24, t, 0.05 * k, f.arp ? 0.035 : 0.025);
    }

    this.next += dt;
    this.s16++;
    if (this.s16 >= 16) {
      this.s16 = 0;
      this.advanceBar();
    }
  }

  /** Меню: тема четвертями на чётных тактах, арпеджио восьмыми на нечётных; щётки и римшот. */
  private stepMenu(): void {
    if (this.orch && this.s16 === 0) this.alignBar(false);
    const f = this.flavor;
    const dt = 60 / f.bpm / 4;
    const s = this.s16;
    const t = this.next + (s % 2 === 1 ? f.swing * dt : 0);
    const motif = this.bar % 4;
    const phrase = Math.floor(this.bar / 4) % 2; // каждые 4 такта — другая подача
    const lead = (i: number) => LEAD[motif * 4 + (i % 4)];
    if (this.plays('bass')) {
      if (s === 0 || s === 8) this.voice(f.bass, BASS[motif * 4 + s / 4], t, 0.7, 0.14);
      if (s === 14) this.voice(f.bass, BASS[motif * 4 + 3], t, 0.15, 0.1);
    }
    if (this.plays('drums')) {
      if (s % 4 === 2) this.hit(0.05, 0.022, 7000, t);
      if (s === 12) this.hit(0.03, 0.04, 2500, t);
    }
    if (phrase === 0 ? this.bar % 2 === 0 : this.bar % 2 === 1) {
      if (s % 4 === 0 && this.plays('lead')) this.voice(f.lead, lead(s / 4), t, 0.45, 0.07);
    } else if (s % 2 === 0 && this.plays('arp')) {
      const notes = [0, 1, 2, 3].map(lead).sort((a, b) => a - b);
      this.voice(f.lead, notes[[0, 1, 2, 3, 2, 1, 3, 2][s / 2]] + 12, t, 0.2, 0.045);
    }
    // оркестр: четвёртому телефону — тихий аккорд-подушка из нот такта (без оркестра его нет)
    if (this.orch && this.roles?.has('pad') && s === 0) {
      const notes = [0, 1, 2, 3].map(lead).sort((a, b) => a - b);
      for (const n of notes.slice(0, 3)) this.voice('triangle', n, t, dt * 15, 0.025);
    }
    this.next += dt;
    this.s16 = (s + 1) % 16;
    if (this.s16 === 0) this.bar++;
  }

  /**
   * Новогоднее меню: тот же круг и мелодия, что в «Корпоративе», но спокойно — бас на сильные доли,
   * тихий аккорд-подушка, бубенцы шаффлом; мелодия колокольчиком, во второй фразе — октавой ниже
   * с подголоском; в конце круга — звон сверху вниз.
   */
  private stepMenuNewYear(): void {
    if (this.orch && this.s16 === 0) this.alignBar(false);
    const f = this.flavor;
    const dt = 60 / f.bpm / 4;
    const s = this.s16;
    const t = this.next + (s % 2 === 1 ? f.swing * dt : 0);
    const ch = this.bar % 4;
    const root = NY_ROOTS[ch];
    const tri = NY_TRIADS[ch];
    const phrase = Math.floor(this.bar / 4) % 2;
    if (this.plays('bass')) {
      if (s === 0) this.voice(f.bass, root, t, dt * 6, 0.13);
      if (s === 8) this.voice(f.bass, root + 7, t, dt * 6, 0.11);
    }
    if (s === 0 && this.plays('pad')) for (const iv of tri) this.voice('sine', root + 24 + iv, t, dt * 14, this.orch ? 0.03 : 0.018);
    if (this.plays('drums')) {
      if (s % 2 === 0) this.hit(0.025, s % 4 === 2 ? 0.03 : 0.018, 8500, t);
      if (s === 12 && this.bar % 2 === 1) this.hit(0.04, 0.035, 2600, t);
    }
    const m = this.plays('lead') ? nyMelodyAt(ch, s) : null;
    if (m) {
      if (phrase === 0) {
        this.voice('sine', m[0] + 12, t, dt * 0.7, 0.03);
        this.voice('triangle', m[0], t, dt * m[1] * 0.9, 0.05);
      } else {
        this.voice('triangle', m[0] - 12, t, dt * m[1] * 0.9, 0.05);
        this.voice('sine', m[0] + 7, t, dt * 0.6, 0.015);
      }
    }
    if (ch === 3 && s >= 12 && s % 2 === 0 && this.plays('arp')) this.voice('sine', 91 - (s - 12) * 2, t, dt * 1.5, 0.02);
    this.next += dt;
    this.s16 = (s + 1) % 16;
    if (this.s16 === 0) this.bar++;
  }

  /**
   * Обвинение: сердцебиение с «туком» на 1 кГц и тиканье часов, всё чаще к концу (фаза ~5 с).
   * Слышно на любом динамике: удар сердца — щелчок сверху, бас — только опора.
   */
  private stepAccuse(): void {
    const sec = this.ctx.currentTime - this.startedAt;
    const bpm = 76 + Math.min(1, sec / 5) * 40;
    const dt = 60 / bpm / 4;
    const t = this.next;
    const s = this.s16;
    const beat = (v: number, from: number) => {
      this.kick(t, v, from);
      this.hit(0.035, v * 4, 1000, t);
      this.osc('triangle', 520, t, 0.06, v * 0.9, this.bus!);
    };
    if (s === 0) beat(0.32, 70);
    if (s === 3) beat(0.2, 60);
    if (s % 4 === 0) {
      this.hit(0.015, 0.3, 3200, t);
      this.osc('square', s % 8 ? 1760 : 2093, t, 0.02, 0.14, this.bus!);
    }
    if (s === 8 && this.bar % 2 === 1) this.voice('triangle', BASS[(this.bar * 4) % 16] + 24, t, 0.6, 0.08);
    this.next += dt;
    this.s16 = (s + 1) % 16;
    if (this.s16 === 0) this.bar++;
  }

  private voice(type: OscillatorType | 'pulse', midi: number, when: number, dur: number, vol: number): void {
    const bus = this.bus;
    if (!bus) return;
    const freq = mtf(midi + this.flavor.transpose);
    // низкие ноты чистым тоном телефон не играет: громкость басу даёт не уровень, а обертоны
    let v = vol;
    if (freq < BASS_HZ) {
      if (type === 'triangle' || type === 'sine') {
        this.osc('square', freq * 2, when, dur, vol * (type === 'sine' ? 0.28 : 0.38), bus);
        v = vol * 0.75;
      } else v = vol * 0.8;
    }
    this.osc(type, freq, when, dur, v, bus, this.echo && type !== this.flavor.bass ? this.echo : null);
  }

  private osc(type: OscillatorType | 'pulse', freq: number, when: number, dur: number, vol: number, bus: AudioNode, echo: AudioNode | null = null): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    if (type === 'pulse') o.setPeriodicWave(this.pulse);
    else o.type = type;
    o.frequency.setValueAtTime(freq, when);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(vol, when + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g).connect(bus);
    if (echo) g.connect(echo);
    o.start(when);
    o.stop(when + dur + 0.02);
    this.live.push({ src: o, until: when + dur });
  }

  /** Перегруз: квинта + октава пилой через «овердрайв» и фильтр — гитара 90-х из синтезатора. */
  private power(midi: number, when: number, dur: number, vol: number, iv: readonly number[] = [0, 7, 12]): void {
    const bus = this.bus;
    if (!bus) return;
    const ctx = this.ctx;
    if (!this.drive) {
      const shaper = ctx.createWaveShaper();
      const n = 1024;
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * 6) * 0.8;
      }
      shaper.curve = curve;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2600;
      // гул ниже 120 Гц у гитары телефон не играет, а громкость он съедает
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 120;
      const out = ctx.createGain();
      out.gain.value = 0.55;
      shaper.connect(hp).connect(lp).connect(out).connect(bus);
      this.drive = shaper;
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(vol, when + 0.008);
    g.gain.setValueAtTime(vol, when + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    g.connect(this.drive);
    iv.forEach((step, k) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(mtf(midi + step + this.flavor.transpose), when);
      o.detune.value = [-6, 5, 0, 3][k % 4];
      o.connect(g);
      o.start(when);
      o.stop(when + dur + 0.02);
      this.live.push({ src: o, until: when + dur });
    });
  }

  /** Тик часов: щелчок и короткий звон (тик выше, так ниже). */
  private clockTick(when: number, tick: boolean): void {
    const bus = this.bus;
    if (!bus) return;
    this.hit(0.012, 0.3, tick ? 4200 : 3400, when);
    this.osc('square', tick ? 3136 : 2637, when, 0.018, 0.05, bus);
  }

  /** Бочка: синус вниз — опора, и «тук» на 1–2 кГц — то, что от неё слышно на телефоне. */
  private kick(when: number, vol = 0.3, from = 150): void {
    const bus = this.bus;
    if (!bus) return;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(from, when);
    o.frequency.exponentialRampToValueAtTime(42, when + 0.12);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol * 0.8, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.16);
    o.connect(g).connect(bus);
    o.start(when);
    o.stop(when + 0.18);
    this.live.push({ src: o, until: when + 0.16 });
    this.hit(0.018, vol * 0.9, 1600, when);
    this.osc('square', Math.min(from, 160) * 2, when, 0.04, vol * 0.25, bus);
  }

  private hit(dur: number, vol: number, freq: number, when: number): void {
    const bus = this.bus;
    if (!bus) return;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    s.connect(f).connect(g).connect(bus);
    s.start(when, Math.random() * 0.5);
    s.stop(when + dur + 0.02);
    this.live.push({ src: s, until: when + dur });
  }
}
