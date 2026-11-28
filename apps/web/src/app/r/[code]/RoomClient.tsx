'use client';

import Link from 'next/link';
import QRCode from 'qrcode';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PAL } from '@kto/assets';
import { DICTS, fmt, tp } from '@kto/game-core';
import type { Dict, Lang } from '@kto/game-core';
import { getAudio } from '@/game/audio';
import { tutorialDone } from '@/game/tutorial';
import { TutorialStage } from '@/ui/TutorialStage';
import { isBotUA } from '@/lib/bot';
import { detectLang } from '@/lib/lang';
import { TopBar } from '@/ui/TopBarView';
import type { TopBar as Bar } from '@/ui/topbar';
import { soundEnabled } from '@/ui/topbar';
import { featureOn } from '@/lib/features';
import { playerName, saveName } from '@/lib/name';
import { loadChunk } from '@/lib/chunk';
import { setTrackContext, shareKind, track } from '@/lib/analytics';
import { Snow, useNewYear } from '@/ui/Festive';
import { Actor } from '@/ui/Actor';
import { inTelegram, inviteLink, linkTelegramOnce, telegramInvite, telegramReady, telegramShare, telegramShareCard, tgLink } from '@/lib/telegram';
import { download, shareContent, withLang } from '@/lib/share';
import { Room, SPECTATE_DELAY_MS } from '@/net/room';
import { GAME_API } from '@/lib/env';
import { serverClipFile } from '@/lib/clips';
import type { RemoteSession } from '@kto/net';
import type { Audio as GameAudio, RoundMusic } from '@/game/audio';
import type { RunningGame } from '@/game/boot';
import type { RoomSettings, RoomState } from '@/net/room';

