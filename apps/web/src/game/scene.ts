import * as Phaser from 'phaser';
import { PAL, PLAYER_COLORS, hexToInt } from '@kto/assets';
import {
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
} from '@kto/game-core';
import type { AwardId, ClientSession, CrowdKind, Dict, Entity, GameConfig, Lang, Moment, Notice, RoundRecording, ThemeText, World, WorldEvent } from '@kto/game-core';
import { resultCardFile } from './card';
import { clipSupported, openClipOverlay, recordClipInBackground } from './clip-ui';
import type { ClipPlayer } from './clip';
import { Audio } from './audio';
import { frameFor } from './frames';
import type { CharFrame } from './frames';
import type { FontColor } from './font';
import { registerFonts } from './font';
import {
  CH_H, CH_W, OL_H, OL_W,
  makeArenaBackground, makeArrow, makeCharacterSheets, makeHedge, makeIconSheet, makeIcons, makeMark, makePigeon,
  makePoof, makeProp, makeRing, makeShadow, makeStar, makeStarFlash, makeStunStars, makeVignette,
} from './sprites';
import { isThemeLoaded, loadTheme, lookCount, preloadThemes, themeLook, themePack } from './themes';
import type { Look } from './themes';

const AY = 24; // верх арены на экране
const CROWD_KINDS: CrowdKind[] = ['freeze', 'jump', 'dance'];
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
  /** Мигание света при смене изнанки: время начала (performance.now), 0 — нет. */
  private flicker = 0;
  private blackout!: Phaser.GameObjects.Rectangle;
  private pigeons: Pigeon[] = [];
  private ui!: Phaser.GameObjects.Graphics;
  private fxG!: Phaser.GameObjects.Graphics;
  private arrow!: Phaser.GameObjects.Image;
  private ring!: Phaser.GameObjects.Image;
  private hud: Record<string, Phaser.GameObjects.BitmapText> = {};
  private hudIcons: Phaser.GameObjects.Image[] = [];
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
  private wasFrozen = false;
  private deathObjs: Phaser.GameObjects.GameObject[] = [];
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
    this.events.once('shutdown', () => this.sim.dispose());
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
    this.ring = this.add.image(0, 0, 'ring').setAlpha(0.7).setVisible(false);
    this.arrow = this.add.image(0, 0, 'arrow').setOrigin(0.5, 1).setTint(hexToInt(PLAYER_COLORS[0])).setDepth(800).setVisible(false);

    const pigeonSpots = [[70, 56], [118, 214], [146, 98], [34, 182], [104, 30]];
    for (const [x, y] of pigeonSpots) {
      this.pigeons.push({ hx: x, hy: y, x, y, state: 'idle', t: Math.random() * 3000, spr: this.add.image(x, AY + y, 'pigeon0_0', 0).setOrigin(0.5, 1) });
    }

    this.add.image(0, AY, 'vignette').setOrigin(0, 0).setDepth(950).setAlpha(0.35);
    this.fxG = this.add.graphics().setDepth(960);
    this.ui = this.add.graphics().setDepth(1000);
    this.buildHud();
    this.buildButtons();
    this.crowdIcon = this.add.image(90, AY + 46, 'icons', 0).setScale(3).setDepth(1500).setVisible(false);
    this.crowdText = this.txt(90, AY + 64, '', 'yellow').setOrigin(0.5, 0).setDepth(1500).setVisible(false);
    this.toast = this.txt(90, PANEL_Y - 14, '', 'sand').setOrigin(0.5, 0).setDepth(1600).setVisible(false);
    this.ui2 = this.add.graphics().setDepth(2050);
    this.dim = this.add.rectangle(0, AY, 180, 260, hexToInt(PAL.ink), 0.45).setOrigin(0, 0).setDepth(39).setVisible(false);
    this.blackout = this.add.rectangle(0, AY, 180, 260, hexToInt(PAL.ink), 0.92).setOrigin(0, 0).setDepth(1000).setVisible(false);
    this.setupFreezeFrame();
    // постоянная пометка в нижней панели, пока ты призрак
    this.ghostUi = [
      this.add.image(16, PANEL_Y + 19, 'qmark').setScale(2).setDepth(1101),
      this.txt(30, PANEL_Y + 7, this.t.game.ghost, 'mist').setDepth(1101),
      this.txt(30, PANEL_Y + 19, this.t.game.ghostHint, 'sand').setDepth(1101),
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
    this.uiSet.add(this.crowdG).add(this.crowdIcon).add(this.crowdText);
    for (const b of this.buttons) {
      if (!b.id.startsWith('crowd-')) continue;
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
    once('arrow', makeArrow);
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

  private icon(name: string): number {
    return Math.max(0, this.iconNames.indexOf(name));
  }

  private txt(x: number, y: number, s: string, color: FontColor = 'white'): Phaser.GameObjects.BitmapText {
    return this.add.bitmapText(x, y, 'px-' + color, s).setLetterSpacing(-2);
  }

  // ───────────── HUD и кнопки ─────────────

  private buildHud(): void {
    this.hud.timer = this.txt(3, 7, '0:00', 'sand').setDepth(1100);
    this.hud.round = this.txt(3, -1, '', 'mist').setDepth(1100).setVisible(false);
    for (let i = 0; i < this.cfg.attacksPerRound; i++) {
      this.hudIcons.push(this.add.image(48 + i * 10, 12, 'icons', this.icon('fist')).setDepth(1100));
    }
    // Свои звёзды — своим цветом; чужие — без цветов и имён, по убыванию:
    // видно, что кто-то близок к победе, но не видно, кто именно (раздел 5).
    const mine = this.sim.info(this.sim.selfPid)!;
    this.add.image(86, 12, 'icons', this.icon('star')).setDepth(1100);
    this.hud.starsMe = this.txt(91, 7, '0', COLOR_FONT[mine.color]).setDepth(1100);
    for (let i = 1; i < this.sim.players.length; i++) {
      this.add.image(90 + i * 19, 12, 'icons', this.icon('star')).setDepth(1100).setAlpha(0.6);
      this.hud['starsOther' + i] = this.txt(95 + i * 19, 7, '0', 'mist').setDepth(1100);
    }
  }

  private buildButtons(): void {
    const play = () => this.sim.phase === 'play' && !!this.me()?.alive;
    const crowdOpen = () => play() && this.sim.crowdWindowOpen(this.sim.world.time);
    this.buttons.push(
      {
        id: 'autopilot', x: 3, y: PANEL_Y + 3, w: 38, h: 30, icon: 'robot', visible: play,
        onDown: () => this.sim.intent({ k: 'autopilot', on: true }),
        onUp: () => this.sim.intent({ k: 'autopilot', on: false }),
      },
      { id: 'emote', x: 139, y: PANEL_Y + 3, w: 38, h: 30, icon: 'smile', visible: play, onDown: () => this.sim.intent({ k: 'emote' }) },
    );
    const kinds: [CrowdKind, string][] = [['freeze', 'hand'], ['jump', 'jump'], ['dance', 'dance']];
    kinds.forEach(([kind, icon], i) => {
      this.buttons.push({
        id: 'crowd-' + kind, x: 45 + i * 31, y: PANEL_Y + 3, w: 29, h: 30, icon, accent: PAL.amber, visible: crowdOpen,
        onDown: () => {
          const c = this.sim.world.crowd;
          if (c && this.me()?.crowdAnswered === c.warnAt) return;
          this.crowdChoice = kind;
          this.sim.intent({ k: 'crowd', kind });
        },
      });
    });
    // шестерёнка: звук, правила и выход — в листе настроек поверх игры (язык меняется вне матча)
    this.buttons.push({
      id: 'sound', x: 166, y: 3, w: 12, h: 18, icon: this.init0.onSettings ? 'gear' : this.audio.enabled ? 'soundOn' : 'soundOff', visible: () => true,
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
    for (const b of this.buttons) {
      const icon = b.icon ? this.add.image(b.x + b.w / 2, b.y + b.h / 2, 'icons', this.icon(b.icon)).setDepth(1101) : undefined;
      if (icon && b.id !== 'sound') icon.setScale(2);
      this.btnObjs.set(b.id, { icon });
    }
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
      if (!vis || b.id === 'sound') continue;
      if (b.id.startsWith('crowd-')) {
        const chosen = answered && b.id === 'crowd-' + this.crowdChoice;
        this.drawPanel(b.x, b.y, b.w, b.h, chosen ? PAL.forest : PAL.dusk, b.pressed, chosen ? PAL.green : b.accent, this.crowdG);
        o?.icon?.setAlpha(answered && !chosen ? 0.35 : 1);
        if (o?.icon) o.icon.y = b.y + b.h / 2 + (b.pressed ? 1 : 0);
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
      if (b.visible() && x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) return b;
    }
    return undefined;
  }

  private pressedBy = new Map<number, Button>();

  private onDown(p: Phaser.Input.Pointer): void {
    // первый тап разблокирует звук; нужная музыка включится сама (по фазе), без перезапуска при каждом касании
    this.audio.unlock();
    requestWakeLock();
    const b = this.hitButton(p.x, p.y);
    if (b) {
      b.pressed = true;
      this.pressedBy.set(p.id, b);
      this.audio.play('click');
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
        else this.ghostMarks.add(c.eid);
        this.audio.play('tick');
      }
      return;
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
    }
    this.sim.intent({ k: 'attack', eid });
  }

  // ───────────── события ─────────────

  private onWorldEvent(ev: WorldEvent): void {
    const myEid = this.me()?.eid;
    switch (ev.t) {
      case 'hit':
        this.audio.play(ev.result === 'player' ? 'hitPlayer' : 'hitBot');
        this.audio.play('poof');
        this.cameras.main.shake(120, 0.008);
        this.hitStop = 60;
        if (ev.target === myEid || this.sim.world.time - this.lastAttackAt < 200) navigator.vibrate?.(40);
        if (ev.target === myEid) {
          this.showDeath();
          if (ev.result === 'player' && myEid !== undefined) this.offerDeathClip(myEid, ev.at);
        }
        break;
      case 'star_taken':
        this.audio.play('starTake');
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
      case 'crowd':
        this.audio.cutMusic();
        this.audio.play('crowd');
        this.musicResumeAt = ev.windowEnd + 900;
        break;
      case 'zone':
        this.audio.play('hedge');
        this.showToast(this.t.game.hedge, 1800);
        break;
      case 'twist': {
        // изнанка темы: свет мигает, офис → подвал (и обратно); песня темы — громче
        this.audio.setTwist(ev.on);
        if (this.sim.phase !== 'play') break;
        this.flicker = performance.now();
        this.audio.play('flicker');
        this.cameras.main.shake(90, 0.004);
        const tt = this.themeText();
        const msg = ev.on ? tt?.twistOn : tt?.twistOff;
        if (msg) this.showToast(msg, 1800);
        break;
      }
      default:
        break;
    }
  }

  private handleNotices(): void {
    const list = this.sim.drainNotices();
    for (const n of list) this.onNotice(n);
  }

  private onNotice(n: Notice): void {
    if (n.t === 'round_start') {
      this.clearDeath();
      this.audio.setTwist(false);
      this.next25 = 0;
      void loadTheme(n.theme);
      this.applyTheme();
      this.ghostMarks.clear();
      this.replay = null;
      this.deathClip = null;
      if (n.round === 1) {
        // реванш: новый матч — новые лучший момент и карточка
        this.best = null;
        this.cardFile = null;
      }
    } else if (n.t === 'phase') {
      if (n.phase === 'countdown') this.audio.play('count');
      if (n.phase === 'play') {
        this.audio.play('ready');
        this.flashWord(this.t.game.action);
        const intro = this.themeText()?.intro;
        if (intro) this.time.delayedCall(900, () => this.sim.phase === 'play' && this.showToast(intro, 2400));
      }
      if (n.phase === 'accuse') this.audio.play('tick');
      this.syncMusic(n.phase === 'countdown');
      if (n.phase === 'reveal') {
        this.revealStartNow = this.sim.now;
        this.finalSoundsPlayed = false;
        const s = this.sim.summary!;
        this.replay = makeReplay(this.sim.world, s.replayFrom, this.sim.world.time);
        this.trails.clear();
        this.noteMoment();
        this.upgradeDeathClip();
        this.audio.play('drum');
      }
      if (n.phase === 'match_end') {
        this.audio.play(this.sim.match?.tooAlive ? 'sad' : 'fanfare');
        this.spawnConfetti();
      }
      this.buildOverlay();
    } else if (n.t === 'denied' && n.pid === this.sim.selfPid) {
      this.audio.play('denied');
      const msg = this.t.game.denied[n.reason];
      this.showToast(msg, 1000);
    }
  }

  /** Крупно и сразу понятно: тебя выбили, теперь ты призрак. */
  private showDeath(): void {
    this.clearDeath();
    const flash = this.add.rectangle(0, 0, 180, 320, hexToInt(PAL.red), 0.55).setOrigin(0, 0).setDepth(1690);
    this.tweens.add({ targets: flash, alpha: 0, duration: 500, onComplete: () => flash.destroy() });
    const y = AY + 92;
    const g = this.add.graphics().setDepth(1700);
    g.fillStyle(hexToInt(PAL.ink), 0.88).fillRect(0, y, 180, 62);
    g.fillStyle(hexToInt(PAL.red)).fillRect(0, y, 180, 2).fillRect(0, y + 60, 180, 2);
    const title = this.txt(0, y + 9, this.t.game.outTitle, 'red').setScale(2).setDepth(1701);
    this.centerScaled(title);
    const sub = this.txt(0, y + 33, this.t.game.outSub, 'white').setDepth(1701);
    sub.x = Math.round(90 - sub.width / 2);
    const hint = this.txt(0, y + 45, this.t.game.outHint, 'mist').setDepth(1701);
    hint.x = Math.round(90 - hint.width / 2);
    this.deathObjs = [g, title, sub, hint];
    this.cameras.main.shake(260, 0.012);
    navigator.vibrate?.([80, 60, 160]);
    const objs = this.deathObjs;
    this.time.delayedCall(2800, () => {
      if (this.deathObjs !== objs) return;
      this.tweens.add({ targets: objs, alpha: 0, duration: 450, onComplete: () => this.clearDeath() });
    });
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
        const ok = !!this.deathClip && (ph === 'play' || ph === 'accuse' || ph === 'reveal' || ph === 'results');
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

  private offerDeathClip(eid: number, at: number): void {
    if (!clipSupported()) return;
    const round = this.sim.round;
    // после баннера «Ты выбит!» (он гаснет через ~3,3 с)
    this.time.delayedCall(3400, () => {
      if (this.sim.round !== round || this.me()?.alive) return;
      this.deathClip = { eid, at, status: 'offer', progress: 0, file: null };
      this.updateDeathClipLabel();
      this.audio.play('ready');
    });
  }

  /** Раунд закончился: теперь известно, кто выбил, — клип выбывшего можно снять заново, с ним в кадре. */
  private upgradeDeathClip(): void {
    const dc = this.deathClip;
    const k = this.sim.summary?.kills?.find((x) => dc && x.victim === dc.eid);
    if (!dc || !k) return;
    // полную версию — с выбившим и всеми живыми в их цветах — монтируем сразу, без нажатия
    const next: DeathClip = { eid: dc.eid, at: dc.at, status: 'offer', progress: 0, file: null, killer: k.by };
    this.deathClip = next;
    this.updateDeathClipLabel();
    this.renderDeathClip(next);
  }

  private placeDeathClipButton(b: Button, wide: boolean): void {
    const [x, y, w, h] = wide ? [3, PANEL_Y + 3, 174, 30] : [96, PANEL_Y - 26, 80, 22];
    if (b.x === x && b.y === y) return;
    Object.assign(b, { x, y, w, h });
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
      void this.init0.onShare?.(kName ? fmt(this.t.clip.deathTextBy, { name: kName }) : this.t.clip.deathText, [dc.file]);
      return;
    }
    if (dc.status !== 'offer') return;
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

  /** Свет мигает при смене изнанки: тьма — свет — тьма — новый облик (мс от начала). */
  private renderFlicker(): void {
    const k = performance.now() - this.flicker;
    const dark = this.flicker > 0 && ((k >= 0 && k < 70) || (k >= 130 && k < 260));
    // пакет темы ещё грузится (медленная сеть) — поле тёмное, а не парк, который потом переоденется
    const waiting = !isThemeLoaded(this.sim.theme);
    this.blackout.setVisible(dark || waiting).setAlpha(waiting ? 1 : 0.92);
    if (k > 300) this.flicker = 0;
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
    if (!this.next25) this.next25 = now + 5000 + Math.random() * 6000;
    if (now < this.next25) return;
    this.next25 = now + 7000 + Math.random() * 9000;
    const alive = this.sim.world.alive();
    if (!alive.length) return;
    // любая сущность, чаще бот: ничего не выдаёт
    this.flash25 = { eid: alive[Math.floor(Math.random() * alive.length)].eid, until: now + 70 };
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
    const lk = this.phaseWorld().twist ? 1 : 0;
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
    if (this.hitStop > 0) {
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
    if (phase === 'reveal') this.renderReveal(alpha);
    else this.renderWorld(this.sim.world, phase === 'countdown' || phase === 'play' ? alpha : 1, 'live');

    this.dim.setVisible(phase === 'accuse');
    const ghost = phase === 'play' && !!this.me() && !this.me()!.alive;
    for (const o of this.ghostUi) (o as Phaser.GameObjects.Image).setVisible(ghost);
    this.renderProps();
    this.renderHedge(phase === 'reveal' && this.replay ? this.replay : this.sim.world);
    this.renderPigeons(delta);
    this.renderFx(delta);
    this.renderHud();
    this.drawUi();
    this.updateOverlay(delta);
    this.syncUiCamera();
    if (this.toast.visible && performance.now() > this.toastUntil) this.toast.setVisible(false);
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
    w.entities.forEach((e, i) => {
      const v = this.views[i];
      if (!v) return;
      const x = Math.round(e.px + (e.x - e.px) * alpha);
      const y = Math.round(e.py + (e.y - e.py) * alpha);
      const sy = AY + y;
      // «поф» при выбивании
      const since = w.time - e.removedAt;
      if (!e.alive) {
        v.spr.setVisible(false);
        v.ol.setVisible(false);
        v.shadow.setVisible(false);
        v.stun.setVisible(false);
        v.mark.setVisible(false);
        v.q.setVisible(false);
        if (since >= 0 && since < 360) v.poof.setVisible(true).setFrame(Math.min(5, Math.floor(since / 60))).setPosition(x, sy - 8).setDepth(sy + 1);
        else v.poof.setVisible(false);
        return;
      }
      v.poof.setVisible(false);
      const { frame, flip, yoff } = this.frameFor(e, t);
      let jumpOff = yoff;
      if (mode === 'final' && highlight?.has(e.eid)) jumpOff = -Math.abs(Math.round(Math.sin(performance.now() / 140) * 5));
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
      const chKey = 'ch' + (flashKey ?? this.lookKey);
      if (v.spr.texture.key !== chKey) v.spr.setTexture(chKey, frame);
      v.spr.setVisible(true).setFrame(frame).setFlipX(flip).setPosition(x + lx, sy + jumpOff + ly).setDepth(sy);
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
      this.arrow.setVisible(true).setPosition(x, y + yoff - CH_H - 2 - bounce);
      this.ring.setVisible(true).setPosition(x, y).setDepth(y - 0.6);
      if (phase === 'countdown') {
        const blinkOn = Math.floor(performance.now() / 160) % 2 === 0;
        const idx = w.entities.indexOf(mine);
        this.views[idx]?.spr.setAlpha(blinkOn ? 1 : 0.25);
      }
    } else {
      this.arrow.setVisible(false);
      this.ring.setVisible(false);
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
      this.renderWorld(this.replay, alpha, 'replay', colors);
      return;
    }
    const alive = new Map<number, number>();
    for (const r of s.reveal) if (r.alive) alive.set(r.eid, colors.get(r.eid)!);
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
      const [tex, fr] = this.crowdIconOf(cr.kind);
      if (this.crowdIcon.texture.key !== tex || this.crowdIcon.frame.name !== String(fr)) this.crowdIcon.setTexture(tex, fr);
      const answered = this.me()?.crowdAnswered === cr.warnAt;
      if (frozen) {
        this.crowdText.setText(this.crowdLabel(cr.kind)).setFont('px-yellow');
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
        else this.crowdText.setText(answered ? this.t.game.withCrowd : this.t.game.late).setFont(answered ? 'px-green' : 'px-red');
      }
      this.crowdText.x = Math.round(90 - this.crowdText.width / 2);
      this.crowdText.setOrigin(0, 0);
    }
  }

  private renderHud(): void {
    const sim = this.sim;
    const left = sim.timeLeft();
    const sec = Math.ceil(left / 1000);
    const showTimer = sim.phase === 'play' || sim.phase === 'accuse' || sim.phase === 'countdown';
    this.hud.timer.setText(showTimer ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : tp(this.lang, this.t.game.roundShort, sim.round));
    this.hud.timer.setFont(sim.phase === 'play' && sec <= 10 ? 'px-red' : 'px-sand');
    const me = this.me();
    this.hudIcons.forEach((ic, i) => ic.setFrame(this.icon(me && i < me.attacksLeft ? 'fist' : 'fistOff')));
    this.hud.starsMe?.setText(String(me?.stars ?? 0));
    const others = sim.otherStars();
    others.forEach((n, i) => this.hud['starsOther' + (i + 1)]?.setText(String(n)).setFont(n >= this.cfg.starsToWin - 1 ? 'px-amber' : 'px-mist'));
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
    const keep = new Set(this.buttons.filter((b) => b.keep).map((b) => b.id));
    this.buttons = this.buttons.filter((b) => !b.label || b.keep);
    for (const [id, o] of this.btnObjs) if (o.text && !keep.has(id)) this.btnObjs.delete(id);
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
        this.ovText(90, AY + 126, this.t.game.findYourself, 'sand');
        this.ovText(90, AY + 138, tp(this.lang, this.t.game.roundTheme, sim.round, { theme: this.t.themes[sim.theme] }), 'mist');
        break;
      }
      case 'accuse': {
        this.ovText(90, AY + 6, this.t.game.accuseTitle, 'yellow');
        this.ovDyn.sub = this.ovText(90, AY + 18, this.t.game.accuseSub, 'sand');
        this.ovDyn.timer = this.ovText(90, PANEL_Y + 13, '5', 'red');
        break;
      }
      case 'reveal': {
        this.ovDyn.title = this.ovText(90, AY + 6, this.t.game.reveal, 'yellow');
        this.ovDyn.speed = this.ovText(176, AY + 248, '×2.5', 'mist', false).setOrigin(1, 0).setVisible(false);
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
    this.ovText(90, AY + 16, tp(this.lang, this.t.game.resultsTitle, s.round), 'yellow');
    this.ovText(90, AY + 28, reason, 'mist');
    const order = [...sim.players].sort((a, b) => sim.scores[b.pid] - sim.scores[a.pid]);
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
    this.addOverlayButton('share', 9, AY + 214, 81, 30, this.t.game.share, () => this.share(), undefined, true);
    this.addOverlayButton('next', 91, AY + 214, 80, 30, this.t.game.next, () => sim.intent({ k: 'next' }), PAL.amber);
    this.ovDyn.auto = this.ovText(90, AY + 200, '', 'mist');
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
    this.addOverlayButton('rematch', 9, AY + 214, 81, 30, this.t.game.rematch, () => {
      this.confetti = [];
      sim.intent({ k: 'rematch' });
    }, PAL.amber);
    this.addOverlayButton('share2', 91, AY + 214, 80, 30, this.t.game.share, () => this.share(), undefined, true);
    // открывается касанием: отпускание пальца у нижнего края экрана браузер может забрать себе (Chrome на iPhone);
    // жест для системного меню не нужен — отправка идёт отдельной кнопкой в окне клипа
    if (this.best) this.addOverlayButton('clip', 3, PANEL_Y + 3, 174, 30, this.t.clip.button, () => this.openClip(), PAL.amber);
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
        s.reveal.forEach((r, i) => {
          const t = this.ovDyn['name' + i];
          if (!t) return;
          t.setVisible(r.alive);
          if (r.alive) t.setPosition(Math.round(Math.min(178 - t.width, Math.max(2, r.x - t.width / 2))), AY + r.y - CH_H - 16);
        });
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
    if (phase === 'results' && this.ovDyn.auto) {
      this.ovDyn.auto.setText(tp(this.lang, this.t.game.nextIn, Math.ceil(sim.timeLeft() / 1000)));
      this.ovDyn.auto.x = Math.round(90 - this.ovDyn.auto.width / 2);
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

  private openClip(): void {
    const best = this.best;
    if (!best) return;
    this.closeClip?.();
    // модуль клипа в основной сборке (не ленивый чанк): после обновления сайта открытая вкладка
    // не сможет подгрузить чанк, которого уже нет на сервере, и кнопка молча не срабатывала бы
    try {
      this.closeClip = openClipOverlay(
        document.body,
        { ...best, arena: this.sim.arena, t: this.t, font: this.init0.fontFamily, site: location.host },
        this.t,
        async (file) => {
          const m = best.moment;
          const a = best.players.find((p) => p.eid === m.attacker);
          const b = best.players.find((p) => p.eid === m.victim);
          const text = m.kind === 'knockout' && a && b ? fmt(this.t.clip.shareKo, { a: a.name, b: b.name }) : this.t.meta.title;
          await this.init0.onShare?.(text, [file]);
        },
        (file) => this.init0.onSave?.(file),
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
