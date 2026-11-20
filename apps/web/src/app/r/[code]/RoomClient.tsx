'use client';

import Link from 'next/link';
import QRCode from 'qrcode';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PAL, PLAYER_COLORS } from '@kto/assets';
import { DICTS, fmt } from '@kto/game-core';
import type { Dict, Lang } from '@kto/game-core';
import { LANG_KEY, detectLang } from '@/lib/lang';
import { playerName, saveName } from '@/lib/name';
import { download, shareContent } from '@/lib/share';
import { AuthError, ensureAnonymousUser, supabase } from '@/lib/supabase';
import { Room } from '@/net/room';
import type { Audio as GameAudio } from '@/game/audio';
import type { RunningGame } from '@/game/boot';
import type { RoomSettings, RoomState } from '@/net/room';

export default function RoomClient({ code }: { code: string }) {
  const [lang, setLang] = useState<Lang>('ru');
  const t = DICTS[lang];
  const [state, setState] = useState<RoomState | null>(null);
  const [fatal, setFatal] = useState('');
  const roomRef = useRef<Room | null>(null);

  useEffect(() => {
    const l = detectLang();
    setLang(l);
    document.documentElement.lang = l;
  }, []);

  useEffect(() => {
    let room: Room | null = null;
    let off: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      let uid: string;
      try {
        uid = await ensureAnonymousUser();
      } catch (e) {
        setFatal(e instanceof AuthError ? 'auth' : 'network');
        return;
      }
      if (cancelled) return;
      room = new Room(supabase(), code, uid);
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
  }, [code]);

  const audioRef = useRef<GameAudio | null>(null);
  const unlockAudio = () => {
    void import('@/game/audio').then(({ Audio }) => {
      audioRef.current ??= new Audio();
      audioRef.current.unlock();
    });
  };

  const errorKey = fatal || (state?.status === 'error' ? state.error : '');
  if (errorKey) return <ErrorScreen t={t} errorKey={errorKey} />;
  if (!state || state.status === 'connecting') {
    return (
      <main className="lobby center">
        <p className="muted">{t.lobby.connecting}</p>
      </main>
    );
  }
  if (state.status === 'game' && roomRef.current?.session) {
    return <GameView key={state.gameId} room={roomRef.current} lang={lang} audio={audioRef} t={t} />;
  }
  return <Lobby t={t} lang={lang} setLang={setLang} state={state} room={roomRef.current!} onGesture={unlockAudio} />;
}

/** Экран игры: та же сцена, что в песочнице, но сессия — хост или гость. */
function GameView({ room, lang, audio, t }: { room: Room; lang: Lang; audio: React.RefObject<GameAudio | null>; t: Dict }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let running: RunningGame | null = null;
    let cancelled = false;
    const session = room.session!;
    const me = session.info(room.state.selfId);
    void Promise.all([import('@/game/boot'), import('@/game/audio')]).then(async ([{ bootGame }, { Audio }]) => {
      if (cancelled || !ref.current) return;
      audio.current ??= new Audio();
      running = await bootGame(ref.current, {
        playerName: me?.name ?? '',
        fontFamily: '"Press Start 2P", monospace',
        audio: audio.current,
        lang,
        createSession: () => session,
        onShare: async (text: string, files?: File[]) => {
          await shareContent({ text, url: `${location.origin}/r/${room.state.code}`, files });
        },
        onSave: (file: File) => download(file),
      });
      if (cancelled) running.destroy();
    });
    return () => {
      cancelled = true;
      running?.destroy();
    };
  }, [room, lang, audio]);
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
      <Link className="btn" href="/">
        {errorKey === 'room_full' || errorKey === 'room_playing' ? t.lobby.createOwn : t.lobby.backHome}
      </Link>
    </main>
  );
}

