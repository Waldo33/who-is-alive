/**
 * Эффекты игры — синтез на Web Audio без DOM: один и тот же код звучит в игре (audio.ts),
 * в клипе на телефоне (clip-audio.ts → MediaStream) и в фильме матча на сервере (офлайн-рендер).
 */
export type Sfx =
  | 'step' | 'hitPlayer' | 'hitBot' | 'poof' | 'starTake' | 'starSpawn' | 'crowd' | 'tick'
  | 'click' | 'ready' | 'accuseRight' | 'accuseWrong' | 'fanfare' | 'sad' | 'hedge' | 'pigeon' | 'drum' | 'denied' | 'count' | 'swing' | 'flicker' | 'dusk' | 'siren' | 'whack' | 'clang' | 'stab' | 'knockedOut'
  | 'hitOther' | 'cut' | 'clap' | 'logo' | 'wrap' | 'unmask' | 'rewind' | 'leshyStep' | 'leshyBreath' | 'leshyStinger' | 'leshyTake' | 'leshyCall' | 'snap' | 'whisper' | 'scream' | 'fern'
  | 'bossAhem' | 'bossStamp';

/**
 * Приоритет эффекта (звуковой гайд, план звука): P1 — меняет решение игрока, обязан пробиться
 * через музыку (на динамике телефона −30…−33 дБ, музыку глушит на 9 дБ на 0,6 с); P2 — событие
 * на поле (−35…−39 дБ, глушит на 4 дБ); остальное — фон. Уровни проверяет `pnpm --filter web sound-check`.
 */
export const P1: ReadonlySet<Sfx> = new Set<Sfx>(['hitPlayer', 'hitBot', 'starTake', 'crowd', 'ready', 'knockedOut', 'cut', 'drum', 'accuseRight', 'accuseWrong', 'unmask', 'wrap', 'logo', 'leshyStinger', 'leshyTake', 'scream', 'fern', 'bossAhem']);
export const P2: ReadonlySet<Sfx> = new Set<Sfx>(['hitOther', 'whack', 'clang', 'stab', 'starSpawn', 'flicker', 'dusk', 'leshyBreath', 'bossStamp']);

/**
 * Частые звуки: каждый раз чуть другие (±30 центов, ±1,5 дБ), чтобы за три матча не стать
 * «пулемётом». Сигналы (команда, старт, логотип) не меняются — их узнают по звуку.
 */
const VARY: ReadonlySet<Sfx> = new Set<Sfx>(['step', 'hitPlayer', 'hitOther', 'hitBot', 'poof', 'starSpawn', 'tick', 'click', 'hedge', 'pigeon', 'whack', 'clang', 'stab', 'swing', 'unmask']);

/** Детский режим: без оружия, звона в ушах и пилы — удары «поф» и бумажный хлопок. */
const KIDS: Partial<Record<Sfx, Sfx>> = { whack: 'hitOther', clang: 'hitOther', stab: 'hitOther', knockedOut: 'cut', siren: 'starSpawn', scream: 'cut' };