export default function RoomClient({ code, bot = false }: { code: string; bot?: boolean }) {
  const [lang, setLang] = useState<Lang>('ru');
  const t = DICTS[lang];
  const [state, setState] = useState<RoomState | null>(null);
  const roomRef = useRef<Room | null>(null);
  const router = useRouter();
  const bar = useRef<Bar | null>(null);

  useEffect(() => {
    const l = detectLang();
    setLang(l);
    document.documentElement.lang = l;
    // стикеры за матч: сервер должен знать, какой это аккаунт Telegram (один раз на телефон)
    void linkTelegramOnce();
  }, []);

  useEffect(() => {
    let room: Room | null = null;
    let off: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      // боты превью (в т. ч. iMessage — он выполняет скрипты) не входят в комнату и не занимают место
      if (bot || isBotUA(navigator.userAgent)) return;
      // превью и предзагрузка открывают страницу невидимой — входим, только когда её реально видно
      if (document.visibilityState !== 'visible') {
        await new Promise<void>((res) => {
          const on = () => {
            if (document.visibilityState !== 'visible') return;
            document.removeEventListener('visibilitychange', on);
            res();
          };
          document.addEventListener('visibilitychange', on);
        });
        if (cancelled) return;
      }
      // в Telegram — сначала SDK и имя из профиля: входим в комнату уже под ним
      await telegramReady();
      if (cancelled) return;
      setTrackContext({ room: code, mode: 'online' });
      track('page_view', { page: 'room' });
      room = new Room(code);
      roomRef.current = room;
      off = room.subscribe(setState);
      await room.join(playerName(DICTS[detectLang()]));
    })();
    const leave = () => void room?.leave();
    window.addEventListener('pagehide', leave);
    return () => {
      cancelled = true;
      window.removeEventListener('pagehide', leave);
      off?.();
      void room?.leave();
    };
  }, [code, bot]);

  const audioRef = useRef<GameAudio | null>(null);
  const unlockAudio = () => {
    void loadChunk(() => import('@/game/audio')).then(({ getAudio }) => {
      audioRef.current ??= getAudio();
      audioRef.current.unlock();
    });
  };

  // аналитика: вход в лобби (один раз), ошибки комнаты, режиссёр ли я — в контексте всех событий
  const isHostNow = !!state && state.hostId === state.selfId;
  const joinedRef = useRef(false);
  useEffect(() => {
    setTrackContext({ room: code, mode: 'online', host: isHostNow });
  }, [code, isHostNow]);
  useEffect(() => {
    if (!state) return;
    if (state.status === 'lobby' && !joinedRef.current) {
      joinedRef.current = true;
      track('room_join', { members: state.members.length, tutorial: tutorialDone() });
    } else if (state.status === 'watch') track('room_spectate');
    else if (state.status === 'error' && state.error) track('room_error', { error: state.error });
  }, [state?.status, state?.error]);

  // зритель (опоздал к матчу) видит ту же сцену, только смотрит
  const watching = state?.status === 'watch';
  const inGame = (state?.status === 'game' || watching) && !!roomRef.current?.session;
  // обучение поверх лобби: новичку — сразу, остальным — из «Как играть»; матч начнётся — закроется само
  const [tutOpen, setTutOpen] = useState(false);
  const inLobby = state?.status === 'lobby';
  const autoTut = useRef(false);
  useEffect(() => {
    if (!inLobby || autoTut.current) return;
    autoTut.current = true;
    if (!tutorialDone()) setTutOpen(true);
  }, [inLobby]);
  // в лобби — музыка меню; в игре музыкой управляет сцена
  useEffect(() => {
    if (!inGame) getAudio().setMusic('menu');
  }, [inGame]);
  // музыка дубля: по умолчанию только у режиссёра — 2–4 телефона с одной песней вразнобой глушат
  // сигналы. Гость может вернуть её себе (own) — только на своём телефоне. Сменился режиссёр
  // посреди матча — саундтрек переходит к новому
  const [ownMusic, setOwnMusic] = useState(false);
  const [sfxOff, setSfxOff] = useState(false);
  useEffect(() => setSfxOff(!soundEnabled()), []);
  const roomMusic = state?.settings.roomMusic ?? 'host';
  useEffect(() => {
    const level: RoundMusic = ownMusic || roomMusic === 'all' ? 'full' : roomMusic === 'none' ? 'off' : isHostNow ? 'full' : 'quiet';
    getAudio().setRoundMusic(level);
  }, [ownMusic, roomMusic, isHostNow]);
  useEffect(() => () => getAudio().setRoundMusic('full'), []);
  // оркестр из телефонов в лобби: одна песня по часам сервера, партия — по месту в комнате
  // (режиссёр — бас и барабаны, гости — мелодия, арпеджио, аккорды)
  const orchOn = !!state?.settings.orchestra && state.status === 'lobby';
  const orchKey = orchOn ? orderedOnline(state).join(',') : '';
  useEffect(() => {
    const room = roomRef.current;
    if (!orchKey || !room || !state) {
      getAudio().setOrchestra(null);
      return;
    }
    const ids = orchKey.split(',');
    const part = ids.indexOf(state.selfId);
    let live = true;
    void room.serverNow().then((now) => {
      if (live) getAudio().setOrchestra(now && part >= 0 && ids.length > 1 ? { part, parts: ids.length, now } : null);
    });
    return () => {
      live = false;
    };
    // партии меняются, когда меняется состав (orchKey); остальное состояние комнаты не важно
  }, [orchKey]);
  useEffect(() => {
    // отладка и автопроверки: ?dev — звук в консоли как window.__ktoAudio
    if (new URLSearchParams(location.search).has('dev')) (window as unknown as { __ktoAudio: GameAudio }).__ktoAudio = getAudio();
    return () => getAudio().setOrchestra(null);
  }, []);
  // «Назад» и «Выйти в меню» сразу освобождают место в комнате
  const goHome = () => {
    track(inGame ? 'match_exit' : 'room_leave');
    void roomRef.current?.quit();
    router.push('/');
  };
  const topBar = (
    <TopBar
      lang={lang}
      barRef={bar}
      // посреди матча язык не меняем (экран игры пересоздался бы), выход — через «Выйти в меню»
      onLang={
        inGame
          ? undefined
          : (l) => {
              setLang(l);
              document.documentElement.lang = l;
            }
      }
      onHowTo={inGame ? undefined : () => setTutOpen(true)}
      onBack={inGame ? undefined : goHome}
      onExit={inGame ? goHome : undefined}
      noGear={inGame}
      onSound={(on) => setSfxOff(!on)}
      roomMusic={
        state && state.status !== 'connecting' && state.status !== 'error'
          ? {
              mode: roomMusic,
              director: isHostNow,
              own: ownMusic,
              onOwn: setOwnMusic,
            }
          : undefined
      }
    />
  );

  const errorKey = state?.status === 'error' ? state.error : '';
  let screen: React.ReactNode;
  if (errorKey) screen = <ErrorScreen t={t} errorKey={errorKey} />;
  else if (!state || state.status === 'connecting') {
    screen = (
      <main className="lobby center">
        <p className="muted">{t.lobby.connecting}</p>
      </main>
    );
  } else if (inGame) {
    screen = (
      <GameView key={state.gameId} room={roomRef.current!} lang={lang} audio={audioRef} t={t} spectator={watching} onSettings={() => bar.current?.openSettings()} />
    );
  } else screen = <Lobby t={t} lang={lang} state={state} room={roomRef.current!} onGesture={unlockAudio} sfxOff={sfxOff} />;
  return (
    <>
      {topBar}
      {screen}
      {tutOpen && inLobby && <TutorialStage lang={lang} t={t} onClose={() => setTutOpen(false)} />}
    </>
  );
}

