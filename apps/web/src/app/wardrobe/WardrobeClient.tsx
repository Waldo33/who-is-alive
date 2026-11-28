'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { DICTS, SHOP_ITEMS, STICKER_LIST, fmt, isEffect, isSkin, shopItem } from '@kto/game-core';
import type { Lang, ShopItemId } from '@kto/game-core';
import { track } from '@/lib/analytics';
import { TG_APP } from '@/lib/env';
import { detectLang } from '@/lib/lang';
import { bootTelegram, haptic, inTelegram, linkTelegramOnce, openTelegram, prefetchInvoice, shopBuy, shopCached, shopSignedIn, shopState, shopWear, shopAura, tgLink } from '@/lib/telegram';
import { currentWebLogin, prepareWebLogin, resumeWebLogin, startWebLogin, webLogout } from '@/lib/tg-login';
import type { TgLogin } from '@/lib/tg-login';
import type { ShopState } from '@/lib/telegram';
import { TopBar } from '@/ui/TopBarView';
import { CARD_H, CARD_W, buyLabel, drawCard, itemIcon, starsIcon } from '@/game/skins/wardrobe';

/** Скины гардероба. */
const SKINS = SHOP_ITEMS.filter((x) => !x.effect);
/**
 * Эффекты: те же, что на стикерах (вкладка «Эффекты» стикерпака), — в гардеробе их надевают на своего персонажа
 * (решение владельца 28.11.2026, активен один). В ленте — после скинов.
 */
