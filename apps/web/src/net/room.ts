'use client';

import type { SupabaseClient } from '@supabase/supabase-js';
import { DelayedTransport, HostSession, RemoteSession, SupabaseTransport } from '@kto/net';
import type { PresenceMember, RoomMsg, Transport } from '@kto/net';
import { DICTS, fmt } from '@kto/game-core';
import type { ClientSession, PlayerInfo } from '@kto/game-core';
import { rpcErrorCode } from '@/lib/supabase';

export interface RoomSettings {
  roundSec: 60 | 75 | 90;
  maxRounds: 3 | 5 | 7;
  kidsMode: boolean;
  /**
   * ИИ-актёры: свободные места до 4 занимают ИИ (за них играет хост), матч можно начать и одному.
   * Пока владелец проводит плейтесты — по умолчанию выключено (решение 22.11.2026), потом включить.
   */
  aiFill: boolean;
}

export const DEFAULT_SETTINGS: RoomSettings = { roundSec: 75, maxRounds: 5, kidsMode: false, aiFill: false };

/** Сколько всего мест в матче (люди + ИИ-актёры). */
const SEATS = 4;

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
  /** Номер игровой сессии: меняется при старте и смене хоста — экран игры пересоздаётся. */
  gameId?: number;
  error?: string;
  code: string;
  selfId: string;
  hostId: string;
  members: Member[];
  settings: RoomSettings;
}

/** Сообщения лобби в общем канале (только от хоста). */
export type LobbyMsg =
  | { t: 'lobby'; hostId: string; settings: RoomSettings }
  | { t: 'kick_refresh' }
  /** Режиссёр убрал участника: тот уходит сам, остальные перечитывают состав. */
  | { t: 'kick'; userId: string };

/**
 * Комната: вход через RPC, состав из таблицы room_members + Presence (кто онлайн и готов),
 * хост и настройки. Игровой протокол работает поверх того же транспорта (этап C).
 */
export class Room {
  state: RoomState;
  transport: Transport | null = null;
  private listeners = new Set<(s: RoomState) => void>();
  private dbMembers: { user_id: string; name: string; color: number; joined_at: string }[] = [];
  private presence: PresenceMember[] = [];
  private touchTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private myName = '';
  private myReady = false;
  /** Сообщения игры (всё, что не лобби) — для этапа C. */
  onGameMessage: ((channel: string, msg: unknown, from: string) => void) | null = null;
  /** Текущая игровая сессия (хост или гость). */
  session: ClientSession | null = null;
  private gameSeq = 0;
  private matchPlayers: PlayerInfo[] = [];
  private hostMissingSince = 0;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private lastStatus = '';
  /** Зритель: задержка поверх транспорта, опрос «кончился ли матч», когда кончился у игроков. */
  private delayed: DelayedTransport | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private watchEndAt = 0;
  private spectateTries = 0;

  constructor(private sb: SupabaseClient, code: string, selfId: string) {
    this.state = { status: 'connecting', code: code.toUpperCase(), selfId, hostId: '', members: [], settings: DEFAULT_SETTINGS };
  }

