import type { CrowdKind, Dict, GameConfig, Intent, LocalSession, MatchSim } from '@kto/game-core';

/**
 * «Пробный дубль» — обучение на практике, по шагам. Каждый важный момент игры — свой шаг:
 * мир встаёт на паузу, вокруг того, о чём речь, — рамка (остальное притушено), сверху две
 * короткие строки, внизу «Тапни — дальше». Шаги-действия ждут, пока игрок сам сделает
 * (походит, повторит жест, ударит, возьмёт звезду, угадает жест толпы, обвинит).
 *
 * Сценарий идёт поверх обычной симуляции (песочница без ИИ): игрок + «актёр», который стоит
 * и не повторяет жесты — его ловит прожектор, его и надо найти. Команды и звёзды ставит сценарий.
 */

/** Числа для пробного дубля: сами команды и звёзды не появляются — их вызывает сценарий. */
export const TUTORIAL_CFG: Partial<GameConfig> = {
  roundSec: 900,
  countdownSec: 1,
  crowdCmdIntervalSec: [999, 999],
  crowdCmdIntervalEndSec: [999, 999],
  maxStars: 0,
  botStarTakeChance: 0,
  botQuirkPerMin: 0,
  roundMods: false,
  crowdVoteChance: 0,
  ghostClaps: 0,
  fixedTheme: 0,
  attacksPerRound: 3,
  endWhenLastAlive: false,
  spotSec: 12,
};

/** Что выделить рамкой: свой персонаж, кнопки жестов, удары и звёзды в шапке, точка поля. */
export type TutFocus = 'me' | 'buttons' | 'fists' | 'stars' | { x: number; y: number; r: number } | null;

type Lines = readonly string[];

interface Beat {
  /** Подсказка шага (две строки). */
  say: Lines;
  focus?: TutFocus | (() => TutFocus);
  /** Пауза: мир стоит, ждём тап. */
  tap?: boolean;
  /** Подготовка при входе в шаг. */
  enter?: () => void;
  /** Действие выполнено: true — к следующему шагу, строка — к шагу с этой меткой. */
  done?: () => boolean | string;
  /** Пока условие истинно — мир на паузе (стоп-кадр, пока игрок не выбрал жест). */
  hold?: () => boolean;
  id?: string;
}

export class Tutorial {
  /** Две строки подсказки сверху поля. */
  lines: Lines = ['', ''];
  focus: TutFocus = null;
  /** Куда показать стрелкой (координаты поля). */
  arrow: { x: number; y: number } | null = null;
  /** Мир на паузе (сцена не шагает симуляцию). */
  paused = false;
  /** Ждём тап «дальше» (сцена перехватывает касание поля). */
  waitTap = false;
  done = false;

  private beats: Beat[];
  private i = -1;
  private at = 0;
  private start: { x: number; y: number } | null = null;
  private plannedAt = 0;
  private lastCrowd: { warnAt: number; kind: CrowdKind } | null = null;
  private accused = false;
  private botHits = 0;
  /** На обвинении: человечек, на которого показываем «тапни сюда». */
  private suspect = -1;
  private note: { lines: Lines; until: number } | null = null;

  constructor(
    private s: LocalSession,
    private t: Dict['tutorial'],
    private onDone: () => void,
  ) {
    this.beats = this.script();
  }

  private get sim(): MatchSim {
    return this.s.sim;
  }

  private me() {
    return this.sim.playerRound(this.s.selfPid)!;
  }

  private meE() {
    return this.sim.world.get(this.me().eid)!;
  }

  private actor() {
    return this.sim.pr.find((p) => p.pid !== this.s.selfPid)!;
  }

  /** Сцена сообщает о каждом намерении игрока (до симуляции). */
  noteIntent(it: Intent): void {
    const c = this.sim.world.crowd;
    if (it.k === 'crowd' && c) this.lastCrowd = { warnAt: c.warnAt, kind: it.kind };
    if (it.k === 'accuse') this.accused = true;
  }

  /** Тап по полю, пока ждём «дальше». */
  tap(): void {
    // пока видна реплика-итог прошлого шага («Как все!»), листать рано — сначала прочитать
    if (this.waitTap && !this.note && performance.now() - this.at > 350) this.next();
  }

