import type { Dict } from '@kto/game-core';

const KEY = 'kto:name';

export function randomName(t: Dict): string {
  const a = t.names.adj[Math.floor(Math.random() * t.names.adj.length)];
  const n = t.names.noun[Math.floor(Math.random() * t.names.noun.length)];
  return `${a} ${n}`;
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
