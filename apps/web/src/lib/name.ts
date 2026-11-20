import type { Dict } from '@kto/game-core';

const KEY = 'kto:name';

/** Имена — до 14 знаков (лимит комнаты): длинней в итогах и подписях не помещаются целиком. */
export const NAME_MAX = 14;

export function randomName(t: Dict): string {
  for (let i = 0; i < 20; i++) {
    const a = t.names.adj[Math.floor(Math.random() * t.names.adj.length)];
    const n = t.names.noun[Math.floor(Math.random() * t.names.noun.length)];
    const s = `${a} ${n}`;
    if (s.length <= NAME_MAX) return s;
  }
  return t.names.noun[0];
}

export function savedName(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveName(name: string): void {
  try {
    localStorage.setItem(KEY, name);
  } catch {
    /* приватный режим */
  }
}

/** Имя игрока: сохранённое или случайное (и сразу сохранить, чтобы не менялось между экранами). */
export function playerName(t: Dict): string {
  const s = savedName();
  if (s) return s;
  const n = randomName(t);
  saveName(n);
  return n;
}