  private next(to?: string): void {
    if (to) this.i = this.beats.findIndex((b) => b.id === to);
    else this.i++;
    this.at = performance.now();
    this.arrow = null;
    const b = this.beats[this.i];
    if (!b) {
      this.lines = [this.t.doneTitle, ''];
      this.focus = null;
      this.paused = true;
      this.waitTap = false;
      this.done = true;
      setTimeout(() => this.onDone(), 1600);
      return;
    }
    b.enter?.();
    this.waitTap = !!b.tap;
    this.update();
  }

  private say(lines: Lines, ms = 2200): void {
    this.note = { lines, until: performance.now() + ms };
  }

  update(): void {
    if (this.done) return;
    // начинаем после отсчёта, когда дубль пошёл
    if (this.i < 0) {
      if (this.sim.phase === 'play') this.next();
      return;
    }
    const b = this.beats[this.i];
    if (!b) return;
    const me = this.me();
    // удары не кончаются — это учёба
    if (me.attacksLeft < 1) me.attacksLeft = 3;
    this.focus = typeof b.focus === 'function' ? b.focus() : (b.focus ?? null);
    const now = performance.now();
    if (this.note && now >= this.note.until) this.note = null;
    this.lines = this.note ? this.note.lines : b.say;
    this.paused = !!b.tap || !!b.hold?.();
    if (b.tap) return;
    const r = b.done?.();
    if (r) this.next(typeof r === 'string' ? r : undefined);
  }

  private plan(kind: CrowdKind, inMs: number, vote = false): void {
    this.plannedAt = this.sim.world.time + inMs;
    this.lastCrowd = null;
    this.sim.planCrowd(kind, inMs, vote);
  }

  /** Команда сценария уже показана (стоп-кадр или после). */
  private myCrowd() {
    const c = this.sim.world.crowd;
    return c && c.warnAt >= this.plannedAt ? c : null;
  }

  private actorAt(r: number): TutFocus {
    const a = this.sim.world.get(this.actor().eid);
    return a && a.alive ? { x: a.x, y: a.y - 6, r } : null;
  }

