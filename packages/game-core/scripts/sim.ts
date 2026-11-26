/**
 * Безголовая симуляция: N раундов с ботами и ИИ-игроками, проверка инвариантов.
 * Запуск: pnpm sim -- --rounds 1000
 */
import { AiPlayer, MatchSim, ROUND_MODS, fightAttacks, hasSanity, makeConfig, rectContains } from '../src/index';
import type { WorldEvent } from '../src/index';

const argi = process.argv.indexOf('--rounds');
const target = argi > 0 ? Number(process.argv[argi + 1]) : 1000;
// --cfg '{"maxStars":3}' — попробовать другие числа баланса
const cfgi = process.argv.indexOf('--cfg');
const overrides = cfgi > 0 ? JSON.parse(process.argv[cfgi + 1]) : {};

let rounds = 0;
let matches = 0;
let errors = 0;
const tally = { time: 0, stars: 0, last_alive: 0, kills: 0, botHits: 0, stolen: 0, awards: new Map<string, number>() };
const madness = { players: 0, lost: 0, minSum: 0, endSum: 0, alive: 0 };
// новые механики: команды (всего / «Толпа решает» / от вырезанных), звёзды (игроки / статисты), вырезанные «Жёстким дублем»
const mech = { crowd: 0, vote: 0, clap: 0, starP: 0, starB: 0, hardCut: 0, mods: new Map<string, number>(), deadMs: 0 };
const t0 = Date.now();

function check(cond: boolean, msg: string): void {
  if (!cond) {
    errors++;
    if (errors < 20) console.error('✗', msg);
  }
}

while (rounds < target) {
  matches++;
  const players = ['a', 'b', 'c', 'd'].map((pid, i) => ({ pid, name: pid, color: i }));
  const sim = new MatchSim(makeConfig(overrides), players, 1000 + matches, 'a');
  players.forEach((p, i) => sim.addAgent(new AiPlayer(p.pid, matches * 10 + i)));
  let roundEids = new Set<number>();
  let lastCrowd = -1;
  let pendingClap = false;
  const origIntent = sim.intent.bind(sim);
  sim.intent = (pid, it) => {
    if (it.k === 'clap') pendingClap = true;
    origIntent(pid, it);
  };
  sim.world.listeners.push((ev: WorldEvent) => {
    if (ev.t === 'crowd' && ev.at !== lastCrowd) {
      lastCrowd = ev.at;
      mech.crowd++;
      if (ev.vote) mech.vote++;
      if (pendingClap) mech.clap++;
      pendingClap = false;
    } else if (ev.t === 'star_taken') {
      if (roundEids.has(ev.eid)) mech.starP++;
      else mech.starB++;
    } else if (ev.t === 'hit' && ev.result === 'player' && !sim.pr.some((p) => p.kills && p.killTimes.includes(ev.at))) mech.hardCut++;
  });
  let lastRound = sim.round;
  let guard = 0;
  let scoreSum = 0;
  while (sim.phase !== 'match_end' && rounds < target) {
    sim.tick();
    if (++guard > 20 * 60 * 30) {
      check(false, `match ${matches}: не закончился за 30 минут`);
      break;
    }
    if (sim.phase === 'play' && guard % 10 === 0) {
      for (const e of sim.world.entities) {
        if (!e.alive) continue;
        check(rectContains({ x: 0, y: 0, w: 180, h: 260 }, e.x, e.y), `сущность ${e.eid} вне арены (${e.x}, ${e.y})`);
      }
    }
    if (sim.phase === 'reveal' && sim.summary && sim.summary.round === sim.round && lastRound === sim.round) {
      lastRound = -1;
      rounds++;
      const s = sim.summary;
      tally[s.endReason]++;
      for (const p of sim.pr) {
        tally.kills += p.kills;
        tally.botHits += p.botHits;
        // «Казино»: «три кулака» на «Крутке» — +1 удар, не больше одного за «Крутку»
        const spins = sim.world.log.filter((ev) => ev.t === 'crowd' && ev.slot).length;
        check(p.attacksLeft >= 0 && p.attacksLeft <= (fightAttacks(sim.theme) || sim.cfg.attacksPerRound) + spins, 'лимит ударов нарушен');
      }
      if (hasSanity(sim.theme)) {
        for (const p of sim.pr) {
          madness.players++;
          if (!p.alive && p.sanity <= 0) madness.lost++;
          madness.minSum += p.sanityMin;
          if (p.alive) madness.endSum += p.sanity;
          if (p.alive) madness.alive++;
        }
      }
      for (const a of s.awards) tally.awards.set(a.id, (tally.awards.get(a.id) ?? 0) + 1);
      const roundPts = Object.values(s.points).reduce((acc, l) => acc + l.total, 0);
      scoreSum += roundPts;
      check(Object.values(sim.scores).reduce((a, b) => a + b, 0) === scoreSum, 'сумма очков не сходится');
      check(s.awards.length <= 2, 'больше двух наград');
      // «Кража»: метка не на себя; украдено не больше, чем угадавших; счёт не ниже нуля
      for (const a of s.accusations) {
        const self = s.reveal.find((r) => r.pid === a.pid)!;
        check(self.eid !== a.eid, 'обвинил сам себя');
        if (a.correct) tally.stolen++;
      }
      for (const r of s.reveal) {
        // за голову лидера крадут по bounty: и угадавшие, и выбившие
        const by = s.accusations.filter((a) => a.correct && a.eid === r.eid).length;
        const head = r.pid === sim.bountyPid ? sim.cfg.points.bounty : sim.cfg.points.accuse;
        const hunted = r.pid === sim.bountyPid ? (s.kills ?? []).filter((k) => k.victim === r.eid).length * sim.cfg.points.bounty : 0;
        check(-(s.points[r.pid].stolen ?? 0) <= by * head + hunted, 'украли больше, чем угадавших');
        check(sim.scores[r.pid] >= 0, 'счёт ниже нуля');
      }
    }
    if (sim.phase === 'countdown' && lastRound !== sim.round) {
      lastRound = sim.round;
      roundEids = new Set(sim.pr.map((p) => p.eid));
      mech.mods.set(ROUND_MODS[sim.mod], (mech.mods.get(ROUND_MODS[sim.mod]) ?? 0) + 1);
    }
    if (sim.phase === 'play') for (const p of sim.pr) if (!p.alive) mech.deadMs += 50;
  }
}

