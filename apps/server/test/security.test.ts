import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClipStore } from '../src/clips';
import { silentLogger } from '../src/log';
import { GameServer } from '../src/server';

/**
 * Регрессии ревью безопасности (docs/security.md): каждое исправление — с тестом, который падал бы до него.
 * Сервер за Caddy (trustProxy): адрес игрока — из X-Forwarded-For, как в проде.
 */

const SECRET = 'test-secret-test-secret-test-secret!!';
let servers: GameServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(extra: Partial<ConstructorParameters<typeof GameServer>[0]> = {}) {
  const srv = new GameServer({ authSecret: SECRET, log: silentLogger, trustProxy: true, ...extra });
  servers.push(srv);
  const port = await srv.listen(0, '127.0.0.1');
  return { srv, http: `http://127.0.0.1:${port}` };
}

const from = (ip: string, h: Record<string, string> = {}) => ({ ...h, 'x-forwarded-for': ip });

async function anon(http: string, ip: string): Promise<string> {
  const r = await fetch(`${http}/v1/auth/anon`, { method: 'POST', headers: from(ip) });
  return ((await r.json()) as { token: string }).token;
}

describe('ревью безопасности', () => {
  it('M1: коды комнат не перебрать — промахи с одного адреса ограничены, другие адреса и своя машина не страдают', async () => {
    const { http } = await boot();
    const codes = ['ZZZA', 'ZZZB', 'ZZZC', 'ZZZD', 'ZZZE', 'ZZZF'];
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await fetch(`${http}/v1/rooms/${codes[i % codes.length]}`, { headers: from('203.0.113.5') })).status);
    expect(statuses.slice(0, 30).every((s) => s === 404)).toBe(true);
    expect(statuses[30]).toBe(429);
    // другой адрес — как обычно
    expect((await fetch(`${http}/v1/rooms/ZZZA`, { headers: from('203.0.113.6') })).status).toBe(404);
    // запрос изнутри машины (превью ссылок сайта, сосед-экземпляр) — без лимита
    for (let i = 0; i < 40; i++) expect((await fetch(`${http}/v1/rooms/ZZZA`)).status).toBe(404);
  });

  it('M2: обложку клипа меняет только его автор', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec-clips-'));
    dirs.push(dir);
    const { http } = await boot({ clips: new ClipStore(dir) });
    const [a, b] = [await anon(http, '198.51.100.1'), await anon(http, '198.51.100.2')];
    const up = await fetch(`${http}/v1/clips`, { method: 'POST', headers: from('198.51.100.1', { authorization: `Bearer ${a}`, 'content-type': 'video/mp4' }), body: Buffer.alloc(5000, 1) });
    expect(up.status).toBe(200);
    const { id } = (await up.json()) as { id: string };
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(500, 7)]);
    const thumb = (token: string, ip: string) => fetch(`${http}/v1/clips/${id}/thumb`, { method: 'POST', headers: from(ip, { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg' }), body: jpeg });
    expect((await thumb(b, '198.51.100.2')).status).toBe(404);
    expect((await thumb(a, '198.51.100.1')).status).toBe(200);
  });

  it('M3: загрузки клипов ограничены и по адресу, а не только по игроку', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec-clips-'));
    dirs.push(dir);
    const { http } = await boot({ clips: new ClipStore(dir) });
    const ip = '192.0.2.9';
    let limited = 0;
    // каждый раз новый токен: лимит на игрока (12 за 10 минут) так не сработал бы
    for (let i = 0; i < 61; i++) {
      const t = await anon(http, `192.0.2.${100 + (i % 50)}`);
      const r = await fetch(`${http}/v1/clips`, { method: 'POST', headers: from(ip, { authorization: `Bearer ${t}`, 'content-type': 'video/mp4' }), body: Buffer.alloc(1200, 1) });
      if (r.status === 429) limited++;
    }
    expect(limited).toBe(1);
  });
});

describe('подпись видео-карточки (M3)', () => {
  it('свои ссылки остаются, чужие адреса, домены, @упоминания и невидимые символы — нет', async () => {
    const { safeCaption } = await import('../src/bot');
    const site = 'https://benobody.app';
    expect(safeCaption('Наш фильм в «Массовке» 🎬 Сыграем?\nhttps://benobody.app/ABCDE', site)).toBe('Наш фильм в «Массовке» 🎬 Сыграем?\nhttps://benobody.app/ABCDE');
    expect(safeCaption('Меня вырезал игрок Оля 😤 Найдёшь меня в массовке?', site)).toBe('Меня вырезал игрок Оля 😤 Найдёшь меня в массовке?');
    expect(safeCaption('Приз тут: https://evil.example/win и t.me/scam, пиши @scam_bot', site)).toBe('Приз тут: и пиши');
    expect(safeCaption('бесплатно на evil.com/x?y=1 сейчас', site)).toBe('бесплатно на сейчас');
    expect(safeCaption('Оля‮теслем​ 👨‍👩', site)).toBe('Олятеслем 👨‍👩');
    expect(safeCaption('а вот https://benobody.app.evil.com/', site)).toBe('а вот');
  });
});
