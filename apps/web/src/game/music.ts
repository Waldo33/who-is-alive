/**
 * Музыка игры: маленький секвенсор на Web Audio. Всё растёт из одной темы — исходного чиптюн-лупа
 * (бас квадратом, мелодия треугольником, хэт и малый на слабые доли). Чтобы не надоедало:
 *  - песня собирается из частей: вступление → тема → вариация → «B» (арпеджио по тем же нотам)
 *    → тема → … с барабанными сбивками на стыках; вариации мелодии случайны в каждом раунде;
 *  - у каждой темы раунда свой характер (тональность, темп, свинг, тембр), но мотив тот же;
 *  - напряжение растёт к концу раунда: бочка, частый хэт, мелодия октавой выше, темп быстрее;
 *  - «Море волнуется» обрывает музыку эффектом зажёванной плёнки, после паузы песня
 *    продолжается с того же места, а не с начала;
 *  - в фазе обвинения — сердцебиение.
 */

/** Исходная тема: бас по четвертям, мелодия восьмыми (вторая половина такта — октавой выше). */
const BASS = [45, 45, 52, 45, 48, 48, 55, 48, 41, 41, 48, 41, 43, 43, 50, 47];
const LEAD = [69, 72, 76, 72, 72, 76, 79, 76, 65, 69, 72, 69, 67, 71, 74, 71];
/** Ля минор (натуральный) — для проходящих нот вариаций. */
const SCALE = [0, 2, 3, 5, 7, 8, 10];
const ROOT = 57;

export type MusicMode = 'off' | 'menu' | 'play' | 'accuse';

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
  /** Перегруженный квинтаккорд («пауэр-корд» гитары). */
  power(midi: number, when: number, dur: number, vol: number): void;
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
}

/** Меню и лобби: та же тема «лаунжем» — медленно, мягко, с эхом. */
const MENU: Flavor = { transpose: 0, bpm: 92, swing: 0.18, lead: 'sine', bass: 'triangle', arp: false, echo: true };

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

export class Music {
  private bus: GainNode | null = null;
  private echo: DelayNode | null = null;
  private timer: number | null = null;
  private next = 0;
  private s16 = 0;
  private bar = 0;
  private sec: Section;
  private queue: Section[] = [];
  private rng = rngFrom(1);
  private flavor: Flavor = PARK_FLAVOR;
  private song: Song | null = null;
  private twist = false;
  private twistBar = 0;
  private drive: AudioNode | null = null;
  private readonly api: SongApi = {
    voice: (type, midi, when, dur, vol) => this.voice(type, midi, when, dur, vol),
    kick: (when, vol, from) => this.kick(when, vol, from),
    hit: (dur, vol, freq, when) => this.hit(dur, vol, freq, when),
    power: (midi, when, dur, vol) => this.power(midi, when, dur, vol),
    rng: () => this.rng(),
  };
  private intensity = 0;
  private tempoMul = 1;
  private live: Live[] = [];
  private pulse: PeriodicWave;
  private sinceA = 0;
  mode: MusicMode = 'off';
  /** Пауза «Море волнуется»: музыка остановлена, но место в песне помним. */
  paused = false;

  constructor(
    private ctx: AudioContext,
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

  /** Новый раунд (или новая фаза): тема раунда задаёт характер, вариации — новые. */
  start(mode: MusicMode, style?: { flavor: Flavor; song?: Song }): void {
    this.hardStop();
    this.mode = mode;
    this.paused = false;
    this.twist = false;
    if (mode === 'off') return;
    this.flavor = mode === 'menu' ? MENU : (style?.flavor ?? PARK_FLAVOR);
    this.song = mode === 'play' ? (style?.song ?? null) : null;
    this.rng = rngFrom((Math.random() * 2 ** 31) | 0);
    this.intensity = 0;
    this.tempoMul = 1;
    this.queue = mode === 'play' ? [this.make('intro'), this.make('A'), this.make('A2'), this.make('B'), this.make('A')] : [];
    this.sec = this.queue.shift() ?? this.make('A');
    this.sinceA = 0;
    this.bar = 0;
    this.s16 = 0;
    this.openBus();
    this.next = this.ctx.currentTime + 0.06;
    this.run();
  }

  /** Изнанка темы: своя песня меняет подачу (тихий куплет → громкий припев). */
  setTwist(on: boolean): void {
    if (on === this.twist) return;
    this.twist = on;
    this.twistBar = this.bar;
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
      if (l.src instanceof OscillatorNode) {
        l.src.detune.cancelScheduledValues(now);
        l.src.detune.setValueAtTime(0, now);
        l.src.detune.linearRampToValueAtTime(-2400, now + T);
      } else if (l.src instanceof AudioBufferSourceNode) {
        l.src.playbackRate.cancelScheduledValues(now);
        l.src.playbackRate.setValueAtTime(1, now);
        l.src.playbackRate.linearRampToValueAtTime(0.25, now + T);
      }
    }
    const bus = this.bus;
    if (bus) {
      bus.gain.cancelScheduledValues(now);
      bus.gain.setValueAtTime(bus.gain.value, now);
      bus.gain.exponentialRampToValueAtTime(0.0001, now + T + 0.05);
      setTimeout(() => bus.disconnect(), (T + 0.15) * 1000);
    }
    this.bus = null;
    this.clearTimer();
    this.live = [];
    this.paused = true;
  }

