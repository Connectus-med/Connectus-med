/* Connectus service worker — installable, and the app opens offline.
 *
 * Deliberately conservative, because the app is a single HTML file that
 * SELF-UPDATES from the cloud (settings.library_html / ui_version):
 *   - the shell is fetched network-first, so an online load always gets the
 *     freshest index.html; the cached copy is only a fallback for offline
 *   - static files (icons, manifest) are cache-first
 *   - NOTHING from Supabase or the edge functions is ever cached or touched,
 *     so progress, decks and passes always go to the network
 * Bump CACHE when the shell assets change.
 */
var CACHE = 'connectus-shell-v3';
var SHELL = ['./', './index.html', './manifest.webmanifest',
             './icon-192.png', './icon-512.png', './icon-maskable-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return Promise.all(SHELL.map(function (u) {
        return c.add(u).catch(function () { /* a missing optional file must not block install */ });
      })); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  /* only our own origin — never Supabase, never the edge functions */
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/functions/') >= 0) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (r) {
        try { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put('./index.html', copy); }); } catch (err) {}
        return r;
      }).catch(function () {
        return caches.match('./index.html').then(function (r) {
          return r || new Response('<h1>Connectus</h1><p>You are offline and no copy is saved yet.</p>',
                                   { headers: { 'Content-Type': 'text/html' } });
        });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (r) {
        try {
          if (r && r.ok && (url.pathname.endsWith('.png') || url.pathname.endsWith('.webmanifest') || url.pathname.endsWith('.js'))) {
            var copy = r.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); });
          }
        } catch (err) {}
        return r;
      });
    })
  );
});
