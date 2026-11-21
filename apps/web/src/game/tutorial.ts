import type { CrowdKind, Dict, GameConfig, LocalSession, MatchSim } from '@kto/game-core';

/**
 * «Пробный дубль» — обучение действием, а не текстом: каждый шаг — одна механика, короткая
 * подсказка из двух строк сверху поля и ожидание, пока игрок сам это сделает.
 *
 * Сценарий идёт поверх обычной симуляции (песочница без ИИ): игрок + «актёр» b, который стоит
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
  spotSec: 30,
};

type Step = 'move' | 'blend' | 'crowd' | 'spot' | 'hunt' | 'cut' | 'star' | 'starRisk' | 'vote' | 'voteResult' | 'ghost' | 'accuse' | 'done';

export class Tutorial {
  step: Step = 'move';
  /** Две строки подсказки сверху поля. */
  lines: [string, string] = ['', ''];
  /** Куда показать стрелкой (координаты поля), если нужно. */
  arrow: { x: number; y: number } | null = null;
  done = false;
  private at = 0;
  private start: { x: number; y: number } | null = null;
  private plannedAt = 0;
  private kind: CrowdKind = 'jump';
  private botHits = 0;
  private note: { lines: [string, string]; until: number } | null = null;

  constructor(
    private s: LocalSession,
    private t: Dict['tutorial'],
    private onDone: () => void,
  ) {}

  private get sim(): MatchSim {
    return this.s.sim;
  }

  private go(step: Step, now: number): void {
    this.step = step;
    this.at = now;
    this.arrow = null;
  }

  /** Короткая реплика поверх текущего шага (ошибка, похвала). */
  private say(lines: [string, string], now: number, ms = 2600): void {
    this.note = { lines, until: now + ms };
  }

  private actorEid(): number {
    return this.sim.pr.find((p) => p.pid !== this.s.selfPid)!.eid;
  }

  update(): void {
    const sim = this.sim;
    if (this.done || sim.phase !== 'play') return;
    const now = sim.world.time;
    const me = sim.playerRound(this.s.selfPid)!;
    const e = sim.world.get(me.eid)!;
    const t = this.t;
    let lines: [string, string] = ['', ''];
    // удары не кончаются, оглушение короткое — это учёба
    if (me.attacksLeft < 1) me.attacksLeft = 3;

    switch (this.step) {
      case 'move':
        lines = t.move as [string, string];
        if (!this.start) this.start = { x: e.x, y: e.y };
        if (Math.hypot(e.x - this.start.x, e.y - this.start.y) > 10) this.go('blend', now);
        break;
      case 'blend':
        lines = t.blend as [string, string];
        if (now - this.at > 2500) {
          this.placeActor();
          this.plan('jump', 2500);
          this.go('crowd', now);
        }
        break;
      case 'crowd': {
        const c = sim.world.crowd;
        const mine = c && c.warnAt >= this.plannedAt;
        lines = (mine && sim.world.isFrozen() ? t.crowdNow : t.crowdWait) as [string, string];
        if (mine && c && now > c.windowEnd + 700) {
          const ok = me.crowdAnswered === c.warnAt && me.crowdPick === c.kind && !me.crowdLate;
          if (ok) {
            this.say(t.crowdOk as [string, string], now, 2000);
            this.go('spot', now);
          } else {
            this.say(t.crowdMiss as [string, string], now);
            this.plan(c.kind === 'jump' ? 'dance' : 'jump', 4500);
          }
        }
        break;
      }
      case 'spot':
        lines = t.spot as [string, string];
        if (now - this.at > 3500) this.go('hunt', now);
        break;
      case 'hunt': {
        lines = t.hunt as [string, string];
        const actor = sim.playerByEid(this.actorEid())!;
        if (me.botHits > this.botHits) {
          this.botHits = me.botHits;
          this.say(t.huntBot as [string, string], now);
        }
        // долго не находит — подсказка стрелкой
        if (now - this.at > 12000) {
          const a = sim.world.get(actor.eid);
          if (a) this.arrow = { x: a.x, y: a.y };
        }
        if (!actor.alive) {
          this.say(t.cut as [string, string], now, 3000);
          this.go('cut', now);
        }
        break;
      }
      case 'cut':
        if (now - this.at > 3000) {
          const a = Math.atan2(130 - e.y, 90 - e.x);
          sim.spawnStarAt(e.x + Math.cos(a) * 28, e.y + Math.sin(a) * 28);
          this.go('star', now);
        }
        break;
      case 'star': {
        lines = t.star as [string, string];
        const st = [...sim.world.stars.values()][0];
        this.arrow = st ? { x: st.x, y: st.y } : null;
        if (me.stars >= 1) this.go('starRisk', now);
        break;
      }
      case 'starRisk':
        lines = t.starRisk as [string, string];
        if (now - this.at > 3500) {
          this.kind = 'dance';
          this.plan('dance', 4200, true);
          this.go('vote', now);
        }
        break;
      case 'vote': {
        const c = sim.world.crowd;
        const mine = c && c.warnAt >= this.plannedAt && c.vote;
        lines = (mine && sim.world.isFrozen() ? t.voteNow : t.voteWait) as [string, string];
        if (mine && c && now > c.resumeAt + 600) {
          const ok = me.crowdAnswered === c.warnAt && me.crowdPick === c.kind;
          this.say((ok ? t.voteOk : t.voteMiss) as [string, string], now, 3000);
          this.go('voteResult', now);
        }
        break;
      }
      case 'voteResult':
        if (now - this.at > 3000) this.go('ghost', now);
        break;
      case 'ghost':
        lines = t.ghost as [string, string];
        if (now - this.at > 3500) this.go('accuse', now);
        break;
      case 'accuse':
        lines = t.accuse as [string, string];
        if (now - this.at > 3500) {
          this.go('done', now);
          this.done = true;
          this.onDone();
        }
        break;
      case 'done':
        break;
    }
    if (this.note && now < this.note.until) lines = this.note.lines;
    else this.note = null;
    this.lines = lines;
  }

  private plan(kind: CrowdKind, inMs: number, vote = false): void {
    this.plannedAt = this.sim.world.time + inMs;
    this.sim.planCrowd(kind, inMs, vote);
  }

  /** «Актёр» встаёт неподалёку от игрока (но не вплотную) и дальше стоит: его поймает прожектор. */
  private placeActor(): void {
    const sim = this.sim;
    const me = sim.world.get(sim.playerRound(this.s.selfPid)!.eid)!;
    const actor = sim.world.get(this.actorEid())!;
    const nav = sim.nav;
    for (let r = 40; r < 90; r += 6) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const i = nav.cellAt(me.x + Math.cos(a) * r, me.y + Math.sin(a) * r);
        // не под подсказкой сверху поля: круг прожектора должно быть видно
        if (!nav.walkable(i) || nav.cy(i) < 64) continue;
        actor.x = nav.cx(i);
        actor.y = nav.cy(i);
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