const FXS = SHOP_ITEMS.filter((x) => x.effect);
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
  const [ITEM, setItem] = useState<ShopItemId>(SKINS[0].id);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [lang, setLang] = useState<Lang>('ru');
  const t = DICTS[lang].shop;
  const [ready, setReady] = useState(false);
  // tgOn — магазин доступен (Telegram или вход через Telegram в браузере); inTg — игра внутри Telegram (покупка — только там)
  const [tgOn, setTgOn] = useState(false);
  const [inTg, setInTg] = useState(false);
  // вход через Telegram в браузере: кто вошёл; готово ли окно входа (скрипт Telegram и id бота загружены)
  const [login, setLogin] = useState<TgLogin | null>(null);
  const [loginReady, setLoginReady] = useState(false);
  // кнопки внизу — только когда ясно, Telegram ли это и что у игрока есть: иначе сначала мелькает
  // «Купить в Telegram», потом «Купить 49», потом «Уже твой» — экран скачет
  const [known, setKnown] = useState(false);
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
  // оплата прошла, а бот ещё не записал набор (сбой связи, перезапуск бота — Telegram повторит уведомление):
  // не показываем снова кнопку «Купить», ждём и опрашиваем — и после перезагрузки страницы тоже
  const [paidAt, setPaidAt] = useState(0);
  const waiting = !owned && paidAt > 0;
  // эффект на витрине — на том, кто ты в игре: в надетом скине или обычным актёром
  const skin = isSkin(st?.worn) ? st.worn : null;
  const stRef = useRef({ lang, owned, item: ITEM, skin });
  stRef.current = { lang, owned, item: ITEM, skin };

  useEffect(() => {
    const l = detectLang();
    setLang(l);
    document.documentElement.lang = l;
    document.title = `${DICTS[l].shop.title} · ${DICTS[l].meta.title}`;
    setStar(starsIcon().toDataURL());
    setIcons(Object.fromEntries([...SKINS, ...FXS].map((x) => [x.id, itemIcon(x.id).toDataURL()])));
    // со страницы стикерпака: /wardrobe?item=kotBanan — сразу нужный набор
    const want = new URLSearchParams(location.search).get('item');
    // старые ссылки на эффект — во вкладку «Эффекты» стикерпака
    if (isEffect(want)) return router.replace(`/stickers?fx=${want}`);
    const pick = SKINS.find((x) => x.id === want);
    if (pick) setItem(pick.id);
    track('shop_view', pick ? { item: pick.id } : {});
    const inTgNow = inTelegram();
    setInTg(inTgNow);
    const tgNow = shopSignedIn();
    setTgOn(tgNow);
    if (!inTgNow) {
      setLogin(currentWebLogin());
      // вернулись из Telegram на перезагруженную страницу — дождаться начатого входа
      const back = tgNow ? null : resumeWebLogin();
      if (back) void back.then((l) => (l ? void signedIn(l) : undefined));
      else if (!tgNow) void prepareWebLogin().then(setLoginReady);
    }
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
      const { lang: l, owned: o, item, skin: sk } = stRef.current;
      g.setTransform(scale, 0, 0, scale, 0, 0);
      drawCard(g, now - t0, { lang: l, item, skin: sk, issued: new Set(o ? STICKER_LIST.filter((s) => s.set === item && s.now).map((s) => s.id) : []) });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [ready, scale]);

  // код входа живёт 10 минут: страница открыта долго — берём свежий заранее
  useEffect(() => {
    if (inTg || tgOn) return;
    const id = window.setInterval(() => void prepareWebLogin().then(setLoginReady), 5 * 60_000);
    return () => clearInterval(id);
  }, [inTg, tgOn]);

  // вход через Telegram в браузере: бот открывается прямо из нажатия, там — «Войти», сайт ждёт подтверждения
  const signIn = async () => {
    if (busy) return;
    track('tg_login_tap', {});
    setNote(t.loginWait);
    const l = await startWebLogin();
    track('tg_login', { ok: !!l });
    if (!l) {
      flash(t.loginFail);
      void prepareWebLogin().then(setLoginReady);
      return;
    }
    await signedIn(l);
  };
  const signedIn = async (l: TgLogin) => {
    setNote('');
    setLogin(l);
    setTgOn(true);
    // этот браузер — тот же игрок Telegram: скин в комнате и стикеры за матчи
    void linkTelegramOnce();
    const s = await shopState();
    if (s) setSt(s);
  };
  const signOut = () => {
    webLogout();
    setLogin(null);
    setTgOn(false);
    setSt(null);
    void prepareWebLogin().then(setLoginReady);
  };

  // сайт с входом через Telegram: ссылку на счёт берём заранее — «Купить» откроет оплату в Telegram сразу
  useEffect(() => {
    if (!inTg && login && st && !owned) void prefetchInvoice(ITEM);
  }, [inTg, login, st, owned, ITEM]);

  const buy = async () => {
    // вне Telegram без входа покупка невозможна — ведём в гардероб внутри бота
    if (!inTg && !login) {
      track('shop_to_tg', { item: ITEM });
      const link = tgLink('shop');
      if (link) location.href = link;
      return;
    }
    if (busy || owned) return;
    setBusy('buy');
    clearTimeout(noteTimer.current);
    setNote(inTg ? t.paying : t.payInTg);
    track('shop_buy_tap', { item: ITEM, ...(inTg ? {} : { site: true }) });
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

  // «Надеть» / «Снять»: скин (сейчас один) или эффект на персонажа (активен один); в комнате — со следующего входа
  const fxItem = isEffect(ITEM);
  const worn = fxItem ? st?.aura === ITEM : st?.worn === undefined ? owned : st.worn === ITEM;
  const wear = async () => {
    if (busy || !tgOn) return;
    setBusy('wear');
    const on = !worn;
    track(fxItem ? 'shop_aura' : 'shop_wear', { item: ITEM, on });
    const s = await (fxItem ? shopAura : shopWear)(on ? ITEM : null);
    if (s) {
      setSt(s);
      haptic('light');
      setNote(fxItem ? (on ? t.auraOn : t.auraOff) : on ? t.worn : t.unworn);
    } else setNote(t.failed);
    setBusy(null);
  };

  // один пак на игрока: стикеры набора бот кладёт туда сам после оплаты
  const packLink = st?.pack ?? null;

  const bot = TG_APP ? `https://t.me/${TG_APP.split('/')[0]}` : 'https://t.me/be_nobody_bot';
  const was = shopItem(ITEM)?.was;
  const byOwned = (a: (typeof SHOP_ITEMS)[number], b: (typeof SHOP_ITEMS)[number]) => Number(!!st?.items.includes(b.id)) - Number(!!st?.items.includes(a.id));
  // скины, потом эффекты; купленные — первыми
  const list = [...[...SKINS].sort((a, b) => byOwned(a, b) || Number(!!b.isNew) - Number(!!a.isNew)), ...[...FXS].sort(byOwned)];
  return (
    <main className="daily wardrobe">
      <TopBar lang={lang} onBack={() => router.push('/')} />
      <h1 className="daily-title">{t.title}</h1>
      {/* наборы лентой (листается вбок): скины, потом эффекты на персонажа; купленные первыми */}
      <div className="wardrobe-sets" role="tablist">
        {list.map((x) => {
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
      <div className="daily-actions" style={{ visibility: known ? 'visible' : 'hidden' }}>
        {waiting ? (
          <p className="muted" role="status">
            {Date.now() - paidAt > PAID_LATE_MS ? t.paidLate : t.paidWait}
          </p>
        ) : owned ? (
          <>
            <p className="wardrobe-owned">{t.owned}</p>
            {/* скин и эффект надеваются на своего персонажа (эффект — ещё и на стикеры, в стикерпаке) */}
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
            {/* в браузере место подсказки занимает строка входа (iPhone SE: витрина должна влезть) */}
            {inTg && !isEffect(ITEM) && <p className="muted">{t.packHint}</p>}
          </>
        ) : (
          <>
            {inTg || login ? (
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
        {/* эффекты для стикеров — во вкладке стикерпака; на сайте после покупки место занимает строка входа
            (iPhone SE: витрина должна влезть), эффекты — там же, за «Собрать свой стикерпак» */}
        {!(owned && !inTg) && (
          <button className="link" onClick={() => router.push('/stickers?fx=holo')}>
            {t.fxCategory}
          </button>
        )}
        {/* значки для эмодзи-статуса: ставятся только внутри Telegram */}
        {inTg && known && (
          <button className="link" onClick={() => router.push('/badges')}>
            {t.badges.open}
          </button>
        )}
        {/* браузер: вход через Telegram — купленное в боте (скин, стикерпак) и здесь */}
        {!inTg &&
          (login ? (
            <p className="muted">
              {fmt(t.loggedAs, { name: login.username ? `@${login.username}` : (login.first_name ?? String(login.id)) })}{' '}
              <button className="link" onClick={signOut}>
                {t.logout}
              </button>
            </p>
          ) : (
            loginReady && (
              <>
                <button className="link" onClick={() => void signIn()}>
                  {t.login}
                </button>
                <p className="muted">{t.loginHint}</p>
              </>
            )
          ))}
        {st?.error === 'need_bot' && (
          <button className="link" onClick={() => openTelegram(bot)}>
            {bot.replace('https://', '')}
          </button>
        )}
      </div>
    </main>
  );
}
