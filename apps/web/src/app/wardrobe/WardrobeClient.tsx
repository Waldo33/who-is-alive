'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { DICTS, SHOP_ITEMS, STICKER_LIST, TEST_ITEM, shopItem } from '@kto/game-core';
import type { Lang, ShopItemId } from '@kto/game-core';
import { track } from '@/lib/analytics';
import { TG_APP } from '@/lib/env';
import { featureOn } from '@/lib/features';
import { detectLang } from '@/lib/lang';
import { bootTelegram, haptic, inTelegram, linkTelegramOnce, openTelegram, shopBuy, shopCached, shopRefund, shopState, shopWear, tgLink } from '@/lib/telegram';
import type { ShopState } from '@/lib/telegram';
import { TopBar } from '@/ui/TopBarView';
import { CARD_H, CARD_W, buyLabel, drawCard, itemIcon, starsIcon } from '@/game/skins/wardrobe';

/** Ячеек в списке наборов: пока набор один — остальные под знаком вопроса. */
const SLOTS = 4;
// оплата прошла, набор ещё не записан: помним на телефоне, ждём до PAID_KEEP_MS, после PAID_LATE_MS — подсказка про поддержку
const PAID_KEY = 'kto:paid';
const PAID_LATE_MS = 5 * 60_000;
const PAID_KEEP_MS = 24 * 3600_000;
function markPaid(item: string): void {
  try {
    localStorage.setItem(PAID_KEY, JSON.stringify({ item, at: Date.now() }));
  } catch {
    /* приватный режим — ждём только на этой странице */
  }
}
function paidSince(item: string): number {
  try {
    const p = JSON.parse(localStorage.getItem(PAID_KEY) ?? 'null') as { item?: string; at?: number } | null;
    return p?.item === item && typeof p.at === 'number' && Date.now() - p.at < PAID_KEEP_MS ? p.at : 0;
  } catch {
    return 0;
  }
}

