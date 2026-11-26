/**
 * Маленький клиент S3 (подпись AWS Signature V4 на node:crypto, без SDK): положить файл, проверить, что он есть,
 * выдать подписанную ссылку на скачивание или загрузку и поставить бакету правила — срок хранения и CORS.
 *
 * Хранилище — Timeweb S3 в Петербурге (infra/terraform/storage.tf): https://s3.twcstorage.ru, регион ru-1,
 * адресация «путём» (https://s3.twcstorage.ru/<бакет>/<ключ>). Ключи приходят из окружения
 * (S3_ACCESS_KEY / S3_SECRET_KEY — файл /etc/massovka/s3.env, его кладёт выкладка), телефон их не видит:
 * ему достаются только подписанные ссылки.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  /** `virtual` — бакет в имени хоста (как у AWS); у Timeweb — `path` (по умолчанию). */
  style?: 'path' | 'virtual';
}

/** Окружение → настройки S3 или null, если хранилища нет (песочница, локальный запуск, тесты). */
export function s3FromEnv(env: NodeJS.ProcessEnv): S3Config | null {
  if (!env.S3_BUCKET || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) return null;
  return {
    endpoint: (env.S3_ENDPOINT || 'https://s3.twcstorage.ru').replace(/\/$/, ''),
    region: env.S3_REGION || 'ru-1',
    bucket: env.S3_BUCKET,
    accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY,
  };
}

const EMPTY_SHA = createHash('sha256').update('').digest('hex');
const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const hmac = (k: string | Buffer, s: string) => createHmac('sha256', k).update(s).digest();
/** Кодирование по RFC 3986, как требует подпись (encodeURIComponent оставляет !'()*). */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (s: string) => s.split('/').map(enc).join('/');
const amzDate = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export interface SignInput {
  method: string;
  host: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  payloadHash: string;
  at: number;
  region: string;
  accessKey: string;
  secretKey: string;
}