  /** После паузы — короткий «перезапуск» и песня дальше со следующего такта. */
  resume(): void {
    if (!this.paused || this.mode !== 'play') return;
    this.paused = false;
    this.openBus();
    const t = this.ctx.currentTime + 0.03;
    this.voice(this.flavor.lead, 69 - 12, t, 0.06, 0.08);
    this.voice(this.flavor.lead, 76 - 12, t + 0.06, 0.06, 0.08);
    this.voice(this.flavor.lead, 81 - 12, t + 0.12, 0.1, 0.09);
    this.advanceBar();
    this.s16 = 0;
    this.next = t + 0.24;
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
    this.bus.connect(this.out);
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
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
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
        else if (this.mode === 'menu') this.stepMenu();
        else this.stepPlay();
      }
      this.live = this.live.filter((l) => l.until > now - 0.1);
    };
    this.timer = window.setInterval(tick, 25);
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
    const f = this.flavor;
    const dt = 60 / f.bpm / 4;
    const s = this.s16;
    const t = this.next + (s % 2 === 1 ? f.swing * dt : 0);
    const motif = this.bar % 4;
    const phrase = Math.floor(this.bar / 4) % 2; // каждые 4 такта — другая подача
    const lead = (i: number) => LEAD[motif * 4 + (i % 4)];
    if (s === 0 || s === 8) this.voice(f.bass, BASS[motif * 4 + s / 4], t, 0.7, 0.14);
    if (s === 14) this.voice(f.bass, BASS[motif * 4 + 3], t, 0.15, 0.1);
    if (s % 4 === 2) this.hit(0.05, 0.022, 7000, t);
    if (s === 12) this.hit(0.03, 0.04, 2500, t);
    if (phrase === 0 ? this.bar % 2 === 0 : this.bar % 2 === 1) {
      if (s % 4 === 0) this.voice(f.lead, lead(s / 4), t, 0.45, 0.07);
    } else if (s % 2 === 0) {
      const notes = [0, 1, 2, 3].map(lead).sort((a, b) => a - b);
      this.voice(f.lead, notes[[0, 1, 2, 3, 2, 1, 3, 2][s / 2]] + 12, t, 0.2, 0.045);
    }
    this.next += dt;
    this.s16 = (s + 1) % 16;
    if (this.s16 === 0) this.bar++;
  }

  /** Обвинение: сердцебиение и тихое тиканье. */
  private stepAccuse(): void {
    const dt = 60 / 76 / 4;
    const t = this.next;
    const s = this.s16;
    if (s === 0) this.kick(t, 0.32, 70);
    if (s === 2) this.kick(t, 0.18, 60);
    if (s % 4 === 0) this.hit(0.02, 0.03, 5000, t);
    if (s === 8 && this.bar % 2 === 1) this.voice('triangle', BASS[(this.bar * 4) % 16] + 12, t, 0.6, 0.04);
    this.next += dt;
    this.s16 = (s + 1) % 16;
    if (this.s16 === 0) this.bar++;
  }

  private voice(type: OscillatorType | 'pulse', midi: number, when: number, dur: number, vol: number): void {
    const bus = this.bus;
    if (!bus) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    if (type === 'pulse') o.setPeriodicWave(this.pulse);
    else o.type = type;
    o.frequency.setValueAtTime(mtf(midi + this.flavor.transpose), when);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(vol, when + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g).connect(bus);
    if (this.echo && type !== this.flavor.bass) g.connect(this.echo);
    o.start(when);
    o.stop(when + dur + 0.02);
    this.live.push({ src: o, until: when + dur });
  }

  /** Перегруз: квинта + октава пилой через «овердрайв» и фильтр — гитара 90-х из синтезатора. */
  private power(midi: number, when: number, dur: number, vol: number): void {
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
      const out = ctx.createGain();
      out.gain.value = 0.55;
      shaper.connect(lp).connect(out).connect(bus);
      this.drive = shaper;
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(vol, when + 0.008);
    g.gain.setValueAtTime(vol, when + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    g.connect(this.drive);
    for (const [iv, det] of [[0, -6], [7, 5], [12, 0]] as const) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(mtf(midi + iv + this.flavor.transpose), when);
      o.detune.value = det;
      o.connect(g);
      o.start(when);
      o.stop(when + dur + 0.02);
      this.live.push({ src: o, until: when + dur });
    }
  }

  private kick(when: number, vol = 0.3, from = 150): void {
    const bus = this.bus;
    if (!bus) return;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(from, when);
    o.frequency.exponentialRampToValueAtTime(42, when + 0.12);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.16);
    o.connect(g).connect(bus);
    o.start(when);
    o.stop(when + 0.18);
    this.live.push({ src: o, until: when + 0.16 });
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
