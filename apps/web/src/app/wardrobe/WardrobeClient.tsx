'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { DICTS, SHOP_ITEMS, STICKER_LIST, shopItem } from '@kto/game-core';
import type { Lang, ShopItemId } from '@kto/game-core';
import { track } from '@/lib/analytics';
import { TG_APP } from '@/lib/env';
import { featureOn } from '@/lib/features';
import { detectLang } from '@/lib/lang';
import { bootTelegram, haptic, inTelegram, linkTelegramOnce, openTelegram, shopBuy, shopState, shopWear, tgLink } from '@/lib/telegram';
import type { ShopState } from '@/lib/telegram';
import { TopBar } from '@/ui/TopBarView';
import { CARD_H, CARD_W, buyLabel, drawCard, itemIcon, starsIcon } from '@/game/skins/wardrobe';

/** Ячеек в списке наборов: пока набор один — остальные под знаком вопроса. */
const SLOTS = 4;

/** «Гардероб» (/wardrobe, за флагом shop): витрина Кот-банана, покупка за звёзды, стикеры набора — в личный пак игрока. */
export default function WardrobeClient() {
  const router = useRouter();
  const [ITEM, setItem] = useState<ShopItemId>(SHOP_ITEMS[0].id);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [lang, setLang] = useState<Lang>('ru');
  const t = DICTS[lang].shop;
  const [ready, setReady] = useState(false);
  const [tgOn, setTgOn] = useState(false);
  const [st, setSt] = useState<ShopState | null>(null);
  const [busy, setBusy] = useState<'buy' | 'wear' | null>(null);
  const [note, setNote] = useState('');
  const noteTimer = useRef(0);
  // подсказка «Скоро новые наборы» — на пару секунд, потом гаснет сама
  const flash = (text: string) => {
    setNote(text);
    clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote((n) => (n === text ? '' : n)), 2000);
  };
  const [scale, setScale] = useState(0);
  // звезда Telegram (Stars) — пиксельная, из палитры игры
  const [star, setStar] = useState('');
  const slotRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const owned = !!st?.items.includes(ITEM);
  const stRef = useRef({ lang, owned, item: ITEM });
  stRef.current = { lang, owned, item: ITEM };

  useEffect(() => {
    if (!featureOn('shop')) {
      router.replace('/');
      return;
    }
    const l = detectLang();
    setLang(l);
    document.documentElement.lang = l;
    document.title = `${DICTS[l].shop.title} · ${DICTS[l].meta.title}`;
    setStar(starsIcon().toDataURL());
    setIcons(Object.fromEntries(SHOP_ITEMS.map((x) => [x.id, itemIcon(x.id).toDataURL()])));
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
        // купил набор — стикеры за матчи пойдут в пак: сервер узнаёт, какой это аккаунт Telegram
        void linkTelegramOnce();
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
      const { lang: l, owned: o, item } = stRef.current;
      g.setTransform(scale, 0, 0, scale, 0, 0);
      drawCard(g, now - t0, { lang: l, item, issued: new Set(o ? STICKER_LIST.filter((s) => s.set === item && s.now).map((s) => s.id) : []) });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [ready, scale]);

  const buy = async () => {
    // вне Telegram покупка невозможна — ведём в гардероб внутри бота
    if (!tgOn) {
      track('shop_to_tg', { item: ITEM });
      const link = tgLink('ff_shop');
      if (link) location.href = link;
      return;
    }
    if (busy || owned) return;
    setBusy('buy');
    clearTimeout(noteTimer.current);
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

  // «Надеть» / «Снять»: переключать скины (сейчас один); в комнате — со следующего входа
  const worn = st?.worn === undefined ? owned : st.worn === ITEM;
  const wear = async () => {
    if (busy || !tgOn) return;
    setBusy('wear');
    const on = !worn;
    track('shop_wear', { item: ITEM, on });
    const s = await shopWear(on ? ITEM : null);
    if (s) {
      setSt(s);
      haptic('light');
      setNote(on ? t.worn : t.unworn);
    } else setNote(t.failed);
    setBusy(null);
  };

  // один пак на игрока: стикеры набора бот кладёт туда сам после оплаты
  const packLink = st?.pack ?? null;

  const bot = TG_APP ? `https://t.me/${TG_APP.split('/')[0]}` : 'https://t.me/be_nobody_bot';
  const was = shopItem(ITEM)?.was;
  const list = [...SHOP_ITEMS].sort((a, b) => Number(!!st?.items.includes(b.id)) - Number(!!st?.items.includes(a.id)) || Number(!!b.isNew) - Number(!!a.isNew));
  return (
    <main className="daily wardrobe">
      <TopBar lang={lang} onBack={() => router.push('/')} />
      <h1 className="daily-title">{t.title}</h1>
      {/* наборы лентой (листается вбок): купленные первыми, потом новые; пустые ячейки — под вопросом */}
      <div className="wardrobe-sets" role="tablist">
        {Array.from({ length: Math.max(SLOTS, SHOP_ITEMS.length) }, (_, i) => {
          const x = list[i];
          if (!x)
            return (
              <button key={i} className="wardrobe-set locked" onClick={() => flash(t.soon)} aria-label={t.soon}>
                ?
              </button>
            );
          const mine = !!st?.items.includes(x.id);
          return (
            <button key={x.id} role="tab" aria-selected={x.id === ITEM} className={x.id === ITEM ? 'wardrobe-set on' : 'wardrobe-set'} onClick={() => setItem(x.id)} aria-label={t.items[x.id].name}>
              {icons[x.id] && <img src={icons[x.id]} alt="" width={18 * 2} height={30 * 2} />}
              {mine ? <i className="wardrobe-mark mine">✓</i> : x.isNew ? <i className="wardrobe-mark new" /> : null}
            </button>
          );
        })}
      </div>
      <div className="daily-slot" ref={slotRef}>
        {ready && (
          <div className="daily-stage" style={{ width: (CARD_W * scale) / (globalThis.devicePixelRatio || 1), height: (CARD_H * scale) / (globalThis.devicePixelRatio || 1), visibility: scale ? 'visible' : 'hidden' }}>
            <canvas ref={canvasRef} className="daily-canvas" style={{ width: '100%', height: '100%' }} />
            {/* подсказка — поверх витрины, а не строкой под кнопкой: иначе поле сжимается и карточка прыгает */}
            {note && (
              <p className="wardrobe-note" role="status">
                {note}
              </p>
            )}
          </div>
        )}
      </div>
      <div className="daily-actions">
        {owned ? (
          <>
            <p className="wardrobe-owned">{t.owned}</p>
            {tgOn && (
              <button className={worn ? 'btn small alt' : 'btn small'} onClick={() => void wear()} aria-disabled={!!busy} aria-pressed={worn}>
                {worn ? t.unwear : t.wear}
              </button>
            )}
            {packLink ? (
              <button className="btn small" onClick={() => openTelegram(packLink)}>
                {t.openPack}
              </button>
            ) : (
              <p className="muted">{t.sending}</p>
            )}
            <p className="muted">{t.packHint}</p>
          </>
        ) : (
          <>
            {tgOn ? (
              <button className="btn" onClick={() => void buy()} aria-disabled={!!busy}>
                {was && <s className="wardrobe-was">{was}</s>}
                {buyLabel(lang, ITEM)}
                {star && <img className="wardrobe-star" src={star} alt="" width={26} height={26} />}
              </button>
            ) : (
              // вне Telegram цену не показываем — синяя кнопка ведёт в гардероб внутри бота
              <button className="btn tg" onClick={() => void buy()}>
                {t.buyTg}
              </button>
            )}
          </>
        )}
        {/* какие стикеры в паке и свои стикеры — отдельная страница */}
        <button className="link" onClick={() => router.push('/stickers')}>
          {t.build.open}
        </button>
        {st?.error === 'need_bot' && (
          <button className="link" onClick={() => openTelegram(bot)}>
            {bot.replace('https://', '')}
          </button>
        )}
      </div>
    </main>
  );
}
