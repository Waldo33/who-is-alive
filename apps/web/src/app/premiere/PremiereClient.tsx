'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  DICTS,
  FRIEND_MATCHES,
  FRIEND_MAX,
  FRIEND_REWARD,
  MILESTONES,
  PREMIERE,
  PREMIERE_ENTRY,
  SHARE_MAX,
  STREAK_REWARDS,
  dayTasks,
  fmt,
  premiereDay,
  premierePhase,
  premiereWeek,
  tp,
  weekTasks,
} from '@kto/game-core';
import type { Lang } from '@kto/game-core';
import { track } from '@/lib/analytics';
import { featureOn } from '@/lib/features';
import { detectLang } from '@/lib/lang';
import { haptic, openTelegram, premiereCached, premiereState, shopSignedIn, tgLink } from '@/lib/telegram';
import type { PremiereTaskView, PremiereView } from '@/lib/telegram';
import { TopBar } from '@/ui/TopBarView';

type Tab = 'day' | 'week' | 'friends';

/** План без входа в Telegram: задания те же у всех (game-core), счёт — ноль. */
function localView(now: number): PremiereView {
  const phase = premierePhase(now);
  const day = phase === 'before' ? PREMIERE.start : premiereDay(now);
  const double = day >= PREMIERE.double;
  const task = (t: { id: string; goal: number; reward: number; scope: 'day' | 'week' }): PremiereTaskView => ({
    id: t.id,
    goal: t.goal,
    reward: t.scope === 'day' && double ? t.reward * 2 : t.reward,
    progress: 0,
    done: false,
  });
  return {
    phase,
    tickets: 0,
    entry: PREMIERE_ENTRY,
    subscribed: false,
    entered: false,
    double,
    day: phase === 'after' ? [] : dayTasks(day).map(task),
    week: phase === 'after' ? [] : weekTasks(Math.max(0, premiereWeek(now))).map(task),
    streak: 0,
    playedToday: false,
    streakRewards: [...STREAK_REWARDS],
    friends: 0,
    friendsMax: FRIEND_MAX,
    friendMatches: FRIEND_MATCHES,
    shared: 0,
    sharedMax: SHARE_MAX,
    milestones: MILESTONES.map((m) => ({ ...m, open: false })),
    me: 0,
    channel: '',
  };
}

/**
 * «Съёмочный план» (/premiere) — «Новогодняя премьера» 17–30.12: контрамарки, задания дня и недели, серия, друзья.
 * Считает всё игровой сервер (apps/server/src/premiere.ts); здесь только показ. Без входа в Telegram — тот же план
 * с нулевым счётом и кнопкой «Открыть в Telegram».
 */