export class Synth {
  /** Сдвиг высоты и громкости текущего эффекта (вариации). */
  private det = 1;
  private lvl = 1;
  /** Задержка текущего эффекта, с (третий важный звук ждёт, пока прозвучат два). */
  private base = 0;
  /** Детский режим (настройка комнаты): мягкие тембры. */
  kids = false;
  /** Куда сейчас идут слои эффекта: обычно на выход, у визга — через перегруз (scream). */
  private route: AudioNode | null = null;
  private get out(): AudioNode {
    return this.route ?? this.dest;
  }

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly dest: AudioNode,
    private readonly noiseBuf: AudioBuffer,
  ) {}

  /** Сыграть с задержкой delay секунд (правила смеси — audio.ts › play). */
  playAt(delay: number, name: Sfx, step = 0): void {
    this.base = delay;
    try {
      this.play(name, step);
    } finally {
      this.base = 0;
    }
  }

  /**
   * Сыграть эффект сейчас (по часам контекста). step — ступень для звуков с нарастанием (звезда).
   * Телефон не играет ниже ~350 Гц: всё важное звучит обертонами 1–5 кГц, бас — только опора.
   */
  play(name: Sfx, step = 0): void {
    if (this.kids) {
      name = KIDS[name] ?? name;
      if (this.kidsPlay(name)) return;
    }
    if (VARY.has(name)) {
      this.det = Math.pow(2, ((Math.random() * 2 - 1) * 30) / 1200);
      this.lvl = Math.pow(10, ((Math.random() * 2 - 1) * 1.5) / 20);
    }
    try {
      this.voice(name, step);
    } finally {
      this.det = 1;
      this.lvl = 1;
    }
  }

  /** Детский режим: свои мягкие удары. true — сыграно. */
  private kidsPlay(name: Sfx): boolean {
    switch (name) {
      // бумажный хлопок и мажорная квинта: награда без треска
      case 'hitPlayer':
        this.paperPop();
        this.tone('triangle', 1047, 1047, 0.1, 0.3, 0.05);
        this.tone('triangle', 1568, 1568, 0.24, 0.3, 0.14);
        return true;
      case 'hitOther': this.paperPop(); return true;
      // «упс»: хлопок и мягкое «у-у» вниз, без звона в ушах
      case 'cut':
        this.paperPop();
        this.tone('triangle', 660, 440, 0.25, 0.3, 0.12);
        this.tone('triangle', 520, 330, 0.35, 0.28, 0.4);
        return true;
      // бот: мягкое «боинг» вместо зуммера
      case 'hitBot': this.tone('triangle', 900, 260, 0.32, 0.55); this.tone('square', 1800, 520, 0.2, 0.1); return true;
      case 'accuseWrong': this.tone('triangle', 660, 440, 0.35, 0.3); return true;
      case 'sad': [784, 740, 698].forEach((f, i) => this.tone('triangle', f, f * 0.98, 0.3, 0.2, i * 0.3)); return true;
      default: return false;
    }
  }

  /** Бумажный хлопок: короткий широкий шум сверху и мягкий «пф». */
  private paperPop(): void {
    this.noise(0.04, 1, 2600);
    this.noise(0.14, 0.9, 1200, 0.01);
    this.tone('triangle', 760, 420, 0.1, 0.3, 0.01);
  }

  private voice(name: Sfx, step: number): void {
    switch (name) {
      case 'step': this.noise(0.03, 0.05, 1800); break;
      // шеф поворачивается: «Кхм-кхм» — два хриплых толчка горлом (шум в полосе голоса + жёсткий тон с обертонами)
      case 'bossAhem':
        for (const d of [0, 0.17]) {
          this.noise(0.09, 0.9, 1100, d);
          this.noise(0.06, 0.6, 2400, d + 0.01);
          this.tone('sawtooth', 380, 280, 0.1, 0.42, d);
          this.tone('square', 900, 660, 0.08, 0.2, d + 0.005);
        }
        break;
      // выговор: шлёп печатью «ВЫГОВОР» — глухой удар по столу и сухой щелчок
      case 'bossStamp':
        this.noise(0.06, 1, 1400);
        this.noise(0.04, 0.6, 3200, 0.005);
        this.tone('square', 620, 300, 0.12, 0.4);
        this.tone('triangle', 1240, 640, 0.09, 0.24);
        break;
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
      // Леший идёт («Купальская ночь»): шаг великана — глухой удар, хруст сучьев сверху, гул земли следом.
      // step 0–10 — насколько близко: далёкий шаг тихий и тупой, близкий — с треском. Слышат все одинаково.
      case 'leshyStep': {
        const k = Math.min(1, (step + 1) / 11);
        const v = 0.12 + 0.88 * k * k;
        this.tone('square', 150, 48, 0.32, 0.36 * v);
        this.tone('square', 420, 160, 0.2, 0.22 * v);
        this.noise(0.28, 1 * v, 720);
        this.noise(0.16, 1 * v, 1150, 0.005);
        this.noise(0.06, 0.7 * v * (0.3 + k), 1900, 0.01);
        if (k > 0.6) this.tone('triangle', 980, 720, 0.09, 0.14 * v, 0.05);
        // земля гудит ещё миг
        this.noise(0.5, 0.3 * v, 520, 0.12);
        break;
      }
      // Леший над лугом: долгий хриплый выдох и низкий стон
      case 'leshyBreath':
        this.swell(1.8, 0.32, 650, 0, 0.5);
        this.swell(1.6, 0.14, 1900, 0.1, 0.4);
        this.tone('sawtooth', 112, 84, 1.6, 0.12);
        this.tone('square', 224, 168, 1.4, 0.05);
        break;
      // Леший вышел на поляну: визг расстроенных струн (малые секунды наверху), скрежет и удар — как в
      // хорроре, когда монстр попадает в кадр. Сигнал: не шевелиться.
      case 'leshyStinger':
        this.tone('square', 190, 52, 0.5, 0.35);
        this.noise(0.05, 0.6, 3400);
        for (const [f, d] of [[1396, 0], [1480, 0.02], [1568, 0.04], [2093, 0.06]] as const) this.formant(f, f * 0.94, 1.3, 0.065, 0, d, [f * 1.0, f * 2.01], 6);
        this.swell(1.2, 0.24, 2900, 0, 0.08);
        this.swell(1.4, 0.14, 1200, 0.05, 0.1);
        break;
      // Леший забрал того, кто шевельнулся: треск ломаемых сучьев и обрывающийся крик
      case 'leshyTake':
        for (let i = 0; i < 4; i++) {
          this.noise(0.05, 0.9 - i * 0.15, 2600 - i * 300, i * 0.07);
          this.noise(0.1, 0.6, 1100, i * 0.07 + 0.01);
        }
        this.formant(920, 300, 0.7, 0.22, 0.05, 0.12, [900, 1300, 2600], 9);
        this.tone('square', 160, 40, 0.5, 0.4, 0.05);
        break;
      // скример: морда Лешего во весь экран (scene.ts › leshyScreamer, картинка по этим же отметкам).
      // Пугает не громкость, а скачок из тишины: никакого «вдоха» перед ударом (слабый звук за полсекунды
      // до удара гасит вздрагивание — сцена держит перед ним тишину), удар с атакой в пару мс. Визг — как
      // настоящий вопль ужаса: «шершавый» (громкость дрожит с частотой 70–140 Гц), нелинейный — высота
      // срывается скачками, под голосом субгармоника, всё через перегруз, как у динамика на пределе.
      // Начинается с «А» того «Ау», которым Леший звал всю ночь. 0,69 — бросок вплотную, второй взвизг;
      // потом — темнота, гул, сердце и у самого уха его сорванное «Ау-у». Слышит только вырезанный.
      case 'scream': {
        this.noise(0.04, 1, 3600);
        this.noise(0.03, 0.8, 5200);
        this.tone('square', 240, 50, 0.32, 0.45);
        this.noise(0.14, 0.75, 1300, 0.005);
        const ctx = this.ctx;
        const t0 = ctx.currentTime + this.base;
        const shaper = ctx.createWaveShaper();
        const curve = new Float32Array(1024);
        for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / (curve.length - 1)) * 2 - 1) * 5);
        shaper.curve = curve;
        const post = ctx.createGain();
        post.gain.setValueAtTime(0.42, t0);
        post.gain.setValueAtTime(0.42, t0 + 1.0);
        post.gain.linearRampToValueAtTime(0, t0 + 1.2);
        shaper.connect(post).connect(this.dest);
        this.route = shaper;
        try {
          // голоса: каждый — цепочка отрезков, высота срывается скачками до ±4 полутонов и в целом падает
          for (const [f, v] of [[1180, 0.16], [1250, 0.13], [1660, 0.09], [940, 0.12]] as const) {
            let w = 0;
            let fr = f * 1.08;
            while (w < 0.62) {
              const d = 0.07 + Math.random() * 0.09;
              const nf = fr * Math.pow(2, (Math.random() * 8 - 5) / 12);
              this.formant(fr, nf, d * 1.35, v, 0.05, w, [f, f * 2, 3000], 11 + Math.random() * 6, 70 + Math.random() * 70);
              fr = nf;
              w += d;
            }
          }
          // начало вопля — голос, который звал всю ночь: его «А» (форманты «Ау» из leshyCall) взлетает в визг
          this.formant(330, 1250, 0.11, 0.2, 0.05, 0, [820, 1180, 2500], 5, 60);
          // субгармоника под самым низким голосом и хрип выдоха
          this.formant(470, 300, 0.62, 0.1, 0.05, 0, [700, 1100, 2400], 7, 45);
          this.swell(0.62, 0.45, 2600, 0, 0.04);
          this.swell(0.5, 0.3, 1500, 0.02, 0.04);
          // бросок вплотную — второй взвизг выше
          const L = 0.69;
          for (const [f, am] of [[1480, 113], [1570, 97], [2093, 131]] as const) this.formant(f * 1.1, f * 0.72, 0.26, 0.12, 0.02, L, [f, f * 2, 3200], 14, am);
          this.swell(0.22, 0.4, 3000, L, 0.03);
        } finally {
          this.route = null;
        }
        this.noise(0.04, 0.95, 3400, 0.69);
        this.tone('square', 200, 45, 0.25, 0.4, 0.69);
        // темнота: он ещё здесь — у самого уха, медленно и сорванно, то же «Ау-у»
        {
          const sh2 = ctx.createWaveShaper();
          sh2.curve = curve;
          const g2 = ctx.createGain();
          g2.gain.value = 0.3;
          sh2.connect(g2).connect(this.dest);
          this.route = sh2;
          try {
            this.formant(250, 230, 0.5, 0.12, 0.2, 1.55, [820, 1180, 2500], 4, 41);
            this.formant(230, 160, 1.1, 0.12, 0.25, 1.95, [380, 760, 2300], 3, 37);
            this.swell(1.2, 0.18, 2400, 1.55, 0.3);
          } finally {
            this.route = null;
          }
        }
        // темнота: низкий гул и сердце
        this.swell(1.4, 0.12, 500, 1.0, 0.3);
        [1.1, 1.32, 1.9, 2.12].forEach((d, i) => {
          this.tone('sine', 72, 42, 0.2, i % 2 ? 0.25 : 0.35, d);
          this.noise(0.04, i % 2 ? 0.45 : 0.7, 1100, d);
          this.tone('square', 220, 120, 0.08, i % 2 ? 0.1 : 0.15, d);
        });
        break;
      }
      // «Ау-у…» из леса: Леший зовёт голосом заблудившегося и сам себе вторит эхом
      case 'leshyCall':
        for (let e = 0; e < 3; e++) {
          const v = [0.2, 0.09, 0.04][e];
          const w = e * 0.55;
          this.formant(330, 300, 0.45, v, 0.12, w, [820, 1180, 2500], 5);
          this.formant(300, 228, 1.0, v, 0.3, w + 0.38, [380, 760, 2300], 5);
        }
        break;
      // шёпот из темноты: без голоса, только дыхание через «гласные» — слоги неразборчивой речи,
      // шипящие сверху. Каждый раз другой. Общий (лес шепчет всем), со своим рассудком не связан.
      case 'whisper': {
        const n = 4 + Math.floor(Math.random() * 5);
        const vowels: [number, number][] = [[700, 1200], [400, 2000], [550, 900], [350, 800], [500, 1700]];
        let w = 0;
        for (let i = 0; i < n; i++) {
          const v = 0.55 + 0.45 * Math.sin((i / n) * Math.PI); // громче в середине фразы
          if (Math.random() < 0.6) this.noise(0.06, 0.32 * v, 3600 + Math.random() * 2400, w); // «с», «ш», «ф»
          const [f1, f2] = vowels[Math.floor(Math.random() * vowels.length)];
          const d = 0.1 + Math.random() * 0.12;
          this.swell(d, 0.5 * v, f2, w + 0.04, 0.3);
          this.swell(d, 0.3 * v, f1 + 600, w + 0.04, 0.3);
          w += d + 0.03 + (Math.random() < 0.2 ? 0.18 : 0);
        }
        // долгий выдох в конце фразы
        this.swell(0.5, 0.18, 2600, w, 0.2);
        break;
      }
      // сухой треск ветки где-то в темноте
      case 'snap':
        this.noise(0.03, 0.7, 3200);
        this.noise(0.07, 0.5, 1500, 0.004);
        this.noise(0.02, 0.38, 2600, 0.09);
        this.noise(0.05, 0.28, 1200, 0.095);
        break;
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
      case 'starSpawn': this.tone('sine', 2093, 2093, 0.18, 0.26); this.tone('triangle', 3136, 3136, 0.14, 0.14, 0.06); break;
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
      // цвет папоротника (триумф «Купальской ночи»): музыкальная шкатулка в миноре — вверх и замирает,
      // над ней звон-мерцание; в конце низкий колокол, как с той стороны болота
      case 'fern':
        [880, 1047, 1319, 1760, 1568, 1319, 1760].forEach((f, i) => {
          this.tone('triangle', f, f, 0.5, 0.2, i * 0.17);
          this.tone('sine', f * 2, f * 2, 0.3, 0.07, i * 0.17);
        });
        this.swell(1.6, 0.1, 5200, 0.2, 0.5);
        this.tone('square', 440, 436, 1.6, 0.08, 1.25);
        this.tone('triangle', 880, 875, 1.4, 0.12, 1.25);
        break;
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
      // перемотка плёнки (фильм матча после крючка): визг вверх и шорох ленты
      case 'rewind':
        this.tone('square', 420, 2600, 0.5, 0.09);
        this.tone('square', 640, 3400, 0.5, 0.06, 0.04);
        this.noise(0.5, 0.2, 3200);
        break;
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
    const t = ctx.currentTime + this.base + when;
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
    const t = ctx.currentTime + this.base + when;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0 * this.det, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * this.det), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol * this.lvl, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out ?? this.out);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /**
   * Голос: пила с дрожью через полосы-форманты (гласная — по частотам `fmt`), медленная атака и спад.
   * f0→f1 — высота, att — доля длины на нарастание, vib — дрожь, Гц.
   */
  private formant(f0: number, f1: number, dur: number, vol: number, att: number, when: number, fmt: number[], vib: number, am = 0): void {
    const ctx = this.ctx;
    const t = ctx.currentTime + this.base + when;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0 * this.det, t);
    o.frequency.linearRampToValueAtTime(f1 * this.det, t + dur);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = vib;
    const lg = ctx.createGain();
    lg.gain.value = f0 * 0.012;
    lfo.connect(lg).connect(o.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol * this.lvl, t + Math.max(0.01, dur * att));
    g.gain.setValueAtTime(vol * this.lvl, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    fmt.forEach((fr, i) => {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = fr;
      f.Q.value = 6;
      const fg = ctx.createGain();
      fg.gain.value = [1.4, 1, 0.5][i] ?? 0.4;
      o.connect(f).connect(fg).connect(g);
    });
    if (am > 0) {
      // «шершавость» крика: громкость дрожит с частотой am (30–150 Гц) — так звучит настоящий вопль ужаса
      const amG = ctx.createGain();
      amG.gain.value = 0.5;
      const amO = ctx.createOscillator();
      amO.frequency.value = am;
      const amD = ctx.createGain();
      amD.gain.value = 0.5;
      amO.connect(amD).connect(amG.gain);
      g.connect(amG).connect(this.out);
      amO.start(t);
      amO.stop(t + dur + 0.02);
    } else g.connect(this.out);
    o.start(t);
    lfo.start(t);
    o.stop(t + dur + 0.02);
    lfo.stop(t + dur + 0.02);
  }

  /** Шум с медленной атакой (дыхание, ветер): нарастает за `rise` доли длины, потом гаснет. */
  private swell(dur: number, vol: number, freq: number, when = 0, rise = 0.4): void {
    const ctx = this.ctx;
    const t = ctx.currentTime + this.base + when;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq * this.det;
    f.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol * this.lvl, t + dur * rise);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.out);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.05);
  }

  private noise(dur: number, vol: number, freq: number, when = 0, out?: AudioNode): void {
    const ctx = this.ctx;
    const t = ctx.currentTime + this.base + when;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq * this.det;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol * this.lvl, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(out ?? this.out);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.02);
  }

}