/** Экран игры: та же сцена, что в песочнице, но сессия — хост или гость. */
function GameView({
  room,
  lang,
  audio,
  t,
  spectator,
  onSettings,
}: {
  room: Room;
  lang: Lang;
  audio: React.RefObject<GameAudio | null>;
  t: Dict;
  spectator: boolean;
  onSettings: () => void;
}) {
  const settingsRef = useRef(onSettings);
  settingsRef.current = onSettings;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let running: RunningGame | null = null;
    let cancelled = false;
    const session = room.session!;
    const me = session.info(room.state.selfId);
    void loadChunk(() => Promise.all([import('@/game/boot'), import('@/game/audio')])).then(async ([{ bootGame }, { getAudio }]) => {
      if (cancelled || !ref.current) return;
      audio.current ??= getAudio();
      running = await bootGame(ref.current, {
        playerName: me?.name ?? '',
        fontFamily: '"Press Start 2P", monospace',
        audio: audio.current,
        lang,
        createSession: () => session,
        onShare: async (text: string, files?: File[]) => {
          // клипы и карточки уходят в соцсети: ведём на главную — комната занята матчем и через полчаса исчезнет
          const kind = shareKind(files);
          const result = await shareContent({ text, url: withLang(`${location.origin}/`, kind), files });
          track('share', { what: kind, result });
        },
        onEvent: spectator ? undefined : track,
        spectator: spectator ? { delaySec: SPECTATE_DELAY_MS / 1000, watching: () => (session as RemoteSession).watching } : undefined,
        // «Ещё дубль» у режиссёра: вошли новые игроки (досмотрели как зрители) — новый матч с ними
        onRematch: () => room.rematchWithNewcomers(),
        onSave: (file: File) => download(file),
        // клип выбывшего монтирует игровой сервер (Rust); не умеет или занят — пишет телефон
        deathClip: spectator
          ? undefined
          : async (round, mild, onEta) => {
              const c = await room.link?.deathClip(round, lang, mild, onEta);
              return c ? serverClipFile(c, 'kto-tut-zhivoy.mp4') : null;
            },
        onSettings: () => settingsRef.current(),
        // «Фильм матча» монтирует игровой сервер: состояние приходит по той же связи (ServerLink.film)
        film: spectator
          ? undefined
          : {
              current: () => {
                const f = room.link?.film;
                return f && f.state !== 'none' ? f : null;
              },
              on: (h) => room.link?.onFilm(h) ?? (() => undefined),
              url: (id, ext) => `${GAME_API}/v1/clips/${id}.${ext}`,
              rematch: { code: room.state.code, invite: telegramInvite() },
              puzzle: () => room.link?.puzzle ?? null,
            },
      });
      if (cancelled) running.destroy();
      // отладка и автопроверки: ?dev — сцена в консоли как window.__kto
      else if (new URLSearchParams(location.search).has('dev')) (window as unknown as { __kto: RunningGame }).__kto = running;
    });
    return () => {
      cancelled = true;
      running?.destroy();
    };
  }, [room, lang, audio, spectator]);
  return <div ref={ref} className="game-stage" aria-label={t.meta.title} />;
}