export default function PremiereClient() {
  const router = useRouter();
  const [lang, setLang] = useState<Lang>('ru');
  const t = DICTS[lang].premiere;
  const [v, setV] = useState<PremiereView | null>(null);
  const [signed, setSigned] = useState(true);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<Tab>('day');

  const load = async () => {
    setFailed(false);
    const s = await premiereState();
    if (s) setV(s);
    else setFailed(true);
  };

  useEffect(() => {
    const l = detectLang();
    setLang(l);
    document.documentElement.lang = l;
    document.title = `${DICTS[l].premiere.title} · ${DICTS[l].meta.title}`;
    featureOn('premiere'); // ?ff=premiere из ссылки startapp=premiere — запомнить
    const on = shopSignedIn();
    setSigned(on);
    track('premiere_view', { signed: on });
    if (!on) return setV(localView(Date.now()));
    const c = premiereCached();
    if (c) setV(c);
    void load();
  }, []);

  const subscribe = () => {
    if (!v?.channel) return;
    track('premiere_sub', {});
    openTelegram(v.channel);
    // вернётся из канала — спросить снова
    const again = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', again);
      void load();
    };
    document.addEventListener('visibilitychange', again);
  };

  const invite = () => {
    haptic('light');
    track('premiere_invite', {});
    // друг засчитывается, только если играет вместе: сразу комната, приглашение в ней несёт ссылку друга
    router.push('/?create=1&src=premiere');
  };

  const openTg = () => {
    const link = tgLink('premiere');
    if (link) location.href = link;
  };

  const view = v ?? localView(Date.now());
  const ready = !!v;
  const need = Math.max(0, view.entry - view.tickets);
  const top = MILESTONES[MILESTONES.length - 1].at;

  const row = (x: PremiereTaskView) => (
    <li key={x.id} className={x.done ? 'done' : ''}>
      <span className="pr-task">{x.id === 'friend' ? t.friendRow : x.id === 'share' ? t.shareRow : tp(lang, t.tasks[x.id as keyof typeof t.tasks], x.goal)}</span>
      <span className="pr-prog">{x.done ? t.done : x.goal > 1 ? `${x.progress}/${x.goal}` : ''}</span>
      <span className="pr-rew" style={x.reward ? undefined : { visibility: 'hidden' }}>
        +{x.reward}
        <i className="pr-ticket mini" aria-hidden />
      </span>
    </li>
  );

  return (
    <main className="daily premiere">
      <TopBar lang={lang} onBack={() => router.push('/')} />
      <h1 className="daily-title">{t.title}</h1>
      <p className="pr-prize">{view.phase === 'before' ? t.before : t.prize}</p>
      <section className="pr-head" style={{ visibility: ready ? 'visible' : 'hidden' }}>
        <div className="pr-count">
          <i className="pr-ticket" aria-hidden />
          <b>{view.tickets}</b>
          <span>{tp(lang, t.tickets, view.tickets)}</span>
        </div>
        {view.phase === 'after' ? (
          <p className="pr-status">{t.after}</p>
        ) : !signed ? (
          <p className="pr-status">{t.noTg}</p>
        ) : view.entered ? (
          <p className="pr-status in">{t.entered}</p>
        ) : need > 0 ? (
          <p className="pr-status">{tp(lang, t.needMore, need)}</p>
        ) : (
          <div className="pr-status pr-need">
            <span>{t.needSub}</span>
            {view.channel && (
              <button className="btn small" onClick={subscribe}>
                {t.subscribe}
              </button>
            )}
          </div>
        )}
        <div className="pr-road" aria-label={t.road}>
          <div className="pr-bar">
            <i style={{ width: `${Math.min(100, (view.tickets / top) * 100)}%` }} />
          </div>
          <ol>
            {view.milestones.map((m) => (
              <li key={m.at} className={m.open ? 'open' : ''} style={{ left: `${(m.at / top) * 100}%` }}>
                <b>{m.at}</b>
                <span>{t.milestones[m.id]}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>
      <div className="pr-tabs" role="tablist">
        {(['day', 'week', 'friends'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {t.tabs[k]}
          </button>
        ))}
      </div>
      <section className="pr-body">
        {tab === 'day' && (
          <>
            <p className="pr-note">{t.base}</p>
            <ul className="pr-list">{view.day.map(row)}</ul>
            {view.double && <p className="pr-note hot">{t.double}</p>}
            <p className="pr-note">
              {signed && <b>{tp(lang, t.streak, view.streak)}</b>}
              {signed && view.phase === 'on' && ` · ${view.playedToday ? t.playedToday : t.notToday}`}
              {signed && <br />}
              {t.streakHint}
            </p>
          </>
        )}
        {tab === 'week' && (
          <>
            <ul className="pr-list">{view.week.map(row)}</ul>
            <p className="pr-note">{t.weekHint}</p>
          </>
        )}
        {tab === 'friends' && (
          <>
            <ul className="pr-list">
              {row({ id: 'friend', goal: view.friendsMax, reward: FRIEND_REWARD, progress: view.friends, done: view.friends >= view.friendsMax })}
              {row({ id: 'share', goal: view.sharedMax, reward: 0, progress: view.shared, done: view.shared >= view.sharedMax })}
            </ul>
            <p className="pr-note">{fmt(t.friendHow, { m: view.friendMatches, r: FRIEND_REWARD })}</p>
            <p className="pr-note">{t.shareHow}</p>
            {signed && view.phase !== 'after' && (
              <button className="btn small" onClick={invite}>
                {t.invite}
              </button>
            )}
          </>
        )}
      </section>
      <div className="daily-actions">
        {!signed && tgLink('premiere') && (
          <button className="btn small tg" onClick={openTg}>
            {t.openTg}
          </button>
        )}
        {signed && failed && !v && (
          <button className="btn small" onClick={() => void load()}>
            {t.retry}
          </button>
        )}
        {signed && !v && <p className="muted">{failed ? t.fail : t.loading}</p>}
        <p className="pr-rules">{t.rules}</p>
      </div>
    </main>
  );
}
