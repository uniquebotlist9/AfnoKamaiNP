/* AfnoKamai service worker — stale-while-revalidate for pages, JS and
   static assets (cached copy answers instantly, a background no-cache
   fetch keeps it honest), plus real Web Push delivery.

   The push handlers below are what make notifications arrive while the
   site is closed. They only ever *display*; the subscription document is
   owned by the page (js/push.js) because Firestore auth does not exist
   inside a service worker. */
const CACHE = 'afnokamai-v15';
const ASSETS = [
  'assets/icon.svg',
  'css/fonts.css?v=1',
  'css/global.css?v=6',
  'css/auth.css?v=2',
  'css/app.css?v=7',
  'css/chat.css?v=3',
  'css/notifications.css?v=1',
  'css/admin.css?v=1'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // Pages: stale-while-revalidate. The cached copy answers instantly, so
  // switching sections is a direct swap — no spinner flash on every nav — while
  // a background `no-cache` fetch revalidates, so the *next* switch always
  // has the freshest HTML (at most one navigation behind). A non-OK
  // revalidation drops the cached copy so a page we removed cannot linger.
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/') {
    const net = fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone)).catch(() => {});
        } else if (res && !res.ok) {
          caches.open(CACHE).then((c) => c.delete(e.request)).catch(() => {});
        }
        return res; // hand the caller the Response itself, not the put() promise
      })
      .catch(() => null);
    e.respondWith(
      caches.match(e.request).then(
        (cached) =>
          cached ||
          net.then((res) => res || caches.match('/'))
      ).then((r) => r || Promise.reject(new TypeError('offline and not cached')))
    );
    return;
  }

  // JS: stale-while-revalidate. The cached copy answers instantly, so repeat
  // navigations never wait on the network (the old network-first path forced
  // ~19 conditional round trips before a page could boot), while a background
  // `no-cache` fetch still checks the server every time — so a release lands
  // on the very next navigation instead of the hour the HTTP cache would
  // otherwise hold it. Offline: the cache copy is the only answer.
  if (url.pathname.endsWith('.js')) {
    const net = fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone)).catch(() => {});
        }
        return res; // hand the caller the Response itself, not the put() promise
      })
      .catch(() => null);
    e.respondWith(
      caches.match(e.request).then(
        (cached) =>
          cached ||
          net.then((res) => {
            if (res) return res;
            return Promise.reject(new TypeError('offline and not cached'));
          })
      )
    );
    return;
  }

  // Other static assets (css/images): stale-while-revalidate, same policy
  // as pages and JS. Pure cache-first pinned an entry forever — an edit
  // shipped without a ?v= bump (or an old tab carrying the previous query)
  // could never reach that browser again, which is how stale bytes of
  // global.css kept tiling the admin panel's select chevron. Answer from
  // cache now, revalidate in the background, drop the entry if the asset
  // was removed server-side.
  const net = fetch(e.request, { cache: 'no-cache' })
    .then((res) => {
      if (res && res.ok && res.type === 'basic') {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone)).catch(() => {});
      } else if (res && !res.ok) {
        caches.open(CACHE).then((c) => c.delete(e.request)).catch(() => {});
      }
      return res;
    })
    .catch(() => null);
  e.respondWith(
    caches.match(e.request).then(
      (cached) =>
        cached ||
        net.then((res) => res || Promise.reject(new TypeError('offline and not cached')))
    )
  );
});

/* ─── Web Push ───────────────────────────────────────────────────────
   These handlers are the reason a notification reaches the device while
   the site is closed. The page cannot do any of this — when every tab is
   gone, only the service worker is still alive.

   Hard requirement: because the subscription is created with
   `userVisibleOnly: true`, the browser expects a visible notification for
   every push we receive. Failing to show one is treated as a violation.
   So every branch here ends in showNotification(), including the
   malformed-payload branch. */

const ICON = '/assets/icon-512.png';

/* Public half of the VAPID keypair. This is NOT a secret — it is the same
   value as VAPID_PUBLIC_KEY in js/firebase-config.js. It is duplicated
   here because the worker is registered as a classic script (not a
   module), so it cannot import from js/. If you rotate the keypair,
   change BOTH places. */
const VAPID_PUBLIC_KEY =
  'BE059IWEP_ohblWyVzofCA0-hlYSD1-S7H8fCVK5SVe_E7GSzsoP2Wcf7FTvjmopy2xu1N5s9w9UKZ3htWVfMI4';

function base64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json() || {};
    } catch (_) {
      // A non-JSON body is still something the sender meant to show, so
      // fall back to treating the whole body as the message text.
      payload = { body: event.data.text() };
    }
  }

  const title = String(payload.title || 'AfnoKamai').slice(0, 140);
  const body = String(payload.body || 'You have a new notification.').slice(0, 600);

  const options = {
    body,
    icon: typeof payload.icon === 'string' && payload.icon ? payload.icon : ICON,
    badge: ICON,
    // tag = the notification id, so distinct events never silently replace
    // one another (a rejected task must not overwrite an approved one).
    tag: typeof payload.notificationId === 'string' && payload.notificationId
      ? payload.notificationId
      : undefined,
    // Urgent alerts stay on screen until dismissed rather than sliding
    // into the notification shade after a few seconds.
    requireInteraction: payload.priority === 'urgent',
    data: {
      url: typeof payload.url === 'string' ? payload.url : '/notifications',
      notificationId: typeof payload.notificationId === 'string' ? payload.notificationId : '',
      category: typeof payload.category === 'string' ? payload.category : 'system'
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const rawUrl = (event.notification.data && event.notification.data.url) || '/notifications';

  // The URL arrives from a push payload. Never navigate off-origin: a
  // compromised or misconfigured sender must not be able to bounce a user
  // to a phishing page by clicking our own notification.
  let target;
  try {
    target = new URL(rawUrl, self.location.origin);
    if (target.origin !== self.location.origin) {
      target = new URL('/notifications', self.location.origin);
    }
  } catch (_) {
    target = new URL('/notifications', self.location.origin);
  }

  event.waitUntil((async () => {
    const wanted = target.pathname;

    // 1. A window already sitting on the destination: just focus it.
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of open) {
      try {
        if (new URL(client.url).pathname === wanted && 'focus' in client) {
          await client.focus();
          return;
        }
      } catch (_) { /* unparseable url — keep looking */ }
    }

    // 2. Some other window is open: focus it and ask the app to navigate.
    //    A window cannot be navigated from here directly, so the page must
    //    honour this message (registered in js/shell.js).
    for (const client of open) {
      if ('focus' in client) {
        await client.focus();
        client.postMessage({ type: 'notification:navigate', url: target.pathname + target.search });
        return;
      }
    }

    // 3. Nothing open: start a new session at the destination.
    await self.clients.openWindow(target.pathname + target.search);
  })());
});

/* The browser can retire or rotate a subscription on its own — an OS
   update, a storage wipe, or the push service reissuing the endpoint. When
   that happens we re-subscribe immediately so the device keeps receiving
   alerts instead of silently going dark.

   The new endpoint only reaches Firestore on the page's next
   autoSyncIfGranted(); until then the stale record is addressed and the
   sender's 410 handling retires it. */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const reg = await self.registration;
      await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    } catch (_) {
      // Nothing useful to do here — the page re-subscribes on next load.
    }
  })());
});
