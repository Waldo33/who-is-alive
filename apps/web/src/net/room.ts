'use client';

import { DelayedTransport, RemoteSession, ServerLink } from '@kto/net';
import type { RoomMsg, WireRoom, WireRoomSettings } from '@kto/net';
import type { ClientSession, PlayerInfo } from '@kto/game-core';
import { createGameRoom, ensureGameUser, forgetGameUser, gameRoomInfo } from '@/lib/game-server';
import { setVideoOff } from '@/game/video-switch';
import { detectLang } from '@/lib/lang';
import { mildOn } from '@/ui/topbar';

/**
 * Комната на своём игровом сервере (docs/server-migration.md): одно WebSocket-соединение на лобби
 * и игру, матч считает сервер. У всех, включая режиссёра, — `RemoteSession`; режиссёр — только
 * роль (настройки, старт, «Дальше», «Ещё дубль», кик). Ушёл — роль у следующего, матч идёт.
 */

export type RoomSettings = WireRoomSettings;

/**
 * ИИ-актёры (aiFill) включены по умолчанию (решение владельца 23.11.2026): свободные места занимает ИИ,
 * матч можно начать вдвоём и даже одному. Режиссёр выключает их в настройках лобби.
 */
export const DEFAULT_SETTINGS: RoomSettings = { roundSec: 75, maxRounds: 5, kidsMode: false, aiFill: true };

/**
 * Задержка трансляции для зрителя: опоздавший обычно сидит рядом с игроками — всё, что он видит,
 * они уже видели, подсказать «вон тот живой» поздно.
 */
export const SPECTATE_DELAY_MS = 10_000;

export interface Member {
  userId: string;
  name: string;
  color: number;
  joinedAt: number;
  online: boolean;
  ready: boolean;
}

export interface RoomState {
  /** watch — зритель: матч уже шёл, смотрит трансляцию, после матча войдёт в комнату сам. */
  status: 'connecting' | 'lobby' | 'error' | 'game' | 'watch';
  /** Номер игровой сессии: меняется при старте — экран игры пересоздаётся. */
  gameId?: number;
  error?: string;
  code: string;
  selfId: string;
  hostId: string;
  members: Member[];
  settings: RoomSettings;
}

export class Room {
  state: RoomState;
  link: ServerLink | null = null;
  /** Текущая игровая сессия. */
  session: ClientSession | null = null;
  private listeners = new Set<(s: RoomState) => void>();
  private gameSeq = 0;
  private myName = '';
  private myReady = false;
  private delayed: DelayedTransport | null = null;
  private watchEndAt = 0;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private left = false;

  constructor(code: string) {
    this.state = { status: 'connecting', code: code.toUpperCase(), selfId: '', hostId: '', members: [], settings: DEFAULT_SETTINGS };
  }

  get isHost(): boolean {
    return this.state.hostId === this.state.selfId;
  }

  /** Сдвиг часов сервера (оркестр из телефонов); null — ещё не мерили или сервер не ответил. */
  private clockOff: number | null = null;
  private clockAt = 0;

  /**
   * Время сервера, мс — общее для всех телефонов комнаты (оркестр). Замер — при первом вызове
   * и раз в 30 с; до замера — null.
   */
  async serverNow(): Promise<(() => number) | null> {
    const link = this.link;
    if (!link) return null;
    if (this.clockOff === null || Date.now() - this.clockAt > 30_000) {
      const off = await link.serverClock();
      if (off !== null) {
        this.clockOff = off;
        this.clockAt = Date.now();
      }
    }
    const off = this.clockOff;
    return off === null ? null : () => Date.now() + off;
  }

