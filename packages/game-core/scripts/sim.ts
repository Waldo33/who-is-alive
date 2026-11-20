/**
 * Безголовая симуляция: N раундов с ботами и ИИ-игроками, проверка инвариантов.
 * Запуск: pnpm sim -- --rounds 1000
 */
import { AiPlayer, MatchSim, makeConfig, rectContains } from '../src/index';

const argi = process.argv.indexOf('--rounds');
const target = argi > 0 ? Number(process.argv[argi + 1]) : 1000;

let rounds = 0;
let matches = 0;
let errors = 0;
const tally = { time: 0, stars: 0, last_alive: 0, kills: 0, botHits: 0, awards: new Map<string, number>() };
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
  const sim = new MatchSim(makeConfig(), players, 1000 + matches, 'a');
  players.forEach((p, i) => sim.addAgent(new AiPlayer(p.pid, matches * 10 + i)));
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
        check(p.attacksLeft >= 0 && p.attacksLeft <= sim.cfg.attacksPerRound, 'лимит ударов нарушен');
      }
      for (const a of s.awards) tally.awards.set(a.id, (tally.awards.get(a.id) ?? 0) + 1);
      const roundPts = Object.values(s.points).reduce((acc, l) => acc + l.total, 0);
      scoreSum += roundPts;
      check(Object.values(sim.scores).reduce((a, b) => a + b, 0) === scoreSum, 'сумма очков не сходится');
      check(s.awards.length <= 2, 'больше двух наград');
    }
    if (sim.phase === 'countdown' && lastRound !== sim.round) lastRound = sim.round;
  }
}

const sec = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`Раундов: ${rounds}, матчей: ${matches}, ${sec} с`);
console.log(`Конец раунда: по времени ${tally.time}, звёзды ${tally.stars}, последний живой ${tally.last_alive}`);
console.log(`Выбиваний на раунд: ${(tally.kills / rounds).toFixed(2)}, ударов по ботам: ${(tally.botHits / rounds).toFixed(2)}`);
console.log('Награды:', Object.fromEntries(tally.awards));
if (errors) {
  console.error(`Ошибок: ${errors}`);
  process.exit(1);
}
console.log('Инварианты соблюдены ✓');
