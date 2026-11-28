/**
 * Клип выбывшего на сервере: что монтировать — как телефон (apps/web/src/game/scene.ts › renderDeathClip).
 * Без нативных модулей: это считает комната (room.ts), монтирует процесс film-worker.ts.
 *
 * Тайна игроков (CLAUDE.md, правило 2): кого подсветить, решает сервер, а не клиент. Герой — всегда
 * сущность самого просящего; до разоблачения дубля в кадре подсвечен и подписан только он,
 * остальные живые — обычная толпа (как в клипе с телефона).
 */
import { hasSanity, makeConfig, nightCause, recordRound, skullClipFrom, skullSpin } from '@kto/game-core';
import type { ArenaDef, Moment, RoundSummary, SlotRecord, World } from '@kto/game-core';
import type { ClipJob } from './film-render';

export interface DeathClipView {
  world: World;
  round: number;
  theme: number;
  arena: ArenaDef;
  summary: RoundSummary | null;
  /** «Казино»: вращения игроков в этом дубле — кого вырезали черепа (в клип идёт только своё). */
  spins?: readonly SlotRecord[];
  info(pid: string): { name: string; color: number; skin?: string; fx?: string } | undefined;
}

/** Задача на клип выбывшего pid (его сущность eid) или null: не выбит игроком, рано или нечего показать. */
export function deathClipJob(
  v: DeathClipView,
  pid: string,
  eid: number,
  o: { lang: 'ru' | 'en'; noGore: boolean },
): Omit<ClipJob, 'site' | 'link'> | null {
  const w = v.world;
  const hit = w.log.find((e) => e.t === 'hit' && e.target === eid && e.result === 'player');
  const me = v.info(pid);
  if (!hit || hit.t !== 'hit' || !me) return null;
  const at = hit.at;
  // итоги этого дубля (разоблачение) — тогда известно, кто выбил, и всех живых можно назвать
  const s = v.summary && v.summary.round === v.round ? v.summary : null;
  const killer = s?.kills?.find((k) => k.victim === eid)?.by;
  const known = !!s && killer !== undefined;
  const start = w.keyframes[0]?.time ?? 0;
  const to = Math.min(w.time, at + 1500);
  // «Казино»: вырезали черепа — в кадре вся «Крутка» (свой автомат), а не «кто вырезал»
  const cfg = makeConfig();
  const mine = (s?.slots ?? v.spins ?? []).filter((r) => r.eid === eid);
  const skull = killer === undefined ? skullSpin(mine, eid, at, cfg) : undefined;
  // с известным нападавшим — его подход целиком (до 4,5 с), иначе — 6 с до развязки
  const from = Math.max(start, skull ? skullClipFrom(skull, cfg) : known ? at - 4500 : to - 6000);
  if (to - from < 1500) return null;
  const players = known
    ? s.reveal.flatMap((r) => {
        const i = v.info(r.pid);
        return i ? [{ eid: r.eid, name: i.name, color: i.color, ...(i.skin ? { skin: i.skin } : {}), ...(i.fx ? { fx: i.fx } : {}) }] : [];
      })
    : [{ eid, name: me.name, color: me.color, ...(me.skin ? { skin: me.skin } : {}), ...(me.fx ? { fx: me.fx } : {}) }];
  const rec = recordRound(w, { round: v.round, theme: v.theme, players: known ? s.reveal : [], playEnd: to, kills: s?.kills, slots: known ? s.slots : mine });
  // мир идёт дальше, пока задача ждёт в очереди: снимок того, что уже было
  rec.log = rec.log.slice();
  rec.keyframes = rec.keyframes.slice();
  // «Купальская ночь»: забрал Леший или туман — подпись про них (клип рисует ночь сам)
  const by = skull ? 'slot' : hasSanity(v.theme) && killer === undefined ? nightCause(cfg, w.log, eid, at, s?.kills) : undefined;
  const moment: Moment = { from, to, score: 0, kind: 'knockout', at, victim: eid, attacker: killer, selfRole: 'victim', ...(by ? { by } : {}) };
  return { rec, moment, arena: v.arena, players, hero: eid, known, noGore: o.noGore, lang: o.lang };
}
