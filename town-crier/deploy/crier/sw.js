/* Town Crier service worker — receives Web Push, shows macOS notifications. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch (err) { d = { title: 'Town Crier', body: e.data && e.data.text() }; }
  const title = d.source && d.source !== 'ogrady.ai' ? `${d.source} — ${d.title}` : (d.title || 'Town Crier');
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    icon: '/crier/icons/icon-192.png',
    badge: '/crier/icons/icon-192.png',
    tag: d.ts ? 'crier-' + d.ts : undefined,
    requireInteraction: d.priority === 'high' || d.priority === 'urgent',
    data: { url: d.url || '/crier/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow(e.notification.data && e.notification.data.url || '/crier/'));
});

/* Passthrough fetch handler — required for installability in Chromium. */
self.addEventListener('fetch', () => {});
