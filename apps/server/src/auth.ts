import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

/**
 * Анонимный вход: сервер выдаёт игроку id и подписанный токен (HS256, ключ только в секретах).
 * Переносить из Supabase нечего — игроки анонимные. Токен живёт долго: один телефон — один игрок.
 */
export class Auth {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error('AUTH_SIGNING_KEY: нужно не меньше 32 символов');
    this.key = new TextEncoder().encode(secret);
  }

  async issue(): Promise<{ userId: string; token: string }> {
    const userId = randomUUID();
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime('400d')
      .sign(this.key);
    return { userId, token };
  }

  /** id игрока или null, если токен чужой, испорчен или истёк. */
  async verify(token: string): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'] });
      return typeof payload.sub === 'string' ? payload.sub : null;
    } catch {
      return null;
    }
  }
}
