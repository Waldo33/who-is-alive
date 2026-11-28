'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { BADGE_IDS, DICTS, fmt } from '@kto/game-core';
import type { BadgeId, Lang } from '@kto/game-core';
import { track } from '@/lib/analytics';
import { detectLang } from '@/lib/lang';
import { bootTelegram, emojiStatusCaps, haptic, inTelegram, linkTelegramOnce, shopCached, shopSignedIn, shopState, setEmojiStatus, tgLink } from '@/lib/telegram';
import type { ShopState } from '@/lib/telegram';
import { TopBar } from '@/ui/TopBarView';
import { badgeIcon } from '@/game/skins/badges';

type Badge = NonNullable<ShopState['badges']>[number];

/**
 * «Значки» (/badges): значки за игру и покупки (game-core/badges.ts) — игрок ставит их в эмодзи-статус Telegram
 * (`WebApp.setEmojiStatus`, нужен Telegram Premium). Что заработано, считает сервер; id эмодзи — из набора бота.
 */
export default function BadgesClient() {
  const router = useRouter();
  const [lang, setLang] = useState<Lang>('ru');
  const t = DICTS[lang].shop.badges;
  const [icons, setIcons] = useState<Partial<Record<BadgeId, { src: string; w: number; h: number }>>>({});
  const [inTg, setInTg] = useState(false);
  const [tgOn, setTgOn] = useState(false);
  const [list, setList] = useState<Badge[] | null>(null);
  const [known, setKnown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const noteTimer = useRef(0);
  const flash = (text: string) => {
    setNote(text);
    clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote((n) => (n === text ? '' : n)), 3000);
  };

  useEffect(() => {
    const l = detectLang();
    setLang(l);
    document.documentElement.lang = l;
    document.title = `${DICTS[l].shop.badges.title} · ${DICTS[l].meta.title}`;
    setIcons(Object.fromEntries(BADGE_IDS.map((id) => {
      const c = badgeIcon(id);
      return [id, { src: c.toDataURL(), w: c.width * 2, h: c.height * 2 }];
    })));
    const inTgNow = inTelegram();
    setInTg(inTgNow);
    const on = shopSignedIn();
    setTgOn(on);
    track('badges_view', {});
    if (!on) {
      setKnown(true);
      return;
    }
    void (async () => {
      await bootTelegram();
      const c = shopCached();
      if (c?.badges) setList(c.badges);
      // счёт ведёт игровой сервер по связке «игрок ↔ Telegram»
      void linkTelegramOnce();
      const s = await shopState();
      if (s?.badges) setList(s.badges);
      setKnown(true);
    })();
  }, []);

  // набор эмодзи у бота доделывается в фоне: заработанный значок без эмодзи — спросить ещё раз чуть позже
  const waiting = !!list?.some((b) => b.have && !b.emoji);
  useEffect(() => {
    if (!waiting) return;
    let n = 0;
    const id = window.setInterval(() => {
      if (++n > 6) return clearInterval(id);
      void shopState().then((s) => s?.badges && setList(s.badges));
    }, 15_000);
    return () => clearInterval(id);
  }, [waiting]);

  const put = async (b: Badge) => {
    if (busy) return;
    if (!b.emoji) return flash(t.preparing);
    const caps = emojiStatusCaps();
    if (!caps.ok) return flash(t.noTg);
    setBusy(true);
    const ok = await setEmojiStatus(b.emoji, b.until);
    track('badge_set', { id: b.id, ok, premium: caps.premium });
    if (ok) {
      haptic('success');
      flash(t.setDone);
    } else flash(caps.premium ? t.setFail : t.premium);
    setBusy(false);
  };

  const sub = (b: Badge) => {
    if (b.have && b.until !== null) return fmt(t.hoursLeft, { h: Math.max(1, Math.ceil((b.until - Date.now()) / 3600_000)) });
    if (!b.have && b.of > 1) return `${t.how[b.id]} · ${fmt(t.progress, { n: b.n, of: b.of })}`;
    return t.how[b.id];
  };

  const open = () => {
    const link = tgLink('badges');
    if (link) location.href = link;
  };

  return (
    <main className="daily badges">
      <TopBar lang={lang} onBack={() => router.push('/wardrobe')} />
      <h1 className="daily-title">{t.title}</h1>
      <p className="badges-hint">{note || t.hint}</p>
      <ul className="badges-list" style={{ visibility: known ? 'visible' : 'hidden' }}>
        {(list ?? BADGE_IDS.map((id): Badge => ({ id, have: false, n: 0, of: 1, until: null, emoji: null }))).map((b) => {
          const ic = icons[b.id];
          return (
            <li key={b.id} className={b.have ? 'have' : ''}>
              <span className="badges-icon">{ic && <img src={ic.src} alt="" width={ic.w} height={ic.h} />}</span>
              <span className="badges-text">
                <b>{t.names[b.id]}</b>
                <span>{sub(b)}</span>
              </span>
              {b.have && inTg && (
                <button className="btn small" onClick={() => void put(b)} aria-disabled={busy}>
                  {t.set}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {known && !inTg && (
        <div className="daily-actions">
          <p className="muted">{t.noTg}</p>
          {tgLink('badges') && (
            <button className="btn small tg" onClick={open}>
              {t.openTg}
            </button>
          )}
        </div>
      )}
      {known && tgOn && list === null && <p className="muted">{t.preparing}</p>}
    </main>
  );
}
