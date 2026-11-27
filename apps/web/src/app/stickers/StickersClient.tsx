'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DICTS, MY_COLORS, MY_FIGS, MY_MAX, MY_POSES, STICKER_LIST, THEME_RULES, canDrop, fmt, myCaption } from '@kto/game-core';
import type { Lang, MyFig, MyPose, MySticker, ShopItemId, StickerMeta } from '@kto/game-core';
import { PAL } from '@kto/assets';
import { track } from '@/lib/analytics';
import { detectLang } from '@/lib/lang';
import { bootTelegram, haptic, inTelegram, linkTelegramOnce, openTelegram, shopClaim, shopMy, shopMyDel, shopPick, shopState, tgLink } from '@/lib/telegram';
import type { ShopState } from '@/lib/telegram';
import { TopBar } from '@/ui/TopBarView';
import { ST_SIZE, STICKERS, stickerFrame } from '@/game/skins/stickers';
import { drawMy, myDef } from '@/game/skins/my-sticker';
import type { MyLook } from '@/game/skins/my-sticker';
import { loadAllThemes } from '@/game/themes';

/** Без Telegram (просто сайт): видно, каким бывает пак, — бесплатные стикеры и приманка; собрать можно только в Telegram. */
const PREVIEW: Pick<ShopState, 'open' | 'off' | 'my' | 'figs' | 'earned' | 'pending' | 'pack' | 'items'> = {
  open: STICKER_LIST.filter((s) => s.set === 'starter').map((s) => s.id),
  off: [],
  my: [],
  figs: ['actor'],
  earned: [],
  pending: 0,
  pack: null,
  items: [],
};

type Tab = 'pack' | 'make';
interface Draft {
  slot: number | null;
  fig: MyFig;
  pose: MyPose;
  color: number;
  caption: string;
}
const NEW_DRAFT: Draft = { slot: null, fig: 'actor', pose: 'wave', color: 1, caption: '' };

const png = (c: HTMLCanvasElement) => c.toDataURL('image/png');
const themeName = (lang: Lang, id: string) => DICTS[lang].themes[THEME_RULES.findIndex((r) => r.id === id)] ?? id;

/**
 * «Собери свой стикерпак» (/stickers, за флагом shop): игрок сам решает, какие стикеры в его паке в Telegram, —
 * убирает и возвращает открытые, видит, за что откроются закрытые, и собирает свои стикеры в конструкторе
 * (фигурка, поза, цвет, надпись). Превью рисует тот же код, что файл для Telegram на сервере; пак правит бот.
 */
/** Канал игры — если сервер бота старый и не прислал ссылку. */
const CHANNEL = 'https://t.me/benobody_app';

