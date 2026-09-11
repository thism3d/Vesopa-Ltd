/*
 * The venue app's notification worker.
 *
 * Registered with the app's own scope (/app/<slug>/), which the server allows
 * with a Service-Worker-Allowed header. It does one thing: show what the venue
 * sent, and open the app on the message when it is tapped. Nothing is cached --
 * the app itself is fetched fresh, so a venue's rebrand is seen at once.
 *
 * The payload (src/loyalty_app.js deliver):
 *   { id, title, body, image, link, url }
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'News';
  const options = {
    body: data.body || '',
    icon: data.icon || 'icons/Icon-192.png',
    badge: 'icons/Icon-192.png',
    image: data.image || undefined,
    tag: data.id ? 'msg-' + data.id : undefined,
    data: { url: data.url || data.link || self.registration.scope, link: data.link || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || self.registration.scope, self.location.href).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.registration.scope)) {
        await c.focus();
        c.postMessage({ type: 'open', url: target });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