  private script(): Beat[] {
    const t = this.t;
    return [
      // 1. кто ты и кто вокруг
      { say: t.me, focus: 'me', tap: true },
      { say: t.crowd, tap: true },
      { say: t.bots, tap: true },
      // 2. ходьба
      {
        say: t.move,
        focus: 'me',
        enter: () => (this.start = { x: this.meE().x, y: this.meE().y }),
        done: () => Math.hypot(this.meE().x - this.start!.x, this.meE().y - this.start!.y) > 12,
      },
      // 3. «Море волнуется»: стоп-кадр держится, пока игрок не выберет жест
      {
        id: 'crowd',
        say: t.crowdSoon,
        enter: () => {
          this.placeActor();
          this.plan('jump', 2200);
        },
        done: () => !!this.myCrowd(),
      },
      {
        say: t.crowdNow,
        focus: () => (this.lastCrowd ? null : 'buttons'),
        hold: () => !this.lastCrowd && this.sim.world.isFrozen(),
        done: () => {
          const c = this.myCrowd();
          if (!c || this.sim.world.time <= c.windowEnd + 700) return false;
          const me = this.me();
          if (me.crowdAnswered === c.warnAt && me.crowdPick === c.kind && !me.crowdLate) {
            this.say(t.crowdOk, 1600);
            return true;
          }
          this.say(t.crowdMiss, 2600);
          return 'crowd';
        },
      },
      // 4. прожектор: «актёр» не повторил — его высветило
      { say: t.spot, tap: true, focus: () => this.actorAt(26) },
      { say: t.actor, tap: true, focus: () => this.actorAt(14) },
      // 5. удар
      {
        say: t.hunt,
        enter: () => (this.botHits = this.me().botHits),
        focus: () => {
          // долго не находит — рамка и стрелка над ним
          if (performance.now() - this.at < 9000) return null;
          const a = this.sim.world.get(this.actor().eid);
          if (a) this.arrow = { x: a.x, y: a.y };
          return this.actorAt(14);
        },
        done: () => {
          const me = this.me();
          if (me.botHits > this.botHits) {
            this.botHits = me.botHits;
            this.say(t.huntBot, 2600);
          }
          if (this.actor().alive) return false;
          this.say(t.cut, 1800);
          return true;
        },
      },
      { say: t.fists, focus: 'fists', tap: true },
      // 6. звёзды
      {
        say: t.star,
        tap: true,
        enter: () => {
          const e = this.meE();
          const a = Math.atan2(130 - e.y, 90 - e.x);
          this.sim.spawnStarAt(e.x + Math.cos(a) * 28, e.y + Math.sin(a) * 28);
        },
        focus: () => {
          const st = [...this.sim.world.stars.values()][0];
          return st ? { x: st.x, y: st.y - 2, r: 12 } : null;
        },
      },
      {
        say: t.star,
        focus: () => {
          const st = [...this.sim.world.stars.values()][0];
          this.arrow = st ? { x: st.x, y: st.y } : null;
          return null;
        },
        done: () => this.me().stars >= 1,
      },
      { say: t.starHud, focus: 'stars', tap: true },
      // 7. «Толпа решает»: разогрев толпы → стоп-кадр без названия жеста
      {
        say: t.voteSoon,
        enter: () => this.plan('dance', 4200, true),
        done: () => !!this.myCrowd(),
      },
      {
        say: t.voteNow,
        focus: () => (this.lastCrowd ? null : 'buttons'),
        hold: () => !this.lastCrowd && this.sim.world.isFrozen(),
        done: () => {
          const c = this.myCrowd();
          if (!c || this.sim.world.time <= c.resumeAt + 700) return false;
          const me = this.me();
          this.say(me.crowdAnswered === c.warnAt && me.crowdPick === c.kind ? t.voteOk : t.voteMiss, 2400);
          return true;
        },
      },
      // 8. вырезанный не скучает
      { say: t.ghost, tap: true },
      // 9. конец дубля: обвинение (таймер обвинения стоит, пока игрок не выбрал)
      {
        say: t.accuse,
        // рамка и стрелка с «кругами от касания» над человечком рядом — понятно, куда тапать
        focus: () => this.suspectAt(),
        enter: () => {
          this.accused = false;
          this.suspect = -1;
          // конец дубля без сужения кадра: сразу обвинение
          this.sim.zoneStarted = true;
          this.sim.plannedPlayEnd = this.sim.world.time;
        },
        hold: () => this.sim.phase === 'accuse' && !this.accused,
        done: () => this.accused,
      },
      { say: t.accuseOk, tap: true },
    ];
  }

  /** Подсказка обвинения: ближайший к игроку человечек (не под надписями сверху и не у края). */
  private suspectAt(): TutFocus {
    const w = this.sim.world;
    if (this.sim.phase !== 'accuse' || this.accused) {
      this.arrow = null;
      return null;
    }
    let e = w.get(this.suspect);
    if (!e || !e.alive) {
      const me = this.meE();
      const ok = w.alive().filter((o) => o.eid !== me.eid && o.y > 90 && o.y < 240 && o.x > 24 && o.x < 156);
      ok.sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
      e = ok[0];
      if (!e) return null;
      this.suspect = e.eid;
    }
    this.arrow = { x: e.x, y: e.y };
    return { x: e.x, y: e.y - 6, r: 12 };
  }

  /** «Актёр» встаёт неподалёку от игрока (но не вплотную) и дальше стоит: его поймает прожектор. */
  private placeActor(): void {
    const sim = this.sim;
    const me = this.meE();
    const actor = sim.world.get(this.actor().eid)!;
    const nav = sim.nav;
    for (let r = 40; r < 90; r += 6) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const i = nav.cellAt(me.x + Math.cos(a) * r, me.y + Math.sin(a) * r);
        const x = nav.cx(i);
        // не под подсказкой сверху поля и не у края: круг прожектора должно быть видно
        if (!nav.walkable(i) || nav.cy(i) < 64 || x < 34 || x > 146) continue;
        actor.x = x;
        actor.y = nav.cy(i);
        actor.px = actor.x;
        actor.py = actor.y;
        actor.path = [];
        actor.pi = 0;
        return;
      }
    }
  }
}

const DONE_KEY = 'kto:tutorial';

export function tutorialDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === '1';
  } catch {
    return false;
  }
}

export function markTutorialDone(): void {
  try {
    localStorage.setItem(DONE_KEY, '1');
  } catch {
    /* приватный режим */
  }
}