export default function StickersClient() {
  const router = useRouter();
  const [lang, setLang] = useState<Lang>('ru');
  const t = DICTS[lang].shop;
  const b = t.build;
  const [ready, setReady] = useState(false);
  const [tgOn, setTgOn] = useState(false);
  // низ экрана — когда ясно, Telegram ли это и что в паке (иначе мелькает «Открыть в Telegram»)
  const [known, setKnown] = useState(false);
  const [st, setSt] = useState<ShopState | null>(null);
  const [tab, setTab] = useState<Tab>('pack');
  const [pics, setPics] = useState<Record<string, string>>({});
  const [figPics, setFigPics] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(NEW_DRAFT);
  const [tile, setTile] = useState(44);
  const [cols, setCols] = useState(6);
  const [scale, setScale] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lookRef = useRef<MyLook>({ fig: 'actor', pose: 'wave', color: 1, text: [] });

  const s = st ?? PREVIEW;
  const open = useMemo(() => new Set(s.open ?? []), [s.open]);
  const off = useMemo(() => new Set(s.off ?? []), [s.off]);
  const my = s.my ?? [];
  const figs = new Set(s.figs ?? ['actor']);
  const hasPack = !!st?.items.includes('pack');
  const cap = myCaption(draft.caption);
  const capErr = 'error' in cap ? b.errors[cap.error] : '';
  lookRef.current = { fig: draft.fig, pose: draft.pose, color: draft.color, text: 'error' in cap ? lookRef.current.text : cap.lines };

  useEffect(() => {
    const l = detectLang();
    setLang(l);
    document.documentElement.lang = l;
    document.title = `${DICTS[l].shop.build.title} · ${DICTS[l].meta.title}`;
    track('stickers_view', {});
    const tgNow = inTelegram();
    setTgOn(tgNow);
    void (async () => {
      try {
        await Promise.race([document.fonts.load('8px "Press Start 2P"', 'Стикер ABC 42'), new Promise((r) => setTimeout(r, 2500))]);
      } catch {
        /* системный моноширинный */
      }
      // костюмы тем — для стикеров «за игру» и героев площадок
      await loadAllThemes(20000).catch(() => undefined);
      setPics(Object.fromEntries(STICKERS.map((x) => [x.id, png(stickerFrame(x, 5, l))])));
      setFigPics(Object.fromEntries(MY_FIGS.map((f) => [f.id, png(stickerFrame(myDef({ fig: f.id, pose: 'wave', color: 0, text: [] }), 0, l))])));
      setReady(true);
      if (tgNow) {
        await bootTelegram();
        void linkTelegramOnce();
        setSt(await shopState());
      }
      setKnown(true);
    })();
  }, []);

  // картинки своих стикеров (первый кадр с подписью)
  const myPics = useMemo(() => (ready ? Object.fromEntries(my.map((m) => [m.slot, png(stickerFrame(myDef(m), 5, lang))])) : {}), [ready, my, lang]);

  // экран-замок: вернулись из канала (подписка) — проверить шаги заново
  useEffect(() => {
    if (!tgOn || hasPack) return;
    const back = () => {
      if (document.visibilityState === 'visible') void shopState().then((x) => x && setSt(x));
    };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('kto:back', back);
    return () => {
      document.removeEventListener('visibilitychange', back);
      window.removeEventListener('kto:back', back);
    };
  }, [tgOn, hasPack]);

  // пока бот правит пак — спрашиваем, как дела (до минуты)
  useEffect(() => {
    if (!st?.pending) return;
    let n = 0;
    const id = setInterval(() => {
      if (++n > 30) return clearInterval(id);
      void shopState().then((x) => x && setSt(x));
    }, 2000);
    return () => clearInterval(id);
  }, [st?.pending]);

  // сетка: размер ячейки — самый крупный, при котором всё влезает без прокрутки
  const count = STICKER_LIST.length + my.length + (my.length < MY_MAX ? 1 : 0);
  useEffect(() => {
    const el = gridRef.current;
    if (!el || tab !== 'pack') return;
    const fit = () => {
      const W = el.clientWidth;
      const H = el.clientHeight;
      let best = { size: 0, cols: 6 };
      for (let c = 4; c <= 10; c++) {
        const rows = Math.ceil(count / c);
        const size = Math.floor(Math.min((W - (c - 1) * 6) / c, (H - (rows - 1) * 6) / rows, 72));
        if (size > best.size) best = { size, cols: c };
      }
      setTile(best.size);
      setCols(best.cols);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab, count]);

  // превью конструктора: целый масштаб в пикселях экрана, 10 кадров в секунду
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot || tab !== 'make') return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const k = Math.floor(Math.min((slot.clientWidth * dpr) / ST_SIZE, (slot.clientHeight * dpr) / ST_SIZE));
      setScale(k >= 1 ? k : 0);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(slot);
    return () => ro.disconnect();
  }, [tab]);
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !ready || !scale || tab !== 'make') return;
    c.width = ST_SIZE * scale;
    c.height = ST_SIZE * scale;
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    const t0 = performance.now();
    let last = -1;
    let raf = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const f = Math.floor((now - t0) / 100) % 20;
      if (f === last) return;
      last = f;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, c.width, c.height);
      g.drawImage(stickerFrame({ draw: (q, tt) => drawMy(q, lookRef.current, tt) }, f, lang), 0, 0, c.width, c.height);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [ready, scale, tab, lang]);

  /** За что откроется стикер. */
  const howTo = (m: StickerMeta): string => {
    if (m.set === 'starter') return b.earn.starter;
    if (m.set !== 'play' && !st?.items.includes(m.set)) return fmt(b.earn.buy, { item: t.items[m.set].name });
    if (m.earn === 'theme' && m.theme) return fmt(b.earn.theme, { theme: themeName(lang, m.theme) });
    return m.earn ? b.earn[m.earn] : b.earn.starter;
  };
  const figHow = (f: MyFig): string => {
    const d = MY_FIGS.find((x) => x.id === f)!;
    if ('item' in d) return fmt(b.earn.buy, { item: t.items[d.item].name });
    if ('theme' in d) return fmt(b.earn.theme, { theme: themeName(lang, d.theme) });
    return '';
  };
  const figName = (f: MyFig): string => (f === 'actor' || f === 'kotBanan' ? b.figs[f] : themeName(lang, (MY_FIGS.find((x) => x.id === f) as { theme: string }).theme));

  const apply = (r: Awaited<ReturnType<typeof shopPick>>): boolean => {
    if (!r) {
      setNote(t.failed);
      return false;
    }
    if (r.error) {
      setNote(r.error in b.errors ? b.errors[r.error as keyof typeof b.errors] : r.error === 'need_pack' ? b.needPack : b.errors.bad);
      haptic('error');
      return false;
    }
    if (r.body) setSt(r.body);
    return true;
  };

  const tapSticker = async (m: StickerMeta) => {
    setSel(m.id);
    if (!open.has(m.id)) {
      setNote(fmt(b.locked, { how: howTo(m) }));
      return;
    }
    if (!canDrop(m.id)) {
      setNote(b.lureFixed);
      return;
    }
    if (!tgOn || !hasPack || busy) {
      setNote(tgOn ? b.needPack : b.onlyTg);
      return;
    }
    const on = off.has(m.id);
    // сразу на экране, бот догонит
    setSt((x) => x && { ...x, off: on ? (x.off ?? []).filter((i) => i !== m.id) : [...(x.off ?? []), m.id] });
    setNote(on ? b.inPack : b.outPack);
    haptic('light');
    track('stickers_pick', { id: m.id, on });
    setBusy(true);
    apply(await shopPick(m.id, on));
    setBusy(false);
  };

  const editMy = (m: MySticker | null) => {
    setSel(null);
    setDraft(m ? { slot: m.slot, fig: m.fig, pose: m.pose, color: m.color, caption: m.text.join(' ') } : NEW_DRAFT);
    setNote('');
    setTab('make');
  };

  // вне Telegram пак не собрать — сразу в бота, на эту же страницу
  const toTg = (from: string) => {
    track('stickers_to_tg', { from });
    const link = tgLink('stickers');
    if (link) location.href = link;
  };

  const saveMy = async () => {
    if (busy || capErr) return;
    if (!tgOn) return toTg('make');
    // фигурка из набора гардероба ещё не куплена — сразу к покупке
    if (lockedItemFig) return toShop(lockedItemFig);
    if (!hasPack) return setNote(b.needPack);
    if (!figs.has(draft.fig)) return setNote(b.errors.locked);
    setBusy(true);
    setNote(b.syncing);
    track('stickers_my', { fig: draft.fig, pose: draft.pose, edit: draft.slot !== null });
    const ok = apply(await shopMy({ fig: draft.fig, pose: draft.pose, color: draft.color, caption: draft.caption }, draft.slot ?? undefined));
    setBusy(false);
    if (ok) {
      haptic('success');
      setTab('pack');
    }
  };

  const delMy = async () => {
    if (busy || draft.slot === null || !tgOn) return;
    setBusy(true);
    const ok = apply(await shopMyDel(draft.slot));
    setBusy(false);
    if (ok) {
      setNote(b.syncing);
      setTab('pack');
    }
  };

  const claim = async () => {
    if (busy) return;
    setBusy(true);
    setNote(t.sending);
    const r = await shopClaim();
    setBusy(false);
    if (r) setSt(r);
    setNote(r?.error === 'need_sub' ? t.needSub : r?.error === 'need_match' ? t.needMatch : r?.error === 'need_bot' ? t.needBot : r ? '' : t.failed);
  };

  // фигурка набора, который ещё не куплен (кнопка конструктора — «Купить …»)
  const lockedItemFig = ((): ShopItemId | null => {
    const d = MY_FIGS.find((f) => f.id === draft.fig);
    return d && 'item' in d && !figs.has(draft.fig) ? d.item : null;
  })();

  // экран-замок: в Telegram, бесплатный пак ещё не забран — два шага поверх сетки
  const locked = tgOn && !!st && !hasPack;
  const free = st?.free;

  const status = st?.pending ? b.syncing : note;
  const selMeta = STICKER_LIST.find((x) => x.id === sel);
  const buyItem = selMeta && !open.has(selMeta.id) && selMeta.set !== 'play' && selMeta.set !== 'starter' && !st?.items.includes(selMeta.set) ? (selMeta.set as ShopItemId) : null;
  const toPlay = () => {
    track('stickers_lock', { step: 'match' });
    router.push('/?create=1');
  };
  const toChannel = () => {
    track('stickers_lock', { step: 'sub' });
    openTelegram(free?.channel || CHANNEL);
  };
  const toShop = (item: string) => {
    track('stickers_to_shop', { item });
    router.push(`/wardrobe?item=${encodeURIComponent(item)}`);
  };
  const pack = st?.pack ?? null;

  return (
    <main className="daily stickers">
      <TopBar lang={lang} onBack={() => (tab === 'make' ? setTab('pack') : router.push('/wardrobe'))} />
      <h1 className="daily-title">{b.title}</h1>
      <div className="stickers-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'pack'} className={tab === 'pack' ? 'on' : ''} onClick={() => setTab('pack')}>
          {b.tabPack}
        </button>
        <button role="tab" aria-selected={tab === 'make'} className={tab === 'make' ? 'on' : ''} onClick={() => editMy(null)}>
          {b.tabMake}
        </button>
      </div>

      {tab === 'pack' ? (
        <>
          <div className={locked ? 'stickers-grid-slot dim' : 'stickers-grid-slot'} ref={gridRef}>
            {locked && (
              <div className="stickers-lock" role="dialog" aria-label={b.lockTitle}>
                <h2>{b.lockTitle}</h2>
                <p>{b.lockText}</p>
                <ol>
                  <li className={free?.played ? 'done' : ''}>
                    <i>{free?.played ? '✓' : '1'}</i>
                    <span>{b.stepMatch}</span>
                    {!free?.played && (
                      <button className="btn small" onClick={() => toPlay()}>
                        {b.stepPlay}
                      </button>
                    )}
                  </li>
                  <li className={free?.sub ? 'done' : ''}>
                    <i>{free?.sub ? '✓' : '2'}</i>
                    <span>{b.stepSub}</span>
                    {!free?.sub && (
                      <button className="btn small tg" onClick={() => toChannel()}>
                        {b.stepSubBtn}
                      </button>
                    )}
                  </li>
                </ol>
                <p className="muted">{b.lockHint}</p>
              </div>
            )}
            {ready && (
              <div className="stickers-grid" style={{ gridTemplateColumns: `repeat(${cols}, ${tile}px)`, gridAutoRows: `${tile}px` }}>
                {STICKER_LIST.map((m) => {
                  const isOpen = open.has(m.id);
                  const isOff = off.has(m.id);
                  const cls = ['stickers-tile', !isOpen ? 'locked' : isOff ? 'off' : 'in', sel === m.id ? 'sel' : ''].join(' ');
                  return (
                    <button key={m.id} className={cls} onClick={() => void tapSticker(m)} aria-label={t.stickers[m.id].join(' ')} aria-pressed={isOpen && !isOff}>
                      {pics[m.id] && <img src={pics[m.id]} alt="" />}
                      {!isOpen ? <i className="stickers-mark lock">?</i> : !canDrop(m.id) ? <i className="stickers-mark pin">★</i> : !isOff ? <i className="stickers-mark ok">✓</i> : <i className="stickers-mark back">+</i>}
                    </button>
                  );
                })}
                {my.map((m) => (
                  <button key={`my${m.slot}`} className="stickers-tile in mine" onClick={() => editMy(m)} aria-label={m.text.join(' ') || figName(m.fig)}>
                    {myPics[m.slot] && <img src={myPics[m.slot]} alt="" />}
                    <i className="stickers-mark ok">✓</i>
                  </button>
                ))}
                {my.length < MY_MAX && (
                  <button className="stickers-tile add" onClick={() => editMy(null)} aria-label={b.newMy}>
                    +
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="daily-actions" style={{ visibility: known ? 'visible' : 'hidden' }}>
            <p className="stickers-note">
              {selMeta ? <b>{t.stickers[selMeta.id].join(' ')}</b> : null}
              {selMeta ? ' · ' : ''}
              {status || (hasPack ? b.tapHint : fmt(b.myFull, { n: MY_MAX }))}
            </p>
            {buyItem ? (
              // закрытый стикер набора из гардероба — сразу покупка этого набора
              <button className="btn small" onClick={() => toShop(buyItem)}>
                {fmt(b.buyFor, { item: t.items[buyItem].name })}
              </button>
            ) : tgOn && st && !hasPack ? (
              <button className="btn small" onClick={() => void claim()} aria-disabled={busy || (!!free && !(free.played && free.sub))}>
                {t.freeClaim}
              </button>
            ) : pack ? (
              <button className="btn small" onClick={() => openTelegram(pack)}>
                {t.openPack}
              </button>
            ) : (
              !tgOn && (
                <button className="btn small tg" onClick={() => toTg('pack')}>
                  {b.toTg}
                </button>
              )
            )}
          </div>
        </>
      ) : (
        <>
          <div className="daily-slot" ref={slotRef}>
            {ready && (
              <div className="daily-stage stickers-stage" style={{ width: (ST_SIZE * scale) / (globalThis.devicePixelRatio || 1), height: (ST_SIZE * scale) / (globalThis.devicePixelRatio || 1), visibility: scale ? 'visible' : 'hidden' }}>
                <canvas ref={canvasRef} className="daily-canvas" style={{ width: '100%', height: '100%' }} />
              </div>
            )}
          </div>
          <div className="stickers-form">
            <div className="stickers-row stickers-figs" role="radiogroup" aria-label={b.fig}>
              {MY_FIGS.map((f) => {
                const isOpen = figs.has(f.id);
                return (
                  <button
                    key={f.id}
                    role="radio"
                    aria-checked={draft.fig === f.id}
                    className={['stickers-fig', draft.fig === f.id ? 'on' : '', isOpen ? '' : 'locked'].join(' ')}
                    onClick={() => {
                      // фигурку набора из гардероба можно примерить до покупки: кнопка станет «Купить …»
                      if (!isOpen && !('item' in f)) return setNote(`${figName(f.id)}: ${fmt(b.locked, { how: figHow(f.id) })}`);
                      setDraft((d) => ({ ...d, fig: f.id }));
                      if (!isOpen) return setNote(`${figName(f.id)}: ${fmt(b.locked, { how: figHow(f.id) })}`);
                      setNote(figName(f.id));
                    }}
                    aria-label={figName(f.id)}
                  >
                    {figPics[f.id] && <img src={figPics[f.id]} alt="" />}
                    {!isOpen && <i className="stickers-mark lock">?</i>}
                  </button>
                );
              })}
            </div>
            <div className="stickers-row stickers-poses" role="radiogroup" aria-label={b.pose}>
              {MY_POSES.map((p) => (
                <button key={p} role="radio" aria-checked={draft.pose === p} className={draft.pose === p ? 'on' : ''} onClick={() => setDraft((d) => ({ ...d, pose: p }))}>
                  {b.poses[p]}
                </button>
              ))}
            </div>
            <div className="stickers-row stickers-colors" role="radiogroup" aria-label={b.color}>
              {MY_COLORS.map((c, i) => (
                <button key={c} role="radio" aria-checked={draft.color === i} aria-label={c} className={draft.color === i ? 'on' : ''} style={{ background: PAL[c] }} onClick={() => setDraft((d) => ({ ...d, color: i }))} />
              ))}
            </div>
            <input
              className="stickers-input"
              value={draft.caption}
              maxLength={21}
              placeholder={b.captionHint}
              aria-label={b.caption}
              autoComplete="off"
              enterKeyHint="done"
              onChange={(e) => setDraft((d) => ({ ...d, caption: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            <p className={capErr ? 'stickers-note err' : 'stickers-note'}>{capErr || note || ' '}</p>
            <div className="daily-buttons">
              <button className="btn small" onClick={() => void saveMy()} aria-disabled={busy || !!capErr || (tgOn && !lockedItemFig && (!figs.has(draft.fig) || (draft.slot === null && my.length >= MY_MAX)))}>
                {!tgOn ? b.toTg : lockedItemFig ? fmt(b.buyFor, { item: t.items[lockedItemFig].name }) : draft.slot === null ? b.add : b.save}
              </button>
              {draft.slot !== null && (
                <button className="btn small alt" onClick={() => void delMy()} aria-disabled={busy}>
                  {b.del}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </main>
  );
}