function ErrorScreen({ t, errorKey }: { t: Dict; errorKey: string }) {
  const msg = t.lobby.errors[errorKey as keyof Dict['lobby']['errors']] ?? t.lobby.errors.unknown;
  return (
    <main className="lobby center">
      <h1 className="lobby-logo">{t.meta.title}</h1>
      <p className="error" role="alert">
        {msg}
      </p>
      {/* площадка занята (всплеск игроков): сыграть с ботами — песочница работает без сервера */}
      {(errorKey === 'busy' || errorKey === 'server_busy') && (
        <Link className="btn" href="/sandbox?go">
          {t.start.play}
        </Link>
      )}
      <Link className={errorKey === 'busy' || errorKey === 'server_busy' ? 'btn alt' : 'btn'} href="/">
        {errorKey === 'room_full' || errorKey === 'room_playing' || errorKey === 'kicked' || errorKey === 'closed' ? t.lobby.createOwn : t.lobby.backHome}
      </Link>
    </main>
  );
}

export function Lobby({
  t,
  lang,
  state,
  room,
  onGesture,
  sfxOff = false,
}: {
  t: Dict;
  lang: Lang;
  state: RoomState;
  room: Room;
  onGesture: () => void;
  /** Звуки игры выключены в шестерёнке — подсказка «где включить». */
  sfxOff?: boolean;
}) {
  const [qr, setQr] = useState('');
  const ny = useNewYear();
  const [toast, setToast] = useState('');
  const [editing, setEditing] = useState(false);
  /** Режиссёр нажал «✕» у участника — второе нажатие («Убрать?») подтверждает. */
  const [kickAsk, setKickAsk] = useState('');
  const me = state.members.find((m) => m.userId === state.selfId);
  const isHost = state.hostId === state.selfId;
  const online = state.members.filter((m) => m.online);
  // с ИИ-актёрами свободные места займут они — начать можно и одному
  const enough = online.length >= room.minHumans();
  // «Мотор!» — только когда все подключённые игроки нажали «Готов» (режиссёр — не в счёт); сервер проверяет так же
  const allReady = online.every((m) => m.userId === state.hostId || m.ready);
  const canStart = isHost && enough && allReady;
  // язык отправителя в ссылке — для превью в мессенджере (t меняется вместе с языком)
  // в Telegram ссылка и QR — на бота (inviteLink): друг откроет игру сразу в Telegram, в эту комнату
  const url = useMemo(() => (typeof window === 'undefined' ? '' : inviteLink(withLang(`${window.location.origin}/r/${state.code}`, 'invite'))), [state.code, t]);
  // у QR своя метка: так видно, сколько друзей зашло с экрана рядом, а сколько — по ссылке в чате
  const qrUrl = useMemo(() => (typeof window === 'undefined' ? '' : inviteLink(withLang(`${window.location.origin}/r/${state.code}`, 'qr'))), [state.code, t]);

  useEffect(() => {
    if (!qrUrl) return;
    QRCode.toDataURL(qrUrl, { margin: 1, scale: 1, errorCorrectionLevel: 'M', color: { dark: PAL.ink, light: PAL.sand } })
      .then(setQr)
      .catch(() => setQr(''));
  }, [qrUrl]);

  const flash = (s: string) => {
    setToast(s);
    setTimeout(() => setToast(''), 2000);
  };

  const invite = async () => {
    const text = fmt(t.lobby.inviteText, { name: me?.name ?? '' });
    const members = state.members.length;
    // в Telegram — карточкой с кнопкой «Войти в комнату» (игра не закрывается), иначе окном «выбрать чат»;
    // ссылка открывает игру прямо в Telegram, сразу в эту комнату
    if (inTelegram()) {
      if (await telegramShareCard({ kind: 'room', code: state.code })) {
        track('invite', { result: 'telegram_card', members });
        return;
      }
      if (telegramShare(tgLink(`r_${state.code}`) ?? url, text)) {
        track('invite', { result: 'telegram', members });
        return;
      }
    }
    try {
      if (navigator.share) {
        await navigator.share({ title: t.meta.title, text, url });
        track('invite', { result: 'shared', members });
        return;
      }
    } catch {
      track('invite', { result: 'cancelled', members });
      return;
    }
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      flash(t.lobby.copied);
      track('invite', { result: 'copied', members });
    } catch {
      flash(url);
      track('invite', { result: 'failed', members });
    }
  };

  const slots = [0, 1, 2, 3].map((i) => state.members[i]);
  // главная внизу: пока звать некого, кроме себя, — «Позвать в массовку»; потом «Мотор!», а «Позвать» — в шапку
  const inviteFirst = isHost && !enough;
  const [sheet, setSheet] = useState(false);
  const orchFlag = useMemo(() => featureOn('orchestra'), []);
  const [bigQr, setBigQr] = useState(false);
  const st = state.settings;
  const summary = [
    fmt(t.lobby.sec, { n: st.roundSec }),
    tp(lang, t.lobby.roundsN, st.maxRounds),
    t.start.levels[levelOf(st)],
    ...(st.aiFill ? [t.lobby.aiFill] : []),
    t.lobby.musicSummary[st.roomMusic ?? 'host'],
  ].join(' · ');

  return (
    <main className="lobby lobby2">
      {ny && <Snow />}

      {/* приглашение одной строкой: QR (тап — крупно, для камеры друга), код, «Позвать» второй кнопкой */}
      <section className="inv" aria-label={t.lobby.codeLabel}>
        <button className="inv-qr" onClick={() => setBigQr(true)} aria-label={t.lobby.qrBig}>
          {qr ? <img src={qr} alt="" width={96} height={96} /> : <span />}
        </button>
        <div className="inv-code">
          <span className="muted">{t.lobby.codeLabel}</span>
          <span className="room-code">{state.code}</span>
          {!inviteFirst && (
            <button className="btn small alt" onClick={invite}>
              {t.lobby.inviteShort}
            </button>
          )}
        </div>
      </section>

      {/* игроки — сетка 2×2: человечек цвета игрока, имя, плашка; готовый машет */}
      <section className="cast" aria-label={fmt(t.lobby.players, { n: state.members.length })}>
        {slots.map((m, i) =>
          m ? (
            <div key={m.userId} className={`cast-card${m.online ? '' : ' offline'}${kickAsk === m.userId ? ' ask' : ''}${m.userId === state.selfId && editing ? ' editing' : ''}`}>
              <Actor color={m.color} waving={m.ready || m.userId === state.hostId} skin={m.skin} fx={m.fx} />
              {m.userId === state.selfId && editing ? (
                <NameEditor
                  initial={m.name}
                  label={t.lobby.rename}
                  onDone={(n) => {
                    setEditing(false);
                    if (n && n !== m.name) {
                      saveName(n);
                      void room.rename(n);
                    }
                  }}
                />
              ) : (
                <button
                  className="name"
                  disabled={m.userId !== state.selfId}
                  onClick={() => setEditing(true)}
                  aria-label={m.userId === state.selfId ? t.lobby.rename : undefined}
                >
                  {m.name}
                </button>
              )}
              <span className="badges">
                {m.userId === state.selfId && <span className="badge you">{t.lobby.you}</span>}
                {m.userId === state.hostId && <span className="badge host">{t.lobby.host}</span>}
                {m.ready && <span className="badge ready">{t.lobby.ready}</span>}
              </span>
              {isHost && m.userId !== state.selfId && (
                <button
                  className="kick"
                  aria-label={fmt(t.lobby.kick, { name: m.name })}
                  onClick={() => {
                    if (kickAsk !== m.userId) {
                      setKickAsk(m.userId);
                      setTimeout(() => setKickAsk((k) => (k === m.userId ? '' : k)), 3000);
                      return;
                    }
                    setKickAsk('');
                    void room.kick(m.userId).then((ok) => !ok && flash(t.lobby.errors.unknown));
                  }}
                >
                  ✕
                </button>
              )}
              {kickAsk === m.userId && <span className="ask-label">{t.lobby.kickConfirm}</span>}
            </div>
          ) : (
            <div key={'empty' + i} className="cast-card empty">
              <Actor empty />
              <span className="muted">{st.aiFill ? t.lobby.aiSlot : t.lobby.emptySlot}</span>
              {st.aiFill && <span className="badges"><span className="badge ai">{t.lobby.aiTag}</span></span>}
            </div>
          ),
        )}
      </section>

      {/* настройки — сводкой; режиссёр меняет их в нижнем листе, гость просто видит условия */}
      {isHost ? (
        <button className="summary" onClick={() => setSheet(true)} aria-label={t.lobby.settings}>
          <span>{summary}</span>
          <span className="summary-edit">&gt;</span>
        </button>
      ) : (
        <p className="summary">{summary}</p>
      )}

      {/* «Включи звук» — в потоке под условиями, чтобы нижняя кнопка его не закрыла */}
      <SoundHint t={t} off={sfxOff} />

      {/* главное действие прибито к низу */}
      <div className="lobby-dock">
        {isHost ? (
          inviteFirst ? (
            <button className="btn" onClick={invite}>
              {t.lobby.invite}
            </button>
          ) : (
            <>
            <button className="btn" disabled={!canStart} onClick={() => {
                if (!canStart) return;
                onGesture();
                track('lobby_start', { members: state.members.length, online: online.length, level: levelOf(st), kids: !!st.kidsMode, strict: !!st.strictCrowd, aiFill: !!st.aiFill });
                void room.startMatch();
              }}>
              {t.lobby.start}
            </button>
            {!allReady ? <p className="muted">{t.lobby.waitReady}</p> : online.length === 1 && st.aiFill && <p className="muted">{t.lobby.soloHint}</p>}
            </>
          )
        ) : (
          <>
            <button className={`btn ${me?.ready ? 'on' : ''}`} aria-pressed={!!me?.ready} onClick={() => {
                onGesture();
                void room.setReady(!me?.ready);
              }}>
              {me?.ready ? `✓ ${t.lobby.ready}` : t.lobby.imReady}
            </button>
            {me?.ready && <p className="muted">{t.lobby.waitHost}</p>}
          </>
        )}
      </div>

      {sheet && (
        <div className="lobby-sheet" role="dialog" aria-label={t.lobby.settings} onClick={(e) => e.target === e.currentTarget && setSheet(false)}>
          <div className="lobby-sheet-box">
            <Settings t={t} settings={st} onChange={(s2) => void room.updateSettings(s2)} orchestra={orchFlag} />
            <button className="btn small" onClick={() => setSheet(false)}>
              {t.lobby.done}
            </button>
          </div>
        </div>
      )}

      {bigQr && (
        <button className="qr-full" onClick={() => setBigQr(false)} aria-label={t.ui.close}>
          {qr && <img src={qr} alt="" />}
          <span className="room-code">{state.code}</span>
          <span className="muted">{t.lobby.qrHint}</span>
        </button>
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </main>
  );
}

/** Участники в сети по порядку партий оркестра: режиссёр, потом кто раньше пришёл. */
function orderedOnline(s: RoomState): string[] {
  return s.members
    .filter((m) => m.online)
    .sort((a, b) => (a.userId === s.hostId ? -1 : b.userId === s.hostId ? 1 : a.joinedAt - b.joinedAt))
    .map((m) => m.userId);
}

/** Пиксельный динамик 8×8 (как значок звука в игре). */
const SPEAKER = ['...o..o.', '..oo.o.o', 'oooo..o.', 'oooo.o.o', 'oooo.o.o', 'oooo..o.', '..oo.o.o', '...o..o.'];

/**
 * «Включи звук»: сигналы игры («Море волнуется», удары, звёзды) — звуком; беззвучный режим iPhone
 * игра не видит, поэтому просим заранее. Выключены звуки в шестерёнке — подсказываем, где включить.
 */
function SoundHint({ t, off }: { t: Dict; off: boolean }) {
  return (
    <p className="sound-hint">
      <svg viewBox="0 0 8 8" width="16" height="16" aria-hidden="true" shapeRendering="crispEdges" fill="currentColor">
        {SPEAKER.flatMap((r, y) => [...r].map((c, x) => (c === 'o' ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" /> : null)))}
      </svg>
      {off ? t.lobby.soundOffHint : t.lobby.soundHint}
    </p>
  );
}

function NameEditor({ initial, label, onDone }: { initial: string; label: string; onDone: (n: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <form
      className="name-edit"
      onSubmit={(e) => {
        e.preventDefault();
        onDone(v.trim().slice(0, 14));
      }}
    >
      <input value={v} maxLength={14} autoFocus aria-label={label} onChange={(e) => setV(e.target.value)} onBlur={() => onDone(v.trim().slice(0, 14))} />
    </form>
  );
}

/** Уровень сложности по полям комнаты: старая комната с обоими флажками — «Жёсткая». */
export function levelOf(s: Pick<RoomSettings, 'kidsMode' | 'strictCrowd'>): 'easy' | 'normal' | 'hard' {
  return s.strictCrowd ? 'hard' : s.kidsMode ? 'easy' : 'normal';
}

function Settings({ t, settings, onChange, orchestra = false }: { t: Dict; settings: RoomSettings; onChange: (s: RoomSettings) => void; orchestra?: boolean }) {
  const level = levelOf(settings);
  const music = settings.roomMusic ?? 'host';
  return (
    <section className="settings" aria-label={t.lobby.settings}>
      <h2>{t.lobby.settings}</h2>
      <div className="setting">
        <span>{t.lobby.roundLength}</span>
        <div className="seg" role="group" aria-label={t.lobby.roundLength}>
          {([60, 75, 90] as const).map((v) => (
            <button key={v} aria-pressed={settings.roundSec === v} onClick={() => onChange({ ...settings, roundSec: v })}>
              {fmt(t.lobby.sec, { n: v })}
            </button>
          ))}
        </div>
      </div>
      <div className="setting">
        <span>{t.lobby.rounds}</span>
        <div className="seg" role="group" aria-label={t.lobby.rounds}>
          {([3, 5, 7] as const).map((v) => (
            <button key={v} aria-pressed={settings.maxRounds === v} onClick={() => onChange({ ...settings, maxRounds: v })}>
              {v}
            </button>
          ))}
        </div>
      </div>
      {/* сложность одним переключателем; поля комнаты прежние (kidsMode, strictCrowd) — старые клиенты их понимают */}
      <div className="setting stack">
        <span>{t.start.difficulty}</span>
        <div className="seg" role="radiogroup" aria-label={t.start.difficulty}>
          {(['easy', 'normal', 'hard'] as const).map((v) => (
            <button key={v} role="radio" aria-checked={level === v} aria-pressed={level === v}
              onClick={() => onChange({ ...settings, kidsMode: v === 'easy', strictCrowd: v === 'hard' })}>
              {t.start.levels[v]}
            </button>
          ))}
        </div>
      </div>
      <p className="setting-hint level-hint">{t.start.levelHints[level]}</p>
      <label className="setting check">
        <input type="checkbox" checked={!!settings.aiFill} onChange={(e) => onChange({ ...settings, aiFill: e.target.checked })} />
        <span>{t.lobby.aiFill}</span>
      </label>
      <p className="setting-hint">{t.lobby.aiFillHint}</p>
      {/* где играет музыка дубля: 2–4 телефона с одной песней вразнобой — каша */}
      <div className="setting">
        <span>{t.lobby.music}</span>
        <div className="seg" role="radiogroup" aria-label={t.lobby.music}>
          {(['host', 'all', 'none'] as const).map((v) => (
            <button key={v} role="radio" aria-checked={music === v} aria-pressed={music === v}
              onClick={() => {
                if (v !== music) track('sound_toggle', { what: 'room_music', mode: v });
                onChange({ ...settings, roomMusic: v });
              }}>
              {t.lobby.musicModes[v]}
            </button>
          ))}
        </div>
      </div>
      <p className="setting-hint level-hint">{t.lobby.musicHints[music]}</p>
      {orchestra && (
        <>
          <label className="setting check">
            <input type="checkbox" checked={!!settings.orchestra} onChange={(e) => {
                track('sound_toggle', { what: 'orchestra', on: e.target.checked });
                onChange({ ...settings, orchestra: e.target.checked });
              }} />
            <span>{t.lobby.orchestra}</span>
          </label>
          <p className="setting-hint">{t.lobby.orchestraHint}</p>
        </>
      )}
    </section>
  );
}
