import type { Rect } from './arena';
import { lerpRect } from './arena';
import type { ActKind, CrowdKind, Dir, EntitySpawn, WorldEvent } from './events';
import type { NavGrid } from './nav';
import { TICK_MS } from './config';

export interface Entity {
  eid: number;
  x: number;
  y: number;
  /** Позиция на предыдущем шаге — для интерполяции отрисовки. */
  px: number;
  py: number;
  path: number[];
  pi: number;
  dir: Dir;
  act: ActKind | null;
  actStart: number;
  actEnd: number;
  actDx: number;
  actDy: number;
  alive: boolean;
  removedAt: number;
  removeCause: 'player' | 'bot' | null;
  markUntil: number;
  /** Пройденное расстояние — фаза анимации шага. */
  walk: number;
  moving: boolean;
}

export interface Star {
  id: number;
  x: number;
  y: number;
  spawnedAt: number;
}

export interface ZoneState {
  startAt: number;
  endAt: number;
  from: Rect;
  to: Rect;
}

export interface CrowdState {
  kind: CrowdKind;
  /** «Толпа решает»: жест не назван, kind — жест большинства. */
  vote?: boolean;
  /** Не названный жест загадал вырезанный («Хлопушка»). */
  ghost?: boolean;
  warnAt: number;
  showAt: number;
  resumeAt: number;
  windowEnd: number;
  /** Леший («Купальская ночь»): смотрит до этого момента — замершие держат позу, шевельнувшийся — его. */
  watchUntil?: number;
}

export interface WorldSnapshot {
  time: number;
  entities: Entity[];
  stars: Star[];
  zone: ZoneState | null;
  crowd: CrowdState | null;
  /** Изнанка темы включена (необязательно — для снимков старых версий). */
  twist?: boolean;
  pending: WorldEvent[];
}

/**
 * Воспроизводимое состояние мира. Одинаково работает у хоста, у клиентов и в повторе:
 * получает события с временем `at` и шагает фиксированным шагом 50 мс.
 */
export class World {
  time = 0;
  entities: Entity[] = [];
  byEid = new Map<number, Entity>();
  stars = new Map<number, Star>();
  zone: ZoneState | null = null;
  crowd: CrowdState | null = null;
  /** Изнанка темы: офис стал подвалом (themes.ts › twist). */
  twist = false;
  private pending: WorldEvent[] = [];
  /** Журнал применённых событий (для повтора и клипа). */
  log: WorldEvent[] = [];
  /** Ключевые кадры раз в секунду — откуда начинать повтор. */
  keyframes: WorldSnapshot[] = [];
  recordKeyframes = true;
  listeners: ((ev: WorldEvent) => void)[] = [];
  /** Отсев событий в момент применения (гость не применяет хостовые шаги своего персонажа — он их предсказал). */
  filter: ((ev: WorldEvent) => boolean) | null = null;

  constructor(readonly nav: NavGrid, readonly speed: number) {}

  init(spawns: EntitySpawn[], t0: number): void {
    this.time = t0;
    this.entities = spawns.map((s) => ({
      eid: s.eid,
      x: s.x,
      y: s.y,
      px: s.x,
      py: s.y,
      path: [],
      pi: 0,
      dir: s.dir,
      act: null,
      actStart: 0,
      actEnd: 0,
      actDx: 0,
      actDy: 0,
      alive: true,
      removedAt: 0,
      removeCause: null,
      markUntil: 0,
      walk: 0,
      moving: false,
    }));
    this.byEid = new Map(this.entities.map((e) => [e.eid, e]));
    this.stars.clear();
    this.zone = null;
    this.crowd = null;
    this.twist = false;
    this.pending = [];
    this.log = [];
    this.keyframes = [];
  }

  push(ev: WorldEvent): void {
    // вставка с сохранением порядка по времени (стабильно)
    let i = this.pending.length;
    while (i > 0 && this.pending[i - 1].at > ev.at) i--;
    this.pending.splice(i, 0, ev);
  }

  /** Шаг: применить события с at ≤ time, сдвинуть сущности на 50 мс, time += 50. */
  step(): void {
    if (this.recordKeyframes && this.time % 1000 === 0) this.keyframes.push(this.snapshot());
    while (this.pending.length && this.pending[0].at <= this.time) {
      const ev = this.pending.shift()!;
      if (this.filter && !this.filter(ev)) continue;
      this.apply(ev);
    }
    const dt = TICK_MS / 1000;
    const frozen = this.isFrozen();
    for (const e of this.entities) {
      e.px = e.x;
      e.py = e.y;
      if (!e.alive || frozen) continue;
      e.moving = false;
      if (e.act && this.time >= e.actEnd) e.act = null;
      if (e.act) {
        if (e.act === 'startle' && this.time < e.actStart + (e.actEnd - e.actStart) / 2) {
          const half = (e.actEnd - e.actStart) / 2000;
          const nx = e.x + (e.actDx / half) * dt;
          const ny = e.y + (e.actDy / half) * dt;
          if (this.nav.walkableXY(nx, ny)) {
            e.x = nx;
            e.y = ny;
          }
        }
        continue;
      }
      if (e.pi < e.path.length) this.advance(e, this.speed * dt);
    }
    this.time += TICK_MS;
  }

