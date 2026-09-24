/*
 * Service worker.
 *
 * The previous one registered a fetch handler that consulted a cache nothing
 * ever wrote to, so it added a round trip through the worker on every request
 * and cached nothing. Worse, any entries left over from an earlier version kept
 * being served — which would have pinned the old purple logo on returning
 * visitors after the rebrand.
 *
 * This version bumps a version key, deletes every cache it does not recognise,
 * and takes control immediately.
 */

const CACHE_VERSION = 'vesopa-v2';

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

// No fetch handler: pages are server-rendered and the static assets are already
// cached properly by HTTP headers. An offline shell is worth adding later, on
// purpose, rather than leaving a no-op interceptor in the request path.
