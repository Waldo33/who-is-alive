'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { DICTS, REWARDS, THEME_RULES, fmt } from '@kto/game-core';
import type { Lang, RewardId } from '@kto/game-core';
import { track } from '@/lib/analytics';
import { detectLang } from '@/lib/lang';
import { bootTelegram, haptic, inTelegram, linkTelegramOnce, openTelegram, shopCached, shopEmoji, shopSignedIn, shopState, tgLink } from '@/lib/telegram';
import type { ShopState } from '@/lib/telegram';
import { TopBar } from '@/ui/TopBarView';
import { POST_EMOJI, POST_EMOJI_FPS, POST_EMOJI_MS, postEmojiIcon } from '@/game/skins/post-emoji';
import { REWARD_EMOJI } from '@/game/skins/reward-emoji';

type Pack = NonNullable<ShopState['emoji']>;
type Tab = 'rewards' | 'base';
type Icon = { src: string; frames: string[]; w: number; h: number };

/** Эмодзи на странице: открытые анимированные крутятся, как в наборе Telegram. */
function EmojiImg({ ic, play }: { ic: Icon; play: boolean }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!play || !ic.frames.length) return;
    const id = window.setInterval(() => setI((n) => (n + 1) % ic.frames.length), 1000 / POST_EMOJI_FPS);
    return () => clearInterval(id);
  }, [play, ic]);
  return <img src={play && ic.frames.length ? ic.frames[i] : ic.src} alt="" width={ic.w} height={ic.h} />;
}

/**
 * «Эмодзи-пак» (/emoji): личный набор custom emoji Telegram (game-core/emoji-pack.ts). 30 общих — сразу,
 * награды — за площадки, события матча и покупки. Пак собирает бот; ставить эмодзи — с Telegram Premium.
 * Экран без прокрутки: две вкладки, одна сетка.
 */
export default function EmojiClient() {
  const router = useRouter();
  const [lang, setLang] = useState<Lang>('ru');
  const t = DICTS[lang].shop.emojiPack;
  const [icons, setIcons] = useState<Record<string, Icon>>({});
  const [inTg, setInTg] = useState(false);
  const [pack, setPack] = useState<Pack | null>(null);
  const [known, setKnown] = useState(false);
  const [tab, setTab] = useState<Tab>('rewards');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const noteTimer = useRef(0);
  const flash = (text: string) => {
    setNote(text);
    clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote((n) => (n === text ? '' : n)), 3500);
  };

  useEffect(() => {
    const l = detectLang();
    setLang(l);
    document.documentElement.lang = l;
    document.title = `${DICTS[l].shop.emojiPack.open} · ${DICTS[l].meta.title}`;
    setIcons(Object.fromEntries([...POST_EMOJI, ...REWARD_EMOJI].map((e) => {
      const c = postEmojiIcon(e);
      const n = e.anim ? Math.round((POST_EMOJI_MS / 1000) * POST_EMOJI_FPS) : 0;
      const frames = Array.from({ length: n }, (_, k) => postEmojiIcon(e, (k * 1000) / POST_EMOJI_FPS).toDataURL());
      return [e.id, { src: c.toDataURL(), frames, w: c.width * 2, h: c.height * 2 }];
    })));
    setInTg(inTelegram());
    track('emoji_view', {});
    if (!shopSignedIn()) return setKnown(true);
    void (async () => {
      await bootTelegram();
      const c = shopCached();
      if (c?.emoji) setPack(c.emoji);
      void linkTelegramOnce();
      const s = await shopState();
      if (s?.emoji) setPack(s.emoji);
      setKnown(true);
    })();
  }, []);

  // бот кладёт эмодзи в фоне: пока не всё в наборе — спросить ещё раз чуть позже
  const waiting = !!pack?.claimed && (pack.pending > 0 || !pack.pack);
  useEffect(() => {
    if (!waiting) return;
    let n = 0;
    const id = window.setInterval(() => {
      if (++n > 10) return clearInterval(id);
      void shopState().then((s) => s?.emoji && setPack(s.emoji));
    }, 6000);
    return () => clearInterval(id);
  }, [waiting]);

  const open = new Set<RewardId>(pack?.open ?? []);
  const nameOf = (id: RewardId) => {
    const r = REWARDS.find((x) => x.id === id)!;
    if (r.theme) return DICTS[lang].themes[THEME_RULES.findIndex((x) => x.id === r.theme)] ?? '';
    return t.names[id as keyof typeof t.names];
  };
  const howOf = (id: RewardId) => {
    const r = REWARDS.find((x) => x.id === id)!;
    return r.theme ? fmt(t.theme, { name: nameOf(id) }) : t.how[id as keyof typeof t.how];
  };

  const claim = async () => {
    if (busy) return;
    setBusy(true);
    track('emoji_claim', {});
    const s = await shopEmoji();
    if (s?.emoji) {
      setPack(s.emoji);
      haptic('success');
    }
    if (s?.error === 'need_bot') flash(t.needBot);
    setBusy(false);
  };

  const add = () => {
    if (!pack?.pack) return;
    track('emoji_add', {});
    openTelegram(pack.pack);
  };

  const tapReward = (id: RewardId) => flash(`${nameOf(id)}: ${open.has(id) ? '✓' : howOf(id)}`);
  const list = tab === 'base' ? POST_EMOJI.map((e) => ({ id: e.id, have: true })) : REWARD_EMOJI.map((e) => ({ id: e.id, have: open.has(e.id as RewardId) }));

  return (
    <main className="daily badges emoji-page">
      <TopBar lang={lang} onBack={() => router.push('/badges')} />
      <h1 className="daily-title">{t.open}</h1>
      <p className="badges-hint">{note || (pack?.claimed ? t.premium : t.hint)}</p>
      <div className="stickers-tabs" role="tablist">
        <button role="tab" className={tab === 'rewards' ? 'on' : ''} onClick={() => setTab('rewards')}>
          {fmt(t.rewards, { n: open.size, of: REWARDS.length })}
        </button>
        <button role="tab" className={tab === 'base' ? 'on' : ''} onClick={() => setTab('base')}>
          {t.base}
        </button>
      </div>
      <ul className="emoji-grid" style={{ visibility: known ? 'visible' : 'hidden' }}>
        {list.map((e) => (
          <li key={e.id} className={e.have ? 'have' : ''}>
            <button onClick={() => (tab === 'rewards' ? tapReward(e.id as RewardId) : undefined)} aria-label={tab === 'rewards' ? nameOf(e.id as RewardId) : e.id}>
              {icons[e.id] && <EmojiImg ic={icons[e.id]!} play={e.have} />}
            </button>
          </li>
        ))}
      </ul>
      <div className="daily-actions">
        {known && !inTg && (
          <>
            <p className="muted">{t.noTg}</p>
            {tgLink('emoji') && (
              <button className="btn small tg" onClick={() => (location.href = tgLink('emoji')!)}>
                {DICTS[lang].shop.badges.openTg}
              </button>
            )}
          </>
        )}
        {known && inTg && !pack?.claimed && (
          <button className="btn" onClick={() => void claim()} aria-disabled={busy}>
            {t.claim}
          </button>
        )}
        {known && inTg && pack?.claimed && (
          <button className="btn tg" onClick={add} aria-disabled={!pack.pack}>
            {pack.pack ? t.add : t.making}
          </button>
        )}
      </div>
    </main>
  );
}
