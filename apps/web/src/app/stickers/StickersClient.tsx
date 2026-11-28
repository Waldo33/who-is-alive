'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DICTS, EFFECTS, LURE_FX, MY_COLORS, MY_FIGS, MY_MAX, MY_POSES, MY_SLOT_EVERY, STICKER_LIST, THEME_RULES, canDrop, fmt, isEffect, myCaption } from '@kto/game-core';
import type { EffectId, Lang, MyFig, MyPose, MySticker, ShopItemId, StickerId, StickerMeta } from '@kto/game-core';
import { PAL } from '@kto/assets';
import { track } from '@/lib/analytics';
import { detectLang } from '@/lib/lang';
import { bootTelegram, haptic, inTelegram, linkTelegramOnce, openTelegram, shopClaim, shopMy, shopMyDel, shopFx, shopPick, shopRemind, shopBuy, prefetchInvoice, shopCached, shopSignedIn, shopState, tgLink } from '@/lib/telegram';
import type { ShopState } from '@/lib/telegram';
import { prepareWebLogin, resumeWebLogin, startWebLogin } from '@/lib/tg-login';
import type { TgLogin } from '@/lib/tg-login';
import { TopBar } from '@/ui/TopBarView';
import { ST_SIZE, STICKERS, stickerFrame, withCapColor } from '@/game/skins/stickers';
import type { StickerDef } from '@/game/skins/stickers';
import { myDef } from '@/game/skins/my-sticker';
import { holoStrip, withFx } from '@/game/skins/shine';
import type { MyLook } from '@/game/skins/my-sticker';
import { loadAllThemes } from '@/game/themes';
import { buyLabel, itemIcon, starsIcon } from '@/game/skins/wardrobe';

/** Без Telegram (просто сайт): видно, каким бывает пак, — бесплатные стикеры и приманка; собрать можно только в Telegram. */
const PREVIEW: Pick<ShopState, 'open' | 'off' | 'my' | 'figs' | 'earned' | 'pending' | 'pack' | 'items'> = {
  open: STICKER_LIST.filter((s) => s.set === 'starter' && s.now).map((s) => s.id),
  off: [],
  my: [],
  figs: ['actor'],
  earned: [],
  pending: 0,
  pack: null,
  items: [],
};