  get isHost(): boolean {
    return this.state.hostId === this.state.selfId;
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
    const { data, error } = await this.sb.rpc('join_room', { p_code: this.state.code, p_name: name });
    if (error) {
      const code = rpcErrorCode(error);
      // матч уже идёт — смотреть трансляцию, а когда он кончится, войти в комнату
      if (code === 'room_playing' && this.spectateTries++ < 5) await this.spectate();
      else this.set({ status: 'error', error: code });
      return;
    }
    this.spectateTries = 0;
    const r = data as { code: string; color: number; host_id: string; status: string; settings: Partial<RoomSettings> };
    this.set({ code: r.code, hostId: r.host_id, settings: { ...DEFAULT_SETTINGS, ...(r.settings ?? {}) } });
    await this.loadMembers();
    const t = new SupabaseTransport(this.sb, r.code, this.state.selfId);
    this.transport = t;
    t.onPresence((list) => {
      this.presence = list;
      this.recompute();
      this.scheduleRefresh();
    });
    t.onMessage((channel, msg, from) => {
      const m = msg as { t?: string };
      if (channel === 'room' && m?.t === 'kick' && from === this.state.hostId) {
        const km = msg as Extract<LobbyMsg, { t: 'kick' }>;
        if (km.userId === this.state.selfId) void this.kicked();
        else this.scheduleRefresh();
        return;
      }
      if (channel === 'room' && m?.t === 'lobby') {
        const lm = msg as Extract<LobbyMsg, { t: 'lobby' }>;
        if (from === this.state.hostId) this.set({ hostId: lm.hostId, settings: lm.settings });
        // сообщение от другого участника — значит, хост сменился: кто хост, решает база, не сообщение
        else if (this.dbMembers.some((d) => d.user_id === from)) this.scheduleRefresh();
        return;
      }
      // старт матча — от хоста; после смены хоста — от нового (он уже записан в базе как хост)
      if (channel === 'room' && m?.t === 'match_start' && from !== this.state.selfId && this.dbMembers.some((d) => d.user_id === from)) {
        this.beginRemote(msg as Extract<RoomMsg, { t: 'match_start' }>, false);
        return;
      }
      this.onGameMessage?.(channel, msg, from);
    });
    try {
      await t.connect(this.me(), this.isHost, this.dbMembers.map((m) => m.user_id));
    } catch {
      this.set({ status: 'error', error: 'network' });
      return;
    }
    this.set({ status: 'lobby' });
    // перезагрузка во время матча: вернуться в игру по снимку от хоста
    if (r.status === 'playing' && !this.isHost) {
      this.beginRemote({ t: 'match_start', players: this.membersAsPlayers(), cfg: this.cfgFromSettings(), seed: 0, hostId: this.state.hostId }, true);
    }
    this.statusTimer = setInterval(() => this.watch(), 1000);
    // пульс: кто молчит дольше 75 с, тот освобождает место для нового игрока (см. join_room)
    this.touchTimer = setInterval(() => this.touch(), 20_000);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisible);
  }

  private me(): PresenceMember {
    const db = this.dbMembers.find((m) => m.user_id === this.state.selfId);
    return {
      userId: this.state.selfId,
      name: this.myName,
      color: db?.color ?? 0,
      joinedAt: db ? Date.parse(db.joined_at) : Date.now(),
      ready: this.myReady,
    };
  }

  private async loadMembers(): Promise<void> {
    const [{ data: members }, { data: room }] = await Promise.all([
      this.sb.from('room_members').select('user_id,name,color,joined_at').eq('room_code', this.state.code).order('joined_at'),
      this.sb.from('rooms').select('host_id,settings,status').eq('code', this.state.code).maybeSingle(),
    ]);
    if (members) this.dbMembers = members;
    if (room) this.set({ hostId: room.host_id, settings: { ...DEFAULT_SETTINGS, ...(room.settings ?? {}) } });
    this.recompute();
  }

  /** Кто-то вошёл или вышел — перечитать состав (новые участники видны в таблице сразу после join_room). */
  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(async () => {
      const wasHost = this.isHost;
      await this.loadMembers();
      if (this.isHost !== wasHost || this.isHost) {
        await this.transport?.setRole(this.isHost, this.dbMembers.map((m) => m.user_id));
      }
    }, 300);
  }

  private recompute(): void {
    const online = new Map(this.presence.map((p) => [p.userId, p]));
    const members: Member[] = this.dbMembers.map((m) => {
      const p = online.get(m.user_id);
      return {
        userId: m.user_id,
        name: p?.name || m.name,
        color: m.color,
        joinedAt: Date.parse(m.joined_at),
        online: !!p,
        ready: !!p?.ready,
      };
    });
    this.set({ members });
  }

  private membersAsPlayers(): PlayerInfo[] {
    return this.state.members
      .filter((m) => m.online || m.userId === this.state.selfId)
      .map((m) => ({ pid: m.userId, name: m.name, color: m.color }));
  }

  /** Состав нового матча: люди в комнате и, если включено, ИИ-актёры на свободные места и цвета. */
  private roster(): PlayerInfo[] {
    const humans = this.membersAsPlayers();
    if (!this.state.settings.aiFill) return humans;
    const lang = typeof document !== 'undefined' && document.documentElement.lang === 'en' ? 'en' : 'ru';
    const t = DICTS[lang];
    const free = [0, 1, 2, 3].filter((c) => !humans.some((h) => h.color === c));
    const nouns = [...t.names.noun].sort(() => Math.random() - 0.5);
    const ai = free.slice(0, Math.max(0, SEATS - humans.length)).map((color, i) => ({
      pid: `ai-${i + 1}`,
      name: fmt(t.lobby.aiName, { name: nouns[i] }).slice(0, 14),
      color,
      ai: true,
    }));
    return [...humans, ...ai];
  }

  /** Сколько людей нужно, чтобы начать матч: с ИИ-актёрами — хватит одного. */
  minHumans(): number {
    return this.state.settings.aiFill ? 1 : 2;
  }

  private cfgFromSettings() {
    const s = this.state.settings;
    return { roundSec: s.roundSec, maxRounds: s.maxRounds, kidsMode: s.kidsMode };
  }

  /** Зритель: право читать общий канал (spectate_room), трансляция с задержкой, опрос конца матча. */
  private async spectate(): Promise<void> {
    const { data, error } = await this.sb.rpc('spectate_room', { p_code: this.state.code, p_name: this.myName });
    if (error) {
      this.set({ status: 'error', error: rpcErrorCode(error) });
      return;
    }
    const r = data as {
      code: string;
      host_id: string;
      status: string;
      settings: Partial<RoomSettings>;
      members: { user_id: string; name: string; color: number }[];
    };
    this.set({ code: r.code, hostId: r.host_id, settings: { ...DEFAULT_SETTINGS, ...(r.settings ?? {}) } });
    // матч успел кончиться — сразу в комнату
    if (r.status !== 'playing') {
      void this.sb.rpc('unspectate_room', { p_code: r.code });
      await this.join(this.myName);
      return;
    }
    const t = new SupabaseTransport(this.sb, r.code, this.state.selfId);
    this.transport = t;
    t.onMessage((channel, msg) => {
      if (channel !== 'room') return;
      // писать в общий канал может только хост (RLS) — значит, это от него
      const m = msg as { t?: string };
      if (m.t === 'match_start') {
        const ms = msg as Extract<RoomMsg, { t: 'match_start' }>;
        // новый матч (смена хоста, реванш с новым составом) — со своей задержкой, старый досмотреть
        setTimeout(() => this.state.status === 'watch' && this.startWatching(ms.players, ms.hostId), SPECTATE_DELAY_MS);
      } else if (m.t === 'lobby') {
        const lm = msg as Extract<LobbyMsg, { t: 'lobby' }>;
        this.set({ hostId: lm.hostId, settings: lm.settings });
      }
    });
    try {
      await t.watch();
    } catch {
      this.set({ status: 'error', error: 'network' });
      return;
    }
    this.startWatching(
      r.members.map((m) => ({ pid: m.user_id, name: m.name, color: m.color })),
      r.host_id,
    );
    this.watchEndAt = 0;
    this.watchTimer = setInterval(() => void this.checkMatchOver(), 3000);
  }

  private startWatching(players: PlayerInfo[], hostId: string): void {
    if (!this.transport) return;
    this.session?.dispose();
    void this.delayed?.close();
    this.delayed = new DelayedTransport(this.transport, SPECTATE_DELAY_MS);
    this.matchPlayers = players;
    this.session = new RemoteSession({
      transport: this.delayed,
      selfPid: this.state.selfId,
      hostPid: hostId,
      players,
      cfg: this.cfgFromSettings(),
      spectator: true,
    });
    this.set({ status: 'watch', hostId, gameId: ++this.gameSeq });
  }

  /** Зритель: кончился ли матч у игроков. Досмотреть его (задержка) — и войти в комнату к реваншу. */
  private async checkMatchOver(): Promise<void> {
    const { data, error } = await this.sb.rpc('room_status', { p_code: this.state.code });
    if (error || this.state.status !== 'watch') return;
    if (data === null) {
      await this.stopWatching();
      this.set({ status: 'error', error: 'closed' });
      return;
    }
    if (data !== 'lobby') {
      this.watchEndAt = 0;
      return;
    }
    this.watchEndAt ||= Date.now() + SPECTATE_DELAY_MS + 4000;
    if (Date.now() < this.watchEndAt && this.session?.phase !== 'match_end') return;
    await this.stopWatching();
    void this.sb.rpc('unspectate_room', { p_code: this.state.code });
    this.set({ status: 'connecting' });
    await this.join(this.myName);
  }

  private async stopWatching(): Promise<void> {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.session?.dispose();
    this.session = null;
    await this.delayed?.close();
    this.delayed = null;
    await this.transport?.close();
    this.transport = null;
  }

  /**
   * Режиссёр жмёт «Ещё дубль»: если после матча в комнату вошли новые игроки (досмотрели как
   * зрители) — новый матч со всеми, кто сейчас в комнате; иначе — обычный реванш в той же сессии.
   */
  rematchWithNewcomers(): boolean {
    if (!this.isHost || this.state.status !== 'game') return false;
    const now = this.membersAsPlayers();
    const humansBefore = this.matchPlayers.filter((p) => !p.ai);
    const same = now.length === humansBefore.length && now.every((p) => humansBefore.some((q) => q.pid === p.pid));
    if (same || now.length < this.minHumans()) return false;
    void this.startMatch();
    return true;
  }

  /** Хост: начать матч с теми, кто сейчас в комнате. */
  async startMatch(resume?: { scores: Record<string, number>; round: number }): Promise<void> {
    if (!this.isHost || !this.transport) return;
    // ИИ-актёры переживают смену хоста: за них теперь играет новый хост
    const players = resume
      ? this.matchPlayers.filter((p) => p.ai || this.state.members.some((m) => m.userId === p.pid && (m.online || m.userId === this.state.selfId)))
      : this.roster();
    if (players.filter((p) => !p.ai).length < this.minHumans() && !resume) return;
    this.matchPlayers = players;
    // личные каналы — только у людей
    await this.transport.setRole(true, players.filter((p) => !p.ai).map((p) => p.pid));
    await this.sb.rpc('set_room_status', { p_code: this.state.code, p_status: 'playing' });
    const seed = Math.floor(Math.random() * 2 ** 31);
    const cfg = this.cfgFromSettings();
    await this.transport.send('room', { t: 'match_start', players, cfg, seed, hostId: this.state.selfId } satisfies RoomMsg);
    this.session?.dispose();
    this.session = new HostSession({ transport: this.transport, players, cfg, seed, hostPid: this.state.selfId, resume });
    this.set({ status: 'game', gameId: ++this.gameSeq });
  }

  private beginRemote(m: Extract<RoomMsg, { t: 'match_start' }>, resync: boolean): void {
    if (!this.transport) return;
    this.matchPlayers = m.players;
    this.session?.dispose();
    this.session = new RemoteSession({
      transport: this.transport,
      selfPid: this.state.selfId,
      hostPid: m.hostId,
      players: m.players,
      cfg: m.cfg,
      resync,
    });
    this.set({ status: 'game', hostId: m.hostId, gameId: ++this.gameSeq });
  }

  /** Раз в секунду: пропал ли хост, и статус комнаты для опоздавших. */
  private watch(): void {
    // в лобби роль хоста сама не передаётся: хост, ушедший в мессенджер позвать друзей, не должен
    // её терять; перезаход (та же личность на устройстве) возвращает его хостом. Явный уход
    // кнопкой «Назад» передаёт роль через leave_room.
    if (this.state.status !== 'game' || !this.session) return;
    const s = this.session;
    if (this.isHost) {
      const status = s.phase === 'match_end' ? 'lobby' : 'playing';
      if (status !== this.lastStatus) {
        this.lastStatus = status;
        void this.sb.rpc('set_room_status', { p_code: this.state.code, p_status: status });
      }
      return;
    }
    const hostOnline = this.presence.some((p) => p.userId === this.state.hostId);
    if (hostOnline) {
      this.hostMissingSince = 0;
      return;
    }
    this.hostMissingSince ||= Date.now();
    if (Date.now() - this.hostMissingSince < 5000) return;
    // следующий по порядку входа среди оставшихся забирает роль хоста и перезапускает раунд
    const next = this.presence.filter((p) => p.userId !== this.state.hostId).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (next?.userId !== this.state.selfId) return;
    this.hostMissingSince = 0;
    void (async () => {
      const { error } = await this.sb.rpc('claim_host', { p_code: this.state.code });
      if (error) return;
      const oldHost = this.state.hostId;
      this.set({ hostId: this.state.selfId });
      this.matchPlayers = this.matchPlayers.filter((p) => p.pid !== oldHost);
      await this.startMatch({ scores: { ...s.scores }, round: s.round });
    })();
  }

  /**
   * Пульс. Если комнату убрала уборка (долго без действий или старше 6 часов), в лобби показать
   * «комната закрылась»; во время матча — доиграть, следующий пульс в лобби поймает.
   */
  private touch(): void {
    void this.sb.rpc('touch_room', { p_code: this.state.code }).then(({ data, error }) => {
      if (!error && data === 'gone' && this.state.status === 'lobby') void this.closed();
    });
  }

  private async closed(): Promise<void> {
    await this.leave();
    this.set({ status: 'error', error: 'closed' });
  }

  /**
   * Вернулись во вкладку (телефон усыплял таймеры): отметиться заново. Если за это время место
   * освободили, в лобби join_room вернёт игрока обратно (при свободном месте).
   */
  private onVisible = (): void => {
    if (document.visibilityState !== 'visible' || !this.transport) return;
    void this.sb.rpc('join_room', { p_code: this.state.code, p_name: this.myName }).then(({ error }) => {
      // перечитать состав и роли: пока нас не было, хостом мог стать другой
      if (!error) this.scheduleRefresh();
      else if (rpcErrorCode(error) === 'room_not_found' && this.state.status === 'lobby') void this.closed();
    });
  };

  /** Режиссёр: убрать участника из комнаты (только в лобби) — освободить место. По ссылке он может войти снова. */
  async kick(userId: string): Promise<boolean> {
    if (!this.isHost || userId === this.state.selfId || this.state.status !== 'lobby') return false;
    const { error } = await this.sb.rpc('kick_member', { p_code: this.state.code, p_user: userId });
    if (error) return false;
    this.dbMembers = this.dbMembers.filter((m) => m.user_id !== userId);
    this.recompute();
    await this.transport?.send('room', { t: 'kick', userId } satisfies LobbyMsg);
    await this.transport?.setRole(true, this.dbMembers.map((m) => m.user_id));
    return true;
  }

  /** Нас убрали из комнаты: отключиться и показать экран «Режиссёр убрал тебя». */
  private async kicked(): Promise<void> {
    await this.leave();
    this.set({ status: 'error', error: 'kicked' });
  }

  /** Уйти насовсем (кнопка «Назад» / «Выйти в меню»): освободить место сразу. */
  async quit(): Promise<void> {
    const code = this.state.code;
    const watching = this.state.status === 'watch';
    await this.leave();
    await this.sb.rpc(watching ? 'unspectate_room' : 'leave_room', { p_code: code });
  }

  async setReady(ready: boolean): Promise<void> {
    this.myReady = ready;
    await this.transport?.track(this.me());
  }

  async rename(name: string): Promise<void> {
    this.myName = name;
    await this.sb.rpc('rename_member', { p_code: this.state.code, p_name: name });
    await this.transport?.track(this.me());
  }

  async updateSettings(settings: RoomSettings): Promise<void> {
    if (!this.isHost) return;
    this.set({ settings });
    await this.sb.rpc('update_room_settings', { p_code: this.state.code, p_settings: settings });
    await this.transport?.send('room', { t: 'lobby', hostId: this.state.hostId, settings } satisfies LobbyMsg);
  }

  async leave(): Promise<void> {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible);
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    await this.delayed?.close();
    this.delayed = null;
    if (this.touchTimer) clearInterval(this.touchTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.session?.dispose();
    this.session = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    await this.transport?.close();
    this.transport = null;
  }
}

/** Создать комнату и вернуть код. */
export async function createRoom(sb: SupabaseClient, name: string, settings: RoomSettings = DEFAULT_SETTINGS): Promise<string> {
  const { data, error } = await sb.rpc('create_room', { p_name: name, p_settings: settings });
  if (error) throw new Error(rpcErrorCode(error));
  return (data as { code: string }).code;
}
