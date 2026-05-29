// T-Minus Service Worker — FCM push + background notification relay + offline cache

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            "AIzaSyBNPh-0vnQqBWLwf3vfjs7We_yCrJhI5eM",
  authDomain:        "t-minus-29098.firebaseapp.com",
  projectId:         "t-minus-29098",
  storageBucket:     "t-minus-29098.firebasestorage.app",
  messagingSenderId: "423063227627",
  appId:             "1:423063227627:web:749647258fe8d511eb82ae"
});

const messaging = firebase.messaging();

// ── OFFLINE CACHE ─────────────────────────────────────────────────────────────
const CACHE_NAME = "tminus-v2";
// Core app-shell assets to cache on install
const PRECACHE = [
  "/",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.json",
  // CDN assets — icons + Firebase (cached on install so they work offline)
  "https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.34.0/dist/tabler-icons.min.css",
  "https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js",
];

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE)).catch(() => {})
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    // Remove old cache versions
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for API calls; cache-first for CDN assets; stale-while-revalidate for app shell
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  // Never cache API calls or Firestore requests
  if (url.pathname.startsWith("/api/")) return;
  if (url.hostname.includes("firestore.googleapis") || url.hostname.includes("firebase.google")) return;

  // CDN assets (jsDelivr, gstatic) — cache-first, very long lived
  const isCDN = url.hostname.includes("jsdelivr.net") || url.hostname.includes("gstatic.com");
  if (isCDN) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // App shell — network-first, fall back to cache
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then(cached => {
        if (cached) return cached;
        if (event.request.mode === "navigate") return caches.match("/");
      }))
  );
});

// ── FCM PUSH MESSAGES ─────────────────────────────────────────────────────────
// Handle background FCM push messages (app closed / backgrounded)
messaging.onBackgroundMessage(payload => {
  const d = payload.data || {};
  return self.registration.showNotification(d.title || 'T-Minus', {
    body:     d.body || '',
    icon:     '/icon-192.png',
    badge:    '/icon-192.png',
    tag:      d.tag || 'tminus',
    renotify: true,
    vibrate:  [150, 80, 150],
    data:     { url: '/' },
  });
});

// Fallback: handle postMessage relay from page (app open)
self.addEventListener('message', event => {
  if (event.data?.type === 'NOTIFY') {
    const { title, opts } = event.data;
    self.registration.showNotification(title, {
      body:     opts.body || '',
      icon:     opts.icon || '/icon-192.png',
      badge:    '/icon-192.png',
      tag:      opts.tag || title,
      renotify: true,
      vibrate:  [150, 80, 150],
    });
  }
});

// Notification click — focus or open app
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(event.notification.data?.url || '/');
    })
  );
});
