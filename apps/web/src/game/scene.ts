import * as Phaser from 'phaser';
import { PAL, PLAYER_COLORS, hexToInt } from '@kto/assets';
import {
  LocalSession,
  createLocalSession,
  findBestMoment,
  recordRound,
  TICK_MS,
  makeConfig,
  makeReplay,
  tp,
  fmt,
  DICTS,
  THEME_RULES,
  roundMod,
} from '@kto/game-core';
import type { AwardId, ClientSession, CrowdKind, Dict, Entity, GameConfig, Lang, Moment, Notice, RoundRecording, RoundSummary, ThemeText, World, WorldEvent } from '@kto/game-core';
import { resultCardFile } from './card';
import { Tutorial, tutorialDone } from './tutorial';
import { mildOn } from '../ui/topbar';
import { SWING_HIT, aim, armed, armsOf, bodyPose, drawAir, drawFloor, killsFromLog, makeKill, weaponSfx } from './gore';
import type { ArmColors } from './gore';
import type { Kill, Px } from './gore';
import { clipSupported, openClipOverlay, recordClipInBackground, shareClipInTelegram } from './clip-ui';
import type { ClipPlayer } from './clip';
import { Audio } from './audio';
import { frameFor } from './frames';
import type { CharFrame } from './frames';
import type { FontColor } from './font';
import { registerFonts } from './font';
import {
  CH_H, CH_W, F, OL_H, OL_W,
  makeArenaBackground, makeArrow, makeGear, makeHudIcons, makeCharacterSheets, makeHedge, makeIconSheet, makeIcons, makeMark, makePigeon,
  makePoof, makeProp, makeRing, makeShadow, makeStar, makeStarFlash, makeStunStars, makeVignette,
} from './sprites';
import { isThemeLoaded, loadTheme, lookCount, preloadThemes, themeLook, themePack, variantOf } from './themes';
import type { Look } from './themes';
import { haptic, setClosingConfirmation } from '../lib/telegram';

/** Постоянные кнопки «автопилот» и «эмоция» в нижней панели (выключены — не пользовались). */
const HUD_EXTRAS = false;
const AY = 24; // верх арены на экране
const CROWD_KINDS: CrowdKind[] = ['freeze', 'jump', 'dance'];
/** Половина заката/рассвета: столько сгущаются сумерки, столько же проступает новый облик. */
const DUSK_HALF_MS = 1400;
const PANEL_Y = 284;
const ME = 'me';
const COLOR_FONT: FontColor[] = ['red', 'blue', 'yellow', 'green'];

export interface SceneInit {
  playerName: string;
  fontFamily: string;
  audio: Audio;
  cfg?: Partial<GameConfig>;
  seed?: number;
  onExit?: () => void;
  /** Поделиться текстом и, если есть, файлами (карточка, клип). Вызывается из жеста пользователя. */
  onShare?: (text: string, files?: File[]) => void | Promise<void>;
  /** Открыть настройки (шестерёнка в углу). Без него — кнопка просто включает и выключает звук. */
  onSettings?: () => void;
  /** Сохранить файл на устройство (клип). */
  onSave?: (file: File) => void;
  lang?: Lang;
  /** Источник игры; по умолчанию — песочница с ИИ. Сеть подставляет сюда хост или гостя. */
  createSession?: (cfg: GameConfig, players: { pid: string; name: string; color: number }[], seed: number) => ClientSession;
  /** Только для отладки (?dev&speed=4): ускорение времени. */
  timeScale?: number;
  /** «Пробный дубль»: сценарий обучения поверх песочницы без ИИ (tutorial.ts). */
  tutorial?: { onDone: () => void; onSkip: () => void };
  /**
   * Матч с ИИ (песочница на сайте): в конце матча вместо «Поделиться» — «С друзьями»,
   * переход к созданию настоящей комнаты. Вызывается из жеста (отпускание).
   */
  onInvite?: () => void;
  /** Аналитика (lib/analytics › track): ход матча глазами этого игрока. В обучении молчит. */
  onEvent?: (name: string, props?: Record<string, string | number | boolean | null>) => void;
  /**
   * Зритель (опоздал к матчу): смотрит с задержкой, ничего не нажимает, своего персонажа нет.
   * watching — трансляция уже идёт (виден дубль с начала).
   */
  spectator?: { delaySec: number; watching: () => boolean };
  /** Режиссёр жмёт «Ещё дубль»: true — комната сама начала новый матч (пришли новые игроки). */
  onRematch?: () => boolean;
}

interface EntityView {
  spr: Phaser.GameObjects.Image;
  ol: Phaser.GameObjects.Image;
  shadow: Phaser.GameObjects.Image;
  stun: Phaser.GameObjects.Image;
  mark: Phaser.GameObjects.Image;
  q: Phaser.GameObjects.Image;
  poof: Phaser.GameObjects.Image;
}

interface Button {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  icon?: string;
  label?: string;
  visible: () => boolean;
  onDown?: () => void;
  onUp?: () => void;
  pressed?: boolean;
  accent?: string;
  /** Не удалять вместе с кнопками экранов фаз (clearOverlay). */
  keep?: boolean;
  /**
   * Зона нажатия [x, y, w, h], если рисунок мельче пальца: не меньше 30×30 лог. px —
   * при самом мелком масштабе (×1,5, SE в Safari) это 45×45 CSS px, минимум Apple 44×44.
   */
  hit?: [number, number, number, number];
  /** Кнопка экрана итогов: главная (янтарь), вторая (night + рамка amber), плашка (неактивная). */
  kind?: 'primary' | 'secondary' | 'plate';
  /** Заливка главной кнопки 0…1 (обратный отсчёт до следующего дубля). */
  fill?: () => number;
}

/** Кнопка в ряду итогов: ширина — по тексту (поля ≥ 6 px), остаток ряда — кнопке с flex. */
interface RowButton {
  id: string;
  kind: 'primary' | 'secondary' | 'plate';
  label?: string;
  icon?: string;
  flex?: boolean;
  onTap?: () => void;
  /** Системное меню «Поделиться» — только по отпусканию пальца. */
  release?: boolean;
  fill?: () => number;
}

interface Pigeon {
  hx: number;
  hy: number;
  x: number;
  y: number;
  state: 'idle' | 'fly' | 'gone';
  t: number;
  spr: Phaser.GameObjects.Image;
}

/** Клип выбывшего: момент выбивания, состояние монтажа; killer — кто выбил (известен после разоблачения). */
interface DeathClip {
  eid: number;
  at: number;
  /** Дубль, в котором выбили: клип, который уже монтируется или готов, переживает конец дубля и следующий. */
  round: number;
  status: 'offer' | 'rendering' | 'ready';
  progress: number;
  file: File | null;
  killer?: number;
}

export class GameScene extends Phaser.Scene {
  private init0!: SceneInit;
  private lang: Lang = 'ru';
  private t: Dict = DICTS.ru;
  /** Единственный источник состояния игры для экрана: локальная симуляция, хост или гость. */
  sim!: ClientSession;
  private cfg!: GameConfig;
  private audio!: Audio;
  private views: EntityView[] = [];
  private starSprites = new Map<number, Phaser.GameObjects.Image>();
  private hedges: Phaser.GameObjects.TileSprite[] = [];
  private props: { spr: Phaser.GameObjects.Image; kind: string }[] = [];
  private ground!: Phaser.GameObjects.Image;
  /** Тема, под которую сейчас одеты земля, предметы, стенка зоны и зверьки. */
  /** Текущий облик на поле: «тема_облик» (облик 1 — изнанка темы). */
  private lookKey = '';
  /** Свои действия текущего облика темы (эмоции и команды толпы) и его иконки команд. */
  private lookActs: Look['acts'];
  private lookIcons: Look['icons'];
  /** «25-й кадр»: сущность, которая на миг показана в облике изнанки, и до какого времени. */
  private flash25: { eid: number; until: number } | null = null;
  private next25 = 0;
  /** «Вклеенный кадр»: до какого времени (performance.now) весь мир показан в облике изнанки. */
  private cut25Until = 0;
  /** Мигание света при смене изнанки: время начала (performance.now), 0 — нет. */
  private flicker = 0;
  private blackout!: Phaser.GameObjects.Rectangle;
  private duskVeil!: Phaser.GameObjects.Rectangle;
  private pulseVeil!: Phaser.GameObjects.Rectangle;
  private sirenVeil!: Phaser.GameObjects.Rectangle;
  /** Плавная смена облика (закат/рассвет): какой облик показан, идёт ли переход, для какой темы и какого мира. */
  private duskShown = 0;
  private dusk: { from: number; to: number; t0: number } | null = null;
  private duskTheme = -1;
  private duskWorld: World | null = null;
  /** Мигалка «звёзд розыска»: время начала. */
  private siren = 0;
  private pigeons: Pigeon[] = [];
  private ui!: Phaser.GameObjects.Graphics;
  private fxG!: Phaser.GameObjects.Graphics;
  private arrow!: Phaser.GameObjects.Image;
  private ring!: Phaser.GameObjects.Image;
  /** «Где я»: расходящиеся круги вокруг своего персонажа в начале дубля. */
  private findMe!: Phaser.GameObjects.Graphics;
  private findMeAt = -1e9;
  private myColor = 0xffffff;
  /** Корона над лучшим в дубле на финальном кадре разоблачения. */
  private crown!: Phaser.GameObjects.Image;
  private crownEid = -1;
  /** Момент триумфа победителя матча уже показан (до следующего матча). */
  private triumphShown = false;
  private hud: Record<string, Phaser.GameObjects.BitmapText> = {};
  private hudIcons: Phaser.GameObjects.Image[] = [];
  private hudStars: Phaser.GameObjects.Image[] = [];
  private hudThreat?: Phaser.GameObjects.Image;
  private hudSep?: Phaser.GameObjects.Graphics;
  private buttons: Button[] = [];
  private btnObjs = new Map<string, { icon?: Phaser.GameObjects.Image; text?: Phaser.GameObjects.BitmapText }>();
  private ovObjs: Phaser.GameObjects.GameObject[] = [];
  private ui2!: Phaser.GameObjects.Graphics;
  /** Отдельная камера для интерфейса стоп-кадра: основная сереет, а кнопки команд остаются цветными. */
  private uiCam!: Phaser.Cameras.Scene2D.Camera;
  private uiSet = new Set<Phaser.GameObjects.GameObject>();
  private crowdG!: Phaser.GameObjects.Graphics;
  private grayFx: Phaser.FX.ColorMatrix | null = null;
  private freezeVeil!: Phaser.GameObjects.Rectangle;
  private dim!: Phaser.GameObjects.Rectangle;
  private overlayPhase = '';
  private ovDyn: Record<string, Phaser.GameObjects.BitmapText> = {};
  /** Полоска обратного отсчёта до следующего дубля (итоги дубля). */
  private autoBar: Phaser.GameObjects.Graphics | null = null;
  private autoTotal = 1;
  private crowdIcon!: Phaser.GameObjects.Image;
  private crowdText!: Phaser.GameObjects.BitmapText;
  private toast!: Phaser.GameObjects.BitmapText;
  private toastUntil = 0;
  private acc = 0;
  private hitStop = 0;
  private ghostMarks = new Set<number>();
  private replay: World | null = null;
  private trails = new Map<number, { x: number; y: number }[]>();
  private revealStartNow = 0;
  private finalSoundsPlayed = false;
  private confetti: { x: number; y: number; vx: number; vy: number; c: number }[] = [];
  private stepSoundAt = 0;
  private lastAttackAt = -9999;
  /** Замах своего персонажа к цели — сразу по нажатию, до ответа хоста. */
  private lunge: { dx: number; dy: number; start: number } | null = null;
  /** Вспышки замаха у цели (белая обводка цели и искры), мс с начала. */
  private swingFx: { eid: number; x: number; y: number; t: number }[] = [];
  private holdTarget: { eid: number; at: number } | null = null;
  private iconNames: string[] = [];
  private flashes: { x: number; y: number; t: number }[] = [];
  private musicResumeAt = 0;
  private crowdChoice: CrowdKind | null = null;
  private tut: Tutorial | null = null;
  private coachG!: Phaser.GameObjects.Graphics;
  private focusG!: Phaser.GameObjects.Graphics;
  private plateG!: Phaser.GameObjects.Graphics;
  private coachL1!: Phaser.GameObjects.BitmapText;
  private coachL2!: Phaser.GameObjects.BitmapText;
  private coachNext!: Phaser.GameObjects.BitmapText;
  /** Зритель: «Ты зритель» и задержка / «ждём новый дубль» в нижней панели. */
  private specL1: Phaser.GameObjects.BitmapText | null = null;
  private specL2: Phaser.GameObjects.BitmapText | null = null;
  /** Подсказка «впервые видишь» в настоящей игре (две строки, до времени). */
  private coachTip: { lines: readonly string[]; until: number } | null = null;
  /** Новичку: когда подсказать «как искать живого» — в первую спокойную минуту после этого момента. */
  private huntTipAt = 0;
  private clapSentAt = 0;
  /** Выбивание оружием (облик с kill: 'weapon'): замахи, брызги, пятна и тела — до конца дубля. */
  private goreG!: Phaser.GameObjects.Graphics;
  private spotG!: Phaser.GameObjects.Graphics;
  private kills: LiveKill[] = [];
  private bodies: Phaser.GameObjects.Image[] = [];
  /** Повтор на разоблачении: удары оружием по журналу дубля и время повтора (null — повтор не идёт). */
  private replayKills = new Map<number, Kill>();
  /** Повтор: кто бил → его удары (он замахивается). */
  private replayBy = new Map<number, Kill[]>();
  private replayT: number | null = null;
  private pxCache = new Map<string, number>();
  private noPoof = new Set<number>();
  /** Переодевание при смене облика (ThemePack.dressUp): когда началось и в какую сторону. */
  private dress: { at: number; on: boolean } | null = null;
  private dressTheme = -1;
  private dressLk = -1;
  /** Прожекторы режиссёра на поле (время мира). */
  private spots: { x: number; y: number; r: number; at: number; until: number }[] = [];
  private wasFrozen = false;
  private deathObjs: Phaser.GameObjects.GameObject[] = [];
  /** Счётчик текстур крови на экране (у каждого удара — своя). */
  private bloodN = 0;
  private ghostUi: Phaser.GameObjects.GameObject[] = [];
  private starPos = new Map<number, { x: number; y: number }>();
  /** Лучший момент матча для клипа: запись раунда переживает следующий раунд. */
  private best: { rec: RoundRecording; moment: Moment; players: ClipPlayer[] } | null = null;
  private cardFile: File | null = null;
  private closeClip: (() => void) | null = null;
  /** Клип выбывшего: последние секунды перед выбиванием, монтируется в фоне — призрак смотрит игру дальше. */
  /** Клип выбывшего. killer — кто выбил (известно только после разоблачения: тогда клип пересобирается с именами). */
  private deathClip: DeathClip | null = null;

  constructor() {
    super('game');
  }

  init(data: SceneInit): void {
    this.init0 = data;
    this.lang = data.lang ?? 'ru';
    this.t = DICTS[this.lang];
    this.audio = data.audio;
    this.views = [];
    this.starSprites.clear();
    this.hedges = [];
    this.props = [];
    this.pigeons = [];
    this.buttons = [];
    this.btnObjs.clear();
    this.hud = {};
    this.hudIcons = [];
    this.hudStars = [];
    this.overlayPhase = '';
    this.ghostMarks.clear();
    this.replay = null;
    this.confetti = [];
    this.ovObjs = [];
    this.uiSet = new Set();
    this.grayFx = null;
    this.wasFrozen = false;
    this.deathObjs = [];
    this.ghostUi = [];
    this.starPos = new Map();
    this.best = null;
    this.cardFile = null;
    this.deathClip = null;
  }

