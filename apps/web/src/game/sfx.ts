/**
 * Эффекты игры — синтез на Web Audio без DOM: один и тот же код звучит в игре (audio.ts),
 * в клипе на телефоне (clip-audio.ts → MediaStream) и в фильме матча на сервере (офлайн-рендер).
 */
export type Sfx =
  | 'step' | 'hitPlayer' | 'hitBot' | 'poof' | 'starTake' | 'starSpawn' | 'crowd' | 'tick'
  | 'click' | 'ready' | 'accuseRight' | 'accuseWrong' | 'fanfare' | 'sad' | 'hedge' | 'pigeon' | 'drum' | 'denied' | 'count' | 'swing' | 'flicker' | 'dusk' | 'siren' | 'whack' | 'clang' | 'stab' | 'knockedOut'
  | 'hitOther' | 'cut' | 'clap' | 'logo' | 'wrap' | 'unmask';

/**
 * Приоритет эффекта (звуковой гайд, план звука): P1 — меняет решение игрока, обязан пробиться
 * через музыку (на динамике телефона −30…−33 дБ, музыку глушит на 9 дБ на 0,6 с); P2 — событие
 * на поле (−35…−39 дБ, глушит на 4 дБ); остальное — фон. Уровни проверяет `pnpm --filter web sound-check`.
 */
export const P1: ReadonlySet<Sfx> = new Set<Sfx>(['hitPlayer', 'hitBot', 'starTake', 'crowd', 'ready', 'knockedOut', 'cut', 'drum', 'accuseRight', 'accuseWrong', 'unmask', 'wrap', 'logo']);
export const P2: ReadonlySet<Sfx> = new Set<Sfx>(['hitOther', 'whack', 'clang', 'stab', 'starSpawn', 'flicker', 'dusk']);

export class Synth {
  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly out: AudioNode,
    private readonly noiseBuf: AudioBuffer,
  ) {}

  /**
   * Сыграть эффект сейчас (по часам контекста). step — ступень для звуков с нарастанием (звезда).
   * Телефон не играет ниже ~350 Гц: всё важное звучит обертонами 1–5 кГц, бас — только опора.
   */
  play(name: Sfx, step = 0): void {
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
        this.noise(0.03, 1, 3400);
        this.noise(0.18, 0.9, 1200);
        this.tone('square', 480, 120, 0.24, 0.36);
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
      case 'accuseWrong': this.tone('sawtooth', 440, 220, 0.4, 0.16); this.tone('sawtooth', 466, 200, 0.4, 0.1); break;
      case 'fanfare': [523, 659, 784, 1047, 784, 1047].forEach((f, i) => this.tone('square', f, f, 0.16, 0.16, i * 0.12)); break;
      // «Слишком живые!» — грустный тромбон: три ступени вниз и долгая нота с вибрато
      case 'sad': [392, 370, 349].forEach((f, i) => this.tone('sawtooth', f, f * 0.98, 0.32, 0.12, i * 0.36)); this.sadTail(1.08); break;
      case 'hedge': this.noise(0.4, 0.06, 600); break;
      case 'pigeon': for (let i = 0; i < 4; i++) this.noise(0.04, 0.12, 3000, i * 0.05); break;
      // разоблачение: «смотрим отснятое» — стрёкот проектора нарастает и обрывается ударом (2–6 кГц)
      case 'drum':
        this.projector(0, 0.98, 0.25, 0.9);
        this.projector(1 / 36, 0.95, 0.15, 0.7);
        this.noise(0.25, 1, 1800, 0.98);
        this.noise(0.05, 1, 3600, 0.98);
        this.tone('square', 392, 196, 0.22, 0.35, 0.98);
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
      // хлопушка перед дублем в фильме матча
      case 'clap': this.clapper(); break;
      // живой раскрыт: удар и нота; каждый следующий живой — выше (step — его номер)
      case 'unmask': {
        const k = Math.pow(2, (Math.max(1, step) - 1) * 3 / 12);
        this.noise(0.04, 1, 3200);
        this.noise(0.12, 0.9, 1300);
        this.tone('square', 880 * k, 880 * k, 0.16, 0.36, 0.02);
        this.tone('triangle', 1760 * k, 1760 * k, 0.14, 0.16, 0.02);
        break;
      }
      // звуковой логотип: хлопушка и четыре ноты общей темы (ля–до–ми, и снова до — к началу), 1,2 с
      case 'logo': this.logo(0); break;
      // «Снято!»: хлопушка, логотип и аккорд — конец матча (голос и аплодисменты — после записи)
      case 'wrap':
        this.logo(0);
        [523, 659, 784, 1047].forEach((f) => this.tone('square', f, f, 0.6, 0.07, 0.95));
        this.tone('triangle', 2093, 2093, 0.5, 0.08, 0.95);
        break;
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
  /** Звуковой логотип: хлопушка и ля–до–ми–до (мотив общей темы) квадратом с колокольчиком сверху. */
  private logo(when: number): void {
    this.clapper(when);
    const notes: [number, number, number][] = [[880, 0.16, 0.1], [1047, 0.32, 0.1], [1319, 0.48, 0.1], [1047, 0.64, 0.5]];
    for (const [f, at, dur] of notes) {
      this.tone('square', f, f, dur, 0.22, when + at);
      this.tone('triangle', f * 2, f * 2, dur * 0.8, 0.08, when + at);
    }
  }

  /**
   * Проектор: стрёкот обтюратора (18 щелчков в секунду, 3–5 кГц) и гул мотора; громкость идёт от v0
   * к v1 за dur секунд. Слышен на любом динамике.
   */
  projector(when: number, dur: number, v0: number, v1: number): void {
    const n = Math.max(1, Math.round(dur * 18));
    for (let i = 0; i < n; i++) {
      const k = i / n;
      const v = v0 + (v1 - v0) * k;
      this.noise(0.018, v, i % 2 ? 4200 : 3300, when + i / 18);
    }
    this.tone('sawtooth', 220, 220, dur, Math.max(v0, v1) * 0.06, when);
  }

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

  private sadTail(when: number): void {
    const ctx = this.ctx;
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
    o.connect(g).connect(this.out);
    o.start(t);
    lfo.start(t);
    o.stop(t + 1.15);
    lfo.stop(t + 1.15);
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, when = 0, out?: AudioNode): void {
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out ?? this.out);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noise(dur: number, vol: number, freq: number, when = 0, out?: AudioNode): void {
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(out ?? this.out);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.02);
  }

  /**
   * Сыграть эффект. step — ступень для звуков с нарастанием: звезда (1-я, 2-я, 3-я своя —
   * каждая на тон выше).
   */
}