/** Подпись SigV4. Возвращает подпись, строку подписанных заголовков и область (scope). */
export function sign(i: SignInput): { signature: string; signedHeaders: string; scope: string; date: string } {
  const date = amzDate(i.at);
  const scope = `${date.slice(0, 8)}/${i.region}/s3/aws4_request`;
  const headers: Record<string, string> = { host: i.host };
  for (const [k, v] of Object.entries(i.headers ?? {})) headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const query = Object.entries(i.query ?? {})
    .map(([k, v]) => [enc(k), enc(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [i.method, encPath(i.path), query, names.map((n) => `${n}:${headers[n]}\n`).join(''), signedHeaders, i.payloadHash].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonical)].join('\n');
  let k = hmac('AWS4' + i.secretKey, date.slice(0, 8));
  k = hmac(k, i.region);
  k = hmac(k, 's3');
  k = hmac(k, 'aws4_request');
  return { signature: createHmac('sha256', k).update(toSign).digest('hex'), signedHeaders, scope, date };
}

export class S3Client {
  private readonly host: string;
  private readonly base: string;

  constructor(
    readonly cfg: S3Config,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    const u = new URL(cfg.endpoint);
    this.host = cfg.style === 'virtual' ? `${cfg.bucket}.${u.host}` : u.host;
    this.base = `${u.protocol}//${this.host}`;
  }

  private path(key: string): string {
    return this.cfg.style === 'virtual' ? `/${key}` : `/${this.cfg.bucket}/${key}`;
  }

  /** Подписанная ссылка на скачивание (до 7 суток — предел SigV4). */
  presignGet(key: string, expiresSec: number, opts: { disposition?: string } = {}): string {
    return this.presign('GET', key, expiresSec, opts.disposition ? { 'response-content-disposition': opts.disposition } : {}, {});
  }

  /**
   * Подписанная ссылка на загрузку (PUT) одного файла: тип и размер входят в подпись — телефон
   * не положит ни другой файл, ни больше заявленного. Ключей телефон так и не видит.
   */
  presignPut(key: string, expiresSec: number, file: { type: string; length: number }): string {
    return this.presign('PUT', key, expiresSec, {}, { 'content-length': String(file.length), 'content-type': file.type });
  }

  private presign(method: string, key: string, expiresSec: number, extra: Record<string, string>, headers: Record<string, string>): string {
    const at = this.now();
    const date = amzDate(at);
    const query: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.cfg.accessKey}/${date.slice(0, 8)}/${this.cfg.region}/s3/aws4_request`,
      'X-Amz-Date': date,
      'X-Amz-Expires': String(Math.min(604800, Math.max(1, Math.floor(expiresSec)))),
      'X-Amz-SignedHeaders': ['host', ...Object.keys(headers)].sort().join(';'),
      ...extra,
    };
    const s = sign({ method, host: this.host, path: this.path(key), query, headers, payloadHash: 'UNSIGNED-PAYLOAD', at, region: this.cfg.region, accessKey: this.cfg.accessKey, secretKey: this.cfg.secretKey });
    const qs = Object.entries({ ...query, 'X-Amz-Signature': s.signature })
      .map(([k, v]) => `${enc(k)}=${enc(v)}`)
      .join('&');
    return `${this.base}${encPath(this.path(key))}?${qs}`;
  }

  /** Подписанный запрос к бакету (path — ключ объекта или '' для самого бакета). */
  private async request(method: string, key: string, opts: { query?: Record<string, string>; headers?: Record<string, string>; body?: Buffer } = {}): Promise<Response> {
    const at = this.now();
    const payloadHash = opts.body ? sha256(opts.body) : EMPTY_SHA;
    const headers: Record<string, string> = { ...opts.headers, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate(at) };
    const path = key ? this.path(key) : this.cfg.style === 'virtual' ? '/' : `/${this.cfg.bucket}`;
    const s = sign({ method, host: this.host, path, query: opts.query, headers, payloadHash, at, region: this.cfg.region, accessKey: this.cfg.accessKey, secretKey: this.cfg.secretKey });
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKey}/${s.scope}, SignedHeaders=${s.signedHeaders}, Signature=${s.signature}`;
    const qs = Object.entries(opts.query ?? {})
      .map(([k, v]) => (v === '' ? enc(k) : `${enc(k)}=${enc(v)}`))
      .join('&');
    return this.fetchImpl(`${this.base}${encPath(path)}${qs ? '?' + qs : ''}`, {
      method,
      headers,
      body: opts.body ? new Uint8Array(opts.body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
  }

  /** Положить файл с диска (клипы до 12 МБ — читаем целиком). */
  async putFile(key: string, path: string, mime: string, cacheControl = 'public, max-age=172800'): Promise<void> {
    const body = await readFile(path);
    const r = await this.request('PUT', key, { body, headers: { 'content-type': mime, 'cache-control': cacheControl } });
    if (!r.ok) throw new Error(`s3 put ${key}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  }

  /** Положить байты (маленькие файлы: загадки). */
  async putBytes(key: string, body: Buffer, mime: string, cacheControl = 'no-store'): Promise<void> {
    const r = await this.request('PUT', key, { body, headers: { 'content-type': mime, 'cache-control': cacheControl } });
    if (!r.ok) throw new Error(`s3 put ${key}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  }

  /** Прочитать объект целиком; null — его нет. */
  async get(key: string): Promise<Buffer | null> {
    const r = await this.request('GET', key);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`s3 get ${key}: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  /** Открыть объект потоком (GET или HEAD): ответ S3 как есть — статус, длина, тело. */
  open(key: string, method: 'GET' | 'HEAD' = 'GET'): Promise<Response> {
    return this.request(method, key);
  }

  /** Есть ли объект. */
  async has(key: string): Promise<boolean> {
    const r = await this.request('HEAD', key);
    if (r.status === 404) return false;
    if (!r.ok) throw new Error(`s3 head ${key}: HTTP ${r.status}`);
    return true;
  }

  /** Срок хранения по папкам: объекты старше `days` суток бакет удаляет сам. */
  async putLifecycle(rules: { prefix: string; days: number }[]): Promise<void> {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><LifecycleConfiguration>' +
      rules
        .map((r) => `<Rule><ID>${r.prefix.replace(/\W/g, '')}-${r.days}d</ID><Filter><Prefix>${r.prefix}</Prefix></Filter><Status>Enabled</Status><Expiration><Days>${r.days}</Days></Expiration></Rule>`)
        .join('') +
      '</LifecycleConfiguration>';
    await this.putConfig('lifecycle', xml);
  }

  /** CORS: скачивание из web.telegram.org и со страниц сайта; PUT — загрузка клипа с телефона по подписанной ссылке. */
  async putCors(): Promise<void> {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin>' +
      '<AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedHeader>*</AllowedHeader>' +
      '<ExposeHeader>Content-Length</ExposeHeader><MaxAgeSeconds>86400</MaxAgeSeconds></CORSRule></CORSConfiguration>';
    await this.putConfig('cors', xml);
  }

  private async putConfig(name: string, xml: string): Promise<void> {
    const body = Buffer.from(xml);
    const md5 = createHash('md5').update(body).digest('base64');
    const r = await this.request('PUT', '', { query: { [name]: '' }, body, headers: { 'content-type': 'application/xml', 'content-md5': md5 } });
    if (!r.ok) throw new Error(`s3 ${name}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
}
