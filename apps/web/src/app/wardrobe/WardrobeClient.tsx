'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { DICTS, STICKER_LIST, shopItem } from '@kto/game-core';
import type { Lang, ShopItemId } from '@kto/game-core';
import { track } from '@/lib/analytics';
import { TG_APP } from '@/lib/env';
import { featureOn } from '@/lib/features';
import { detectLang } from '@/lib/lang';
import { bootTelegram, haptic, inTelegram, openTelegram, shopBuy, shopClaim, shopState } from '@/lib/telegram';
import type { ShopState } from '@/lib/telegram';
import { TopBar } from '@/ui/TopBarView';
import { CARD_H, CARD_W, buyLabel, drawCard } from '@/game/skins/wardrobe';

const ITEM: ShopItemId = 'kotBanan';

function played(): boolean {
  try {
    return localStorage.getItem('kto:played') === '1';
  } catch {
    return false;
  }
}

/** «Гардероб» (/wardrobe, за флагом shop): витрина Кот-банана, покупка за звёзды и бесплатный стикерпак. */
export default function WardrobeClient() {
  const router = useRouter();
  const [lang, setLang] = useState<Lang>('ru');
  const t = DICTS[lang].shop;
  const [ready, setReady] = useState(false);
  const [tgOn, setTgOn] = useState(false);
  const [canFree, setCanFree] = useState(false);
  const [st, setSt] = useState<ShopState | null>(null);
  const [busy, setBusy] = useState<'buy' | 'claim' | null>(null);
  const [note, setNote] = useState('');
  const [scale, setScale] = useState(0);
  const slotRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const owned = !!st?.items.includes(ITEM);
  const stRef = useRef({ lang, owned });
  stRef.current = { lang, owned };

  useEffect(() => {
    if (!featureOn('shop')) {
      router.replace('/');
      return;
    }
    const l = detectLang();
    setLang(l);
    document.documentElement.lang = l;
    document.title = `${DICTS[l].shop.title} · ${DICTS[l].meta.title}`;
    setCanFree(played());
    track('shop_view', {});
    const tgNow = inTelegram();
    setTgOn(tgNow);
    void (async () => {
      try {
        await Promise.race([document.fonts.load('8px "Press Start 2P"', 'Гардероб ABC'), new Promise((r) => setTimeout(r, 2500))]);
      } catch {
        /* системный моноширинный */
      }
      setReady(true);
      if (tgNow) {
        await bootTelegram();
        setSt(await shopState());
      }
    })();
  }, []);

  // поле — всё место между заголовком и кнопками, масштаб целый в пикселях экрана
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const k = Math.floor(Math.min((slot.clientWidth * dpr) / CARD_W, (slot.clientHeight * dpr) / CARD_H));
      setScale(k >= 1 ? k : 0);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(slot);
    return () => ro.disconnect();
  }, []);

  // анимация витрины: 10 кадров в секунду
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !ready || !scale) return;
    c.width = CARD_W * scale;
    c.height = CARD_H * scale;
    const g = c.getContext('2d')!;
    const t0 = performance.now();
    let last = -1;
    let raf = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const f = Math.floor((now - t0) / 100);
      if (f === last) return;
      last = f;
      const { lang: l, owned: o } = stRef.current;
      g.setTransform(scale, 0, 0, scale, 0, 0);
      drawCard(g, now - t0, { lang: l, item: ITEM, issued: new Set(o ? STICKER_LIST.filter((s) => s.set === ITEM && s.now).map((s) => s.id) : []) });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [ready, scale]);

  const buy = async () => {
    if (busy || !tgOn || owned) return;
    setBusy('buy');
    setNote(t.paying);
    track('shop_buy_tap', { item: ITEM });
    const r = await shopBuy(ITEM);
    track('shop_buy', { item: ITEM, status: r });
    if (r === 'paid') {
      haptic('success');
      setNote(t.paid);
      // набор выдаёт бот по уведомлению Telegram — ждём, пока он запишется
      for (let i = 0; i < 10; i++) {
        const s = await shopState();
        if (s) setSt(s);
        if (s?.items.includes(ITEM) && s.issued >= s.wanted) break;
        await new Promise((res) => setTimeout(res, 1500));
      }
    } else {
      setNote(r === 'cancelled' ? t.cancelled : r === 'pending' ? t.paying : t.failed);
      const s = await shopState();
      if (s) setSt(s);
    }
    setBusy(null);
  };

  const claim = async () => {
    if (busy || !tgOn) return;
    setBusy('claim');
    setNote(t.sending);
    track('shop_claim_tap', {});
    const s = await shopClaim();
    if (s) setSt(s);
    setNote(!s ? t.failed : s.error === 'need_bot' ? t.needBot : s.pack ? '' : t.failed);
    if (s?.pack) haptic('success');
    setBusy(null);
  };

  const bot = TG_APP ? `https://t.me/${TG_APP.split('/')[0]}` : 'https://t.me/be_nobody_bot';
  const was = shopItem(ITEM)?.was;
  return (
    <main className="daily wardrobe">
      <TopBar lang={lang} onBack={() => router.push('/')} />
      <h1 className="daily-title">{t.title}</h1>
      <div className="daily-slot" ref={slotRef}>
        {ready && (
          <div className="daily-stage" style={{ width: (CARD_W * scale) / (globalThis.devicePixelRatio || 1), height: (CARD_H * scale) / (globalThis.devicePixelRatio || 1), visibility: scale ? 'visible' : 'hidden' }}>
            <canvas ref={canvasRef} className="daily-canvas" style={{ width: '100%', height: '100%' }} />
          </div>
        )}
      </div>
      <div className="daily-actions">
        {owned ? (
          <p className="wardrobe-owned">{t.owned}</p>
        ) : (
          <>
            <button className="btn" onClick={() => void buy()} aria-disabled={!tgOn || !!busy}>
              {was && <s className="wardrobe-was">{was}</s>}
              {buyLabel(lang, ITEM)} ⭐
            </button>
            {!tgOn && <p className="muted">{t.onlyTg}</p>}
          </>
        )}
        {note && <p className="wardrobe-note">{note}</p>}
        {st?.error === 'need_bot' && (
          <button className="link" onClick={() => openTelegram(bot)}>
            {bot.replace('https://', '')}
          </button>
        )}
        <div className="wardrobe-free">
          <p className="wardrobe-free-title">{t.freeTitle}</p>
          {canFree && !st?.items.includes('starter') ? (
            <>
              <p className="muted">{t.freeText}</p>
              <button className="btn small alt" onClick={() => void claim()} aria-disabled={!tgOn || !!busy}>
                {busy === 'claim' ? t.sending : t.freeClaim}
              </button>
            </>
          ) : !st?.items.includes('starter') ? (
            <p className="muted">{t.freeLocked}</p>
          ) : null}
          {st?.pack && (
            <button className="btn small" onClick={() => openTelegram(st.pack!)}>
              {t.openPack}
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
