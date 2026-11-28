/* global self, caches, fetch, URL */
/* Сервис-воркер «Массовки»: приложение ставится на телефон и открывается без сети.
 * Статика Next (/_next/static — имена с хешем) и иконки: сначала кеш.
 * Страницы: сначала сеть, без сети — сохранённая копия (песочница с ботами работает офлайн).
 * API не кешируется: игре с друзьями нужна сеть. */
const VERSION = 'kto-v1';
const PRECACHE = ['/', '/sandbox', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/favicon.ico'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(PRECACHE))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const cacheFirst = async (req) => {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(VERSION)).put(req, res.clone());
  return res;
};

const networkFirst = async (req) => {
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') (await caches.open(VERSION)).put(req, res.clone());
    return res;
  } catch (err) {
    const hit = (await caches.match(req, { ignoreSearch: true })) || (await caches.match('/'));
    if (hit) return hit;
    throw err;
  }
};

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/') || url.pathname === '/favicon.ico') {
    e.respondWith(cacheFirst(req));
    return;
  }
  // комнаты — только сеть (там живой матч), остальные страницы — сеть с запасной копией
  if (req.mode === 'navigate' && !url.pathname.startsWith('/r/')) e.respondWith(networkFirst(req));
});