  subscribe(fn: (s: RoomState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<RoomState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  async join(name: string): Promise<void> {
    this.myName = name;
    let user;
    let info;
    try {
      user = await ensureGameUser();
      info = await gameRoomInfo(this.state.code);
    } catch (e) {
      this.set({ status: 'error', error: (e as Error).name === 'AuthError' ? 'auth' : 'network' });
      return;
    }
    if (this.left) return;
    if (!info) {
      this.set({ status: 'error', error: 'room_not_found' });
      return;
    }
    this.set({ selfId: user.userId });
    // язык и «без крови» — серверу для клипа выбывшего: он смонтирует его сразу после удара, до нажатия
    const clipPrefs = () => ({ lang: detectLang(), mild: mildOn() });
    const link = new ServerLink({ url: info.wsUrl, token: user.token, selfId: user.userId, code: this.state.code, name, clipPrefs });
    this.link = link;
    link.onRoom((r) => this.onRoom(r));
    // аварийный выключатель видео: сервер сказал — кнопки клипа и фильма прячутся сразу
    link.onFlags((f) => setVideoOff(!f.video));
    link.onMessage((ch, msg) => {
      const m = msg as RoomMsg;
      if (ch === 'room' && m?.t === 'match_start') this.onMatchStart(m);
    });
    link.onEnd((why) => {
      if (this.left) return;
      this.dropSession();
      if (why === 'bad_token') forgetGameUser();
      if (why === 'bad_version') {
        // сервер новее клиента: перезагрузить страницу (в ней новая версия игры)
        location.reload();
        return;
      }
      this.set({ status: 'error', error: why === 'kicked' || why === 'closed' ? why : why === 'room_full' || why === 'room_not_found' || why === 'room_playing' ? why : 'unknown' });
    });
    let r: WireRoom;
    try {
      r = await link.connect();
    } catch (e) {
      // ошибку входа уже показал onEnd
      void e;
      return;
    }
    if (this.left) return;
    this.applyRoom(r);
    if (link.spectator) this.startWatching(r);
    else {
      this.set({ status: 'lobby' });
      // перезагрузка во время матча: вернуться в игру по снимку от сервера
      if (r.status === 'playing') this.beginRemote(this.membersAsPlayers(r), r.directorId, true);
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisible);
  }

  private onVisible = (): void => {
    if (document.visibilityState === 'visible') this.link?.poke();
  };

  private applyRoom(r: WireRoom): void {
    this.set({
      code: r.code,
      hostId: r.directorId,
      settings: { ...DEFAULT_SETTINGS, ...r.settings },
      members: r.members.map((m) => ({ ...m })),
    });
  }

  private onRoom(r: WireRoom): void {
    const prevHost = this.state.hostId;
    this.applyRoom(r);
    // режиссёр сменился посреди матча: кнопки «Дальше» и «Ещё дубль» — у нового
    if (r.directorId !== prevHost && this.session instanceof RemoteSession && !this.link?.spectator) this.session.setHost(r.directorId);
    // зритель стал игроком (занял место после матча)
    if (this.state.status === 'watch' && this.link && !this.link.spectator) {
      this.stopWatching();
      this.set({ status: 'lobby' });
    }
    // матч у игроков кончился — зритель досматривает (задержка) и занимает место
    if (this.state.status === 'watch') {
      if (r.status === 'lobby') this.watchEndAt ||= Date.now() + SPECTATE_DELAY_MS + 4000;
      else this.watchEndAt = 0;
    }
  }

  private membersAsPlayers(r: WireRoom): PlayerInfo[] {
    return r.members.filter((m) => m.online || m.userId === this.state.selfId).map((m) => ({ pid: m.userId, name: m.name, color: m.color }));
  }

  private onMatchStart(m: Extract<RoomMsg, { t: 'match_start' }>): void {
    if (!this.link) return;
    if (this.link.spectator) {
      // новый матч, пока смотрим: со своей задержкой, старый досмотреть
      setTimeout(() => {
        if (this.state.status === 'watch') this.watch(m.players, m.hostId);
      }, SPECTATE_DELAY_MS);
      return;
    }
    this.beginRemote(m.players, m.hostId, false, m.cfg);
  }

  private beginRemote(players: PlayerInfo[], hostId: string, resync: boolean, cfg?: Extract<RoomMsg, { t: 'match_start' }>['cfg']): void {
    if (!this.link) return;
    this.session?.dispose();
    this.session = new RemoteSession({
      transport: this.link,
      selfPid: this.state.selfId,
      hostPid: hostId,
      players,
      cfg: cfg ?? this.cfgFromSettings(),
      resync,
    });
    this.set({ status: 'game', hostId, gameId: ++this.gameSeq });
  }

  private cfgFromSettings() {
    const s = this.state.settings;
    return { roundSec: s.roundSec, maxRounds: s.maxRounds, kidsMode: s.kidsMode, strictCrowd: !!s.strictCrowd };
  }

  /** Сколько людей нужно, чтобы начать матч: с ИИ-актёрами — хватит одного. */
  minHumans(): number {
    return this.state.settings.aiFill ? 1 : 2;
  }

  // ───────────── зритель ─────────────

  private startWatching(r: WireRoom): void {
    this.watch(this.membersAsPlayers(r), r.directorId);
    this.watchEndAt = 0;
    this.watchTimer = setInterval(() => this.checkMatchOver(), 1000);
  }

  private watch(players: PlayerInfo[], hostId: string): void {
    if (!this.link) return;
    this.session?.dispose();
    void this.delayed?.close();
    this.delayed = new DelayedTransport(this.link, SPECTATE_DELAY_MS);
    this.session = new RemoteSession({ transport: this.delayed, selfPid: this.state.selfId, hostPid: hostId, players, cfg: this.cfgFromSettings(), spectator: true });
    this.set({ status: 'watch', hostId, gameId: ++this.gameSeq });
  }

  /** Матч у игроков кончился и досмотрен — занять место (сервер ответит welcome уже игроком). */
  private checkMatchOver(): void {
    if (this.state.status !== 'watch' || !this.watchEndAt) return;
    if (Date.now() < this.watchEndAt && this.session?.phase !== 'match_end') return;
    this.watchEndAt = Date.now() + 5000;
    this.link?.join();
  }

  private stopWatching(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.dropSession();
  }

  private dropSession(): void {
    this.session?.dispose();
    this.session = null;
    void this.delayed?.close();
    this.delayed = null;
  }

  // ───────────── действия ─────────────

  /** Режиссёр жмёт «Ещё дубль»: новый ли состав, решает сервер — здесь всегда обычный путь. */
  rematchWithNewcomers(): boolean {
    return false;
  }

  /** Режиссёр: начать матч с теми, кто сейчас в комнате. */
  async startMatch(): Promise<void> {
    if (!this.isHost) return;
    this.link?.start();
  }

  /** Режиссёр: убрать участника из комнаты (только в лобби). По ссылке он может войти снова. */
  async kick(userId: string): Promise<boolean> {
    if (!this.isHost || userId === this.state.selfId || this.state.status !== 'lobby' || !this.link) return false;
    this.link.kick(userId);
    return true;
  }

  async setReady(ready: boolean): Promise<void> {
    this.myReady = ready;
    this.link?.setReady(ready);
  }

  async rename(name: string): Promise<void> {
    this.myName = name;
    this.link?.rename(name);
  }

  async updateSettings(settings: RoomSettings): Promise<void> {
    if (!this.isHost) return;
    this.set({ settings });
    this.link?.updateSettings(settings);
  }

  /** Уйти насовсем (кнопка «Назад» / «Выйти в меню»): освободить место сразу. */
  async quit(): Promise<void> {
    this.link?.leave();
    await this.leave();
  }

  /** Закрыть соединение, не уходя из комнаты (место держится ~75 с — можно вернуться). */
  async leave(): Promise<void> {
    this.left = true;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.stopWatching();
    await this.link?.close();
    this.link = null;
  }

  /** Своё состояние «Готов» (для отладки). */
  get ready(): boolean {
    return this.myReady;
  }

  get name(): string {
    return this.myName;
  }
}

/** Создать комнату и вернуть код (`invite` — по карточке бота: общая комната всех нажавших). */
export async function createRoom(name: string, settings: RoomSettings = DEFAULT_SETTINGS, lang = 'ru', invite?: string): Promise<string> {
  return createGameRoom(name, settings, lang, invite);
}