  create(): void {
    this.cfg = makeConfig(this.init0.cfg);
    const names = [this.init0.playerName || this.t.game.you, ...this.botNames()];
    const players = names.map((name, i) => ({ pid: i === 0 ? ME : `ai${i}`, name, color: i }));
    const seed = this.init0.seed ?? (Date.now() & 0x7fffffff);
    this.sim = this.init0.createSession?.(this.cfg, players, seed) ?? createLocalSession(this.cfg, players, seed, ME);
    this.cfg = this.sim.cfg; // по сети конфиг задаёт хост
    this.sim.onWorldEvent((ev) => this.onWorldEvent(ev));
    this.events.once('shutdown', () => {
      this.sim.dispose();
      setClosingConfirmation(false);
    });
    this.tut = this.init0.tutorial && this.sim instanceof LocalSession ? new Tutorial(this.sim, this.t.tutorial, this.init0.tutorial.onDone) : null;
    if (this.tut) {
      // обучению нужно знать, что нажал игрок (жест, обвинение), — до того, как это попадёт в симуляцию
      const send = this.sim.intent.bind(this.sim);
      this.sim.intent = (it) => {
        this.tut?.noteIntent(it);
        send(it);
      };
    }
    registerFonts(this, this.init0.fontFamily);
    this.makeTextures();

    const arena = this.sim.arena;
    this.lookKey = '';
    this.flicker = 0;
    this.flash25 = null;
    this.next25 = 0;
    this.ensureLook(0, 0);
    // пакет темы этого дубля — сразу, остальные — в фоне, когда браузер свободен
    void loadTheme(this.sim.theme);
    preloadThemes();
    this.ground = this.add.image(0, AY, 'arena0_0').setOrigin(0, 0).setDepth(0);
    for (const p of arena.props) {
      const spr = this.add.image(p.x, AY + p.y, `prop-${p.kind}-0_0`, 0).setOrigin(0.5, 1).setDepth(AY + p.y);
      this.props.push({ spr, kind: p.kind });
    }
    for (let i = 0; i < 4; i++) this.hedges.push(this.add.tileSprite(0, 0, 8, 8, 'hedge0_0').setOrigin(0, 0).setDepth(900).setVisible(false));

    for (let i = 0; i < this.cfg.entitiesTotal; i++) {
      this.views.push({
        shadow: this.add.image(0, 0, 'shadow').setOrigin(0.5, 0.5),
        ol: this.add.image(0, 0, 'ol0_0', 0).setOrigin(7 / OL_W, 17 / OL_H).setVisible(false),
        spr: this.add.image(0, 0, 'ch0_0', 0).setOrigin(6 / CH_W, 1),
        stun: this.add.image(0, 0, 'stun', 0).setOrigin(0.5, 1).setVisible(false),
        mark: this.add.image(0, 0, 'mark').setOrigin(0.5, 1).setVisible(false),
        q: this.add.image(0, 0, 'qmark').setOrigin(0.5, 1).setVisible(false),
        poof: this.add.image(0, 0, 'poof', 0).setVisible(false),
      });
    }
    // свой персонаж (только у себя): кольцо под ногами, стрелка над головой, контур — цветом игрока
    const myColor = hexToInt(PLAYER_COLORS[this.sim.info(this.sim.selfPid)?.color ?? 0]);
    this.myColor = myColor;
    this.ring = this.add.image(0, 0, 'ring').setTint(myColor).setVisible(false);
    // стрелка рисуется сразу цветом игрока (кромка) с белой сердцевиной — без тонировки
    const myIdx = this.sim.info(this.sim.selfPid)?.color ?? 0;
    if (!this.textures.exists('arrow' + myIdx)) this.textures.addCanvas('arrow' + myIdx, makeArrow(PLAYER_COLORS[myIdx]));
    this.arrow = this.add.image(0, 0, 'arrow' + myIdx).setOrigin(0.5, 1).setDepth(800).setVisible(false);
    this.findMe = this.add.graphics().setDepth(799);
    this.crown = this.add.image(0, 0, 'icons', 0).setOrigin(0.5, 1).setScale(2).setDepth(801).setVisible(false);

    const pigeonSpots = [[70, 56], [118, 214], [146, 98], [34, 182], [104, 30]];
    for (const [x, y] of pigeonSpots) {
      this.pigeons.push({ hx: x, hy: y, x, y, state: 'idle', t: Math.random() * 3000, spr: this.add.image(x, AY + y, 'pigeon0_0', 0).setOrigin(0.5, 1) });
    }

    this.add.image(0, AY, 'vignette').setOrigin(0, 0).setDepth(950).setAlpha(0.35);
    this.fxG = this.add.graphics().setDepth(960);
    this.goreG = this.add.graphics().setDepth(1);
    // прожектор: темнота и луч поверх фигур, под эффектами и интерфейсом
    this.spotG = this.add.graphics().setDepth(955);
    this.ui = this.add.graphics().setDepth(1000);
    this.buildHud();
    this.buildButtons();
    this.crowdIcon = this.add.image(90, AY + 46, 'icons', 0).setScale(3).setDepth(1500).setVisible(false);
    this.crowdText = this.txt(90, AY + 64, '', 'yellow').setOrigin(0.5, 0).setDepth(1500).setVisible(false);
    this.toast = this.txt(90, PANEL_Y - 14, '', 'sand').setOrigin(0.5, 0).setDepth(1600).setVisible(false);
    this.plateG = this.add.graphics().setDepth(1599);
    this.ui2 = this.add.graphics().setDepth(2050);
    this.dim = this.add.rectangle(0, AY, 180, 260, hexToInt(PAL.ink), 0.45).setOrigin(0, 0).setDepth(39).setVisible(false);
    this.blackout = this.add.rectangle(0, AY, 180, 260, hexToInt(PAL.ink), 0.92).setOrigin(0, 0).setDepth(1000).setVisible(false);
    // цветные вуали поверх поля: закат/рассвет, пульсация ночного клуба, мигалка
    this.duskVeil = this.add.rectangle(0, AY, 180, 260, 0, 0).setOrigin(0, 0).setDepth(998).setVisible(false);
    this.pulseVeil = this.add.rectangle(0, AY, 180, 260, 0, 0).setOrigin(0, 0).setDepth(997).setVisible(false);
    this.sirenVeil = this.add.rectangle(0, AY, 180, 260, 0, 0).setOrigin(0, 0).setDepth(999).setVisible(false);
    // подсказки сверху поля: шаги пробного дубля и «впервые видишь» в настоящей игре
    this.coachG = this.add.graphics().setDepth(1600);
    // затемнение поля вокруг того, что выделяет обучение (на основной камере — под кнопками и подсказкой)
    this.focusG = this.add.graphics().setDepth(1450);
    this.coachL1 = this.txt(90, AY + 5, '', 'white').setDepth(1601);
    this.coachL2 = this.txt(90, AY + 15, '', 'sand').setDepth(1601);
    this.coachNext = this.txt(90, PANEL_Y - 14, '', 'yellow').setDepth(1601).setVisible(false);
    this.setupFreezeFrame();
    // постоянная пометка в нижней панели, пока ты призрак
    this.ghostUi = [
      this.add.image(16, PANEL_Y + 19, 'qmark').setScale(2).setDepth(1101),
      this.txt(25, PANEL_Y + 7, this.t.game.ghost, 'mist').setDepth(1101),
      this.txt(25, PANEL_Y + 19, this.t.game.ghostHint, 'sand').setDepth(1101),
    ];
    for (const o of this.ghostUi) (o as Phaser.GameObjects.Image).setVisible(false);
    this.buildDeathClipButton();

    this.input.addPointer(2);
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => this.onDown(p));
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => this.onUp(p));

    this.applyTheme();
    this.syncMusic(true);
    if (!this.audio.enabled && !this.audio.musicEnabled) this.showToast(this.t.game.soundOffHint, 2500);
  }

  /** Музыка по фазе: отсчёт и игра — тема раунда (новый раунд — с начала), обвинение — пульс, дальше — тишина. */
  private syncMusic(restart = false): void {
    const phase = this.sim.phase;
    if (phase === 'countdown' || phase === 'play') {
      this.audio.setMusic('play', this.sim.theme, restart && phase === 'countdown');
      if (phase === 'play' && this.sim.world.isFrozen()) this.audio.cutMusic();
    } else if (phase === 'accuse') this.audio.setMusic('accuse');
    else this.audio.setMusic('off');
  }

  private setupFreezeFrame(): void {
    this.crowdG = this.add.graphics().setDepth(1490);
    this.freezeVeil = this.add.rectangle(0, 0, 180, 320, hexToInt(PAL.slate), 0.35).setOrigin(0, 0).setDepth(1400).setVisible(false);
    const main = this.cameras.main;
    if (this.renderer.type === Phaser.WEBGL && main.postFX) {
      // флаг active у FX камеры не выключает эффект, поэтому переключаем саму матрицу
      this.grayFx = main.postFX.addColorMatrix();
      this.grayFx.reset();
    }
    this.uiCam = this.cameras.add(0, 0, 180, 320).setName('ui');
    this.uiSet.add(this.crowdG).add(this.crowdIcon).add(this.crowdText).add(this.coachG).add(this.coachL1).add(this.coachL2).add(this.coachNext);
    for (const b of this.buttons) {
      if (!b.id.startsWith('crowd-') && !b.id.startsWith('clap-')) continue;
      const icon = this.btnObjs.get(b.id)?.icon;
      if (icon) this.uiSet.add(icon.setDepth(1495));
    }
    main.ignore([...this.uiSet]);
  }

  /** Всё, что не входит в интерфейс стоп-кадра, вторая камера не рисует (и новые объекты тоже). */
  private syncUiCamera(): void {
    const id = this.uiCam.id;
    for (const o of this.children.list) {
      if (this.uiSet.has(o)) continue;
      if (((o as unknown as { cameraFilter: number }).cameraFilter & id) === 0) this.uiCam.ignore(o);
    }
  }

  private botNames(): string[] {
    const a = [...this.t.names.adj];
    const n = [...this.t.names.noun];
    const out: string[] = [];
    for (let i = 0; i < 3; i++) {
      const adj = a.splice(Math.floor(Math.random() * a.length), 1)[0];
      // существительное — такое, чтобы имя влезло в 14 знаков
      const fit = n.filter((w) => adj.length + 1 + w.length <= 14);
      const noun = fit.length ? fit[Math.floor(Math.random() * fit.length)] : n[0];
      n.splice(n.indexOf(noun), 1);
      out.push(`${adj} ${noun}`);
    }
    return out;
  }

  // ───────────── текстуры ─────────────

  private addSheet(key: string, c: HTMLCanvasElement, fw: number, fh: number): void {
    if (this.textures.exists(key)) return;
    const tex = this.textures.addCanvas(key, c)!;
    const n = Math.floor(c.width / fw);
    for (let i = 0; i < n; i++) tex.add(i, 0, i * fw, 0, fw, fh);
  }

  private makeTextures(): void {
    const once = (key: string, f: () => HTMLCanvasElement) => {
      if (!this.textures.exists(key)) this.textures.addCanvas(key, f());
    };
    once('shadow', makeShadow);
    once('ring', makeRing);
    once('mark', () => makeMark('!'));
    once('qmark', () => makeMark('?'));
    once('vignette', () => makeVignette(180, 260));
    this.addSheet('star', makeStar(), 10, 10);
    this.addSheet('starflash', makeStarFlash(), 16, 16);
    this.addSheet('poof', makePoof(), 24, 24);
    this.addSheet('stun', makeStunStars(), 12, 5);
    const icons = makeIcons();
    this.iconNames = icons.names;
    this.addSheet('icons', icons.canvas, 8, 8);
  }

  /**
   * Текстуры облика темы (толпа, земля, предметы, стенка зоны, зверёк) — по требованию, один раз.
   * Пакет темы должен быть загружен (themes/index.ts), иначе вернётся парк.
   */
  private ensureLook(th: number, lk: number): string {
    const key = isThemeLoaded(th) ? `${th}_${Math.min(lk, lookCount(th) - 1)}` : '0_0';
    if (this.textures.exists('arena' + key)) return key;
    const [t, l] = key.split('_').map(Number);
    const look = themeLook(t, l);
    const s = makeCharacterSheets(look.chars, look.poses);
    this.addSheet('ch' + key, s.body, CH_W, CH_H);
    this.addSheet('ol' + key, s.outline, OL_W, OL_H);
    (look.variants ?? []).forEach((style, i) => {
      const v = makeCharacterSheets(style, look.poses);
      this.addSheet(`ch${key}v${i + 1}`, v.body, CH_W, CH_H);
      this.addSheet(`ol${key}v${i + 1}`, v.outline, OL_W, OL_H);
    });
    this.textures.addCanvas('arena' + key, makeArenaBackground(this.sim.arena, look));
    this.textures.addCanvas('hedge' + key, makeHedge(look));
    this.addSheet('pigeon' + key, makePigeon(look), 6, 6);
    for (const kind of new Set(this.sim.arena.props.map((p) => p.kind))) {
      const [c, fw, fh] = makeProp(kind, look);
      this.addSheet(`prop-${kind}-${key}`, c, fw, fh);
    }
    const ic = look.icons;
    if (ic) this.addSheet('icons' + key, makeIconSheet(CROWD_KINDS.map((k) => ic[k] ?? ['........'])), 8, 8);
    return key;
  }

  /** Текстуры промежуточного облика переодевания темы (ThemePack.dressUp): `chd{тема}[v{i}]`. */
  private ensureDress(th: number): void {
    const du = themePack(th).dressUp;
    if (!du || this.textures.exists('chd' + th)) return;
    const s = makeCharacterSheets(du.look.chars, du.look.poses);
    this.addSheet('chd' + th, s.body, CH_W, CH_H);
    this.addSheet('old' + th, s.outline, OL_W, OL_H);
    (du.look.variants ?? []).forEach((style, i) => {
      const v = makeCharacterSheets(style, du.look.poses);
      this.addSheet(`chd${th}v${i + 1}`, v.body, CH_W, CH_H);
      this.addSheet(`old${th}v${i + 1}`, v.outline, OL_W, OL_H);
    });
  }

  /**
   * Переодевание волной по толпе: у каждой фигуры своя задержка. До неё — прежний вид
   * (на закате — ещё без маски), потом позы dressUp, потом новый облик. null — как обычно.
   */
  private dressFrame(i: number, acting: boolean): { fig: string; frame: number | null } | null {
    const d = this.dress;
    const th = this.sim.theme;
    const du = d && isThemeLoaded(th) ? themePack(th).dressUp : undefined;
    if (!d || !du) return null;
    const total = du.poses.length * du.ms;
    const k = performance.now() - d.at - ((i * 97) % 700);
    if (k >= total) return null;
    const vi = variantOf(i, du.look as Look);
    const dressFig = `d${th}${vi ? 'v' + vi : ''}`;
    if (k < 0) return { fig: d.on ? dressFig : this.charKey(`${th}_${du.to}`, i), frame: null };
    if (acting) return null;
    const seq = d.on ? du.poses : [...du.poses].reverse();
    return { fig: dressFig, frame: F.COUNT + seq[Math.min(seq.length - 1, Math.floor(k / du.ms))] };
  }

  private icon(name: string): number {
    return Math.max(0, this.iconNames.indexOf(name));
  }

  private txt(x: number, y: number, s: string, color: FontColor = 'white'): Phaser.GameObjects.BitmapText {
    return this.add.bitmapText(x, y, 'px-' + color, s).setLetterSpacing(-2);
  }

  // ───────────── HUD и кнопки ─────────────

  private buildHud(): void {
    if (!this.textures.exists('hud')) this.addSheet('hud', makeHudIcons(), 10, 10);
    if (!this.textures.exists('gear')) this.textures.addCanvas('gear', makeGear());
    this.hud.timer = this.txt(3, 7, '0:00', 'sand').setDepth(1100);
    this.hud.round = this.txt(3, -1, '', 'mist').setDepth(1100).setVisible(false);
    // зритель: ни ударов, ни звёзд (звёзды игроков приходят только им лично) — пометка «Ты зритель»
    if (this.init0.spectator) {
      this.specL1 = this.txt(90, PANEL_Y + 7, this.t.game.spectator, 'yellow').setOrigin(0.5, 0).setDepth(1101);
      this.specL2 = this.txt(90, PANEL_Y + 19, '', 'mist').setOrigin(0.5, 0).setDepth(1101);
      return;
    }
    // Шапка — три группы через разделители dusk: время | моё (удары, свои звёзды ★★☆) | чужие звёзды.
    const sep = this.add.graphics().setDepth(1100);
    sep.fillStyle(hexToInt(PAL.dusk)).fillRect(37, 5, 1, 14).fillRect(105, 5, 1, 14);
    this.hudSep = sep;
    for (let i = 0; i < this.cfg.attacksPerRound; i++) {
      this.hudIcons.push(this.add.image(40 + i * 11, 7, 'hud', 0).setOrigin(0, 0).setDepth(1100));
    }
    // свои звёзды — ячейками до цели дубля: цель «3 звезды» видна без слов
    for (let i = 0; i < this.cfg.starsToWin; i++) {
      this.hudStars.push(this.add.image(74 + i * 9, 7, 'hud', 3).setOrigin(0, 0).setDepth(1100));
    }
    // Чужие — без цветов и имён, по убыванию, под общей пометкой «?»: видно, что кто-то близок
    // к победе (звёздочка мигает), но не видно, кто именно (раздел 5).
    this.txt(108, 7, '?', 'mist').setDepth(1100);
    this.hudThreat = this.add.image(114, 7, 'hud', 2).setOrigin(0, 0).setDepth(1100).setAlpha(0.45);
    for (let i = 1; i < this.sim.players.length; i++) {
      this.hud['starsOther' + i] = this.txt(116 + i * 10, 7, '0', 'mist').setDepth(1100);
    }
  }

  private buildButtons(): void {
    const play = () => this.sim.phase === 'play' && !!this.me()?.alive;
    // автопилот и эмоция постоянно висели в панели, но ими не пользовались (плейтесты, ноябрь 2026) —
    // убраны с экрана; механика осталась (боты и ИИ-игроки ею живут), вернуть — HUD_EXTRAS = true
    const extra = () => HUD_EXTRAS && play() && !this.init0.tutorial;
    const crowdOpen = () => play() && this.sim.crowdWindowOpen(this.sim.world.time);
    this.buttons.push(
      {
        id: 'autopilot', x: 3, y: PANEL_Y + 3, w: 38, h: 30, icon: 'robot', visible: extra,
        onDown: () => this.sim.intent({ k: 'autopilot', on: true }),
        onUp: () => this.sim.intent({ k: 'autopilot', on: false }),
      },
      { id: 'emote', x: 139, y: PANEL_Y + 3, w: 38, h: 30, icon: 'smile', visible: extra, onDown: () => this.sim.intent({ k: 'emote' }) },
    );
    const kinds: [CrowdKind, string][] = [['freeze', 'hand'], ['jump', 'jump'], ['dance', 'dance']];
    kinds.forEach(([kind, icon], i) => {
      this.buttons.push({
        id: 'crowd-' + kind, x: 45 + i * 31, y: PANEL_Y + 3, w: 29, h: 30, icon, accent: PAL.amber, visible: crowdOpen,
        hit: [44 + i * 31, PANEL_Y, 31, 36],
        onDown: () => {
          const c = this.sim.world.crowd;
          if (c && this.me()?.crowdAnswered === c.warnAt) return;
          this.crowdChoice = kind;
          this.sim.intent({ k: 'crowd', kind });
        },
      });
    });
    // «Хлопушка» вырезанного: подать команду толпе — справа в панели, рядом с пометкой «за кадром»
    const clapVis = () => {
      const me = this.me();
      return this.sim.phase === 'play' && !!me && !me.alive && me.clapsLeft > 0;
    };
    kinds.forEach(([kind, icon], i) => {
      this.buttons.push({
        id: 'clap-' + kind, x: 98 + i * 27, y: PANEL_Y + 3, w: 26, h: 30, icon, accent: PAL.orchid, visible: clapVis,
        hit: [90 + i * 30, PANEL_Y, 30, 36],
        onDown: () => {
          if (!this.clapReady()) {
            this.audio.play('denied');
            this.showToast(this.t.game.denied.not_now, 900);
            return;
          }
          this.clapSentAt = performance.now();
          this.sim.intent({ k: 'clap', kind });
          this.showToast(this.t.game.clapDone, 1200);
        },
      });
    });
    // обучение: «Пропустить» внизу слева (пока не идёт команда толпы — там её кнопки)
    if (this.init0.tutorial) {
      const skip = this.init0.tutorial.onSkip;
      const b: Button = {
        id: 'tut-skip', x: 3, y: PANEL_Y + 3, w: 84, h: 30, label: this.t.tutorial.skip,
        visible: () => !this.sim.crowdWindowOpen(this.sim.world.time),
        onUp: () => skip(),
        // переживает смену оверлеев (отсчёт → дубль → обвинение), иначе кнопку убирало вместе с ними
        keep: true,
      };
      this.buttons.push(b);
      const text = this.txt(b.x + b.w / 2, b.y + 10, b.label!, 'white').setOrigin(0.5, 0).setDepth(2100);
      this.btnObjs.set(b.id, { text });
    }
    // шестерёнка: звук, правила и выход — в листе настроек поверх игры (язык меняется вне матча)
    // шестерёнка 14×14 без рамки (решение владельца: крупнее и похожей на шестерёнку)
    this.buttons.push({
      id: 'sound', x: 159, y: 5, w: 14, h: 14, icon: this.init0.onSettings ? 'gear' : this.audio.enabled ? 'soundOn' : 'soundOff', visible: () => true,
      // рисунок 14×14, а палец — шире: угол 30×30 (заходит на 6 px в поле, там почти не стоят)
      hit: [150, 0, 30, 30],
      onUp: () => {
        if (this.init0.onSettings) {
          this.init0.onSettings();
          return;
        }
        const on = this.audio.toggle();
        const b = this.buttons.find((x) => x.id === 'sound')!;
        b.icon = on ? 'soundOn' : 'soundOff';
        this.btnObjs.get('sound')?.icon?.setFrame(this.icon(b.icon));
        this.showToast(on ? this.t.game.soundOn : this.t.game.soundOff, 1200);
      },
    });
    // зрителю — только шестерёнка: нажимать в чужом матче нечего
    if (this.init0.spectator) this.buttons = this.buttons.filter((b) => b.id === 'sound');
    for (const b of this.buttons) {
      const cog = b.id === 'sound' && b.icon === 'gear';
      const icon = cog
        ? this.add.image(b.x + b.w / 2, b.y + b.h / 2, 'gear').setDepth(1101)
        : b.icon ? this.add.image(b.x + b.w / 2, b.y + b.h / 2, 'icons', this.icon(b.icon)).setDepth(1101) : undefined;
      if (icon && b.id !== 'sound') icon.setScale(2);
      this.btnObjs.set(b.id, { ...this.btnObjs.get(b.id), icon });
    }
  }

  /** «Хлопушка» готова: перезарядка прошла, команда сейчас не идёт (хост всё равно проверит). */
  private clapReady(): boolean {
    const me = this.me();
    const w = this.sim.world;
    return !!me && !me.alive && me.clapsLeft > 0 && w.time >= me.clapAt && performance.now() - this.clapSentAt > 1500 && this.sim.ghostClapOpen(w.time);
  }

  private addOverlayButton(
    id: string, x: number, y: number, w: number, h: number, label: string, onDown: () => void, accent?: string, onRelease = false,
  ): void {
    const phase = this.sim.phase;
    // системные меню (поделиться) открываются только по отпусканию пальца: касание ещё не считается жестом
    const b: Button = { id, x, y, w, h, label, visible: () => this.sim.phase === phase, accent, ...(onRelease ? { onUp: onDown } : { onDown }) };
    this.buttons = this.buttons.filter((o) => o.id !== id);
    this.buttons.push(b);
    const text = this.txt(x + w / 2, y + Math.floor(h / 2) - 5, label, accent ? 'yellow' : 'white').setOrigin(0.5, 0);
    text.x = Math.round(text.x - (text.width % 2) / 2);
    this.ov(text, 2100);
    this.btnObjs.set(id, { text });
  }

  private drawPanel(x: number, y: number, w: number, h: number, fill: string, pressed = false, accent?: string, top: boolean | Phaser.GameObjects.Graphics = false): void {
    const g = top instanceof Phaser.GameObjects.Graphics ? top : top ? this.ui2 : this.ui;
    g.fillStyle(hexToInt(PAL.ink)).fillRect(x, y, w, h);
    g.fillStyle(hexToInt(pressed ? PAL.night : fill)).fillRect(x + 1, y + 1, w - 2, h - 2);
    if (!pressed) {
      g.fillStyle(hexToInt(accent ?? PAL.steel)).fillRect(x + 1, y + 1, w - 2, 1);
      g.fillStyle(hexToInt(PAL.ink)).fillRect(x + 1, y + h - 2, w - 2, 1);
    }
  }

  private drawUi(): void {
    const g = this.ui;
    g.clear();
    this.ui2.clear();
    const cr = this.sim.world.crowd;
    const answered = !!cr && this.me()?.crowdAnswered === cr.warnAt;
    // шапка и панель
    g.fillStyle(hexToInt(PAL.night)).fillRect(0, 0, 180, AY);
    g.fillStyle(hexToInt(PAL.ink)).fillRect(0, AY - 1, 180, 1);
    g.fillStyle(hexToInt(PAL.dusk)).fillRect(0, 0, 180, 1);
    g.fillStyle(hexToInt(PAL.night)).fillRect(0, PANEL_Y, 180, 36);
    g.fillStyle(hexToInt(PAL.ink)).fillRect(0, PANEL_Y, 180, 1);
    g.fillStyle(hexToInt(PAL.dusk)).fillRect(0, PANEL_Y + 1, 180, 1);
    for (const b of this.buttons) {
      const vis = b.visible();
      const o = this.btnObjs.get(b.id);
      o?.icon?.setVisible(vis);
      o?.text?.setVisible(vis);
      // шестерёнка без рамки: при нажатии чуть проседает, как кнопки
      if (b.id === 'sound' && o?.icon) o.icon.y = b.y + b.h / 2 + (b.pressed ? 1 : 0);
      if (!vis || b.id === 'sound') continue;
      if (b.id.startsWith('clap-')) {
        const ready = this.clapReady();
        this.drawPanel(b.x, b.y, b.w, b.h, PAL.dusk, b.pressed, ready ? b.accent : PAL.steel, this.crowdG);
        o?.icon?.setAlpha(ready ? 1 : 0.35);
        if (o?.icon) o.icon.y = b.y + b.h / 2 + (b.pressed ? 1 : 0);
        continue;
      }
      if (b.id.startsWith('crowd-')) {
        const chosen = answered && b.id === 'crowd-' + this.crowdChoice;
        this.drawPanel(b.x, b.y, b.w, b.h, chosen ? PAL.forest : PAL.dusk, b.pressed, chosen ? PAL.green : b.accent, this.crowdG);
        o?.icon?.setAlpha(answered && !chosen ? 0.35 : 1);
        if (o?.icon) o.icon.y = b.y + b.h / 2 + (b.pressed ? 1 : 0);
        continue;
      }
      if (b.kind) {
        this.drawRowButton(b);
        const dy = b.pressed && b.kind !== 'plate' ? 1 : 0;
        if (o?.icon) o.icon.y = b.y + Math.floor(b.h / 2) - 1 + dy;
        if (o?.text) o.text.y = b.y + Math.floor(b.h / 2) - 6 + dy;
        continue;
      }
      const ap = b.id === 'autopilot' && this.me()?.autopilot;
      this.drawPanel(b.x, b.y, b.w, b.h, b.label ? PAL.grape : PAL.dusk, b.pressed || !!ap, b.accent, !!b.label);
      if (o?.icon) o.icon.y = b.y + b.h / 2 + (b.pressed || ap ? 1 : 0);
    }
  }

  // ───────────── ввод ─────────────

  private me() {
    return this.sim.me();
  }

  private hitButton(x: number, y: number): Button | undefined {
    for (let i = this.buttons.length - 1; i >= 0; i--) {
      const b = this.buttons[i];
      const [bx, by, bw, bh] = b.hit ?? [b.x, b.y, b.w, b.h];
      if (b.visible() && x >= bx && x < bx + bw && y >= by && y < by + bh) return b;
    }
    return undefined;
  }

  private pressedBy = new Map<number, Button>();

  private onDown(p: Phaser.Input.Pointer): void {
    // первый тап разблокирует звук; нужная музыка включится сама (по фазе), без перезапуска при каждом касании
    this.audio.unlock();
    requestWakeLock();
    const b = this.hitButton(p.x, p.y);
    if (this.init0.spectator && !b) return;
    // обучение ждёт «дальше»: любой тап (кроме крестика «пропустить») листает шаг
    if (this.tut?.waitTap && b?.id !== 'tut-skip') {
      this.tut.tap();
      return;
    }
    if (b) {
      b.pressed = true;
      this.pressedBy.set(p.id, b);
      this.audio.play('click');
      haptic('select');
      b.onDown?.();
      return;
    }
    if (p.y < AY || p.y >= PANEL_Y) return;
    this.tapArena(p.x, p.y - AY, true);
  }

  private onUp(p: Phaser.Input.Pointer): void {
    const b = this.pressedBy.get(p.id);
    if (b) {
      b.pressed = false;
      this.pressedBy.delete(p.id);
      b.onUp?.();
      return;
    }
    if (this.holdTarget) {
      const h = this.holdTarget;
      this.holdTarget = null;
      if (performance.now() - h.at >= this.cfg.holdMs) this.doAttack(h.eid);
    }
  }

  private candidates(x: number, y: number): Entity[] {
    const w = this.sim.world;
    const myEid = this.me()?.eid;
    return w.entities
      .filter((e) => e.alive && e.eid !== myEid && Math.hypot(e.x - x, e.y - 8 - y) <= this.cfg.tapTolerance)
      .sort((a, b) => Math.hypot(a.x - x, a.y - 8 - y) - Math.hypot(b.x - x, b.y - 8 - y));
  }

  private tapArena(x: number, y: number, _down: boolean): void {
    const sim = this.sim;
    const me = this.me();
    if (!me) return;
    if (sim.phase === 'accuse') {
      const c = this.candidates(x, y)[0];
      if (c) {
        sim.intent({ k: 'accuse', eid: c.eid });
        this.audio.play('tick');
      }
      return;
    }
    if (sim.phase !== 'play') return;
    const w = sim.world;
    const mine = w.get(me.eid)!;
    if (!me.alive) {
      const c = this.candidates(x, y)[0];
      if (c) {
        if (this.ghostMarks.has(c.eid)) this.ghostMarks.delete(c.eid);
        else {
          this.ghostMarks.add(c.eid);
          this.tut?.noteMark();
        }
        this.audio.play('tick');
      }
      return;
    }
    // тап по звезде — идти за ней (даже если она прямо над своим персонажем или рядом с кем-то)
    for (const st of w.stars.values()) {
      if (Math.hypot(st.x - x, st.y - 3 - y) <= 6) {
        sim.intent({ k: 'move', x: Math.round(st.x), y: Math.round(st.y) });
        return;
      }
    }
    if (Math.hypot(mine.x - x, mine.y - 8 - y) <= 7) {
      sim.intent({ k: 'stop' });
      return;
    }
    const inRange = this.candidates(x, y).filter((e) => Math.hypot(e.x - mine.x, e.y - mine.y) <= this.cfg.attackRange);
    if (inRange.length) {
      if (this.cfg.attackConfirm === 'hold') this.holdTarget = { eid: inRange[0].eid, at: performance.now() };
      else this.doAttack(inRange[0].eid);
      return;
    }
    sim.intent({ k: 'move', x: Math.round(x), y: Math.round(y) });
  }

  private doAttack(eid: number): void {
    this.lastAttackAt = this.sim.world.time;
    // мгновенный отклик: замах, свист и искры у цели. Итог (поф или оглушение) — от хоста
    const me = this.me();
    const w = this.sim.world;
    const mine = me ? w.get(me.eid) : undefined;
    const te = w.get(eid);
    if (me && mine && te && me.attacksLeft > 0 && w.time >= me.stunUntil) {
      const d = Math.hypot(te.x - mine.x, te.y - mine.y) || 1;
      this.lunge = { dx: ((te.x - mine.x) / d) * 3, dy: ((te.y - mine.y) / d) * 2, start: performance.now() };
      this.swingFx.push({ eid, x: te.x, y: te.y, t: 0 });
      this.audio.play('swing');
      haptic('medium');
    }
    this.sim.intent({ k: 'attack', eid });
  }

  // ───────────── события ─────────────

  private onWorldEvent(ev: WorldEvent): void {
    const myEid = this.me()?.eid;
    switch (ev.t) {
      case 'hit':
        // ночью Майами — удар оружием: звук, тряска и стоп-кадр — в момент удара (weaponImpact)
        // бьющий известен (ночь Майами, удар по статисту); без него («Жёсткий дубль») — «поф»
        if (this.weaponKills() && ev.attacker !== undefined) this.weaponHit(ev.target, ev.x, ev.y, ev.attacker);
        else {
          this.audio.play(ev.result === 'player' ? 'hitPlayer' : 'hitBot');
          this.audio.play('poof');
          this.cameras.main.shake(120, 0.008);
          this.hitStop = 60;
        }
        // вибрация (в Telegram — родная): вырезали меня — сильно; мой удар — успех по живому, ошибка по боту
        if (ev.target === myEid) haptic('heavy');
        else if (this.sim.world.time - this.lastAttackAt < 200) haptic(ev.result === 'player' ? 'success' : 'error');
        if (ev.target === myEid) {
          // «Жёсткий дубль»: вырезал режиссёр — сразу после окна команды, без удара
          const c = this.sim.world.crowd;
          const byDirector = (roundMod(this.sim.mod) === 'hard' || this.cfg.strictCrowd) && !!c && !c.vote && ev.at > c.windowEnd && ev.at < c.windowEnd + 2000;
          const sub = byDirector ? this.t.game.cutByCrowd : undefined;
          // оружием — баннер в момент удара, с кровью на экране и сотрясением (weaponImpact)
          const lk = this.kills.find((k) => k.k.eid === ev.target && !k.hit);
          if (lk) lk.mine = { sub };
          else this.showDeath(sub);
          if (ev.result === 'player' && myEid !== undefined) this.offerDeathClip(myEid, ev.at, ev.attacker);
        }
        break;
      case 'star_taken':
        this.audio.play('starTake');
        if (ev.eid === myEid) haptic('success');
        if (ev.eid !== myEid && this.sim.phase === 'play') this.tip('star');
        if (themePack(this.sim.theme).starSiren && this.sim.phase === 'play') {
          this.audio.play('siren');
          this.siren = performance.now();
        }
        {
          // вспышка на месте звезды, а не собравшего: в толпе это не подсказка
          const pos = this.starPos.get(ev.id);
          if (pos) this.flashes.push({ x: pos.x, y: pos.y, t: 0 });
          this.starPos.delete(ev.id);
        }
        break;
      case 'star_spawn':
        this.starPos.set(ev.id, { x: ev.x, y: ev.y });
        if (this.sim.phase === 'play') this.audio.play('starSpawn');
        break;
      case 'spot': {
        this.spots.push({ x: ev.x, y: ev.y, r: ev.r, at: ev.at, until: ev.until });
        if (this.sim.phase === 'play') this.tip('spot');
        // один звук и одна подсказка на команду, даже если ошиблись несколько
        if (this.sim.phase === 'play' && this.spots.filter((p) => p.at === ev.at).length === 1) {
          this.audio.play('flicker');
          const mine = myEid !== undefined ? this.sim.world.get(myEid) : undefined;
          const inSpot = (m: { x: number; y: number }) => this.spots.some((p) => p.at === ev.at && Math.hypot(p.x - m.x, p.y - m.y) <= p.r);
          this.time.delayedCall(0, () => {
            const me = mine && this.sim.world.get(mine.eid);
            this.showToast(me && me.alive && inSpot(me) ? this.t.game.spottedMe : this.t.game.spotted, 1500);
          });
        }
        break;
      }
      case 'crowd':
        if (ev.vote) this.tip('vote');
        else if (this.newbie) this.tip('crowd');
        this.audio.cutMusic();
        this.audio.play('crowd');
        haptic('warning'); // стоп-кадр: «замри» чувствуется рукой, даже без звука
        this.musicResumeAt = ev.windowEnd + 900;
        break;
      case 'zone':
        this.audio.play('hedge');
        this.showToast(this.t.game.hedge, 1800);
        break;
      case 'twist': {
        // изнанка темы: свет мигает, офис → подвал (и обратно); песня темы — громче.
        // Плавная тема (закат): без мигания, музыка — со следующего такта, облик — на пике сумерек
        const smooth = themePack(this.sim.theme).transition === 'dusk';
        this.audio.setTwist(ev.on, smooth);
        if (this.sim.phase !== 'play') break;
        if (smooth) this.audio.play('dusk');
        else {
          this.flicker = performance.now();
          this.audio.play('flicker');
          this.cameras.main.shake(90, 0.004);
        }
        const tt = this.themeText();
        const msg = ev.on ? tt?.twistOn : tt?.twistOff;
        if (msg) this.showToast(msg, 1800);
        break;
      }
      default:
        break;
    }
  }

  /** Я режиссёр (хост): только мои «Дальше» и «Ещё дубль» что-то делают. В песочнице — всегда я. */
  private amHost(): boolean {
    return this.sim.selfPid === this.sim.hostPid;
  }

  /** Событие аналитики; в обучении не пишем — там свои события (TutorialStage). */
  private track(name: string, props?: Record<string, string | number | boolean | null>): void {
    if (this.init0.tutorial) return;
    try {
      this.init0.onEvent?.(name, props);
    } catch {
      /* аналитика не ломает игру */
    }
  }

  /** Итог дубля для аналитики: что было со мной и откуда очки. */
  private trackRound(): void {
    const s = this.sim.summary;
    if (!s) return;
    const self = this.sim.selfPid;
    const me = s.reveal.find((r) => r.pid === self);
    const pts = s.points[self];
    const acc = s.accusations.find((a) => a.pid === self);
    this.track('round_end', {
      round: s.round,
      theme: this.sim.theme,
      mod: this.sim.mod,
      reason: s.endReason,
      alive: !!me?.alive,
      accused: acc ? (acc.correct ? 'right' : 'wrong') : 'none',
      caught: !!me && s.accusations.some((a) => a.eid === me.eid),
      kill: pts?.kill ?? 0,
      survive: pts?.survive ?? 0,
      stars: pts?.stars ?? 0,
      accuse: pts?.accuse ?? 0,
      awards: s.awards.length,
    });
  }

  private handleNotices(): void {
    const list = this.sim.drainNotices();
    for (const n of list) this.onNotice(n);
  }

  private onNotice(n: Notice): void {
    if (n.t === 'round_start') {
      this.clearDeath();
      this.clearGore();
      this.audio.setTwist(false);
      this.next25 = 0;
      void loadTheme(n.theme);
      this.applyTheme();
      this.ghostMarks.clear();
      this.replay = null;
      // клип выбывшего, который уже монтируется или готов, не теряем: кнопка вернётся на итогах следующего дубля
      const dc = this.deathClip;
      if (!dc || dc.status === 'offer' || dc.round < n.round - 1) this.deathClip = null;
      if (n.round === 1) {
        // реванш: новый матч — новые лучший момент и карточка
        this.best = null;
        this.cardFile = null;
        this.track('match_start', { players: this.sim.players.length, ai: this.sim.players.filter((p) => p.ai).length, level: this.cfg.strictCrowd ? 'hard' : this.cfg.kidsMode ? 'easy' : 'normal', kids: this.cfg.kidsMode, strict: this.cfg.strictCrowd, rounds: this.cfg.maxRounds, roundSec: this.cfg.roundSec });
      }
    } else if (n.t === 'phase') {
      if (n.phase === 'countdown') this.audio.play('count');
      if (n.phase !== 'match_end') this.triumphShown = false;
      // Telegram: посреди матча — переспросить, если закрывают приложение
      if (!this.init0.tutorial && !this.init0.spectator) setClosingConfirmation(n.phase !== 'match_end');
      if (n.phase === 'play') {
        this.audio.play('ready');
        this.flashWord(this.t.game.action);
        // присказка темы — только когда нет условия съёмки: его уже прочитали на отсчёте
        const intro = roundMod(this.sim.mod) === 'none' ? this.themeText()?.intro : undefined;
        if (intro) this.time.delayedCall(900, () => this.sim.phase === 'play' && this.showToast(intro, 2400));
        // новичок без «Пробного дубля»: как ходить — сразу, как искать живого — когда осмотрелся
        if (this.newbie && !this.init0.spectator) {
          this.time.delayedCall(1200, () => this.sim.phase === 'play' && !this.sim.world.isFrozen() && this.tip('move'));
          this.huntTipAt = performance.now() + 14000 / (this.init0.timeScale ?? 1);
        }
      }
      if (n.phase === 'accuse') this.audio.play('tick');
      this.syncMusic(n.phase === 'countdown');
      if (n.phase === 'reveal') {
        this.revealStartNow = this.sim.now;
        this.finalSoundsPlayed = false;
        const s = this.sim.summary!;
        this.replay = makeReplay(this.sim.world, s.replayFrom, this.sim.world.time);
        this.setReplayKills();
        this.trails.clear();
        this.noteMoment();
        this.upgradeDeathClip();
        this.audio.play('drum');
      }
      if (n.phase === 'results' && !this.init0.spectator) this.trackRound();
      if (n.phase === 'match_end') {
        this.audio.play(this.sim.match?.tooAlive ? 'sad' : 'fanfare');
        this.spawnConfetti();
        const m = this.sim.match;
        if (m) {
          const scores = Object.values(m.scores).sort((a, b) => b - a);
          this.track('match_end', {
            players: this.sim.players.length,
            rounds: this.sim.roundsPlayed,
            won: m.winners.includes(this.sim.selfPid),
            tooAlive: m.tooAlive,
            score: m.scores[this.sim.selfPid] ?? 0,
            top: scores[0] ?? 0,
            margin: (scores[0] ?? 0) - (scores[1] ?? 0),
            kills: this.sim.myMatchKills,
          });
        }
      }
      this.buildOverlay();
    } else if (n.t === 'denied' && n.pid === this.sim.selfPid) {
      this.audio.play('denied');
      haptic('error');
      const msg = this.t.game.denied[n.reason];
      this.showToast(msg, 1000);
    }
  }

  /**
   * Ночь Майами и т. п.: выбивают оружием, а не «пофом». С личной настройкой «Без насилия» замах
   * тот же (его видят все — правило темы), но пустыми руками и с «пуфом» вместо крови и тела.
   */
  private weaponKills(): boolean {
    if (this.sim.phase !== 'play') return false;
    const [t, l] = this.lookKey.split('_').map(Number);
    return this.lookKey !== '0_0' && isThemeLoaded(t) && themeLook(t, l).kill === 'weapon';
  }

  /** Облик темы дубля (обычный или изнанка) выбивает оружием. */
  private weaponLook(twist: boolean): boolean {
    const th = this.sim.theme;
    return isThemeLoaded(th) && themeLook(th, twist ? 1 : 0).kill === 'weapon';
  }

  /**
   * Удар битой, трубой или ножом над целью (нападавший не раскрыт: оружие — по жертве).
   * Замах (0,11 с) → удар (0,06 с) → в момент удара: звук оружия, стоп-кадр, тряска, красная
   * вспышка, искры, брызги, тело падает, оружие остаётся лежать рядом (рисует gore.ts).
   */
  private weaponHit(eid: number, x: number, y: number, by: number): void {
    this.audio.play('swing');
    const w = this.sim.world;
    const i = w.entities.findIndex((e) => e.eid === eid);
    const tex = i >= 0 ? 'ch' + this.charKey(this.lookKey, i) : '';
    const k = makeKill(eid, x, y, w.time);
    k.mild = mildOn();
    // замахивается сам бьющий: ночью в Майами его видят все (themes.ts › exposeKiller)
    const att = w.get(by);
    if (att) aim(k, att.x);
    k.by = by;
    // до удара жертва ещё стоит
    const standIn = tex ? this.add.image(k.x, AY + k.y - 8, tex, F.D).setDepth(AY + k.y) : null;
    this.kills.push({ k, t: 0, hit: false, tex, standIn });
    this.noPoof.add(eid);
  }

  /** Момент удара: всё, что должно случиться разом. */
  private weaponImpact(lk: LiveKill): void {
    if (lk.k.mild) {
      // «Без насилия»: без крови, вспышки и тела — жертва исчезает обычным «пуфом»
      if (lk.mine) this.time.delayedCall(0, () => this.showDeath(lk.mine!.sub, false));
      this.audio.play('poof');
      this.audio.play('hitPlayer');
      this.cameras.main.shake(120, 0.008);
      lk.standIn?.destroy();
      lk.standIn = null;
      const pf = this.add.image(lk.k.x, AY + lk.k.y - 8, 'poof', 0).setDepth(AY + lk.k.y + 1);
      this.time.addEvent({ delay: 60, repeat: 5, callback: () => (pf.frame.name === '5' ? pf.destroy() : pf.setFrame(Number(pf.frame.name) + 1)) });
      this.time.delayedCall(420, () => pf.destroy());
      return;
    }
    if (lk.mine) this.time.delayedCall(0, () => this.showDeath(lk.mine!.sub, true));
    this.audio.play(weaponSfx(lk.k));
    this.audio.play('hitPlayer');
    this.hitStop = 70;
    this.cameras.main.shake(180, 0.016);
    navigator.vibrate?.(30);
    const flash = this.add.rectangle(0, AY, 180, 260, hexToInt(PAL.red), 0.22).setOrigin(0, 0).setDepth(970);
    this.tweens.add({ targets: flash, alpha: 0, duration: 160, onComplete: () => flash.destroy() });
    lk.standIn?.destroy();
    lk.standIn = null;
    const b = bodyPose(lk.k);
    if (lk.tex) this.bodies.push(this.add.image(b.x, AY + b.y, lk.tex, F.D).setAngle(b.angle).setDepth(AY + lk.k.y - 6));
  }

  /** Повтор разоблачения: удары оружием из журнала дубля (кто бил — в самом событии). */
  private setReplayKills(): void {
    this.replayBy.clear();
    const kills = killsFromLog(this.sim.world.log, (tw) => this.weaponLook(tw));
    const mild = mildOn();
    for (const k of kills) k.mild = mild;
    this.replayKills = new Map(kills.map((k) => [k.eid, k]));
    for (const k of kills) this.replayBy.set(k.by!, [...(this.replayBy.get(k.by!) ?? []), k]);
  }

  /** Руки бьющего в повторе — по костюму облика на экране. */
  private lookArms(): ArmColors {
    const [t, l] = this.lookKey.split('_').map(Number);
    return armsOf(isThemeLoaded(t) ? themeLook(t, l).chars.map : {});
  }

  /** Рисовалка gore.ts поверх Graphics (координаты поля). */
  private pxOf(g: Phaser.GameObjects.Graphics): Px {
    return (x, y, w, h, c, a = 1) => {
      let n = this.pxCache.get(c);
      if (n === undefined) this.pxCache.set(c, (n = hexToInt(c)));
      g.fillStyle(n, a).fillRect(x, AY + y, w, h);
    };
  }

  /**
   * Прожектор как на съёмке: поле притухает (кроме пятен света), из-за верхнего края кадра
   * к каждому пятну тянется конус (шахматкой — полупрозрачно), пятно на полу — эллипс
   * (вид сверху под углом). Первые 0,3 с свет набирает силу, последние 0,5 с — гаснет.
   */
  private renderSpots(wt: number): void {
    const g = this.spotG;
    g.clear();
    if (!this.spots.length) return;
    const ell = this.spots.map((p) => {
      const age = wt - p.at;
      const k = Math.min(1, age / 300, (p.until - wt) / 500);
      // площадка темнеет только на первые 2,5 с, луч светит до конца
      const dk = Math.min(1, age / 300, (p.at + 2500 - wt) / 500);
      return { cx: p.x, cy: p.y, rx: p.r, ry: Math.round(p.r * 0.5), k, dk };
    });
    const k = Math.max(0, ...ell.map((e) => e.dk));
    const ink = hexToInt(PAL.ink);
    // темнота вокруг: по строкам поля, с дырами-эллипсами
    g.fillStyle(ink, 0.42 * k);
    for (let y = 0; k > 0 && y < 260; y++) {
      const holes: [number, number][] = [];
      for (const e of ell) {
        const dy = (y - e.cy) / e.ry;
        if (Math.abs(dy) >= 1) continue;
        const w = Math.round(e.rx * Math.sqrt(1 - dy * dy));
        holes.push([e.cx - w, e.cx + w]);
      }
      holes.sort((a, b) => a[0] - b[0]);
      let x = 0;
      for (const [a, b] of holes) {
        if (a > x) g.fillRect(x, AY + y, a - x, 1);
        x = Math.max(x, b + 1);
      }
      if (x < 180) g.fillRect(x, AY + y, 180 - x, 1);
    }
    // лучи: от узкого у верхнего края до ширины пятна, мерцающая шахматка
    const ph = Math.floor(performance.now() / 120) % 2;
    for (const e of ell) {
      const sx = e.cx + (e.cx < 90 ? 14 : -14); // источник чуть в стороне — луч наклонный
      const top = 0;
      const bot = e.cy;
      g.fillStyle(hexToInt(PAL.white), 0.3 * e.k);
      for (let y = top; y <= bot; y++) {
        const u = (y - top) / Math.max(1, bot - top);
        const cx = Math.round(sx + (e.cx - sx) * u);
        const w = Math.round(3 + (e.rx - 3) * u);
        for (let x = cx - w; x <= cx + w; x++) if ((x + y + ph) % 2 === 0) g.fillRect(x, AY + y, 1, 1);
      }
      // пятно на полу: светлый эллипс и тёплый край
      g.fillStyle(hexToInt(PAL.white), 0.22 * e.k);
      for (let y = -e.ry; y <= e.ry; y++) {
        const w = Math.round(e.rx * Math.sqrt(1 - (y * y) / (e.ry * e.ry)));
        g.fillRect(e.cx - w, AY + e.cy + y, w * 2 + 1, 1);
      }
      g.fillStyle(hexToInt(PAL.yellow), 0.7 * e.k);
      for (let a = 0; a < 64; a++) {
        const t = (a / 64) * Math.PI * 2;
        g.fillRect(Math.round(e.cx + Math.cos(t) * e.rx), Math.round(AY + e.cy + Math.sin(t) * e.ry), 1, 1);
      }
    }
  }

  private clearGore(): void {
    for (const b of this.bodies) b.destroy();
    this.bodies = [];
    for (const lk of this.kills) lk.standIn?.destroy();
    this.kills = [];
    this.replayKills.clear();
    this.replayBy.clear();
    this.noPoof.clear();
    this.goreG?.clear();
  }

  /** Крупно и сразу понятно: тебя выбили, теперь ты призрак. */
  private showDeath(subText?: string, bloody = false): void {
    this.clearDeath();
    if (bloody) this.bloodyScreen();
    const flash = this.add.rectangle(0, 0, 180, 320, hexToInt(PAL.red), 0.55).setOrigin(0, 0).setDepth(1690);
    this.tweens.add({ targets: flash, alpha: 0, duration: 500, onComplete: () => flash.destroy() });
    const y = AY + 92;
    const g = this.add.graphics().setDepth(1700);
    // у вырезанного во время игры есть «Хлопушка» — четвёртая строка о ней
    const clap = this.sim.phase === 'play' && this.sim.cfg.ghostClaps > 0;
    const hgt = clap ? 74 : 62;
    g.fillStyle(hexToInt(PAL.ink), 0.88).fillRect(0, y, 180, hgt);
    g.fillStyle(hexToInt(PAL.red)).fillRect(0, y, 180, 2).fillRect(0, y + hgt - 2, 180, 2);
    const title = this.txt(0, y + 9, this.t.game.outTitle, 'red').setScale(2).setDepth(1701);
    this.centerScaled(title);
    const sub = this.txt(0, y + 33, subText ?? this.t.game.outSub, subText ? 'yellow' : 'white').setDepth(1701);
    sub.x = Math.round(90 - sub.width / 2);
    const hint = this.txt(0, y + 45, this.t.game.outHint, 'mist').setDepth(1701);
    hint.x = Math.round(90 - hint.width / 2);
    this.deathObjs = [g, title, sub, hint];
    if (clap) {
      const ch = this.txt(0, y + 57, this.t.game.clapHint, 'yellow').setDepth(1701);
      ch.x = Math.round(90 - ch.width / 2);
      this.deathObjs.push(ch);
    }
    if (bloody) {
      // в глазах плывёт: надпись дрожит, пока не придёшь в себя
      const texts = [title, sub, hint];
      const base = texts.map((o) => o.x);
      this.tweens.addCounter({
        from: 1,
        to: 0,
        duration: 800,
        onUpdate: (tw) => {
          const dx = Math.round((Math.random() - 0.5) * 5 * tw.getValue()!);
          texts.forEach((o, i) => o.setX(base[i] + dx));
        },
        onComplete: () => texts.forEach((o, i) => o.active && o.setX(base[i])),
      });
    } else {
      this.cameras.main.shake(260, 0.012);
      navigator.vibrate?.([80, 60, 160]);
    }
    const objs = this.deathObjs;
    this.time.delayedCall(2800, () => {
      if (this.deathObjs !== objs) return;
      this.tweens.add({ targets: objs, alpha: 0, duration: 450, onComplete: () => this.clearDeath() });
    });
  }

  /**
   * Тебя вырезали оружием: кровь брызнула на «объектив» и стекает, в глазах темнеет и веки
   * моргают, по краям экрана пульсирует красное в такт сердцу, звон в ушах, музыка глохнет.
   */
  private bloodyScreen(): void {
    const W = 180;
    const H = 320;
    this.audio.play('knockedOut');
    this.cameras.main.shake(450, 0.03);
    navigator.vibrate?.([140, 50, 60, 260, 90, 260]);
    const objs: Phaser.GameObjects.GameObject[] = [];
    const key = `blood-${++this.bloodN}`;
    const tex = this.textures.createCanvas(key, W, H)!;
    const c = tex.getContext();
    const put = (x: number, y: number, w: number, h: number, col: string) => {
      c.fillStyle = col;
      c.fillRect(Math.round(x), Math.round(y), w, h);
    };
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const drips: { x: number; y: number; w: number; v: number; max: number }[] = [];
    const n = 11;
    for (let i = 0; i < n; i++) {
      const big = i < 2;
      const r = big ? rnd(12, 18) : i < 5 ? rnd(6, 10) : rnd(2, 6);
      // крупные — не под баннером «вырезан»: одна сверху, одна снизу
      const cx = big ? (i === 0 ? rnd(20, 80) : rnd(100, 160)) : rnd(8, W - 8);
      const cy = big ? (i === 0 ? rnd(AY + 14, AY + 72) : rnd(AY + 185, PANEL_Y - 24)) : rnd(AY + 4, PANEL_Y - 10);
      const jag = Array.from({ length: 16 }, () => rnd(0.72, 1.25));
      const R = Math.ceil(r * 1.3);
      for (let y = -R; y <= R; y++) {
        for (let x = -R; x <= R; x++) {
          const d = Math.hypot(x, y);
          const a = Math.round(((Math.atan2(y, x) + Math.PI) / (Math.PI * 2)) * 16) % 16;
          const rr = r * jag[a];
          if (d <= rr) put(cx + x, cy + y, 1, 1, d > rr - 1.3 ? PAL.wine : PAL.red);
        }
      }
      // блик на капле
      put(cx - r * 0.45, cy - r * 0.45, 2, 1, PAL.coral);
      put(cx - r * 0.45, cy - r * 0.45 + 1, 1, 1, PAL.coral);
      if (r > 6) put(cx - r * 0.45 + 1, cy - r * 0.45 - 1, 1, 1, PAL.white);
      // мелкие брызги вокруг
      for (let k = 0, m = Math.round(big ? rnd(14, 22) : rnd(5, 11)); k < m; k++) {
        const a = rnd(0, Math.PI * 2);
        const d = r + rnd(2, big ? 18 : 10);
        const sz = Math.random() < 0.35 ? 2 : 1;
        put(cx + Math.cos(a) * d, cy + Math.sin(a) * d, sz, sz, Math.random() < 0.3 ? PAL.wine : PAL.red);
      }
      // потёки вниз
      if (r >= 5) {
        for (let k = 0, m = big ? 3 : 1; k < m; k++) {
          drips.push({ x: Math.round(cx + rnd(-r * 0.5, r * 0.5)), y: Math.round(cy + r * 0.6), w: Math.random() < 0.5 ? 2 : 1, v: rnd(6, 18) / 1000, max: rnd(12, big ? 60 : 30) });
        }
      }
    }
    tex.refresh();
    const splat = this.add.image(0, 0, key).setOrigin(0, 0).setDepth(1695);
    const dripG = this.add.graphics().setDepth(1695);
    objs.push(splat, dripG);
    // красное по краям экрана — пульсирует в такт сердцу (звук knockedOut)
    const vig = this.add.image(0, 0, this.vignetteKey()).setOrigin(0, 0).setDepth(1696).setAlpha(0);
    // веки: темнеет в глазах, моргнул и пришёл в себя
    const lids = this.add.graphics().setDepth(2600);
    objs.push(vig, lids);
    const lid = (t: number) => {
      const keys: [number, number][] = [[0, 160], [140, 160], [420, 18], [640, 95], [860, 0]];
      for (let i = 0; i < keys.length - 1; i++) {
        const [t0, h0] = keys[i];
        const [t1, h1] = keys[i + 1];
        if (t <= t1) return Math.round(h0 + (h1 - h0) * ((t - t0) / (t1 - t0)));
      }
      return 0;
    };
    const beats = [550, 780, 1450, 1680];
    const LIFE = 4800;
    this.tweens.addCounter({
      from: 0,
      to: LIFE,
      duration: LIFE,
      onUpdate: (tw) => {
        const t = tw.getValue()!;
        const h = lid(t);
        lids.clear();
        if (h > 0) lids.fillStyle(hexToInt(PAL.ink), 1).fillRect(0, 0, W, h).fillRect(0, H - h, W, h);
        let v = 0.35;
        for (const b of beats) if (t >= b) v = Math.max(v, 0.95 - (t - b) / 380);
        if (t > 2400) v *= Math.max(0, 1 - (t - 2400) / 1200);
        vig.setAlpha(v);
        const fade = t < LIFE - 1100 ? 1 : (LIFE - t) / 1100;
        splat.setAlpha(fade);
        dripG.clear();
        for (const d of drips) {
          const len = Math.min(d.max, Math.max(0, t - 380) * d.v);
          if (len < 1) continue;
          dripG.fillStyle(hexToInt(PAL.red), fade).fillRect(d.x, d.y, d.w, Math.round(len));
          dripG.fillStyle(hexToInt(PAL.wine), fade).fillRect(d.x, d.y + Math.round(len), d.w + 1, 2);
        }
      },
      onComplete: () => {
        for (const o of objs) o.destroy();
        this.textures.remove(key);
      },
    });
  }

  /** Красная виньетка с дизерингом (раз на сцену). */
  private vignetteKey(): string {
    const key = 'vignette-red';
    if (this.textures.exists(key)) return key;
    const W = 180;
    const H = 320;
    const tex = this.textures.createCanvas(key, W, H)!;
    const c = tex.getContext();
    const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const band = 26;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const e = Math.min(x, y, W - 1 - x, H - 1 - y);
        if (e >= band) continue;
        const p = (1 - e / band) ** 1.6;
        if (p * 16 <= bayer[(y % 4) * 4 + (x % 4)]) continue;
        c.fillStyle = e < band * 0.35 ? PAL.wine : PAL.red;
        c.fillRect(x, y, 1, 1);
      }
    }
    tex.refresh();
    return key;
  }

  // ───────────── клип выбывшего ─────────────

  /** Кнопка в углу поля: появляется после баннера выбывания (анимацию не трогаем). */
  private buildDeathClipButton(): void {
    const b: Button = {
      id: 'deathclip',
      x: 96,
      y: PANEL_Y - 26,
      w: 80,
      h: 22,
      label: this.t.clip.deathBtn,
      accent: PAL.amber,
      keep: true,
      // в игре — в углу поля, на итогах — во всю ширину нижней панели (кнопки итогов выше)
      visible: () => {
        const ph = this.sim.phase;
        const dc = this.deathClip;
        // клип прошлого дубля посреди нового не мешает: кнопка ждёт итогов этого дубля (монтаж идёт фоном)
        const ok = !!dc && (dc.round === this.sim.round ? ph === 'play' || ph === 'accuse' || ph === 'reveal' || ph === 'results' : ph === 'results');
        if (ok) this.placeDeathClipButton(b, ph === 'results');
        return ok;
      },
      // отпускание пальца: «Отправить» открывает системное меню, а ему нужен свежий жест
      onUp: () => this.onDeathClipTap(),
    };
    this.buttons.push(b);
    const text = this.txt(b.x + b.w / 2, b.y + 6, b.label!, 'yellow').setOrigin(0.5, 0).setDepth(2100).setVisible(false);
    this.btnObjs.set(b.id, { text });
  }

  private offerDeathClip(eid: number, at: number, killer?: number): void {
    if (!clipSupported()) return;
    const round = this.sim.round;
    // после баннера «Ты выбит!» (он гаснет через ~3,3 с)
    this.time.delayedCall(3400, () => {
      if (this.sim.round !== round || this.me()?.alive) return;
      // прошлый клип ещё монтируется — не сбиваем его
      if (this.deathClip?.status === 'rendering') return;
      // кто выбил, известно сразу только ночью в Майами (его замах видели все)
      this.deathClip = { eid, at, round, status: 'offer', progress: 0, file: null, killer };
      this.updateDeathClipLabel();
      this.audio.play('ready');
    });
  }

  /** Раунд закончился: теперь известно, кто выбил, — клип выбывшего можно снять заново, с ним в кадре. */
  private upgradeDeathClip(): void {
    const dc = this.deathClip;
    const k = this.sim.summary?.kills?.find((x) => dc && x.victim === dc.eid);
    if (!dc || !k || dc.round !== this.sim.round) return;
    // игрок уже нажал «Клип» — монтаж идёт или готов: не начинаем заново (иначе прогресс сбрасывался
    // на конце дубля), только узнаём, кто выбил, — для подписи при отправке
    if (dc.status !== 'offer') {
      dc.killer ??= k.by;
      return;
    }
    // полную версию — с выбившим и всеми живыми в их цветах — монтируем сразу, без нажатия
    const next: DeathClip = { eid: dc.eid, at: dc.at, round: dc.round, status: 'offer', progress: 0, file: null, killer: k.by };
    this.deathClip = next;
    this.updateDeathClipLabel();
    this.renderDeathClip(next);
  }

  private placeDeathClipButton(b: Button, wide: boolean): void {
    const [x, y, w, h] = wide ? [3, PANEL_Y + 3, 174, 30] : [96, PANEL_Y - 26, 80, 22];
    if (b.x === x && b.y === y) return;
    // маленькая кнопка над панелью: рисунок 22 px высотой, палец ловим на 30
    Object.assign(b, { x, y, w, h, hit: wide ? undefined : [x, PANEL_Y - 30, w, 30] });
    const text = this.btnObjs.get('deathclip')?.text;
    if (text) text.y = y + Math.floor(h / 2) - 5;
    this.updateDeathClipLabel();
  }

  private updateDeathClipLabel(): void {
    const dc = this.deathClip;
    const text = this.btnObjs.get('deathclip')?.text;
    const b = this.buttons.find((x) => x.id === 'deathclip');
    if (!dc || !text || !b) return;
    const wide = b.w > 100;
    const c = this.t.clip;
    const label =
      dc.status === 'offer'
        ? wide ? c.deathBtnLong : c.deathBtn
        : dc.status === 'rendering'
          ? wide ? fmt(c.making, { n: Math.round(dc.progress * 100) }) : `${Math.round(dc.progress * 100)}%`
          : c.send;
    // origin 0.5: центр по кнопке, целый пиксель для нечётной ширины
    text.setText(label);
    text.x = b.x + b.w / 2 - (text.width % 2) / 2;
  }

  private onDeathClipTap(): void {
    const dc = this.deathClip;
    if (!dc) return;
    if (dc.status === 'ready' && dc.file) {
      const k = dc.killer === undefined ? undefined : this.sim.summary?.reveal.find((r) => r.eid === dc.killer);
      const kName = k ? this.sim.info(k.pid)?.name : undefined;
      const file = dc.file;
      const text = kName ? fmt(this.t.clip.deathTextBy, { name: kName }) : this.t.clip.deathText;
      void (async () => {
        // Telegram: видео-карточкой в чат; не вышло — как везде
        const tg = await shareClipInTelegram(file, text);
        this.track('clip_send', { kind: 'death', type: file.type.split(';')[0], ...(tg ? { via: 'tg_card' } : {}) });
        if (!tg) await this.init0.onShare?.(text, [file]);
      })();
      return;
    }
    if (dc.status !== 'offer') return;
    this.track('clip_open', { kind: 'death' });
    this.renderDeathClip(dc);
  }

  private renderDeathClip(dc: DeathClip): void {
    const w = this.sim.world;
    const start = w.keyframes[0]?.time ?? 0;
    const to = Math.min(w.time, dc.at + 1500);
    const me = this.sim.info(this.sim.selfPid);
    const s = this.sim.summary;
    const known = dc.killer !== undefined && !!s;
    // с известным нападавшим показываем его подход целиком (до 4,5 с), иначе — 6 с до развязки
    const from = Math.max(start, known ? dc.at - 4500 : to - 6000);
    if (!me || to - from < 1500) return;
    dc.status = 'rendering';
    this.updateDeathClipLabel();
    const c = this.t.clip;
    // посреди раунда других живых не раскрываем (гость их и не знает): подсвечен только ты, подпись — «Кто меня выбил?».
    // После разоблачения — все живые с именами и итог «Енот / выбил меня».
    const players = known
      ? s!.reveal.map((r) => {
          const info = this.sim.info(r.pid)!;
          return { eid: r.eid, name: info.name, color: info.color };
        })
      : [{ eid: dc.eid, name: me.name, color: me.color }];
    const rec = recordRound(w, { round: this.sim.round, theme: this.sim.theme, players: known ? s!.reveal : [], playEnd: to, kills: s?.kills });
    const moment: Moment = { from, to, score: 0, kind: 'knockout', at: dc.at, victim: dc.eid, attacker: dc.killer, selfRole: 'victim' };
    void recordClipInBackground(
      {
        rec,
        moment,
        arena: this.sim.arena,
        players,
        t: this.t,
        font: this.init0.fontFamily,
        site: location.host,
        captions: known ? { find: c.whoGotMe, reveal: c.reveal, kind: c.gotMe } : { find: c.findMe, reveal: c.thatWasMe, kind: c.whoGotMe },
        noGore: mildOn(),
      },
      (p) => {
        if (this.deathClip !== dc) return;
        dc.progress = p;
        this.updateDeathClipLabel();
      },
    ).then((file) => {
      if (this.deathClip !== dc) return;
      if (!file) {
        this.deathClip = null;
        this.showToast(c.failed, 2000);
        return;
      }
      dc.file = file;
      dc.status = 'ready';
      // подсказка-тост легла бы прямо на кнопку — хватает новой надписи и звука
      this.updateDeathClipLabel();
      this.audio.play('starTake');
    });
  }

  /** Иконка команды толпы: своя у облика темы или общая (рука, прыжок, танец). */
  private crowdIconOf(kind: CrowdKind): [string, number] {
    if (this.lookIcons?.[kind]) return ['icons' + this.lookKey, CROWD_KINDS.indexOf(kind)];
    return ['icons', this.icon(kind === 'freeze' ? 'hand' : kind)];
  }

  /** Название команды толпы: своё у темы (в изнанке — своё у изнанки) или общее. */
  private crowdLabel(kind: CrowdKind): string {
    const tt = this.themeText();
    const own = this.lookKey.endsWith('_1') ? tt?.twistCrowd : tt?.crowd;
    return own?.[kind] ?? this.t.game.crowd[kind];
  }

  /** Свои текстовки темы раунда (словарь › themeText), если есть. */
  private themeText(): ThemeText | undefined {
    const id = THEME_RULES[this.sim.theme]?.id;
    return id ? this.t.themeText[id] : undefined;
  }

  /**
   * Вуали поверх поля: закат/рассвет (золото → лиловый → облик меняется → лиловый тает;
   * рассвет — наоборот), пульсация облика в такт (ночной клуб), мигалка «звёзд розыска».
   */
  private renderVeils(): void {
    const now = performance.now();
    const d = this.dusk;
    if (d) {
      const k = (now - d.t0) / DUSK_HALF_MS;
      const toNight = d.to === 1;
      const ramp = k < 1 ? k : Math.max(0, 2 - k);
      const steps = toNight ? [PAL.amber, PAL.orange, PAL.orchid, PAL.grape] : [PAL.grape, PAL.orchid, PAL.orange, PAL.amber];
      const col = k < 1 ? steps[Math.min(3, Math.floor(k * 4))] : steps[3];
      this.duskVeil.setVisible(true).setFillStyle(hexToInt(col), 0.62 * ramp);
    } else this.duskVeil.setVisible(false);
    const [kt, kl] = this.lookKey.split('_').map(Number);
    const pulse = this.lookKey && this.lookKey !== '0_0' && isThemeLoaded(kt) ? themeLook(kt, kl).pulse : undefined;
    const ph = this.sim.phase;
    if (pulse && (ph === 'play' || ph === 'countdown' || ph === 'reveal') && !d) {
      const beat = Math.floor(now / pulse.ms);
      const decay = 1 - (now % pulse.ms) / pulse.ms;
      this.pulseVeil.setVisible(true).setFillStyle(hexToInt(pulse.colors[beat % pulse.colors.length]), pulse.alpha * decay);
    } else this.pulseVeil.setVisible(false);
    const s = now - this.siren;
    if (this.siren && s < 800) this.sirenVeil.setVisible(true).setFillStyle(hexToInt(Math.floor(s / 100) % 2 ? PAL.blue : PAL.red), 0.22);
    else this.sirenVeil.setVisible(false);
  }

  /** Свет мигает при смене изнанки: тьма — свет — тьма — новый облик (мс от начала). */
  private renderFlicker(): void {
    const k = performance.now() - this.flicker;
    const dark = this.flicker > 0 && ((k >= 0 && k < 70) || (k >= 130 && k < 260));
    // пакет темы ещё грузится (медленная сеть) — поле тёмное, а не парк, который потом переоденется
    const waiting = !isThemeLoaded(this.sim.theme);
    this.blackout.setVisible(dark || waiting).setAlpha(waiting ? 1 : 0.92);
    if (k > 300) this.flicker = 0;
  }

  /** Текстура фигуры в облике key («тема_облик»): свой костюм из `Look.variants` по порядковому номеру. */
  private charKey(key: string, index: number): string {
    const [t, l] = key.split('_').map(Number);
    if (key === '0_0' || !isThemeLoaded(t)) return key;
    const i = variantOf(index, themeLook(t, l));
    return i ? `${key}v${i}` : key;
  }

  /** «25-й кадр»: в обычном облике темы на миг (кадр-два) мелькает кто-то из изнанки. */
  private subliminalKey(eid: number): string | null {
    const f = this.flash25;
    if (!f || f.eid !== eid || performance.now() > f.until) return null;
    return this.ensureLook(this.sim.theme, 1);
  }

  private tickSubliminal(): void {
    const th = this.sim.theme;
    const now = performance.now();
    const can = this.sim.phase === 'play' && !this.sim.world.twist && isThemeLoaded(th) && lookCount(th) > 1 && !!themePack(th).subliminal;
    if (!can) {
      this.flash25 = null;
      return;
    }
    if (!this.next25) this.next25 = now + 4000 + Math.random() * 4000;
    if (now < this.next25) return;
    this.next25 = now + 6000 + Math.random() * 6000;
    // иногда «вклеенный кадр» целиком: на миг весь подвал — и обратно в офис
    if (Math.random() < 0.3) {
      this.cut25Until = now + 80;
      return;
    }
    const alive = this.sim.world.alive().filter((e) => !(e.act && this.sim.world.time < e.actEnd));
    if (!alive.length) return;
    // любая сущность, чаще бот: ничего не выдаёт; ~8 кадров — успеваешь заметить, но не разглядеть
    this.flash25 = { eid: alive[Math.floor(Math.random() * alive.length)].eid, until: now + 140 };
  }

  /** Крупное слово по центру поля на миг («Мотор!» на старте дубля). */
  private flashWord(s: string): void {
    const t = this.txt(90, AY + 96, s, 'yellow').setScale(2).setDepth(2200);
    this.centerScaled(t);
    this.tweens.add({ targets: t, alpha: 0, delay: 500, duration: 400, onComplete: () => t.destroy() });
  }

  private clearDeath(): void {
    for (const o of this.deathObjs) o.destroy();
    this.deathObjs = [];
  }

  private showToast(s: string, ms: number): void {
    // в обучении говорит только подсказка сверху — без лишних надписей
    if (this.tut) return;
    this.toast.setText(s).setVisible(true);
    this.toastUntil = performance.now() + ms;
  }

  /**
   * Облик поля по теме раунда и изнанке того мира, что сейчас на экране (в разоблачении — повтора):
   * толпа, земля, предметы, стенка зоны, зверёк. Пакет темы грузится по требованию — пока его нет,
   * поле остаётся в парке, а как загрузится, облик сменится сам.
   */
  private applyTheme(): void {
    const th = this.sim.theme;
    if (!isThemeLoaded(th)) void loadTheme(th).then(() => (this.lookKey = ''));
    const cut = this.sim.phase === 'play' && performance.now() < this.cut25Until;
    const world = this.phaseWorld();
    let lk = world.twist || cut ? 1 : 0;
    // плавная тема (закат): облик меняется на пике сумерек, а не в момент события
    if (themePack(th).transition === 'dusk' && isThemeLoaded(th)) {
      if (th !== this.duskTheme || world !== this.duskWorld) {
        // новый дубль или повтор на разоблачении — сразу как есть
        this.duskTheme = th;
        this.duskWorld = world;
        this.duskShown = lk;
        this.dusk = null;
      }
      const now = performance.now();
      // страховка: на команде «Море волнуется» облик не меняется посреди — переход сразу доводим
      const c = world.crowd;
      const crowdOn = this.sim.phase === 'play' && !!c && world.time >= c.showAt && world.time <= c.windowEnd;
      if (crowdOn && this.dusk) {
        this.duskShown = this.dusk.to;
        this.dusk = null;
      }
      if (!this.dusk && !crowdOn && lk !== this.duskShown) this.dusk = { from: this.duskShown, to: lk, t0: now };
      if (this.dusk) {
        const k = now - this.dusk.t0;
        if (k >= DUSK_HALF_MS) this.duskShown = this.dusk.to;
        if (k >= DUSK_HALF_MS * 2) this.dusk = null;
      }
      lk = this.duskShown;
    }
    // переодевание (маски на закате): заметить смену облика в живой игре
    const du = isThemeLoaded(th) ? themePack(th).dressUp : undefined;
    if (th !== this.dressTheme || world !== this.sim.world || this.sim.phase !== 'play') {
      if (th !== this.dressTheme || this.sim.phase !== 'play') this.dress = null;
      this.dressTheme = th;
      this.dressLk = lk;
    } else if (lk !== this.dressLk) {
      if (du) {
        this.ensureDress(th);
        this.dress = { at: performance.now(), on: lk === du.to };
      }
      this.dressLk = lk;
    }
    const key = this.ensureLook(th, lk);
    if (key === this.lookKey) return;
    this.lookKey = key;
    const [kt, kl] = key.split('_').map(Number);
    const look = themeLook(kt, kl);
    this.lookActs = key === '0_0' ? undefined : look.acts;
    this.lookIcons = key === '0_0' ? undefined : look.icons;
    for (const k of CROWD_KINDS) {
      const [tex, fr] = this.crowdIconOf(k);
      this.btnObjs.get('crowd-' + k)?.icon?.setTexture(tex, fr);
      this.btnObjs.get('clap-' + k)?.icon?.setTexture(tex, fr);
    }
    for (const v of this.views) {
      v.spr.setTexture('ch' + key, 0);
      v.ol.setTexture('ol' + key, 0);
    }
    this.ground.setTexture('arena' + key);
    for (const p of this.props) p.spr.setTexture(`prop-${p.kind}-${key}`, 0);
    for (const h of this.hedges) h.setTexture('hedge' + key);
    for (const p of this.pigeons) p.spr.setTexture('pigeon' + key, 0);
  }

  // ───────────── кадр ─────────────

  update(_time: number, rawDelta: number): void {
    const delta = rawDelta * (this.init0.timeScale ?? 1);
    if (this.tut?.paused) {
      // обучение остановило мир: подсказка, рамка, «тапни — дальше»
      this.acc = 0;
    } else if (this.hitStop > 0) {
      this.hitStop -= delta;
    } else {
      this.acc += Math.min(delta, 250 * (this.init0.timeScale ?? 1));
      let n = 0;
      while (this.acc >= TICK_MS && n++ < 6 * (this.init0.timeScale ?? 1)) {
        this.sim.tick();
        this.handleNotices();
        this.acc -= TICK_MS;
      }
    }
    const alpha = Math.min(1, this.acc / TICK_MS);
    const phase = this.sim.phase;
    if (this.musicResumeAt && this.sim.world.time >= this.musicResumeAt && phase === 'play') {
      this.musicResumeAt = 0;
      this.audio.resumeMusic();
    }
    if (phase === 'play') {
      // напряжение: изгородь сжимается — 1, последние 10 секунд — 2
      const w = this.sim.world;
      const level = this.sim.timeLeft() <= 10_000 ? 2 : w.zone && w.time >= w.zone.startAt ? 1 : 0;
      this.audio.setIntensity(level);
    }

    this.applyTheme();
    this.tickSubliminal();
    this.renderFlicker();
    this.renderVeils();
    this.replayT = null;
    if (phase === 'reveal') this.renderReveal(alpha);
    else this.renderWorld(this.sim.world, phase === 'countdown' || phase === 'play' ? alpha : 1, 'live');

    this.tut?.update();
    this.renderCoach();
    this.dim.setVisible(phase === 'accuse');
    // в обучении подсказку «за кадром» даёт сам шаг сверху, а внизу слева — «Пропустить»
    const ghost = phase === 'play' && !!this.me() && !this.me()!.alive && !this.tut;
    for (const o of this.ghostUi) (o as Phaser.GameObjects.Image).setVisible(ghost);
    if (ghost) {
      // справа «Хлопушка» — подписи короче, чтобы не налезали на кнопки
      const clap = this.me()!.clapsLeft > 0;
      const [l1, l2] = this.ghostUi.slice(1) as Phaser.GameObjects.BitmapText[];
      const a = clap ? this.t.game.ghostShort : this.t.game.ghost;
      const b = clap ? this.t.game.ghostHintShort : this.t.game.ghostHint;
      if (l1.text !== a) l1.setText(a);
      if (l2.text !== b) l2.setText(b);
    }
    this.renderProps();
    this.renderHedge(phase === 'reveal' && this.replay ? this.replay : this.sim.world);
    this.renderPigeons(delta);
    this.renderFx(delta);
    this.renderHud();
    this.drawUi();
    this.updateOverlay(delta);
    this.syncUiCamera();
    if (this.toast.visible && performance.now() > this.toastUntil) this.toast.setVisible(false);
    // подсказка внизу поля — выше кнопки клипа, если та видна; под ней тёмная подложка
    const clipBtn = this.buttons.find((b) => b.id === 'deathclip');
    const ty = (clipBtn && clipBtn.visible() && this.sim.phase !== 'results') || this.tut?.waitTap ? PANEL_Y - 40 : PANEL_Y - 14;
    if (this.toast.y !== ty) this.toast.y = ty;
    const pg = this.plateG;
    pg.clear();
    if (this.toast.visible && this.toast.text) {
      const w = Math.min(180, this.toast.width + 8);
      pg.fillStyle(hexToInt(PAL.ink), 0.62).fillRect(Math.round(90 - w / 2), ty - 2, w, 13);
    }
  }

  private frameFor(e: Entity, t: number): CharFrame {
    return frameFor(e, t, this.lookActs);
  }

  private renderWorld(
    w: World,
    alpha: number,
    mode: 'live' | 'replay' | 'final',
    highlight?: Map<number, number>,
  ): void {
    const t = w.time - TICK_MS + alpha * TICK_MS;
    const me = this.me();
    const myEid = me?.eid ?? -1;
    const phase = this.sim.phase;
    const mine = w.get(myEid);
    const showTargets = mode === 'live' && phase === 'play' && me?.alive && !me.autopilot && w.time >= (me?.stunUntil ?? 0);
    const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 110);
    let crownShown = false;
    w.entities.forEach((e, i) => {
      const v = this.views[i];
      if (!v) return;
      const x = Math.round(e.px + (e.x - e.px) * alpha);
      const y = Math.round(e.py + (e.y - e.py) * alpha);
      const sy = AY + y;
      // «поф» при выбивании
      const since = w.time - e.removedAt;
      // повтор: выбитый оружием лежит на месте удара
      const body = mode === 'replay' && since >= 0 ? this.replayKills.get(e.eid) : undefined;
      if (!e.alive && body) {
        const b = bodyPose(body);
        const tex = 'ch' + this.charKey(this.lookKey, i);
        if (v.spr.texture.key !== tex) v.spr.setTexture(tex, F.D);
        v.spr.setVisible(true).setFrame(F.D).setFlipX(false).setAngle(b.angle).setPosition(b.x, AY + b.y).setDepth(AY + body.y - 6).setAlpha(highlight && !highlight.has(e.eid) ? 0.45 : 1).clearTint();
        for (const o of [v.ol, v.shadow, v.stun, v.mark, v.q, v.poof]) o.setVisible(false);
        return;
      }
      if (!e.alive) {
        v.spr.setVisible(false);
        v.ol.setVisible(false);
        v.shadow.setVisible(false);
        v.stun.setVisible(false);
        v.mark.setVisible(false);
        v.q.setVisible(false);
        if (since >= 0 && since < 360 && !this.noPoof.has(e.eid)) v.poof.setVisible(true).setFrame(Math.min(5, Math.floor(since / 60))).setPosition(x, sy - 8).setDepth(sy + 1);
        else v.poof.setVisible(false);
        return;
      }
      v.poof.setVisible(false);
      const acting = !!e.act && t < e.actEnd;
      const dz = mode === 'live' ? this.dressFrame(i, acting) : null;
      const base = this.frameFor(e, t);
      let frame = dz?.frame ?? base.frame;
      let flip = dz?.frame != null ? false : base.flip;
      let yoff = dz?.frame != null ? 0 : base.yoff;
      // бьющий оружием (известный: повтор или удар по статисту) стоит боком к жертве, пока замахивается
      const rt = this.replayT;
      const swing =
        mode === 'replay' && rt !== null
          ? this.replayBy.get(e.eid)?.find((k) => armed(rt - k.at))
          : mode === 'live'
            ? this.kills.find((lk) => lk.k.by === e.eid && armed(lk.t - SWING_HIT))?.k
            : undefined;
      if (swing) {
        frame = F.S;
        flip = e.x > swing.x;
        yoff = 0;
      }
      let jumpOff = yoff;
      if (mode === 'final' && highlight?.has(e.eid)) jumpOff = -Math.abs(Math.round(Math.sin(performance.now() / 140) * 5));
      // лучший в дубле — с короной над головой (момент триумфа на финальном кадре разоблачения)
      if (mode === 'final' && e.eid === this.crownEid) {
        crownShown = true;
        this.crown.setVisible(true).setFrame(this.icon('crown')).setPosition(x, sy + jumpOff - CH_H - 1).setDepth(sy + 0.5);
      }
      // замах своего персонажа (только на своём экране)
      let lx = 0;
      let ly = 0;
      if (mode === 'live' && e.eid === myEid && this.lunge) {
        const k = (performance.now() - this.lunge.start) / 160;
        if (k >= 1) this.lunge = null;
        else {
          lx = Math.round(this.lunge.dx * Math.sin(k * Math.PI));
          ly = Math.round(this.lunge.dy * Math.sin(k * Math.PI));
        }
      }
      const flashKey = mode === 'live' && !(e.act && t < e.actEnd) ? this.subliminalKey(e.eid) : null;
      const fig = dz?.fig ?? this.charKey(flashKey ?? this.lookKey, i);
      if (v.spr.texture.key !== 'ch' + fig) v.spr.setTexture('ch' + fig, frame);
      if (v.ol.texture.key !== 'ol' + fig) v.ol.setTexture('ol' + fig, frame);
      v.spr.setVisible(true).setFrame(frame).setFlipX(flip).setAngle(0).setPosition(x + lx, sy + jumpOff + ly).setDepth(sy);
      // цель замаха на миг вспыхивает белым
      if (mode === 'live' && this.swingFx.some((s) => s.eid === e.eid && s.t < 90)) v.spr.setTintFill(0xffffff);
      else v.spr.clearTint();
      v.shadow.setVisible(true).setPosition(x, sy).setDepth(sy - 0.5);
      // контур: цели в радиусе удара (только у себя) или подсветка живых в разоблачении
      let olVis = false;
      if (highlight?.has(e.eid)) {
        v.ol.setTint(highlight.get(e.eid)!).setAlpha(1);
        olVis = true;
      } else if (showTargets && mine && e.eid !== myEid && Math.hypot(e.x - mine.x, e.y - mine.y) <= this.cfg.attackRange) {
        v.ol.clearTint().setAlpha(pulse);
        olVis = true;
      } else if (mode === 'live' && phase === 'accuse' && me?.accused === e.eid) {
        v.ol.setTint(hexToInt(PLAYER_COLORS[0])).setAlpha(1);
        olVis = true;
      } else if (mode === 'live' && e.eid === myEid && (phase === 'countdown' || phase === 'play' || phase === 'accuse')) {
        // свой персонаж всегда в контуре своего цвета — видно только на своём экране
        v.ol.setTint(this.myColor).setAlpha(1);
        olVis = true;
      }
      v.ol.setVisible(olVis);
      if (olVis) v.ol.setFrame(frame).setFlipX(flip).setPosition(x, sy + jumpOff).setDepth(sy - 0.2);
      const dim = mode === 'replay' && highlight && !highlight.has(e.eid);
      v.spr.setAlpha(dim ? 0.45 : 1);
      v.shadow.setAlpha(dim ? 0.4 : 1);
      const stunned = e.act === 'stun' && t < e.actEnd;
      v.stun.setVisible(stunned);
      if (stunned) v.stun.setFrame(Math.floor(t / 120) % 3).setPosition(x, sy - CH_H - 1).setDepth(sy + 0.3);
      const marked = e.markUntil > t;
      v.mark.setVisible(marked);
      if (marked) v.mark.setPosition(x, sy - CH_H - 4 - (Math.floor(t / 150) % 2)).setDepth(sy + 0.4);
      const q = mode === 'live' && this.ghostMarks.has(e.eid);
      v.q.setVisible(q);
      if (q) v.q.setPosition(x + 5, sy - CH_H - 2).setDepth(sy + 0.4);
    });
    if (!crownShown) this.crown.setVisible(false);
    for (let i = w.entities.length; i < this.views.length; i++) {
      const v = this.views[i];
      v.spr.setVisible(false);
      v.ol.setVisible(false);
      v.shadow.setVisible(false);
    }

    // свой маркер
    const showMine = mode === 'live' && mine && mine.alive && (phase === 'countdown' || phase === 'play' || phase === 'accuse');
    if (showMine && mine) {
      const x = Math.round(mine.px + (mine.x - mine.px) * alpha);
      const y = Math.round(mine.py + (mine.y - mine.py) * alpha) + AY;
      const { yoff } = this.frameFor(mine, t);
      const bounce = Math.floor(performance.now() / 180) % 2;
      this.arrow.setVisible(true).setPosition(x, y + yoff - CH_H - 3 - bounce);
      this.ring.setVisible(true).setPosition(x, y).setDepth(y - 0.6);
      // начало дубля: два расходящихся круга вокруг себя — глаз сразу находит своего
      if (phase === 'countdown' && this.findMeAt < 0) this.findMeAt = performance.now();
      const fk = (performance.now() - this.findMeAt) / 700;
      this.findMe.clear();
      if (this.findMeAt > 0 && fk < 2.4) {
        for (const k of [fk % 1.2, (fk + 0.6) % 1.2]) {
          if (fk < 0.6 && k > fk) continue;
          this.findMe.lineStyle(2, this.myColor, Math.max(0, 1 - k / 1.2));
          this.findMe.strokeCircle(x, y - 8, 6 + k * 26);
        }
      }
      if (phase === 'countdown') {
        const blinkOn = Math.floor(performance.now() / 160) % 2 === 0;
        const idx = w.entities.indexOf(mine);
        this.views[idx]?.spr.setAlpha(blinkOn ? 1 : 0.25);
      }
    } else {
      this.arrow.setVisible(false);
      this.ring.setVisible(false);
      this.findMe.clear();
      if (phase !== 'countdown' && phase !== 'play') this.findMeAt = -1e9;
    }

    // звёзды
    const seen = new Set<number>();
    for (const s of w.stars.values()) {
      seen.add(s.id);
      let spr = this.starSprites.get(s.id);
      if (!spr) {
        spr = this.add.image(s.x, AY + s.y, 'star', 0).setOrigin(0.5, 0.8);
        this.starSprites.set(s.id, spr);
      }
      const bob = Math.floor((performance.now() + s.id * 300) / 300) % 2;
      spr.setPosition(s.x, AY + s.y - bob).setFrame(Math.floor(performance.now() / 140) % 4).setDepth(AY + s.y - 1).setVisible(true);
    }
    for (const [id, spr] of this.starSprites) {
      if (!seen.has(id)) {
        spr.destroy();
        this.starSprites.delete(id);
      }
    }

    // свои шаги
    if (mode === 'live' && mine?.moving && performance.now() > this.stepSoundAt) {
      this.audio.play('step');
      this.stepSoundAt = performance.now() + 330;
    }
  }

  private renderReveal(alpha: number): void {
    const s = this.sim.summary;
    if (!s) return;
    const cfg = this.cfg;
    const e = this.sim.now - this.revealStartNow + this.acc;
    const drum = cfg.revealDrumSec * 1000;
    const replayDur = ((s.replayTo - s.replayFrom) / cfg.revealSpeed);
    const colors = new Map<number, number>();
    for (const r of s.reveal) colors.set(r.eid, hexToInt(PLAYER_COLORS[this.sim.info(r.pid)!.color]));
    if (e < drum || !this.replay) {
      this.renderWorld(this.sim.world, 1, 'final');
      if (Math.floor(e / 60) % 2 === 0) this.cameras.main.setScroll(Math.random() < 0.5 ? -1 : 1, 0);
      else this.cameras.main.setScroll(0, 0);
      return;
    }
    this.cameras.main.setScroll(0, 0);
    if (e < drum + replayDur) {
      const target = s.replayFrom + (e - drum) * cfg.revealSpeed;
      while (this.replay.time < target && this.replay.time < this.sim.world.time) {
        this.replay.step();
        for (const r of s.reveal) {
          const en = this.replay.get(r.eid);
          if (!en || !en.alive) continue;
          let tr = this.trails.get(r.eid);
          if (!tr) this.trails.set(r.eid, (tr = []));
          const last = tr[tr.length - 1];
          if (!last || Math.hypot(last.x - en.x, last.y - en.y) >= 2) tr.push({ x: Math.round(en.x), y: Math.round(en.y) });
        }
      }
      this.replayT = this.replay.time - TICK_MS + alpha * TICK_MS;
      this.renderWorld(this.replay, alpha, 'replay', colors);
      return;
    }
    const alive = new Map<number, number>();
    for (const r of s.reveal) if (r.alive) alive.set(r.eid, colors.get(r.eid)!);
    this.crownEid = this.roundStar(s);
    this.renderWorld(this.sim.world, 1, 'final', alive);
    if (!this.finalSoundsPlayed) {
      this.finalSoundsPlayed = true;
      s.accusations.forEach((a, i) => this.time.delayedCall(250 + i * 350, () => this.audio.play(a.correct ? 'accuseRight' : 'accuseWrong')));
      this.ovDyn.final?.setVisible(true);
    }
  }

  private renderProps(): void {
    const t = performance.now();
    for (const p of this.props) {
      if (p.kind === 'fountain') p.spr.setFrame(Math.floor(t / 180) % 4);
      if (p.kind === 'lamp') p.spr.setFrame(Math.floor(t / 900) % 2);
    }
  }

  private renderHedge(w: World): void {
    const z = w.zoneRect();
    const full = this.sim.arena.walk;
    if (!z || this.sim.phase === 'results' || this.sim.phase === 'match_end') {
      for (const h of this.hedges) h.setVisible(false);
      return;
    }
    const x0 = Math.round(z.x) - 4;
    const y0 = Math.round(z.y) - 6;
    const x1 = Math.round(z.x + z.w) + 4;
    const y1 = Math.round(z.y + z.h) + 2;
    const W = this.sim.arena.width;
    const H = this.sim.arena.height;
    const rects = [
      [0, 0, W, Math.max(0, y0)],
      [0, y1, W, Math.max(0, H - y1)],
      [0, y0, Math.max(0, x0), y1 - y0],
      [x1, y0, Math.max(0, W - x1), y1 - y0],
    ];
    const grow = z.w < full.w - 1;
    rects.forEach(([x, y, rw, rh], i) => {
      const h = this.hedges[i];
      const vis = grow && rw > 0 && rh > 0;
      h.setVisible(vis);
      if (vis) {
        h.setPosition(x, AY + y).setSize(rw, rh);
        h.setTilePosition(x, y);
      }
    });
  }

  private renderPigeons(delta: number): void {
    const w = this.phaseWorld();
    for (const p of this.pigeons) {
      p.t += delta;
      if (p.state === 'idle') {
        const near = w.entities.some((e) => e.alive && Math.hypot(e.x - p.x, e.y - p.y) < 12);
        if (near) {
          p.state = 'fly';
          p.t = 0;
          if (this.sim.phase === 'play') this.audio.play('pigeon');
        }
        p.spr.setFrame(Math.floor(p.t / 400) % 3 === 0 ? 1 : 0);
      } else if (p.state === 'fly') {
        p.x += delta * 0.05;
        p.y -= delta * 0.06;
        p.spr.setFrame(2 + (Math.floor(p.t / 90) % 4));
        if (p.y < -30) {
          p.state = 'gone';
          p.t = 0;
        }
      } else if (p.t > 9000 && !w.entities.some((e) => e.alive && Math.hypot(e.x - p.hx, e.y - p.hy) < 20)) {
        p.state = 'idle';
        p.x = p.hx;
        p.y = p.hy;
        p.t = 0;
      }
      p.spr.setVisible(p.state !== 'gone').setPosition(Math.round(p.x), Math.round(AY + p.y)).setDepth(AY + p.y);
    }
  }

  private phaseWorld(): World {
    return this.sim.phase === 'reveal' && this.replay ? this.replay : this.sim.world;
  }

  private renderFx(delta: number): void {
    const g = this.fxG;
    g.clear();
    this.crowdG.clear();
    // следы маршрутов в разоблачении
    if (this.sim.phase === 'reveal' && this.sim.summary) {
      for (const r of this.sim.summary.reveal) {
        const tr = this.trails.get(r.eid);
        if (!tr) continue;
        g.fillStyle(hexToInt(PLAYER_COLORS[this.sim.info(r.pid)!.color]), 0.8);
        tr.forEach((pt, i) => {
          if (i % 2 === 0) g.fillRect(pt.x, AY + pt.y, 1, 1);
        });
      }
    }
    // искры замаха у цели
    this.swingFx = this.swingFx.filter((s) => {
      s.t += delta;
      const fr = Math.floor(s.t / 60);
      if (fr > 2) return false;
      const r = 3 + fr * 2;
      g.fillStyle(hexToInt(fr === 0 ? PAL.white : PAL.sand), 1);
      for (const [ax, ay] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.fillRect(Math.round(s.x + ax * r), Math.round(AY + s.y - 8 + ay * r), 1, 1);
      return true;
    });
    // оружие: замах над целью, брызги; пятна — на полу под всеми
    const gg = this.goreG;
    gg.clear();
    for (const lk of this.kills) {
      lk.t += delta;
      if (!lk.hit && lk.t >= SWING_HIT) {
        lk.hit = true;
        this.weaponImpact(lk);
      }
    }
    const floor = this.pxOf(gg);
    const air = this.pxOf(g);
    // на повторе разоблачения — удары повтора по его времени, живые тела и пятна спрятаны
    const rt = this.replayT;
    const gore = this.sim.phase === 'play' || this.sim.phase === 'accuse' || this.sim.phase === 'reveal';
    for (const b of this.bodies) b.setVisible(gore && rt === null);
    const arms = this.lookArms();
    const at = (w: World, eid: number | undefined) => {
      const e = eid !== undefined ? w.get(eid) : undefined;
      return e ? { x: Math.round(e.x), y: Math.round(e.y) } : null;
    };
    if (rt !== null && this.replay) {
      for (const k of this.replayKills.values()) {
        const dt = rt - k.at;
        const h = at(this.replay, k.by);
        if (h && dt <= 0) aim(k, h.x);
        drawFloor(floor, k, dt);
        drawAir(air, k, dt, h, arms);
      }
    } else if (gore) {
      for (const lk of this.kills) {
        drawFloor(floor, lk.k, lk.t - SWING_HIT);
        drawAir(air, lk.k, lk.t - SWING_HIT, at(this.sim.world, lk.k.by), arms);
      }
    }
    // прожекторы режиссёра: свет на площадке гаснет, сверху падает луч, на полу — светлое пятно
    const wt0 = this.sim.world.time;
    this.spots = this.sim.phase === 'play' ? this.spots.filter((p) => wt0 < p.until) : [];
    this.renderSpots(wt0);
    // вспышки звёзд
    this.flashes = this.flashes.filter((f) => {
      f.t += delta;
      const fr = Math.floor(f.t / 70);
      if (fr > 3) return false;
      const r = 2 + fr * 2;
      g.fillStyle(hexToInt(fr < 2 ? PAL.white : PAL.yellow), 1);
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        g.fillRect(Math.round(f.x + Math.cos(ang) * r), Math.round(AY + f.y - 4 + Math.sin(ang) * r), 1, 1);
      }
      return true;
    });
    // конфетти
    for (const c of this.confetti) {
      c.vy += 0.02 * delta;
      c.x += (c.vx * delta) / 16;
      c.y += (c.vy * delta) / 16;
      if (c.y > 330) {
        c.y = -4;
        c.vy = 0.2 + Math.random();
      }
      g.fillStyle(c.c, 1).fillRect(Math.round(c.x), Math.round(c.y), 1 + (Math.round(c.x) % 2), 1);
    }
    // «Море волнуется»
    const cr = this.sim.world.crowd;
    const wt = this.sim.world.time;
    const playing = this.sim.phase === 'play';
    const frozen = playing && this.sim.world.isFrozen();
    if (frozen !== this.wasFrozen) {
      this.wasFrozen = frozen;
      if (this.grayFx) {
        if (frozen) this.grayFx.grayscale(1);
        else this.grayFx.reset();
      } else this.freezeVeil.setVisible(frozen);
    }
    const showCrowd = playing && cr && wt >= cr.showAt && wt <= cr.windowEnd;
    this.crowdIcon.setVisible(!!showCrowd);
    this.crowdText.setVisible(!!showCrowd);
    if (showCrowd && cr) {
      // «Толпа решает»: в стоп-кадре жест не показывается — только «?»
      const [tex, fr] = cr.vote && frozen ? ['icons', this.icon('question')] : this.crowdIconOf(cr.kind);
      if (this.crowdIcon.texture.key !== tex || this.crowdIcon.frame.name !== String(fr)) this.crowdIcon.setTexture(tex, fr);
      const answered = this.me()?.crowdAnswered === cr.warnAt;
      if (frozen) {
        this.crowdText.setText(cr.vote ? (cr.ghost ? this.t.game.crowdGhost : this.t.game.crowdVote) : this.crowdLabel(cr.kind)).setFont('px-yellow');
        // полоска оставшегося времени стоп-кадра
        const k = Math.max(0, (cr.resumeAt - wt - this.acc) / (cr.resumeAt - cr.showAt));
        const bw = 64;
        const bx = 90 - bw / 2;
        const by = AY + 80;
        this.crowdG.fillStyle(hexToInt(PAL.ink)).fillRect(bx - 1, by - 1, bw + 2, 5);
        this.crowdG.fillStyle(hexToInt(PAL.night)).fillRect(bx, by, bw, 3);
        this.crowdG.fillStyle(hexToInt(k < 0.34 ? PAL.red : PAL.amber)).fillRect(bx, by, Math.round(bw * k), 3);
      } else {
        // призраку нечего нажимать: вместо «Опаздываешь» — подсказка, за кем следить
        if (!this.me()?.alive) this.crowdText.setText(this.t.game.watchLate).setFont('px-mist');
        else if (cr.vote && answered) {
          const ok = this.crowdChoice === cr.kind;
          this.crowdText.setText(ok ? this.t.game.voteMajority : this.t.game.voteMinority).setFont(ok ? 'px-green' : 'px-red');
        } else this.crowdText.setText(answered ? this.t.game.withCrowd : this.t.game.late).setFont(answered ? 'px-green' : 'px-red');
      }
      this.crowdText.x = Math.round(90 - this.crowdText.width / 2);
      this.crowdText.setOrigin(0, 0);
      const pw = this.crowdText.width + 8;
      this.crowdG.fillStyle(hexToInt(PAL.ink), 0.62).fillRect(Math.round(90 - pw / 2), this.crowdText.y - 2, pw, 13);
    }
  }

  /** Подсказка сверху поля: шаг пробного дубля или «впервые видишь». */
  private renderCoach(): void {
    const g = this.coachG;
    g.clear();
    this.renderFocus();
    let lines: readonly string[] = ['', ''];
    if (this.huntTipAt && performance.now() > this.huntTipAt && this.sim.phase === 'play' && !this.sim.world.isFrozen() && !this.coachTip) {
      this.huntTipAt = 0;
      this.tip('hunt');
    }
    if (this.tut) lines = this.tut.lines;
    else if (this.coachTip && performance.now() < this.coachTip.until && this.sim.phase === 'play') lines = this.coachTip.lines;
    else this.coachTip = null;
    // «Тапни — дальше» внизу поля, мигает
    const nx = !!this.tut?.waitTap;
    this.coachNext.setVisible(nx && Math.floor(performance.now() / 450) % 3 !== 2);
    if (nx) {
      if (this.coachNext.text !== this.t.tutorial.tapNext) this.coachNext.setText(this.t.tutorial.tapNext);
      this.coachNext.x = Math.round(90 - this.coachNext.width / 2);
      const w = this.coachNext.width + 8;
      g.fillStyle(hexToInt(PAL.ink), 0.75).fillRect(Math.round(90 - w / 2), PANEL_Y - 16, w, 13);
    }
    const on = !!(lines[0] || lines[1]);
    this.coachL1.setVisible(on);
    this.coachL2.setVisible(on);
    if (!on) return;
    if (this.coachL1.text !== lines[0]) this.coachL1.setText(lines[0]);
    if (this.coachL2.text !== lines[1]) this.coachL2.setText(lines[1]);
    this.coachL1.x = Math.round(90 - this.coachL1.width / 2);
    this.coachL2.x = Math.round(90 - this.coachL2.width / 2);
    const h = lines[1] ? 24 : 14;
    // на обвинении сверху свой заголовок игры — подсказка ниже него
    const by = this.sim.phase === 'accuse' ? AY + 32 : AY + 2;
    this.coachL1.y = by + 3;
    this.coachL2.y = by + 13;
    g.fillStyle(hexToInt(PAL.ink), 0.88).fillRect(0, by, 180, h);
    g.fillStyle(hexToInt(PAL.yellow)).fillRect(0, by + h, 180, 1);
    // стрелка над целью шага (звезда, «актёр»)
    const a = this.tut?.arrow;
    if (a) {
      const bob = Math.round(Math.sin(performance.now() / 140) * 2);
      const x = Math.round(a.x);
      const y = Math.round(AY + a.y - 24 + bob);
      g.fillStyle(hexToInt(PAL.ink));
      g.fillRect(x - 3, y - 1, 7, 4).fillRect(x - 2, y + 3, 5, 2).fillRect(x - 1, y + 5, 3, 2);
      g.fillStyle(hexToInt(PAL.yellow));
      g.fillRect(x - 2, y, 5, 3).fillRect(x - 1, y + 3, 3, 2).fillRect(x, y + 5, 1, 1);
      // на обвинении — «круги от касания» по человечку: сюда тапать
      if (this.sim.phase === 'accuse') {
        const k = (performance.now() % 900) / 900;
        const r = 3 + k * 10;
        const cy = AY + a.y - 7;
        g.fillStyle(hexToInt(PAL.yellow), 1 - k);
        for (let i = 0; i < 20; i++) {
          const an = (i / 20) * Math.PI * 2;
          g.fillRect(Math.round(x + Math.cos(an) * r), Math.round(cy + Math.sin(an) * r * 0.8), 1, 1);
        }
      }
    }
  }

  /**
   * Обучение выделяет важное: поле вокруг цели притушено, вокруг цели пульсирует рамка
   * (свой персонаж, кнопки жестов, круг прожектора, звезда).
   */
  private renderFocus(): void {
    const fg = this.focusG;
    fg.clear();
    const f = this.tut?.focus;
    if (!f || (this.sim.phase !== 'play' && this.sim.phase !== 'accuse')) return;
    let r: { x: number; y: number; w: number; h: number };
    if (f === 'buttons') r = { x: 43, y: PANEL_Y + 1, w: 95, h: 34 };
    else if (f === 'claps') r = { x: 97, y: PANEL_Y + 1, w: 82, h: 34 };
    else if (f === 'fists') r = { x: 38, y: 4, w: 35, h: 16 };
    else if (f === 'stars') r = { x: 72, y: 4, w: 32, h: 16 };
    else if (f === 'me') {
      const e = this.sim.world.get(this.me()?.eid ?? -1);
      if (!e) return;
      r = { x: Math.round(e.x) - 11, y: AY + Math.round(e.y) - 22, w: 22, h: 26 };
    } else r = { x: Math.round(f.x - f.r), y: AY + Math.round(f.y - f.r), w: Math.round(f.r * 2), h: Math.round(f.r * 2) };
    // притушить поле вне рамки (панель снизу — только когда выделены кнопки: там и так тёмное)
    const top = AY;
    const bot = PANEL_Y;
    const ink = hexToInt(PAL.ink);
    fg.fillStyle(ink, 0.55);
    if (f === 'buttons' || f === 'claps' || f === 'fists' || f === 'stars') fg.fillRect(0, top, 180, bot - top);
    else {
      const y0 = Math.max(top, r.y);
      const y1 = Math.min(bot, r.y + r.h);
      fg.fillRect(0, top, 180, Math.max(0, y0 - top));
      fg.fillRect(0, y1, 180, Math.max(0, bot - y1));
      fg.fillRect(0, y0, Math.max(0, r.x), y1 - y0);
      fg.fillRect(r.x + r.w, y0, Math.max(0, 180 - r.x - r.w), y1 - y0);
    }
    // рамка — поверх всего (на камере интерфейса), мигает
    const on = Math.floor(performance.now() / 260) % 2 === 0;
    const g = this.coachG;
    g.fillStyle(ink, 1);
    g.fillRect(r.x - 2, r.y - 2, r.w + 4, 1).fillRect(r.x - 2, r.y + r.h + 1, r.w + 4, 1).fillRect(r.x - 2, r.y - 2, 1, r.h + 4).fillRect(r.x + r.w + 1, r.y - 2, 1, r.h + 4);
    g.fillStyle(hexToInt(on ? PAL.yellow : PAL.amber), 1);
    g.fillRect(r.x - 1, r.y - 1, r.w + 2, 1).fillRect(r.x - 1, r.y + r.h, r.w + 2, 1).fillRect(r.x - 1, r.y - 1, 1, r.h + 2).fillRect(r.x + r.w, r.y - 1, 1, r.h + 2);
  }

  /** «Впервые видишь»: подсказка из двух строк, один раз на устройство для каждого случая. */
  /** Игрок не проходил «Пробный дубль» — в первом матче подсказки «ходи», «стоп-кадр», «ищи живого». */
  private get newbie(): boolean {
    return !this.tut && !tutorialDone();
  }

  private tip(key: 'vote' | 'spot' | 'star' | 'move' | 'crowd' | 'hunt'): void {
    if (this.tut) return;
    let seen: string[] = [];
    try {
      seen = JSON.parse(localStorage.getItem('kto:tips') ?? '[]') as string[];
    } catch {
      seen = [];
    }
    if (seen.includes(key)) return;
    seen.push(key);
    try {
      localStorage.setItem('kto:tips', JSON.stringify(seen));
    } catch {
      /* приватный режим */
    }
    this.coachTip = { lines: this.t.tutorial.tips[key], until: performance.now() + 4000 };
  }

  private renderHud(): void {
    const sim = this.sim;
    const left = sim.timeLeft();
    const sec = Math.ceil(left / 1000);
    const showTimer = !this.tut && (sim.phase === 'play' || sim.phase === 'accuse' || sim.phase === 'countdown');
    this.hud.timer.setText(this.tut ? '' : showTimer ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : tp(this.lang, this.t.game.roundShort, sim.round));
    // последние 10 с — coral и мигание в такт секунде
    const hurry = sim.phase === 'play' && sec <= 10 && !this.tut;
    this.hud.timer.setFont(hurry ? 'px-coral' : 'px-sand').setVisible(!hurry || left % 1000 > 350);
    // «Дубль N» вместо таймера — между дублями; разделитель после времени тогда не нужен
    const me = this.me();
    this.hudIcons.forEach((ic, i) => ic.setFrame(me && i < me.attacksLeft ? 0 : 1));
    this.hudStars.forEach((ic, i) => ic.setFrame(me && i < me.stars ? 2 : 3));
    const spec = this.init0.spectator;
    if (spec && this.specL2) {
      const s = spec.watching() ? fmt(this.t.game.spectatorDelay, { n: spec.delaySec }) : this.t.game.spectatorWait;
      if (this.specL2.text !== s) this.specL2.setText(s);
    }
    const others = sim.otherStars();
    others.forEach((n, i) => this.hud['starsOther' + (i + 1)]?.setText(String(n)).setFont(n >= this.cfg.starsToWin - 1 ? 'px-amber' : 'px-mist'));
    // угроза: у кого-то из чужих звёзд на одну меньше цели — звёздочка группы мигает
    const threat = sim.phase === 'play' && others.some((n) => n >= this.cfg.starsToWin - 1);
    this.hudThreat?.setAlpha(threat ? (Math.floor(performance.now() / 300) % 2 ? 1 : 0.3) : 0.45);
  }

  // ───────────── оверлеи фаз ─────────────

  private ov<T extends Phaser.GameObjects.GameObject>(obj: T, depth = 2100): T {
    (obj as unknown as { setDepth?: (d: number) => void }).setDepth?.(depth);
    this.ovObjs.push(obj);
    return obj;
  }

  private clearOverlay(): void {
    for (const o of this.ovObjs) o.destroy();
    this.ovObjs = [];
    this.ovDyn = {};
    this.autoBar = null;
    const keep = new Set(this.buttons.filter((b) => b.keep).map((b) => b.id));
    this.buttons = this.buttons.filter((b) => (!b.label && !b.kind) || b.keep);
    for (const [id, o] of this.btnObjs) if (o.text && !keep.has(id)) this.btnObjs.delete(id);
  }

  /** Тёмная подложка под текстом поверх поля: читается на любом фоне (снег, пляж, неон). */
  private ovPlate(y: number, h: number): void {
    this.ov(this.add.rectangle(0, y, 180, h, hexToInt(PAL.ink), 0.62).setOrigin(0, 0), 2099);
  }

  private ovText(x: number, y: number, s: string, color: FontColor = 'white', center = true): Phaser.GameObjects.BitmapText {
    const t = this.txt(x, y, s, color);
    if (center) {
      t.setOrigin(0, 0);
      t.x = Math.round(x - t.width / 2);
    }
    this.ov(t, 2100);
    return t;
  }

  private ovPanel(x: number, y: number, w: number, h: number): void {
    const g = this.add.graphics();
    g.fillStyle(hexToInt(PAL.ink)).fillRect(x, y, w, h);
    g.fillStyle(hexToInt(PAL.night)).fillRect(x + 1, y + 1, w - 2, h - 2);
    g.fillStyle(hexToInt(PAL.dusk)).fillRect(x + 1, y + 1, w - 2, 1);
    g.fillStyle(hexToInt(PAL.amber)).fillRect(x + 2, y + 2, 2, 2);
    g.fillRect(x + w - 4, y + 2, 2, 2);
    g.fillRect(x + 2, y + h - 4, 2, 2);
    g.fillRect(x + w - 4, y + h - 4, 2, 2);
    this.ov(g, 2000);
  }

  private buildOverlay(): void {
    // зритель до начала следующего дубля: мира ещё нет — только «Матч уже идёт»
    const spec = this.init0.spectator;
    if (spec && !spec.watching()) {
      if (this.overlayPhase === 'spec-wait') return;
      this.overlayPhase = 'spec-wait';
      this.clearOverlay();
      this.ovPlate(AY + 112, 30);
      this.ovText(90, AY + 116, this.t.game.spectatorLive, 'yellow');
      this.ovText(90, AY + 128, this.t.game.spectatorWait, 'sand');
      return;
    }
    const phase = this.sim.phase;
    if (phase === this.overlayPhase && phase !== 'countdown') return;
    this.overlayPhase = phase;
    this.clearOverlay();
    const sim = this.sim;
    switch (phase) {
      case 'countdown': {
        this.ovDyn.count = this.ovText(90, AY + 92, String(Math.max(1, Math.ceil(sim.timeLeft() / 1000))), 'yellow');
        this.ovDyn.count.setScale(3);
        this.centerScaled(this.ovDyn.count);
        // минимум текста (плейтесты: «много текста в начале дубля»): номер дубля с темой и, если есть,
        // условие съёмки двумя строками; «где ты» показывают круги вокруг своего персонажа
        const mod = roundMod(sim.mod);
        this.ovPlate(AY + 122, mod !== 'none' ? 42 : 18);
        this.ovText(90, AY + 126, tp(this.lang, this.t.game.roundTheme, sim.round, { theme: this.t.themes[sim.theme] }), 'mist');
        if (mod !== 'none') {
          this.ovText(90, AY + 140, this.t.mods[mod].name, 'yellow');
          this.ovText(90, AY + 152, this.t.mods[mod].desc, 'white');
        }
        break;
      }
      case 'accuse': {
        this.ovPlate(AY + 2, 28);
        this.ovText(90, AY + 6, this.t.game.accuseTitle, 'yellow');
        this.ovDyn.sub = this.ovText(90, AY + 18, this.t.game.accuseSub, 'sand');
        // в обучении обвинение ждёт игрока — отсчёта нет
        if (!this.tut && !spec) this.ovDyn.timer = this.ovText(90, PANEL_Y + 13, '5', 'red');
        break;
      }
      case 'reveal': {
        this.ovPlate(AY + 2, 16);
        this.ovDyn.title = this.ovText(90, AY + 6, this.t.game.reveal, 'yellow');
        // слева внизу: справа там кнопка клипа
        this.ovDyn.speed = this.ovText(4, AY + 248, '×2.5', 'mist', false).setVisible(false);
        const s = sim.summary!;
        this.ovDyn.final = this.ovText(90, PANEL_Y + 13, '', 'sand').setVisible(false);
        this.ovDyn.caught = this.ovText(90, PANEL_Y + 20, this.t.game.caught, 'red').setVisible(false);
        // кто выбил тебя — после разоблачения уже не секрет
        const myEid = s.reveal.find((r) => r.pid === this.sim.selfPid)?.eid;
        const by = s.kills?.find((k) => k.victim === myEid)?.by;
        const killer = s.reveal.find((r) => r.eid === by);
        const kInfo = killer ? sim.info(killer.pid) : undefined;
        if (kInfo) {
          // имя — отдельной строкой: целиком (до 14 знаков), без обрезки
          this.ovDyn.killedBy = this.ovText(90, PANEL_Y + 13, this.t.game.killedBy, 'mist').setVisible(false);
          this.ovDyn.killerName = this.ovText(90, PANEL_Y + 23, kInfo.name, COLOR_FONT[kInfo.color]).setVisible(false);
        }
        s.reveal.forEach((r, i) => {
          const info = sim.info(r.pid)!;
          this.ovDyn['name' + i] = this.txt(0, 0, info.name, COLOR_FONT[info.color]).setVisible(false);
          this.ov(this.ovDyn['name' + i], 2100);
        });
        break;
      }
      case 'results':
        this.buildResults();
        break;
      case 'match_end':
        this.buildMatchEnd();
        break;
      default:
        break;
    }
  }

  private buildResults(): void {
    const sim = this.sim;
    const s = sim.summary!;
    this.ovPanel(8, AY + 8, 164, 244);
    const reason = this.t.game.endReason[s.endReason];
    this.ovText(90, AY + 14, tp(this.lang, this.t.game.resultsTitle, s.round), 'yellow');
    this.ovText(90, AY + 25, reason, 'mist');
    const order = [...sim.players].sort((a, b) => sim.scores[b.pid] - sim.scores[a.pid]);
    // цель матча над столбцом счёта (своя строка, не налезает на подзаголовок): дублей будет несколько
    const goal = this.ovText(0, AY + 36, fmt(this.t.game.toWin, { n: this.cfg.scoreToWin }), 'mist', false);
    goal.x = 171 - goal.width;
    order.forEach((p, i) => {
      const y = AY + 46 + i * 16;
      const pts = s.points[p.pid];
      const g = this.add.graphics();
      // имя целиком (до 14 знаков = 112 пикс.): квадрат цвета, имя, очки за дубль, счёт у правого края
      g.fillStyle(hexToInt(PAL.ink)).fillRect(9, y + 1, 7, 7);
      g.fillStyle(hexToInt(PLAYER_COLORS[p.color])).fillRect(10, y + 2, 5, 5);
      this.ov(g, 2010);
      this.ovText(18, y, p.name.slice(0, 14), p.pid === this.sim.selfPid ? 'yellow' : 'white', false);
      this.ovText(136, y, pts.total ? `+${pts.total}` : '0', pts.total ? 'green' : 'mist', false);
      const total = this.ovText(0, y, String(sim.scores[p.pid]), 'sand', false);
      total.x = 171 - total.width;
    });
    s.awards.forEach((a, i) => this.awardCard(16, AY + 112 + i * 42, a.id, a.pids, a.value));
    if (!s.awards.length) this.ovText(90, AY + 130, this.t.game.noAwards, 'mist');
    // Одна главная кнопка: следующий дубль. Он начнётся сам — отсчёт идёт заливкой кнопки (у всех);
    // ускорить может только режиссёр (хост), у остальных та же кнопка — неактивной плашкой с секундами.
    // «Поделиться» — квадратной второй кнопкой с иконкой слева.
    this.autoTotal = Math.max(1, sim.timeLeft());
    const fill = () => Math.max(0, Math.min(1, sim.timeLeft() / this.autoTotal));
    const n = sim.round + 1;
    if (!this.init0.spectator) {
      const share: RowButton = { id: 'share', kind: 'secondary', icon: 'share', onTap: () => this.share(), release: true };
      this.addRow(AY + 214, this.amHost()
        ? [share, { id: 'next', kind: 'primary', flex: true, label: fmt(this.t.game.next, { n }), fill, onTap: () => {
          this.track('next_tap', { round: sim.round });
          sim.intent({ k: 'next' });
        } }]
        : [share, { id: 'next', kind: 'plate', flex: true, label: fmt(this.t.game.nextTake, { n, s: Math.ceil(sim.timeLeft() / 1000) }) }]);
    }
  }

  /** Ряд кнопок итогов от x = 9 до 171 с зазором 2: ширина по тексту, остаток — кнопке с flex. */
  private addRow(y: number, row: RowButton[]): void {
    const L = 9;
    const R = 171;
    const H = 30;
    const need = (r: RowButton) => (r.label ? r.label.length * 8 + 12 : 0) + (r.icon ? (r.label ? 20 : 30) : 0);
    const fixed = row.reduce((s, r) => s + (r.flex ? 0 : need(r)), 0) + (row.length - 1) * 2;
    let x = L;
    for (const r of row) {
      const w = r.flex ? R - L - fixed : need(r);
      const b: Button = {
        id: r.id, x, y, w, h: H, label: r.label ?? '', kind: r.kind, fill: r.fill,
        visible: ((ph) => () => this.sim.phase === ph)(this.sim.phase),
        ...(r.kind === 'plate' || !r.onTap ? {} : r.release ? { onUp: r.onTap } : { onDown: r.onTap }),
      };
      this.buttons = this.buttons.filter((o) => o.id !== r.id);
      this.buttons.push(b);
      const font: FontColor = r.kind === 'primary' ? 'ink' : r.kind === 'plate' ? 'mist' : 'sand';
      const iconW = r.icon ? 16 : 0;
      const text = r.label ? this.ov(this.txt(0, y + 9, r.label, font).setOrigin(0, 0), 2100) : undefined;
      // ширина надписи без контура по краям (у тёмного шрифта контура нет)
      const textW = text ? text.width - (font === 'ink' ? 2 : 0) : 0;
      const gap = r.icon && r.label ? 4 : 0;
      const x0 = Math.round(x + (w - iconW - gap - textW) / 2);
      const icon = r.icon ? this.ov(this.add.image(x0 + 8, y + 14, 'icons', this.icon(r.icon)).setScale(2), 2100) : undefined;
      if (text) text.x = x0 + iconW + gap - (font === 'ink' ? 1 : 0);
      this.btnObjs.set(r.id, { text, icon });
      x += w + 2;
    }
  }

  /** Кнопки итогов: главная — янтарь с тенью rust (как в HTML), вторая — night с рамкой amber, плашка — тихая. */
  private drawRowButton(b: Button): void {
    const g = this.ui2;
    const { x, y, w, h } = b;
    const down = b.pressed && b.kind !== 'plate' ? 1 : 0;
    g.fillStyle(hexToInt(PAL.ink)).fillRect(x, y, w, h);
    if (b.kind === 'primary') {
      g.fillStyle(hexToInt(PAL.rust)).fillRect(x + 1, y + 1 + down, w - 2, h - 2 - down);
      g.fillStyle(hexToInt(PAL.clay)).fillRect(x + 1, y + 1 + down, w - 2, h - 4);
      const f = b.fill ? b.fill() : 1;
      g.fillStyle(hexToInt(PAL.amber)).fillRect(x + 1, y + 1 + down, Math.round((w - 2) * f), h - 4);
    } else if (b.kind === 'secondary') {
      g.fillStyle(hexToInt(PAL.amber)).fillRect(x + 1, y + 1 + down, w - 2, h - 2 - down);
      g.fillStyle(hexToInt(down ? PAL.ink : PAL.night)).fillRect(x + 2, y + 2 + down, w - 4, h - 4 - down);
    } else {
      g.fillStyle(hexToInt(PAL.dusk)).fillRect(x + 1, y + 1, w - 2, h - 2);
      g.fillStyle(hexToInt(PAL.night)).fillRect(x + 2, y + 2, w - 4, h - 4);
    }
  }

  private awardCard(x: number, y: number, id: AwardId, pids: string[], value: number): void {
    const def = this.t.awards[id];
    const fit = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
    const names = pids.map((pid) => this.sim.info(pid)?.name ?? '?');
    const g = this.add.graphics();
    g.fillStyle(hexToInt(PAL.ink)).fillRect(x, y, 148, 40);
    g.fillStyle(hexToInt(PAL.grape)).fillRect(x + 1, y + 1, 146, 38);
    g.fillStyle(hexToInt(PAL.orchid)).fillRect(x + 1, y + 1, 146, 1);
    this.ov(g, 2010);
    this.ov(this.add.image(x + 9, y + 9, 'icons', this.icon('crown')).setOrigin(0.5), 2100);
    this.ovText(x + 17, y + 4, fit(def.title, 16), 'yellow', false);
    const who = names.length > 1 ? names.map((n) => n.split(' ')[0]).join(this.t.game.and) : names[0];
    this.ovText(x + 4, y + 15, fit(who, 18), 'white', false);
    this.ovText(x + 4, y + 26, fit(tp(this.lang, def.text, value), 18), 'mist', false);
  }

  private buildMatchEnd(): void {
    const sim = this.sim;
    const m = sim.match!;
    if (!m.tooAlive && !this.triumphShown && !this.init0.spectator) {
      this.triumphShown = true;
      this.showTriumph(() => {
        this.clearOverlay();
        this.buildMatchEnd();
      });
      return;
    }
    this.ovPanel(8, AY + 8, 164, 244);
    this.ov(this.add.image(90, AY + 22, 'icons', this.icon('crown')).setScale(2), 2100);
    if (m.tooAlive) this.ovText(90, AY + 36, this.t.game.tooAlive, 'yellow');
    else {
      const w = sim.info(m.winners[0])!;
      this.ovText(90, AY + 36, w.pid === this.sim.selfPid ? this.t.game.youWon : this.t.game.winner, 'yellow');
      if (w.pid !== this.sim.selfPid) this.ovText(90, AY + 48, w.name, COLOR_FONT[w.color]);
    }
    const order = [...sim.players].sort((a, b) => m.scores[b.pid] - m.scores[a.pid]);
    order.forEach((p, i) => {
      const y = AY + 66 + i * 14;
      this.ovText(16, y, p.name.slice(0, 14), COLOR_FONT[p.color], false);
      const total = this.ovText(0, y, String(m.scores[p.pid]), 'sand', false);
      total.x = 166 - total.width;
    });
    m.awards.forEach((a, i) => this.awardCard(16, AY + 124 + i * 42, a.id, a.pids, a.value));
    // Одна главная: «Ещё раз» у режиссёра. Матч с ИИ — вторая «С друзьями» (настоящая комната),
    // в комнате — «Поделиться» иконкой; у остальных — «Поделиться» второй кнопкой во всю ширину.
    if (this.init0.spectator) {
      /* зритель после матча сам войдёт в комнату (net/room.ts) */
    } else if (this.amHost()) {
      const rematch: RowButton = { id: 'rematch', kind: 'primary', label: this.t.game.rematch, onTap: () => {
        this.confetti = [];
        this.track('rematch', { rounds: sim.roundsPlayed });
        // пришли новые игроки (зрители после матча) — комната начинает новый матч с ними
        if (this.init0.onRematch?.()) return;
        sim.intent({ k: 'rematch' });
      } };
      const invite = this.init0.onInvite;
      this.addRow(AY + 214, invite
        ? [{ ...rematch, flex: true }, { id: 'invite', kind: 'secondary', label: this.t.game.withFriends, release: true, onTap: () => {
          this.track('invite_tap', { from: 'match_end' });
          invite();
        } }]
        : [{ id: 'share2', kind: 'secondary', icon: 'share', release: true, onTap: () => this.share() }, { ...rematch, flex: true }]);
    } else this.addRow(AY + 214, [{ id: 'share2', kind: 'secondary', icon: 'share', label: this.t.game.share, flex: true, release: true, onTap: () => this.share() }]);
    // клип — третьей, тихой кнопкой с кадром плёнки в нижней панели. Открывается касанием: отпускание
    // у нижнего края экрана браузер может забрать себе (Chrome на iPhone); отправка — кнопкой в окне клипа
    if (this.best && !this.init0.spectator) {
      this.addRow(PANEL_Y + 3, [{ id: 'clip', kind: 'secondary', icon: 'film', label: this.t.clip.button, flex: true, onTap: () => this.openClip() }]);
      const b = this.buttons.find((x) => x.id === 'clip');
      if (b) Object.assign(b, { x: 3, w: 174 });
    }
    // карточку рисуем заранее: к нажатию «Поделиться» файл уже готов, и меню откроется без задержки
    void resultCardFile({
      players: sim.players,
      scores: m.scores,
      winners: m.winners,
      tooAlive: m.tooAlive,
      awards: m.awards,
      theme: sim.theme,
      arena: sim.arena,
      t: this.t,
      lang: this.lang,
      font: this.init0.fontFamily,
      site: location.host,
    }).then((f) => {
      if (this.sim.phase === 'match_end') this.cardFile = f;
    });
  }

  private centerScaled(t: Phaser.GameObjects.BitmapText): void {
    const w = t.getTextBounds(true).local.width * t.scaleX;
    t.x = Math.round(90 - w / 2);
  }

  private updateOverlay(_delta: number): void {
    const sim = this.sim;
    const phase = sim.phase;
    if (phase !== this.overlayPhase) this.buildOverlay();
    if (phase === 'countdown' && this.ovDyn.count) {
      const n = Math.max(1, Math.ceil(sim.timeLeft() / 1000));
      if (this.ovDyn.count.text !== String(n)) {
        this.ovDyn.count.setText(String(n));
        this.centerScaled(this.ovDyn.count);
        if (n < 3) this.audio.play('count');
      }
    }
    if (phase === 'accuse' && this.ovDyn.timer) {
      const n = Math.ceil(sim.timeLeft() / 1000);
      if (this.ovDyn.timer.text !== String(n)) {
        this.ovDyn.timer.setText(String(n));
        this.audio.play('tick');
      }
      if (this.me()?.accused !== null) this.ovDyn.sub?.setText(this.t.game.accuseChange);
    }
    if (phase === 'reveal' && sim.summary) {
      const s = sim.summary;
      const e = sim.now - this.revealStartNow + this.acc;
      const drum = this.cfg.revealDrumSec * 1000;
      const replayDur = (s.replayTo - s.replayFrom) / this.cfg.revealSpeed;
      const inReplay = e >= drum && e < drum + replayDur;
      const final = e >= drum + replayDur;
      this.ovDyn.speed?.setVisible(inReplay);
      if (inReplay) this.ovDyn.title?.setText(this.t.game.revealReplay);
      if (final) {
        this.ovDyn.title?.setText(this.t.game.revealFinal);
        // имена над живыми; если подписи налезают друг на друга — верхнюю поднимаем
        const placed: { x: number; y: number; w: number }[] = [];
        const order = s.reveal.map((r, i) => ({ r, i })).sort((a, b) => b.r.y - a.r.y);
        for (const { r, i } of order) {
          const t = this.ovDyn['name' + i];
          if (!t) continue;
          t.setVisible(r.alive);
          if (!r.alive) continue;
          const x = Math.round(Math.min(178 - t.width, Math.max(2, r.x - t.width / 2)));
          let y = AY + r.y - CH_H - 16;
          for (let k = 0; k < 4; k++) {
            const hit = placed.find((q) => x < q.x + q.w && q.x < x + t.width && Math.abs(q.y - y) < 10);
            if (!hit) break;
            y = hit.y - 10;
          }
          y = Math.max(AY + 18, y);
          placed.push({ x, y, w: t.width });
          t.setPosition(x, y);
        }
        const mine = s.accusations.find((a) => a.pid === this.sim.selfPid);
        this.ovDyn.final?.setText(mine ? (mine.correct ? this.t.game.guessed : this.t.game.missed) : this.t.game.noAccuse).setVisible(true);
        this.ovDyn.final.x = Math.round(90 - this.ovDyn.final.width / 2);
        // тебя вычислили: вторая строка, первая поднимается
        const meR = s.reveal.find((r) => r.pid === this.sim.selfPid);
        const caught = !!meR?.alive && s.accusations.some((a) => a.eid === meR.eid);
        this.ovDyn.caught?.setVisible(caught);
        this.ovDyn.killedBy?.setVisible(!caught);
        this.ovDyn.killerName?.setVisible(!caught);
        this.ovDyn.final.y = this.ovDyn.killedBy ? PANEL_Y + 3 : caught ? PANEL_Y + 6 : PANEL_Y + 13;
        this.drawAccusations();
      }
    }
    // у гостя на плашке — секунды до следующего дубля (у режиссёра отсчёт идёт заливкой кнопки)
    const plate = phase === 'results' ? this.buttons.find((b) => b.id === 'next' && b.kind === 'plate') : undefined;
    const pt = plate && this.btnObjs.get('next')?.text;
    if (pt) {
      const s = fmt(this.t.game.nextTake, { n: sim.round + 1, s: Math.max(0, Math.ceil(sim.timeLeft() / 1000)) });
      if (pt.text !== s) {
        pt.setText(s);
        pt.x = Math.round(plate.x + (plate.w - pt.width) / 2);
      }
    }
  }

  private drawAccusations(): void {
    const s = this.sim.summary!;
    const g = this.fxG;
    s.accusations.forEach((a, i) => {
      const info = this.sim.info(a.pid)!;
      const from = s.reveal.find((r) => r.pid === a.pid)!;
      const target = this.sim.world.get(a.eid);
      if (!target) return;
      const fx = from.alive ? from.x : 20 + i * 46;
      const fy = from.alive ? from.y - 8 : -6;
      const tx = target.x;
      const ty = target.y - 8;
      const color = hexToInt(PLAYER_COLORS[info.color]);
      g.fillStyle(hexToInt(PAL.ink), 1);
      const steps = Math.ceil(Math.hypot(tx - fx, ty - fy));
      for (let k = 0; k <= steps; k++) {
        const x = Math.round(fx + ((tx - fx) * k) / steps);
        const y = Math.round(AY + fy + ((ty - fy) * k) / steps);
        g.fillStyle(hexToInt(PAL.ink), 1).fillRect(x - 1, y, 3, 1);
        g.fillStyle(color, 1).fillRect(x, y, 1, 1);
      }
      g.fillStyle(color, 1).fillRect(Math.round(tx) - 1, Math.round(AY + ty) - 1, 3, 3);
      const iconName = a.correct ? 'check' : 'cross';
      const key = 'acc' + i;
      if (!this.ovDyn[key]) {
        const img = this.ov(this.add.image(Math.round(tx) + 6, Math.round(AY + ty) - 6, 'icons', this.icon(iconName)), 2100);
        this.ovDyn[key] = img as unknown as Phaser.GameObjects.BitmapText;
      }
    });
  }

  /** Лучший в дубле (больше всех очков, без ничьей) — если он в кадре; иначе -1. */
  private roundStar(s: RoundSummary): number {
    let best: { pid: string; total: number } | null = null;
    let tie = false;
    for (const [pid, line] of Object.entries(s.points)) {
      if (!best || line.total > best.total) {
        best = { pid, total: line.total };
        tie = false;
      } else if (line.total === best.total) tie = true;
    }
    if (!best || tie || best.total <= 0) return -1;
    const r = s.reveal.find((x) => x.pid === best.pid);
    return r && r.alive ? r.eid : -1;
  }

  /**
   * Момент триумфа победителя матча: поле темнеет, его персонаж — крупно в луче света, с короной,
   * пляшет; имя его цветом, фанфары и конфетти. Через 2,8 с (или по касанию) — итоги матча.
   */
  private showTriumph(done: () => void): void {
    const sim = this.sim;
    const m = sim.match!;
    const pid = m.winners[0];
    const info = sim.info(pid)!;
    const color = hexToInt(PLAYER_COLORS[info.color]);
    const eid = sim.summary?.reveal.find((r) => r.pid === pid)?.eid ?? -1;
    const idx = Math.max(0, sim.world.entities.findIndex((e) => e.eid === eid));
    const fig = this.charKey(this.lookKey, idx);
    const cy = AY + 156;
    const bg = this.add.graphics();
    bg.fillStyle(hexToInt(PAL.ink), 0.82).fillRect(0, AY, 180, PANEL_Y - AY);
    // луч прожектора: светлый конус сверху и пятно на полу
    bg.fillStyle(hexToInt(PAL.sand), 0.12).fillTriangle(90, AY, 52, cy + 4, 128, cy + 4);
    bg.fillStyle(hexToInt(PAL.sand), 0.25).fillEllipse(90, cy + 2, 64, 14);
    this.ov(bg, 2050);
    const ol = this.ov(this.add.image(90, cy, 'ol' + fig, F.DANCE).setOrigin(7 / OL_W, 17 / OL_H).setScale(3).setTint(color), 2051);
    const body = this.ov(this.add.image(90, cy, 'ch' + fig, F.DANCE).setOrigin(6 / CH_W, 1).setScale(3), 2052);
    const crown = this.ov(this.add.image(90, cy - CH_H * 3 - 2, 'icons', this.icon('crown')).setOrigin(0.5, 1).setScale(3), 2053);
    const me = pid === sim.selfPid;
    const title = this.ovText(90, AY + 40, (me ? this.t.game.youWon : this.t.game.winner).replace(/:$/, ''), 'yellow');
    // крупно, если влезает в ширину поля
    if (title.width * 2 <= 170) {
      title.setScale(2);
      this.centerScaled(title);
    }
    this.ovText(90, cy + 14, info.name, COLOR_FONT[info.color]);
    this.audio.play('fanfare');
    haptic('success');
    this.spawnConfetti();
    let k = 0;
    const dance = this.time.addEvent({
      delay: 160,
      loop: true,
      callback: () => {
        k++;
        const fr = F.DANCE + (k % 4);
        const hop = k % 2 === 0 ? 0 : -3;
        body.setFrame(fr).setY(cy + hop);
        ol.setFrame(fr).setY(cy + hop);
        crown.setY(cy - CH_H * 3 - 2 + hop);
      },
    });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      dance.remove();
      if (this.sim.phase === 'match_end') done();
    };
    this.time.delayedCall(2800, finish);
    this.input.once('pointerup', finish);
  }

  private spawnConfetti(): void {
    const cols = [PAL.red, PAL.yellow, PAL.green, PAL.cyan, PAL.orchid, PAL.white].map(hexToInt);
    this.confetti = Array.from({ length: 90 }, (_, i) => ({
      x: Math.random() * 180,
      y: -Math.random() * 320,
      vx: (Math.random() - 0.5) * 0.6,
      vy: 0.3 + Math.random(),
      c: cols[i % cols.length],
    }));
  }

  private share(): void {
    const sim = this.sim;
    const me = sim.info(this.sim.selfPid)!;
    const score = sim.scores[this.sim.selfPid];
    const kills = sim.myMatchKills;
    const squares = sim.roundAwards.map((_, i) => (i < sim.round ? '🟩' : '⬛')).join('');
    const sh = this.t.share;
    const text = tp(this.lang, sh.text, 0, {
      title: this.t.meta.title,
      name: me.name,
      points: tp(this.lang, sh.points, score),
      kills: kills ? tp(this.lang, sh.kills, kills) : sh.noKills,
      squares,
    });
    const files = sim.phase === 'match_end' && this.cardFile ? [this.cardFile] : undefined;
    this.track('share_tap', { from: sim.phase, card: !!files });
    void this.init0.onShare?.(text, files);
  }

  /** Запомнить лучший момент раунда (если он лучше прежних в этом матче). */
  private noteMoment(): void {
    const s = this.sim.summary;
    if (!s) return;
    try {
      const rec = recordRound(this.sim.world, { round: s.round, theme: this.sim.theme, players: s.reveal, playEnd: s.replayTo, kills: s.kills });
      const moment = findBestMoment(rec, this.sim.me()?.eid);
      if (!moment || (this.best && this.best.moment.score > moment.score)) return;
      const players = s.reveal.map((r) => {
        const info = this.sim.info(r.pid)!;
        return { eid: r.eid, name: info.name, color: info.color };
      });
      this.best = { rec, moment, players };
    } catch {
      /* клип — не главное: при сбое просто не предлагаем его */
    }
  }

  /** Победитель матча для заставки клипа (клип из итогов матча, без «слишком живых»). */
  private clipWinner(): { name: string; color: number } | undefined {
    const m = this.sim.match;
    if (this.sim.phase !== 'match_end' || !m || m.tooAlive || !m.winners[0]) return undefined;
    const w = this.sim.info(m.winners[0]);
    return w ? { name: w.name, color: w.color } : undefined;
  }

  private openClip(): void {
    const best = this.best;
    if (!best) return;
    this.closeClip?.();
    this.track('clip_open', { kind: best.moment.kind, self: !!best.moment.selfRole });
    const m = best.moment;
    const a = best.players.find((p) => p.eid === m.attacker);
    const b = best.players.find((p) => p.eid === m.victim);
    const text = m.kind === 'knockout' && a && b ? fmt(this.t.clip.shareKo, { a: a.name, b: b.name }) : this.t.meta.title;
    // модуль клипа в основной сборке (не ленивый чанк): после обновления сайта открытая вкладка
    // не сможет подгрузить чанк, которого уже нет на сервере, и кнопка молча не срабатывала бы
    try {
      this.closeClip = openClipOverlay(
        document.body,
        { ...best, arena: this.sim.arena, t: this.t, font: this.init0.fontFamily, site: location.host, noGore: mildOn(), winner: this.clipWinner() },
        this.t,
        async (file) => {
          this.track('clip_send', { kind: best.moment.kind, type: file.type.split(';')[0] });
          await this.init0.onShare?.(text, [file]);
        },
        (file) => {
          this.track('clip_save', { kind: best.moment.kind });
          this.init0.onSave?.(file);
        },
        {
          text,
          // внутри Telegram: сторис, видео-карточка в чат, родное «Сохранить»
          // не вышло — сработает обычный путь и посчитается там
          onTelegram: (what, ok) =>
            this.track(ok ? (what === 'story' ? 'clip_story' : what === 'chat' ? 'clip_send' : 'clip_save') : 'clip_tg_fail', { kind: best.moment.kind, via: 'tg', what }),
        },
      );
      this.events.once('shutdown', () => this.closeClip?.());
    } catch {
      this.showToast(this.t.clip.failed, 2500);
    }
  }
}

let wakeLock: { release(): Promise<void> } | null = null;
function requestWakeLock(): void {
  if (wakeLock) return;
  const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } };
  nav.wakeLock
    ?.request('screen')
    .then((l) => {
      wakeLock = l;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') wakeLock = null;
      }, { once: true });
    })
    .catch(() => undefined);
}


/** Удар оружием в живой игре: часы замаха и жертва, которая стоит до удара. */
interface LiveKill {
  k: Kill;
  t: number;
  hit: boolean;
  tex: string;
  standIn: Phaser.GameObjects.Image | null;
  /** Это меня: баннер «вырезан» — в момент удара. */
  mine?: { sub?: string };
}

