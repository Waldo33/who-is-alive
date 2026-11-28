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
  const [help, setHelp] = useState(false);

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

  const row = (x: PremiereTaskView, text?: string) => (
    <li key={x.id} className={x.done ? 'done' : ''}>
      <span className="pr-task">{text ?? tp(lang, t.tasks[x.id as keyof typeof t.tasks], x.goal)}</span>
      <span className="pr-prog">{x.done ? '' : x.goal > 1 ? `${x.progress}/${x.goal}` : ''}</span>
      <span className="pr-rew" style={x.reward ? undefined : { visibility: 'hidden' }}>
        +{x.reward}
        <i className="pr-ticket mini" aria-hidden />
      </span>
    </li>
  );
  const base = view.basePerDay ?? 3;
  const played = Math.min(view.matchesToday ?? 0, base);
  const nextStreak = view.streakRewards.find((r) => r.days > view.streak) ?? view.streakRewards[view.streakRewards.length - 1];

  return (
    <main className="daily premiere">
      <TopBar lang={lang} onBack={() => router.push('/')} />
      <h1 className="daily-title">{t.title}</h1>
      <p className="pr-prize">
        <b>{t.prize}</b>
        <span>{view.phase === 'before' ? t.before : t.prizeSub}</span>
      </p>
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
          <p className="pr-status pr-pill in">{t.entered}</p>
        ) : need > 0 ? (
          <p className="pr-status pr-pill">{tp(lang, t.needMore, need)}</p>
        ) : (
          view.channel && (
            <button className="btn small" onClick={subscribe}>
              {t.needSub}
            </button>
          )
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
        {/* памятка: пояснения не на экране, а по «?» — экран читается списком «сделай → получи» */}
        <button className="pr-q" aria-label={t.help} onClick={() => setHelp(true)}>
          ?
        </button>
      </div>
      <section className="pr-body">
        {tab === 'day' && (
          <ul className="pr-list">
            {row({ id: 'match', goal: base, reward: 1, progress: played, done: played >= base }, t.match)}
            {view.day.map((x) => row(x))}
            {signed &&
              row(
                { id: 'streak', goal: nextStreak.days, reward: nextStreak.n, progress: Math.min(view.streak, nextStreak.days), done: view.streak >= nextStreak.days },
                tp(lang, t.streakRow, view.streak),
              )}
          </ul>
        )}
        {tab === 'week' && <ul className="pr-list">{view.week.map((x) => row(x))}</ul>}
        {tab === 'friends' && (
          <>
            <ul className="pr-list">
              {row({ id: 'friend', goal: view.friendsMax, reward: FRIEND_REWARD, progress: view.friends, done: view.friends >= view.friendsMax }, t.friendRow)}
              {row({ id: 'share', goal: view.sharedMax, reward: 0, progress: view.shared, done: view.shared >= view.sharedMax }, t.shareRow)}
            </ul>
            {signed && view.phase !== 'after' && (
              <button className="btn small" onClick={invite}>
                {t.invite}
              </button>
            )}
          </>
        )}
        {view.double && tab === 'day' && <p className="pr-note hot">{t.double}</p>}
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
      </div>
      {help && (
        <div className="pr-sheet" role="dialog" aria-label={t.help} onClick={() => setHelp(false)}>
          <div className="pr-sheet-card" onClick={(e) => e.stopPropagation()}>
            <h2>{t.help}</h2>
            <ul>
              {t.helpText.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            <button className="btn small" onClick={() => setHelp(false)}>
              {t.close}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