/** «Гардероб» (/wardrobe, за флагом shop): витрина Кот-банана, покупка за звёзды, стикеры набора — в личный пак игрока. */
export default function WardrobeClient() {
  const router = useRouter();
  const [ITEM, setItem] = useState<ShopItemId>(SHOP_ITEMS[0].id);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [lang, setLang] = useState<Lang>('ru');
  const t = DICTS[lang].shop;
  const [ready, setReady] = useState(false);
  const [tgOn, setTgOn] = useState(false);
  // кнопки внизу — только когда ясно, Telegram ли это и что у игрока есть: иначе сначала мелькает
  // «Купить в Telegram», потом «Купить 49», потом «Уже твой» — экран скачет
  const [known, setKnown] = useState(false);
  const [st, setSt] = useState<ShopState | null>(null);
  const [busy, setBusy] = useState<'buy' | 'wear' | 'test' | null>(null);
  // проверочная покупка за 1 звезду (флаг shoptest, ссылка startapp=shoptest): своя карточка с «Вернуть звёзды»
  const [testOn, setTestOn] = useState(false);
  const [testNote, setTestNote] = useState('');
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
  // оплата прошла, а бот ещё не записал набор (сбой связи, перезапуск бота — Telegram повторит уведомление):
  // не показываем снова кнопку «Купить», ждём и опрашиваем — и после перезагрузки страницы тоже
  const [paidAt, setPaidAt] = useState(0);
  const waiting = !owned && paidAt > 0;
  const stRef = useRef({ lang, owned, item: ITEM });
  stRef.current = { lang, owned, item: ITEM };

  useEffect(() => {
    const l = detectLang();
    setLang(l);
    document.documentElement.lang = l;
    document.title = `${DICTS[l].shop.title} · ${DICTS[l].meta.title}`;
    setStar(starsIcon().toDataURL());
    setIcons(Object.fromEntries(SHOP_ITEMS.map((x) => [x.id, itemIcon(x.id).toDataURL()])));
    // со страницы стикерпака: /wardrobe?item=kotBanan — сразу нужный набор
    const want = new URLSearchParams(location.search).get('item');
    const pick = SHOP_ITEMS.find((x) => x.id === want);
    if (pick) setItem(pick.id);
    track('shop_view', pick ? { item: pick.id } : {});
    const tgNow = inTelegram();
    setTgOn(tgNow);
    setTestOn(featureOn('shoptest'));
    void (async () => {
      try {
        await Promise.race([document.fonts.load('8px "Press Start 2P"', 'Гардероб ABC'), new Promise((r) => setTimeout(r, 2500))]);
      } catch {
        /* системный моноширинный */
      }
      if (tgNow) {
        await bootTelegram();
        // что куплено — сразу из прошлого ответа, свежий придёт следом: иначе витрина сначала «не куплено», потом «твой»
        const c = shopCached();
        if (c) {
          setSt(c);
          setPaidAt(paidSince(ITEM));
          setKnown(true);
        }
      }
      setReady(true);
      if (tgNow) {
        // купил набор — стикеры за матчи пойдут в пак: сервер узнаёт, какой это аккаунт Telegram
        void linkTelegramOnce();
        setPaidAt(paidSince(ITEM));
        const s = await shopState();
        if (s) setSt(s);
      }
      setKnown(true);
    })();
  }, []);

  // ждём набор после оплаты: опрашиваем бота, пока не появится (Telegram повторяет уведомление об оплате сам)
  useEffect(() => {
    if (!waiting) return;
    const id = window.setInterval(() => {
      void shopState().then((s) => {
        if (s) setSt(s);
      });
    }, 4000);
    return () => clearInterval(id);
  }, [waiting]);
  useEffect(() => {
    if (!owned) return;
    setPaidAt(0);
    try {
      localStorage.removeItem(PAID_KEY);
    } catch {
      /* приватный режим */
    }
  }, [owned]);

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
      const link = tgLink('shop');
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
      markPaid(ITEM);
      setPaidAt(Date.now());
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

  // проверочная покупка: купить за 1 звезду и тут же вернуть — та же оплата и тот же возврат, что у наборов
  const testOwned = !!st?.items.includes(TEST_ITEM.id);
  const testBuy = async () => {
    if (busy || !tgOn) return;
    setBusy('test');
    setTestNote('');
    const r = await shopBuy(TEST_ITEM.id);
    track('shop_test', { status: r });
    if (r === 'paid') {
      haptic('success');
      setTestNote(t.test.bought);
      // отметку ставит сервер по уведомлению Telegram (или по сверке) — ждём её
      for (let i = 0; i < 10; i++) {
        const s = await shopState();
        if (s) setSt(s);
        if (s?.items.includes(TEST_ITEM.id)) break;
        await new Promise((res) => setTimeout(res, 1500));
      }
    } else if (r !== 'cancelled') setTestNote(t.test.failed);
    setBusy(null);
  };
  const testRefund = async () => {
    if (busy || !tgOn) return;
    setBusy('test');
    const s = await shopRefund(TEST_ITEM.id);
    track('shop_test_refund', { ok: !!s });
    if (s) {
      setSt(s);
      haptic('light');
      setTestNote(t.test.refunded);
    } else setTestNote(t.test.failed);
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
          <div className="daily-stage" style={{ width: (CARD_W * scale) / (globalThis.devicePixelRatio || 1), height: (CARD_H * scale) / (globalThis.devicePixelRatio || 1), visibility: scale && known ? 'visible' : 'hidden' }}>
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
      {testOn && tgOn && known && (
        <div className="wardrobe-test">
          <p>
            <b>{t.test.title}</b> · {testNote || t.test.hint}
          </p>
          {testOwned ? (
            <button className="btn small alt" onClick={() => void testRefund()} aria-disabled={!!busy}>
              {t.test.refund}
            </button>
          ) : (
            <button className="btn small" onClick={() => void testBuy()} aria-disabled={!!busy}>
              {t.test.buy}
              {star && <img className="wardrobe-star" src={star} alt="" width={20} height={20} />}
            </button>
          )}
        </div>
      )}
      <div className="daily-actions" style={{ visibility: known ? 'visible' : 'hidden' }}>
        {waiting ? (
          <p className="muted" role="status">
            {Date.now() - paidAt > PAID_LATE_MS ? t.paidLate : t.paidWait}
          </p>
        ) : owned ? (
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
        {/* какие стикеры в паке и свои стикеры — отдельная страница; до покупки не отвлекаем от неё */}
        {owned && (
          <button className="link" onClick={() => router.push('/stickers')}>
            {t.build.open}
          </button>
        )}
        {st?.error === 'need_bot' && (
          <button className="link" onClick={() => openTelegram(bot)}>
            {bot.replace('https://', '')}
          </button>
        )}
      </div>
    </main>
  );
}
