import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

// Precache exactly this build's public shell. Never cache APIs, media or user data.
export function pwaPlugin(): Plugin {
  return {
    name: 'mollytime-pwa',
    apply: 'build',
    generateBundle(_, bundle) {
      const assets = Object.keys(bundle).filter(name => !name.endsWith('.map'));
      const version = createHash('sha256').update(assets.map(name => {
        const item = bundle[name];
        return item.type === 'chunk' ? item.code : String(item.source);
      }).join('')).digest('hex').slice(0, 16);
      const shell = ['/manage/', ...assets.filter(name => name !== 'index.html').map(name => `/manage/${name}`),
        '/manage/manifest.webmanifest', '/manage/favicon.svg', '/manage/brand/mollytime-icon.svg',
        '/manage/icons/maskable-512.png', '/manage/icons/icon-192.png', '/manage/icons/icon-512.png', '/manage/icons/apple-touch-icon.png'];
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: `
const CACHE = 'mollytime-shell-${version}';
const SHELL = ${JSON.stringify(shell)};
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});
self.addEventListener('message', event => {
  if (event.data === 'ACTIVATE_UPDATE') self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('mollytime-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith('/manage/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.open(CACHE).then(cache => cache.match('/manage/'))));
  } else if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(url.pathname)).then(cached => cached || fetch(event.request)));
  }
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clients => {
    const client = clients.find(client => new URL(client.url).pathname.startsWith('/manage/'));
    if (client) { await client.navigate('/manage/#/overview'); return client.focus(); }
    return self.clients.openWindow('/manage/#/overview');
  }));
});
` });
    },
  };
}