  private advance(e: Entity, dist: number): void {
    let left = dist;
    while (left > 0 && e.pi < e.path.length) {
      const tx = this.nav.cx(e.path[e.pi]);
      const ty = this.nav.cy(e.path[e.pi]);
      const dx = tx - e.x;
      const dy = ty - e.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.0001) {
        if (Math.abs(dx) > Math.abs(dy)) e.dir = dx < 0 ? 2 : 3;
        else e.dir = dy < 0 ? 1 : 0;
      }
      if (d <= left) {
        e.x = tx;
        e.y = ty;
        left -= d;
        e.walk += d;
        e.pi++;
      } else {
        e.x += (dx / d) * left;
        e.y += (dy / d) * left;
        e.walk += left;
        left = 0;
      }
      e.moving = true;
    }
    if (e.pi >= e.path.length) {
      e.path = [];
      e.pi = 0;
    }
  }

  private apply(ev: WorldEvent): void {
    this.log.push(ev);
    switch (ev.t) {
      case 'move': {
        const e = this.byEid.get(ev.eid);
        if (!e || !e.alive) break;
        e.path = ev.path.slice();
        e.pi = 0;
        if (e.act && e.act !== 'stun') e.act = null;
        break;
      }
      case 'stop': {
        const e = this.byEid.get(ev.eid);
        if (!e) break;
        e.path = [];
        e.pi = 0;
        break;
      }
      case 'face': {
        const e = this.byEid.get(ev.eid);
        if (e && e.alive && e.path.length === 0) e.dir = ev.dir;
        break;
      }
      case 'act': {
        const e = this.byEid.get(ev.eid);
        if (!e || !e.alive) break;
        e.path = [];
        e.pi = 0;
        e.act = ev.kind;
        e.actStart = ev.at;
        e.actEnd = ev.at + ev.dur;
        e.actDx = ev.dx ?? 0;
        e.actDy = ev.dy ?? 0;
        break;
      }
      case 'remove': {
        const e = this.byEid.get(ev.eid);
        if (!e) break;
        e.alive = false;
        e.removedAt = ev.at;
        e.removeCause = ev.cause;
        e.path = [];
        e.act = null;
        break;
      }
      case 'mark': {
        const e = this.byEid.get(ev.eid);
        if (e) e.markUntil = ev.until;
        break;
      }
      case 'star_spawn':
        this.stars.set(ev.id, { id: ev.id, x: ev.x, y: ev.y, spawnedAt: ev.at });
        break;
      case 'star_taken':
        this.stars.delete(ev.id);
        break;
      case 'zone':
        this.zone = { startAt: ev.startAt, endAt: ev.endAt, from: ev.from, to: ev.to };
        break;
      case 'crowd':
        this.crowd = { kind: ev.kind, warnAt: ev.at, showAt: ev.showAt, resumeAt: ev.resumeAt, windowEnd: ev.windowEnd, ...(ev.vote ? { vote: true } : {}), ...(ev.ghost ? { ghost: true } : {}), ...(ev.watchUntil !== undefined ? { watchUntil: ev.watchUntil } : {}) };
        break;
      case 'twist':
        this.twist = ev.on;
        break;
      case 'hit':
      case 'spot':
        break;
    }
    for (const l of this.listeners) l(ev);
  }

  /** Идёт стоп-кадр «Море волнуется»: никто не двигается. */
  isFrozen(t = this.time): boolean {
    const c = this.crowd;
    return !!c && t >= c.showAt && t < c.resumeAt;
  }

  zoneRect(t = this.time): Rect | null {
    const z = this.zone;
    if (!z || t < z.startAt) return null;
    return lerpRect(z.from, z.to, (t - z.startAt) / (z.endAt - z.startAt));
  }

  get(eid: number): Entity | undefined {
    return this.byEid.get(eid);
  }

  alive(): Entity[] {
    return this.entities.filter((e) => e.alive);
  }

  /** Куда сущность в итоге придёт по текущему пути. */
  destination(e: Entity): { x: number; y: number } {
    if (e.pi < e.path.length) {
      const last = e.path[e.path.length - 1];
      return { x: this.nav.cx(last), y: this.nav.cy(last) };
    }
    return { x: e.x, y: e.y };
  }

  snapshot(): WorldSnapshot {
    return {
      time: this.time,
      entities: this.entities.map((e) => ({ ...e, path: e.path.slice() })),
      stars: [...this.stars.values()].map((s) => ({ ...s })),
      zone: this.zone ? { ...this.zone } : null,
      crowd: this.crowd ? { ...this.crowd } : null,
      twist: this.twist,
      pending: this.pending.slice(),
    };
  }

  restore(s: WorldSnapshot): void {
    this.time = s.time;
    this.entities = s.entities.map((e) => ({ ...e, path: e.path.slice() }));
    this.byEid = new Map(this.entities.map((e) => [e.eid, e]));
    this.stars = new Map(s.stars.map((st) => [st.id, { ...st }]));
    this.zone = s.zone ? { ...s.zone } : null;
    this.crowd = s.crowd ? { ...s.crowd } : null;
    this.twist = !!s.twist;
    this.pending = s.pending.slice();
  }
}

/**
 * Повтор из журнала: восстанавливает мир на момент `from` и проигрывает события до `to`.
 * Возвращает объект, который можно шагать кадр за кадром.
 */
export function makeReplay(src: World, from: number, to: number): World | null {
  const kf = [...src.keyframes].reverse().find((k) => k.time <= from) ?? src.keyframes[0];
  if (!kf) return null;
  const w = new World(src.nav, src.speed);
  w.recordKeyframes = false;
  w.restore(kf);
  const pendingTimes = new Set(kf.pending);
  for (const ev of src.log) {
    if (ev.at >= kf.time && !pendingTimes.has(ev)) w.push(ev);
  }
  while (w.time < from && w.time < to) w.step();
  return w;
}