export function Lobby({
  t,
  lang,
  setLang,
  state,
  room,
  onGesture,
}: {
  t: Dict;
  lang: Lang;
  setLang: (l: Lang) => void;
  state: RoomState;
  room: Room;
  onGesture: () => void;
}) {
  const [qr, setQr] = useState('');
  const [toast, setToast] = useState('');
  const [editing, setEditing] = useState(false);
  const me = state.members.find((m) => m.userId === state.selfId);
  const isHost = state.hostId === state.selfId;
  const online = state.members.filter((m) => m.online);
  const canStart = isHost && online.length >= 2;
  const url = useMemo(() => (typeof window === 'undefined' ? '' : `${window.location.origin}/r/${state.code}`), [state.code]);

  useEffect(() => {
    if (!url) return;
    QRCode.toDataURL(url, { margin: 1, scale: 1, errorCorrectionLevel: 'M', color: { dark: PAL.ink, light: PAL.sand } })
      .then(setQr)
      .catch(() => setQr(''));
  }, [url]);

  const flash = (s: string) => {
    setToast(s);
    setTimeout(() => setToast(''), 2000);
  };

  const invite = async () => {
    const text = fmt(t.lobby.inviteText, { name: me?.name ?? '' });
    try {
      if (navigator.share) {
        await navigator.share({ title: t.meta.title, text, url });
        return;
      }
    } catch {
      return;
    }
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      flash(t.lobby.copied);
    } catch {
      flash(url);
    }
  };

  const slots = [0, 1, 2, 3].map((i) => state.members[i]);

  return (
    <main className="lobby">
      <div className="lang-switch" role="group" aria-label={t.start.language}>
        {(['ru', 'en'] as Lang[]).map((l) => (
          <button
            key={l}
            aria-pressed={l === lang}
            onClick={() => {
              setLang(l);
              try {
                localStorage.setItem(LANG_KEY, l);
              } catch {
                /* приватный режим */
              }
            }}
          >
            {l.toUpperCase()}
          </button>
        ))}
      </div>

      <h1 className="lobby-logo">{t.meta.title}</h1>

      <section className="invite-card" aria-label={t.lobby.codeLabel}>
        {qr ? <img className="qr" src={qr} alt="" width={168} height={168} /> : <div className="qr" />}
        <div className="code-block">
          <span className="muted">{t.lobby.codeLabel}</span>
          <span className="room-code">{state.code}</span>
        </div>
      </section>
      <button className="btn" onClick={invite}>
        {t.lobby.invite}
      </button>

      <section className="players" aria-label={fmt(t.lobby.players, { n: state.members.length })}>
        <h2>{fmt(t.lobby.players, { n: state.members.length })}</h2>
        <ul>
          {slots.map((m, i) =>
            m ? (
              <li key={m.userId} className={m.online ? '' : 'offline'}>
                <i className="swatch" style={{ background: PLAYER_COLORS[m.color] }} />
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
                    {m.userId === state.selfId && <span className="tag-you"> · {t.lobby.you}</span>}
                  </button>
                )}
                <span className="badges">
                  {m.userId === state.hostId && <span className="badge host">{t.lobby.host}</span>}
                  {m.ready && <span className="badge ready">{t.lobby.ready}</span>}
                </span>
              </li>
            ) : (
              <li key={'empty' + i} className="empty">
                <i className="swatch" />
                <span className="muted">{t.lobby.emptySlot}</span>
              </li>
            ),
          )}
        </ul>
      </section>

      {isHost && <Settings t={t} settings={state.settings} onChange={(s) => void room.updateSettings(s)} />}

      <div className="lobby-actions">
        {!isHost && (
          <button className={`btn ${me?.ready ? 'on' : ''}`} aria-pressed={!!me?.ready} onClick={() => {
              onGesture();
              void room.setReady(!me?.ready);
            }}>
            {me?.ready ? `✓ ${t.lobby.ready}` : t.lobby.imReady}
          </button>
        )}
        {isHost ? (
          <button className="btn" disabled={!canStart} onClick={() => {
              onGesture();
              void room.startMatch();
            }}>
            {t.lobby.start}
          </button>
        ) : (
          <p className="muted">{t.lobby.waitHost}</p>
        )}
        {isHost && !canStart && <p className="muted">{t.lobby.needTwo}</p>}
      </div>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </main>
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

function Settings({ t, settings, onChange }: { t: Dict; settings: RoomSettings; onChange: (s: RoomSettings) => void }) {
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
      <label className="setting check">
        <input type="checkbox" checked={settings.kidsMode} onChange={(e) => onChange({ ...settings, kidsMode: e.target.checked })} />
        <span>{t.lobby.kids}</span>
      </label>
    </section>
  );
}
