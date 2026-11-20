import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import { DICTS } from '@kto/game-core';
import type { Lang } from '@kto/game-core';

/**
 * Картинка превью ссылки 1200×630 в стиле игры. Фон (полосы, площадь ×2 в рамке, «?») — готовый PNG
 * из кадра настоящей игры (assets/og/bg.png); текст — пиксельным шрифтом, кегли кратны 8.
 */
export const OG_SIZE = { width: 1200, height: 630 };

const C = {
  ink: '#181425',
  yellow: '#fee761',
  amber: '#feae34',
  rust: '#be4a2f',
  coral: '#f6757a',
  sand: '#ead4aa',
  mist: '#c0cbdc',
  cyan: '#2ce8f5',
  white: '#ffffff',
  night: '#262b44',
};

let assets: Promise<{ bg: string; fonts: { name: string; data: Buffer; weight: 400; style: 'normal' }[] }> | null = null;
function load() {
  assets ??= (async () => {
    const dir = join(process.cwd(), 'assets/og');
    const [bg, cyr, lat] = await Promise.all([
      readFile(join(dir, 'bg.png')),
      readFile(join(dir, 'press-start-2p-cyrillic-400-normal.woff')),
      readFile(join(dir, 'press-start-2p-latin-400-normal.woff')),
    ]);
    return {
      bg: `data:image/png;base64,${bg.toString('base64')}`,
      fonts: [
        // у шрифтов разные имена: с одинаковым генератор берёт только первый и ищет кириллицу в сети
        { name: 'PS2P', data: lat, weight: 400 as const, style: 'normal' as const },
        { name: 'PS2PCyr', data: cyr, weight: 400 as const, style: 'normal' as const },
      ],
    };
  })();
  return assets;
}

export interface OgInput {
  /** Язык отправителя ссылки (из параметра l). */
  lang: Lang;
  /** Пригласивший (если ссылка на комнату). */
  host?: string | null;
  code?: string;
  players?: number;
  site: string;
}

const fit = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export async function renderOg(o: OgInput): Promise<ImageResponse> {
  const { bg, fonts } = await load();
  const room = !!o.code;
  const T = DICTS[o.lang].og;
  const host = o.host ? fit(o.host, 14) : null;
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', position: 'relative', fontFamily: 'PS2P, PS2PCyr', background: C.ink }}>
        <img src={bg} width={1200} height={630} alt="" style={{ position: 'absolute', left: 0, top: 0 }} />
        <div style={{ position: 'absolute', left: 64, top: 64, width: 680, display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 16, color: C.amber, letterSpacing: 0 }}>{room ? T.invite : T.party}</div>
          <div style={{ fontSize: 48, color: C.yellow, marginTop: 28, textShadow: `4px 4px 0 ${C.rust}, 8px 8px 0 ${C.ink}`, lineHeight: 1.3 }}>
            {T.title}
          </div>
          {room ? (
            <div style={{ display: 'flex', flexDirection: 'column', marginTop: 40 }}>
              {host ? (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <div style={{ fontSize: 32, color: C.white, lineHeight: 1.4 }}>{host}</div>
                  <div style={{ fontSize: 24, color: C.sand, marginTop: 12 }}>{T.callsYou}</div>
                </div>
              ) : (
                <div style={{ fontSize: 24, color: C.sand }}>{T.called}</div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', marginTop: 36 }}>
                <div style={{ fontSize: 16, color: C.mist, marginRight: 20 }}>{T.code}</div>
                <div
                  style={{
                    display: 'flex',
                    fontSize: 40,
                    color: C.ink,
                    background: C.amber,
                    padding: '14px 20px 10px',
                    boxShadow: `0 6px 0 ${C.rust}`,
                    letterSpacing: 8,
                  }}
                >
                  {o.code}
                </div>
                {typeof o.players === 'number' && o.players > 0 ? (
                  <div style={{ fontSize: 16, color: C.mist, marginLeft: 24 }}>{`${Math.min(4, o.players)}/4`}</div>
                ) : null}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', marginTop: 40 }}>
              <div style={{ fontSize: 24, color: C.coral, lineHeight: 1.6 }}>{T.tag1}</div>
              <div style={{ fontSize: 24, color: C.coral, lineHeight: 1.6 }}>{T.tag2}</div>
              <div style={{ fontSize: 16, color: C.sand, marginTop: 28, lineHeight: 1.8 }}>{T.line1}</div>
              <div style={{ fontSize: 16, color: C.sand, lineHeight: 1.8 }}>{T.line2}</div>
            </div>
          )}
        </div>
        <div style={{ position: 'absolute', left: 64, bottom: 56, display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 16, color: C.cyan }}>{o.site}</div>
        </div>
      </div>
    ),
    { ...OG_SIZE, fonts },
  );
}