const sec = ((Date.now() - t0) / 1000).toFixed(1);
if (madness.players) {
  console.log(
    `Рассудок: сгинули в тумане ${((madness.lost / madness.players) * 100).toFixed(1)}% игроков, ` +
      `минимум в среднем ${(madness.minSum / madness.players).toFixed(0)}, у доживших к концу ${(madness.endSum / Math.max(1, madness.alive)).toFixed(0)}`,
  );
}
console.log(`Раундов: ${rounds}, матчей: ${matches}, ${sec} с`);
console.log(`Конец раунда: по времени ${tally.time}, звёзды ${tally.stars}, последний живой ${tally.last_alive}`);
console.log(`Выбиваний на раунд: ${(tally.kills / rounds).toFixed(2)}, ударов по ботам: ${(tally.botHits / rounds).toFixed(2)}`);
console.log('Награды:', Object.fromEntries(tally.awards));
console.log(`Команд на раунд: ${(mech.crowd / rounds).toFixed(2)} (из них «Толпа решает» ${(mech.vote / rounds).toFixed(2)}, «Хлопушка» ${(mech.clap / rounds).toFixed(2)})`);
console.log(`Звёзд взяли на раунд: игроки ${(mech.starP / rounds).toFixed(2)}, статисты ${(mech.starB / rounds).toFixed(2)}; вырезано «Жёстким дублем» ${mech.hardCut}`);
console.log(`Вырезанный игрок за кадром в среднем ${(mech.deadMs / rounds / 4 / 1000).toFixed(1)} с за раунд`);
console.log('Условия съёмки:', Object.fromEntries(mech.mods));
if (errors) {
  console.error(`Ошибок: ${errors}`);
  process.exit(1);
}
console.log(`Угаданных обвинений (краж) на раунд: ${(tally.stolen / rounds).toFixed(2)}`);
console.log('Инварианты соблюдены ✓');
