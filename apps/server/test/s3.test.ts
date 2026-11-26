import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ClipStore } from '../src/clips';
import { silentLogger } from '../src/log';
import { S3Client, s3FromEnv, sign } from '../src/s3';
import { GameServer } from '../src/server';

// примеры из документации AWS (Signature V4 для S3): ключи и подписи — оттуда
const AWS = { accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' };
const AT = Date.UTC(2013, 4, 24);

describe('подпись S3 (SigV4)', () => {
  it('GET объекта с заголовками — как в примере AWS', () => {
    const s = sign({
      ...AWS,
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      headers: { range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      at: AT,
    });
    expect(s.signedHeaders).toBe('host;range;x-amz-content-sha256;x-amz-date');
    expect(s.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('подписанная ссылка — как в примере AWS', () => {
    const c = new S3Client({ ...AWS, endpoint: 'https://s3.amazonaws.com', bucket: 'examplebucket', style: 'virtual' }, fetch, () => AT);
    const url = new URL(c.presignGet('test.txt', 86400));
    expect(url.host).toBe('examplebucket.s3.amazonaws.com');
    expect(url.pathname).toBe('/test.txt');
    expect(url.searchParams.get('X-Amz-Signature')).toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  });

  it('ссылка на загрузку (PUT) — как у botocore (S3SigV4QueryAuth, тип и размер в подписи)', () => {
    const c = new S3Client({ endpoint: 'https://s3.example', region: 'ru-1', bucket: 'bucket', accessKey: 'key', secretKey: 'secret' }, fetch, () => Date.UTC(2026, 10, 26, 7, 33, 3));
    const url = new URL(c.presignPut('clips/abc.webm', 600, { type: 'video/webm', length: 5000 }));
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(url.searchParams.get('X-Amz-Signature')).toBe('d0bc818517441c2eef60337fd32ecf87d47a465c9ed3f51abeb8b85aae08abc7');
  });

  it('адрес «путём» (Timeweb) и настройки из окружения', () => {
    expect(s3FromEnv({})).toBeNull();
    const cfg = s3FromEnv({ S3_BUCKET: 'abc-massovka-media', S3_ACCESS_KEY: 'k', S3_SECRET_KEY: 's' })!;
    expect(cfg).toMatchObject({ endpoint: 'https://s3.twcstorage.ru', region: 'ru-1' });
    const url = new URL(new S3Client(cfg, fetch, () => AT).presignGet('clips/a.mp4', 3600, { disposition: 'attachment; filename="x.mp4"' }));
    expect(url.host).toBe('s3.twcstorage.ru');
    expect(url.pathname).toBe('/abc-massovka-media/clips/a.mp4');
    expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="x.mp4"');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
  });
});

/** S3 в памяти: принимает PUT/HEAD/PUT ?lifecycle, проверяет, что запрос подписан. */
function fakeS3() {
  const objects = new Map<string, { body: Buffer; type: string }>();
  const configs = new Map<string, string>();
  let failPut = false;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const h = new Headers(init?.headers);
    if (!h.get('authorization')?.startsWith('AWS4-HMAC-SHA256 Credential=key/')) return new Response('', { status: 403 });
    const key = decodeURIComponent(u.pathname.replace(/^\/bucket\/?/, ''));
    const method = init?.method ?? 'GET';
    if (method === 'PUT' && !key) {
      if (!h.get('content-md5')) return new Response('no md5', { status: 400 });
      configs.set(u.search.slice(1), Buffer.from(init!.body as Uint8Array).toString());
      return new Response('', { status: 200 });
    }
    if (method === 'PUT') {
      if (failPut) return new Response('nope', { status: 500 });
      objects.set(key, { body: Buffer.from(init!.body as Uint8Array), type: h.get('content-type') ?? '' });
      return new Response('', { status: 200 });
    }
    if (method === 'HEAD') return new Response(null, { status: objects.has(key) ? 200 : 404, headers: objects.has(key) ? { 'content-length': String(objects.get(key)!.body.length) } : {} });
    if (method === 'GET') {
      const o = objects.get(key);
      return o ? new Response(new Uint8Array(o.body), { status: 200, headers: { 'content-length': String(o.body.length), 'content-type': o.type } }) : new Response('<Code>NoSuchKey</Code>', { status: 404 });
    }
    return new Response('', { status: 405 });
  }) as typeof fetch;
  return {
    objects,
    configs,
    fetch: f,
    failPuts: (v: boolean) => (failPut = v),
    client: () => new S3Client({ endpoint: 'https://s3.example', region: 'ru-1', bucket: 'bucket', accessKey: 'key', secretKey: 'secret' }, f),
  };
}

const body = (buf: Buffer, type: string) => {
  const r = Readable.from([buf]) as unknown as IncomingMessage;
  r.headers = { 'content-type': type, 'content-length': String(buf.length) };
  return r;
};

describe('клипы в S3', () => {
  let dir = '';
  let srv: GameServer | null = null;
  afterEach(async () => {
    await srv?.close();
    srv = null;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('клип и обложка уходят в бакет, без копии на диске — сервер отдаёт файл из бакета с того же адреса', async () => {
    dir = await mkdtemp(join(tmpdir(), 'clips-s3-'));
    const s3 = fakeS3();
    const store = new ClipStore(dir, Date.now, { s3: s3.client() });
    const video = Buffer.alloc(5000, 7);
    const up = await store.upload('u1', body(video, 'video/mp4'));
    expect(up.status).toBe(200);
    const { id } = up.body as { id: string };
    await store.flushRemote();
    expect(s3.objects.get(`clips/${id}.mp4`)?.body.equals(video)).toBe(true);
    expect(s3.objects.get(`clips/${id}.mp4`)?.type).toBe('video/mp4');

    // фильм с сервера: mp4 и обложка
    const tmp = join(dir, 'film.mp4');
    await writeFile(tmp, Buffer.alloc(3000, 1));
    const film = await store.adopt(tmp, 'mp4', Buffer.from([0xff, 0xd8, 1, 2]));
    // фильм уже в бакете к ответу adopt — и на диске его копии нет
    expect(s3.objects.has(`clips/${film.id}.mp4`)).toBe(true);
    expect(s3.objects.get(`clips/${film.id}.jpg`)?.type).toBe('image/jpeg');
    expect(await store.file(film.id, 'mp4')).toBeNull();
    expect(await store.file(film.id, 'jpg')).toBeNull();

    srv = new GameServer({ authSecret: 'test-secret-test-secret-test-secret!!', log: silentLogger, clips: store });
    const http = `http://127.0.0.1:${await srv.listen(0, '127.0.0.1')}`;
    // пока файл на диске — отдаём сами, как раньше
    const local = await fetch(`${http}/v1/clips/${id}.mp4`, { redirect: 'manual' });
    expect(local.status).toBe(200);
    // диск почистили — ссылка в S3
    await rm(join(dir, `${id}.mp4`));
    // без перенаправления: Telegram не отправил карточку по 302 на S3 (26.11)
    const moved = await fetch(`${http}/v1/clips/${id}.mp4`, { redirect: 'manual' });
    expect(moved.status).toBe(200);
    expect(moved.headers.get('content-type')).toBe('video/mp4');
    expect(moved.headers.get('content-length')).toBe(String(video.length));
    expect(moved.headers.get('content-disposition')).toContain('attachment');
    expect(Buffer.from(await moved.arrayBuffer()).equals(video)).toBe(true);
    const head = await fetch(`${http}/v1/clips/${film.id}.mp4`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('3000');
    // нет ни на диске, ни в бакете — 404
    expect((await fetch(`${http}/v1/clips/${'0'.repeat(20)}.mp4`, { redirect: 'manual' })).status).toBe(404);
    expect(await (await fetch(`${http}/metrics`)).text()).toContain('game_clips_s3_redirects_total 2');
  });

  it('S3 не отвечает — клип всё равно сохранён и отдаётся с диска', async () => {
    dir = await mkdtemp(join(tmpdir(), 'clips-s3-'));
    const s3 = fakeS3();
    s3.failPuts(true);
    const store = new ClipStore(dir, Date.now, { s3: s3.client() });
    const up = await store.upload('u1', body(Buffer.alloc(5000, 3), 'video/webm'));
    expect(up.status).toBe(200);
    await store.flushRemote();
    expect(store.remoteStats.failed).toBe(1);
    const { id } = up.body as { id: string };
    expect(await store.file(id, 'webm')).not.toBeNull();
    // и ссылки в S3 нет — значит, 404, а не битый редирект
    await rm(join(dir, `${id}.webm`));
    expect(await store.remoteUrl(id, 'webm')).toBeNull();
    // фильм при лежащем S3 остаётся на диске и отдаётся оттуда
    const tmp = join(dir, 'film.mp4');
    await writeFile(tmp, Buffer.alloc(3000, 1));
    const film = await store.adopt(tmp, 'mp4');
    expect(await store.file(film.id, 'mp4')).not.toBeNull();
  });

  it('телефон грузит прямо в S3: ссылка PUT с типом и размером в подписи, потом отдаётся из бакета', async () => {
    dir = await mkdtemp(join(tmpdir(), 'clips-s3-'));
    const s3 = fakeS3();
    const store = new ClipStore(dir, Date.now, { s3: s3.client() });
    expect(new ClipStore(dir).direct('u1', { ext: 'mp4', size: 5000 }).status).toBe(404);
    expect(store.direct('u1', { ext: 'mov', size: 5000 }).status).toBe(400);
    expect(store.direct('u1', { ext: 'mp4', size: 13 * 1024 * 1024 }).status).toBe(413);
    const r = store.direct('u1', { ext: 'webm', size: 5000 });
    expect(r.status).toBe(200);
    const d = r.body as { id: string; ext: string; put: string; type: string };
    expect(d.type).toBe('video/webm');
    const put = new URL(d.put);
    expect(put.host).toBe('s3.example');
    expect(put.pathname).toBe(`/bucket/clips/${d.id}.webm`);
    expect(put.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(put.searchParams.get('X-Amz-Expires')).toBe('600');
    // обложка — только к выданному клипу и только его автору (M2: id виден в каждой ссылке)
    expect(store.directThumb('0'.repeat(20), { size: 2000 }, 'u1').status).toBe(404);
    expect(store.directThumb(d.id, { size: 2000 }, 'u2').status).toBe(404);
    expect(store.directThumb(d.id, { size: 999_999 }, 'u1').status).toBe(400);
    expect(new URL((store.directThumb(d.id, { size: 2000 }, 'u1').body as { put: string }).put).pathname).toBe(`/bucket/clips/${d.id}.jpg`);
    // телефон положил файл — GET ведёт в бакет
    s3.objects.set(`clips/${d.id}.webm`, { body: Buffer.alloc(5000), type: 'video/webm' });
    expect(new URL((await store.remoteUrl(d.id, 'webm'))!).pathname).toBe(`/bucket/clips/${d.id}.webm`);
  });

  it('HTTP: /v1/clips/direct и /thumb-url — с токеном игрока', async () => {
    dir = await mkdtemp(join(tmpdir(), 'clips-s3-'));
    const s3 = fakeS3();
    srv = new GameServer({ authSecret: 'test-secret-test-secret-test-secret!!', log: silentLogger, clips: new ClipStore(dir, Date.now, { s3: s3.client() }) });
    const http = `http://127.0.0.1:${await srv.listen(0, '127.0.0.1')}`;
    const call = (p: string, body: unknown, token?: string) =>
      fetch(`${http}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    expect((await call('/v1/clips/direct', { ext: 'mp4', size: 5000 })).status).toBe(401);
    const { token } = (await (await fetch(`${http}/v1/auth/anon`, { method: 'POST' })).json()) as { token: string };
    const r = await call('/v1/clips/direct', { ext: 'mp4', size: 5000 }, token);
    expect(r.status).toBe(200);
    const d = (await r.json()) as { id: string; put: string; type: string };
    expect(d.type).toBe('video/mp4');
    expect(new URL(d.put).pathname).toBe(`/bucket/clips/${d.id}.mp4`);
    const t = await call(`/v1/clips/${d.id}/thumb-url`, { size: 2000 }, token);
    expect(t.status).toBe(200);
    expect(await (await fetch(`${http}/metrics`)).text()).toContain('game_clips_s3_direct_total 1');
  });

  it('срок хранения и CORS — XML с Content-MD5', async () => {
    const s3 = fakeS3();
    const c = s3.client();
    await c.putLifecycle([{ prefix: 'clips/', days: 2 }]);
    await c.putCors();
    expect(s3.configs.get('lifecycle')).toContain('<Filter><Prefix>clips/</Prefix></Filter><Status>Enabled</Status><Expiration><Days>2</Days>');
    expect(s3.configs.get('cors')).toContain('<AllowedMethod>GET</AllowedMethod>');
    expect(s3.configs.get('cors')).toContain('<AllowedMethod>PUT</AllowedMethod>');
  });
});