type Tab = 'pack' | 'make' | 'fx';
interface Draft {
  slot: number | null;
  fig: MyFig;
  pose: MyPose;
  color: number;
  caption: string;
  fx: EffectId | null;
  /** Готовый стикер пака в редакторе: эффект и цвет надписи (null — родной), надпись не меняется. */
  std: StickerId | null;
  stdColor: number | null;
}
const NEW_DRAFT: Draft = { slot: null, fig: 'actor', pose: 'wave', color: 1, caption: '', fx: null, std: null, stdColor: null };

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
  // дневной лимит стикеров за дубли: часы до новых, раз в полминуты
  const [clock, setClock] = useState(() => Date.now());
  const earnNext = st?.earnNext ?? null;
  useEffect(() => {
    if (!earnNext) return;
    setClock(Date.now());
    const h = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(h);
  }, [earnNext]);
  const [tab, setTab] = useState<Tab>('pack');
  // вкладка «Эффекты»: какой эффект на витрине, иконки эффектов, звезда Telegram, игра внутри Telegram (покупка — только там)
  const [fxSel, setFxSel] = useState<EffectId>(EFFECTS[0]);
  const fxSelRef = useRef<EffectId>(EFFECTS[0]);
  fxSelRef.current = fxSel;
  const [fxIcons, setFxIcons] = useState<Record<string, string>>({});
  const [star, setStar] = useState('');
  const [inTg, setInTg] = useState(false);
  const [fxNote, setFxNote] = useState('');
  // витрина открыта из редактора стикера: эффект показываем на нём, купил — сразу на этот стикер
  const [fxFor, setFxFor] = useState<Draft | null>(null);
  // сайт без входа: «Войти через Telegram» (тот же вход через бота, что в гардеробе) — пак собирается и здесь
  const [loginReady, setLoginReady] = useState(false);
  const [pics, setPics] = useState<Record<string, string>>({});
  // стикеры с эффектом (товар «Эффекты»): голограмма — лента кадров для CSS-анимации, нуар — картинка
  const [fxPics, setFxPics] = useState<Record<string, string>>({});
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
  // витрина эффекта: стикер, на котором его показываем
  const fxBaseRef = useRef<Pick<StickerDef, 'draw'>>(STICKERS[0]);

  const s = st ?? PREVIEW;
  const open = useMemo(() => new Set(s.open ?? []), [s.open]);
  const off = useMemo(() => new Set(s.off ?? []), [s.off]);
  const my = s.my ?? [];
  const figs = new Set(s.figs ?? ['actor']);
  const hasPack = !!st?.items.includes('pack');
  const cap = myCaption(draft.caption);
  const capErr = !draft.std && 'error' in cap ? b.errors[cap.error] : '';
  // готовый стикер в редакторе — его рисунок с выбранным цветом надписи и эффектом
  const stdBase = draft.std ? STICKERS.find((x) => x.id === draft.std) : undefined;
  const stdDefRef = useRef<Pick<StickerDef, 'draw'> | null>(null);
  stdDefRef.current = stdBase ? withFx(withCapColor(stdBase, draft.stdColor), draft.fx) : null;
  lookRef.current = { fig: draft.fig, pose: draft.pose, color: draft.color, text: 'error' in cap ? lookRef.current.text : cap.lines, ...(draft.fx ? { fx: draft.fx } : {}) };

  useEffect(() => {
    const l = detectLang();
    setLang(l);
    document.documentElement.lang = l;
    document.title = `${DICTS[l].shop.build.title} · ${DICTS[l].meta.title}`;
    track('stickers_view', {});
    setInTg(inTelegram());
    setStar(starsIcon().toDataURL());
    setFxIcons(Object.fromEntries(EFFECTS.map((fx) => [fx, itemIcon(fx).toDataURL()])));
    // /stickers?fx=holo — сразу вкладка «Эффекты» с этим эффектом (ссылки из гардероба и бота)
    const want = new URLSearchParams(location.search).get('fx');
    if (isEffect(want)) {
      setFxSel(want);
      setTab('fx');
    }
    // в браузере — если вошёл через Telegram на сайте (гардероб › «Войти через Telegram»)
    const tgNow = shopSignedIn();
    setTgOn(tgNow);
    if (!tgNow && !inTelegram()) {
      // вернулись из Telegram на перезагруженную страницу — дождаться начатого входа
      const back = resumeWebLogin();
      if (back) void back.then((l) => (l ? void signedIn(l) : undefined));
      else void prepareWebLogin().then(setLoginReady);
    }
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
      if (tgNow) {
        await bootTelegram();
        // прошлый ответ — сразу, свежий следом (иначе экран сначала «пака нет», потом пак)
        const c = shopCached();
        if (c) {
          setSt(c);
          setKnown(true);
        }
      }
      setReady(true);
      if (tgNow) {
        void linkTelegramOnce();
        const s = await shopState();
        if (s) setSt(s);
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
  // места под свои стикеры открываются постепенно: закрытые — замочками в конце сетки
  const slots = Math.max(my.length, Math.min(MY_MAX, st?.slots ?? MY_MAX));
  const count = STICKER_LIST.length + my.length + (my.length < slots ? 1 : 0) + (MY_MAX - slots);
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
    if (!slot || tab === 'pack') return;
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
    if (!c || !ready || !scale || tab === 'pack') return;
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
      const def = tab === 'make' ? (stdDefRef.current ?? myDef(lookRef.current)) : withFx(fxBaseRef.current, fxSelRef.current);
      g.drawImage(stickerFrame(def, f, lang), 0, 0, c.width, c.height);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [ready, scale, tab, lang]);

  /** За что откроется стикер. */
  const howTo = (m: StickerMeta): string => {
    if (m.set === 'starter') return m.now || !hasPack ? b.earn.starter : b.earn.next;
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

  const waitMs = earnNext ? earnNext - clock : 0;
  const nextNote =
    waitMs > 0
      ? fmt(b.nextIn, {
          time: waitMs >= 3600_000 ? fmt(b.hm, { h: Math.floor(waitMs / 3600_000), m: Math.floor((waitMs % 3600_000) / 60_000) }) : fmt(b.m, { m: Math.max(1, Math.ceil(waitMs / 60_000)) }),
        })
      : null;

  // облик готового стикера в паке: эффект и цвет надписи (у приманки — всегда VHS); ключ картинки — `id:эффект:цвет`
  const lookOf = (id: StickerId): { fx: EffectId | null; col: number | null; key: string | null } => {
    const fx = !canDrop(id) ? LURE_FX : (st?.fx?.[id] ?? null);
    const col = canDrop(id) ? (st?.col?.[id] ?? null) : null;
    return { fx, col, key: fx || col !== null ? `${id}:${fx ?? ''}:${col ?? ''}` : null };
  };
  const looksKey = JSON.stringify([st?.fx ?? {}, st?.col ?? {}]);
  useEffect(() => {
    if (!ready) return;
    const add: Record<string, string> = {};
    for (const m of STICKER_LIST) {
      const { fx, col, key } = lookOf(m.id);
      if (!key || fxPics[key]) continue;
      const def = withCapColor(STICKERS.find((x) => x.id === m.id)!, col);
      add[key] = png(fx === 'holo' ? holoStrip(stickerFrame(def, 5, lang), 3) : stickerFrame(withFx(def, fx), 5, lang));
    }
    if (Object.keys(add).length) setFxPics((p) => ({ ...p, ...add }));
  }, [ready, looksKey, lang]);

  const remindMe = async () => {
    if (busy) return;
    setBusy(true);
    apply(await shopRemind());
    setBusy(false);
  };

  // нажатие на открытый стикер — его редактор (эффект, цвет надписи, убрать/вернуть); на закрытый — за что откроется
  const tapSticker = (m: StickerMeta) => {
    haptic('light');
    if (!open.has(m.id)) {
      setNote('');
      setSel(m.id);
      return;
    }
    setSel(null);
    const lure = !canDrop(m.id);
    setDraft({ ...NEW_DRAFT, std: m.id, caption: t.stickers[m.id].join(' '), fx: lure ? LURE_FX : (st?.fx?.[m.id] ?? null), stdColor: lure ? null : (st?.col?.[m.id] ?? null) });
    setNote(lure ? b.lureFixed : off.has(m.id) ? b.outPack : b.inPack);
    setTab('make');
  };

  const saveStd = async () => {
    const id = draft.std;
    if (!id || busy) return;
    if (!tgOn) return toTg('std');
    if (!hasPack) return setNote(b.needPack);
    setBusy(true);
    setNote(b.syncing);
    track('stickers_std', { id, fx: draft.fx ?? '', color: draft.stdColor ?? -1 });
    const ok = apply(await shopFx(id, draft.fx, draft.stdColor));
    setBusy(false);
    if (ok) {
      haptic('success');
      setTab('pack');
    }
  };

  const togglePick = async (m: StickerMeta) => {
    if (!tgOn || !hasPack || busy || !open.has(m.id) || !canDrop(m.id)) return;
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
    setDraft(m ? { slot: m.slot, fig: m.fig, pose: m.pose, color: m.color, caption: m.text.join(' '), fx: m.fx ?? null, std: null, stdColor: null } : NEW_DRAFT);
    setNote('');
    setTab('make');
  };

  // вход через Telegram на сайте: бот открывается прямо из нажатия, там — «Войти», страница ждёт подтверждения
  const signIn = async () => {
    if (busy) return;
    track('tg_login_tap', { from: 'stickers' });
    setNote(t.loginWait);
    const l = await startWebLogin();
    track('tg_login', { ok: !!l, from: 'stickers' });
    if (!l) {
      setNote(t.loginFail);
      void prepareWebLogin().then(setLoginReady);
      return;
    }
    await signedIn(l);
  };
  const signedIn = async (_l: TgLogin) => {
    setNote('');
    setTgOn(true);
    // этот браузер — тот же игрок Telegram: матчи, сыгранные здесь до входа, засчитаются
    await linkTelegramOnce();
    const x = await shopState();
    if (x) setSt(x);
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
    const ok = apply(await shopMy({ fig: draft.fig, pose: draft.pose, color: draft.color, caption: draft.caption, ...(draft.fx ? { fx: draft.fx } : {}) }, draft.slot ?? undefined));
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
  // готовый стикер в редакторе: приманка — облик закреплён; «Сохранить» — только если что-то поменял
  const stdMeta = STICKER_LIST.find((x) => x.id === draft.std);
  const stdLocked = !!stdMeta && !canDrop(stdMeta.id);
  const stdDirty = !!stdMeta && (draft.fx !== (st?.fx?.[stdMeta.id] ?? null) || draft.stdColor !== (st?.col?.[stdMeta.id] ?? null));

  // витрина эффекта — на выбранном открытом стикере, иначе на своём, иначе на первом открытом
  const owns = new Set(st?.effects ?? []);
  const fxBase = ((): { def: Pick<StickerDef, 'draw'>; name: string } => {
    if (fxFor?.std) return { def: withCapColor(STICKERS.find((x) => x.id === fxFor.std)!, fxFor.stdColor), name: t.stickers[fxFor.std].join(' ') };
    if (fxFor) {
      const c = myCaption(fxFor.caption);
      const text = 'error' in c ? [] : c.lines;
      return { def: myDef({ fig: fxFor.fig, pose: fxFor.pose, color: fxFor.color, text }), name: text.join(' ') || figName(fxFor.fig) };
    }
    const pick = STICKER_LIST.find((x) => x.id === sel && open.has(x.id) && canDrop(x.id));
    const std = (id: string) => ({ def: STICKERS.find((x) => x.id === id)!, name: t.stickers[id as StickerMeta['id']].join(' ') });
    if (pick) return std(pick.id);
    const m = my[0];
    if (m) return { def: myDef({ fig: m.fig, pose: m.pose, color: m.color, text: m.text }), name: m.text.join(' ') || figName(m.fig) };
    return std(STICKER_LIST.find((x) => open.has(x.id) && canDrop(x.id))?.id ?? STICKER_LIST[0].id);
  })();
  fxBaseRef.current = fxBase.def;
  const toFx = (fx: EffectId, from: Draft | null = null) => {
    setFxSel(fx);
    setFxFor(from);
    setFxNote('');
    setTab('fx');
  };
  /** Эффект — на стикер, с которого пришли на витрину: готовый — сразу в пак, свой — в редактор (останется «Сохранить»). */
  const fxApply = async (fx: EffectId) => {
    const d = fxFor;
    if (!d) return setTab('pack');
    setFxFor(null);
    setDraft({ ...d, fx });
    setTab('make');
    if (!d.std) return setNote(b.fxSave);
    setBusy(true);
    setNote(b.syncing);
    if (apply(await shopFx(d.std, fx, d.stdColor))) haptic('success');
    setBusy(false);
  };
  // сайт с входом через Telegram: ссылка на счёт эффекта — заранее (оплата откроется сразу из нажатия)
  useEffect(() => {
    if (!inTg && tgOn && tab === 'fx' && st && !st.effects?.includes(fxSel)) void prefetchInvoice(fxSel);
  }, [inTg, tgOn, tab, st, fxSel]);
  const buyFx = async () => {
    // сайт: с входом через Telegram — оплата в приложении Telegram, без входа — в бота
    if (!inTg && !tgOn) return toTg('fx');
    if (busy || owns.has(fxSel)) return;
    const fx = fxSel;
    setBusy(true);
    setFxNote(inTg ? t.paying : t.payInTg);
    track('shop_buy_tap', { item: fx, from: 'stickers', ...(inTg ? {} : { site: true }) });
    const r = await shopBuy(fx);
    track('shop_buy', { item: fx, status: r, from: 'stickers' });
    if (r === 'paid') {
      haptic('success');
      setFxNote(t.paidWait);
      // эффект записывает бот по уведомлению Telegram — ждём его
      for (let i = 0; i < 10; i++) {
        const x = await shopState();
        if (x) setSt(x);
        if (x?.effects?.includes(fx)) {
          setFxNote('');
          setBusy(false);
          return void fxApply(fx);
        }
        await new Promise((res) => setTimeout(res, 1500));
      }
    } else {
      setFxNote(r === 'cancelled' ? t.cancelled : r === 'pending' ? t.paying : r === 'owned' ? '' : t.failed);
      const x = await shopState();
      if (x) setSt(x);
    }
    setBusy(false);
  };
  // строка эффектов: тот же стикер во всех эффектах — у выбранного в паке и у своего в редакторе
  const draftText = 'error' in cap ? '' : cap.lines.join('|');
  const thumbKey = draft.std ? `std:${draft.std}:${draft.stdColor ?? ''}` : `my:${draft.fig}:${draft.pose}:${draft.color}:${draftText}`;
  const fxThumbs = useMemo(() => {
    if (!ready) return {} as Record<string, string>;
    const def: Pick<StickerDef, 'draw'> | undefined = thumbKey.startsWith('my:')
      ? myDef({ fig: draft.fig, pose: draft.pose, color: draft.color, text: draftText ? draftText.split('|') : [] })
      : stdBase && withCapColor(stdBase, draft.stdColor);
    if (!def) return {} as Record<string, string>;
    return Object.fromEntries([null, ...EFFECTS].map((fx) => [fx ?? 'none', png(stickerFrame(withFx(def, fx), 5, lang))]));
  }, [ready, thumbKey, lang]);
  /**
   * Строка выбора эффекта — всегда на месте (экран не прыгает): «без эффекта» и 7 эффектов квадратиками
   * с этим же стикером. Купленные — накинуть, некупленные — тусклые со звездой, ведут на витрину «Эффекты».
   */
  const fxRow = (cur: EffectId | null, pick: (fx: EffectId | null) => void, on: boolean, idle = b.fxPick) => (
    <div className={on ? 'stickers-fxpick' : 'stickers-fxpick idle'} role="radiogroup" aria-label={b.fx} aria-disabled={!on}>
      {[null, ...EFFECTS.filter((fx) => owns.has(fx)), ...EFFECTS.filter((fx) => !owns.has(fx))].map((fx) => {
        const now = cur === fx;
        const mine = !fx || owns.has(fx);
        const name = fx ? t.items[fx].title : b.fxNone;
        return (
          <button
            key={fx ?? 'none'}
            role="radio"
            aria-checked={now}
            aria-label={name}
            className={[now ? 'on' : '', mine ? '' : 'locked'].join(' ')}
            onClick={() => {
              if (!on) return setNote(idle);
              if (!mine && fx) return toFx(fx, tab === 'make' ? draft : null);
              if (!now) pick(fx);
              setNote(name);
            }}
          >
            {fxThumbs[fx ?? 'none'] && <img src={fxThumbs[fx ?? 'none']} alt="" />}
            {!fx ? <i className="stickers-fxnone" /> : !mine ? <i className="stickers-mark buy">★</i> : null}
          </button>
        );
      })}
    </div>
  );
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
      <TopBar lang={lang} onBack={() => (tab === 'fx' && fxFor ? setTab('make') : tab !== 'pack' ? setTab('pack') : router.push('/wardrobe'))} />
      <h1 className="daily-title">{b.title}</h1>
      <div className="stickers-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'pack' || (tab === 'make' && !!draft.std)} className={tab === 'pack' || (tab === 'make' && draft.std) ? 'on' : ''} onClick={() => setTab('pack')}>
          {b.tabPack}
        </button>
        <button role="tab" aria-selected={tab === 'make' && !draft.std} className={tab === 'make' && !draft.std ? 'on' : ''} onClick={() => editMy(null)}>
          {b.tabMake}
        </button>
        <button role="tab" aria-selected={tab === 'fx'} className={tab === 'fx' ? 'on' : ''} onClick={() => toFx(fxSel)}>
          {b.tabFx}
        </button>
      </div>

      {tab === 'pack' ? (
        <>
          <div className={locked ? 'stickers-grid-slot dim' : 'stickers-grid-slot'} ref={gridRef} style={{ visibility: known ? 'visible' : 'hidden' }}>
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
                  const look = lookOf(m.id);
                  const cls = ['stickers-tile', !isOpen ? 'locked' : isOff ? 'off' : 'in', sel === m.id ? 'sel' : ''].join(' ');
                  return (
                    <button key={m.id} className={cls} onClick={() => tapSticker(m)} aria-label={t.stickers[m.id].join(' ')} aria-pressed={isOpen && !isOff}>
                      {isOpen && look.key && fxPics[look.key] ? (
                        look.fx === 'holo' ? (
                          <span className="stickers-holo">
                            <img src={fxPics[look.key]} alt="" />
                          </span>
                        ) : (
                          <img src={fxPics[look.key]} alt="" />
                        )
                      ) : (
                        pics[m.id] && <img src={pics[m.id]} alt="" />
                      )}
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
                {my.length < slots && (
                  <button className="stickers-tile add" onClick={() => editMy(null)} aria-label={b.newMy}>
                    +
                  </button>
                )}
                {Array.from({ length: MY_MAX - slots }, (_, i) => (
                  <button key={`slot${i}`} className="stickers-tile add slot" onClick={() => setNote(fmt(b.slotLocked, { n: (st?.slotIn ?? 3) + i * MY_SLOT_EVERY }))} aria-label={b.newMy}>
                    <i className="stickers-mark lock">?</i>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="daily-actions" style={{ visibility: known ? 'visible' : 'hidden' }}>
            <p className="stickers-note fix">
              {selMeta ? <b>{t.stickers[selMeta.id].join(' ')}</b> : null}
              {selMeta ? ' · ' : ''}
              {status ||
                (selMeta &&
                  (!open.has(selMeta.id)
                    ? fmt(b.locked, { how: howTo(selMeta) }) + (nextNote && selMeta.earn ? `. ${nextNote}` : '')
                    : !canDrop(selMeta.id)
                      ? b.lureFixed
                      : !tgOn
                        ? b.onlyTg
                        : !hasPack
                          ? b.needPack
                          : (off.has(selMeta.id) ? b.outPack : b.inPack) + (st?.fx?.[selMeta.id] ? ` · ${t.items[st.fx[selMeta.id]!].title}` : ''))) ||
                (hasPack && nextNote ? (
                  <>
                    {nextNote}
                    {' · '}
                    {st?.remind ? (
                      b.reminded
                    ) : (
                      <button className="stickers-link" onClick={() => void remindMe()} aria-disabled={busy}>
                        {b.remind}
                      </button>
                    )}
                  </>
                ) : hasPack ? (
                  b.tapHint
                ) : (
                  fmt(b.myFull, { n: MY_MAX })
                ))}
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
                <>
                  <button className="btn small tg" onClick={() => toTg('pack')}>
                    {b.toTg}
                  </button>
                  {loginReady && (
                    <button className="link" onClick={() => void signIn()}>
                      {b.orLogin}
                    </button>
                  )}
                </>
              )
            )}
          </div>
        </>
      ) : tab === 'fx' ? (
        <>
          {/* эффекты лентой: купленные — с галочкой */}
          <div className="wardrobe-sets stickers-fxset" role="tablist">
            {EFFECTS.map((fx) => (
              <button key={fx} role="tab" aria-selected={fx === fxSel} className={fx === fxSel ? 'wardrobe-set on' : 'wardrobe-set'} onClick={() => toFx(fx, fxFor)} aria-label={t.items[fx].title}>
                {fxIcons[fx] && <img src={fxIcons[fx]} alt="" width={18 * 2} height={30 * 2} />}
                {owns.has(fx) ? <i className="wardrobe-mark mine">✓</i> : null}
              </button>
            ))}
          </div>
          <div className="daily-slot" ref={slotRef}>
            {ready && (
              <div className="daily-stage stickers-stage" style={{ width: (ST_SIZE * scale) / (globalThis.devicePixelRatio || 1), height: (ST_SIZE * scale) / (globalThis.devicePixelRatio || 1), visibility: scale ? 'visible' : 'hidden' }}>
                <canvas ref={canvasRef} className="daily-canvas" style={{ width: '100%', height: '100%' }} />
              </div>
            )}
          </div>
          <div className="daily-actions stickers-fxinfo">
            <p className="stickers-fxname">
              <b>{t.items[fxSel].title}</b> · {t.items[fxSel].tagline}
            </p>
            <p className="stickers-note">{fxNote || (owns.has(fxSel) && !fxFor ? b.fxOwned : `${b.fxHint}: ${fxBase.name}`)}</p>
            {owns.has(fxSel) ? (
              <button className="btn small" onClick={() => void fxApply(fxSel)} aria-disabled={busy}>
                {fxFor ? fmt(b.fxPut, { name: fxBase.name }) : b.back}
              </button>
            ) : inTg || tgOn ? (
              <button className="btn" onClick={() => void buyFx()} aria-disabled={busy}>
                {buyLabel(lang, fxSel)}
                {star && <img className="wardrobe-star" src={star} alt="" width={26} height={26} />}
              </button>
            ) : (
              <button className="btn tg" onClick={() => void buyFx()}>
                {t.buyTg}
              </button>
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
            {draft.std ? null : (<>
            <div className="stickers-row stickers-figs" role="radiogroup" aria-label={b.fig}>
              {/* открытые фигурки — первыми, закрытые — дальше в ленте (порядок внутри групп — как в MY_FIGS) */}
              {[...MY_FIGS.filter((f) => figs.has(f.id)), ...MY_FIGS.filter((f) => !figs.has(f.id))].map((f) => {
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
            </>)}
            {draft.std ? (
              // готовый стикер: родной цвет надписи (перечёркнутый) или один из цветов своих стикеров; у приманки — не меняется
              <div className={stdLocked ? 'stickers-row stickers-colors idle' : 'stickers-row stickers-colors'} role="radiogroup" aria-label={b.color}>
                {[null, ...MY_COLORS.map((_, i) => i)].map((i) => (
                  <button
                    key={i ?? 'own'}
                    role="radio"
                    aria-checked={draft.stdColor === i}
                    aria-label={i === null ? b.colorOwn : MY_COLORS[i]}
                    className={[draft.stdColor === i ? 'on' : '', i === null ? 'own' : ''].join(' ')}
                    style={i === null ? undefined : { background: PAL[MY_COLORS[i]] }}
                    onClick={() => (stdLocked ? setNote(b.lureFixed) : setDraft((d) => ({ ...d, stdColor: i })))}
                  >
                    {i === null && <i className="stickers-fxnone" />}
                  </button>
                ))}
              </div>
            ) : (
              <div className="stickers-row stickers-colors" role="radiogroup" aria-label={b.color}>
                {MY_COLORS.map((c, i) => (
                  <button key={c} role="radio" aria-checked={draft.color === i} aria-label={c} className={draft.color === i ? 'on' : ''} style={{ background: PAL[c] }} onClick={() => setDraft((d) => ({ ...d, color: i }))} />
                ))}
              </div>
            )}
            {fxRow(draft.fx, (fx) => setDraft((d) => ({ ...d, fx })), !stdLocked, b.lureFixed)}
            <input
              className={draft.std ? 'stickers-input locked' : 'stickers-input'}
              readOnly={!!draft.std}
              tabIndex={draft.std ? -1 : undefined}
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
            {draft.std ? (
              <div className="daily-buttons">
                {!stdLocked && (
                  <button className="btn small" onClick={() => void saveStd()} aria-disabled={busy || (tgOn && !stdDirty)}>
                    {tgOn ? b.save : b.toTg}
                  </button>
                )}
                {!stdLocked && tgOn && hasPack && stdMeta && (
                  <button className={off.has(stdMeta.id) ? 'btn small' : 'btn small alt'} onClick={() => void togglePick(stdMeta)} aria-disabled={busy}>
                    {off.has(stdMeta.id) ? b.restore : b.del}
                  </button>
                )}
              </div>
            ) : (
            <div className="daily-buttons">
              <button className="btn small" onClick={() => void saveMy()} aria-disabled={busy || !!capErr || (tgOn && !lockedItemFig && (!figs.has(draft.fig) || (draft.slot === null && my.length >= slots)))}>
                {!tgOn ? b.toTg : lockedItemFig ? fmt(b.buyFor, { item: t.items[lockedItemFig].name }) : draft.slot === null ? b.add : b.save}
              </button>
              {draft.slot !== null && (
                <button className="btn small alt" onClick={() => void delMy()} aria-disabled={busy}>
                  {b.del}
                </button>
              )}
            </div>
            )}
          </div>
        </>
      )}
    </main>
  );
}

