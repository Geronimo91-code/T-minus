// T-Minus Service Worker
// Handles: offline cache, FCM background push, postMessage notification relay.
// Firebase is loaded defensively so the SW always installs even if the CDN fails.

const CACHE_NAME = "tminus-v4";
const PRECACHE = [
  "/",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.json",
];

// ── INSTALL ───────────────────────────────────────────────────
self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(PRECACHE)).catch(() => {})
  );
});

// ── ACTIVATE ──────────────────────────────────────────────────
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── FETCH: cache-first for CDN, network-first for app shell ────
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.pathname.startsWith("/api/")) return;
  if (url.hostname.includes("firestore.googleapis") || url.hostname.includes("firebase.google")) return;

  const isCDN = url.hostname.includes("jsdelivr.net") || url.hostname.includes("gstatic.com");
  if (isCDN) {
    event.respondWith(
      caches.match(event.request).then(cached =>
        cached || fetch(event.request).then(res => {
          if (res.ok) { const cl = res.clone(); caches.open(CACHE_NAME).then(c => c.put(event.request, cl)); }
          return res;
        })
      )
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res.ok && url.origin === self.location.origin) {
          const cl = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, cl));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then(cached => {
        if (cached) return cached;
        if (event.request.mode === "navigate") return caches.match("/");
      }))
  );
});

// ── NOTIFICATION RELAY FROM PAGE ──────────────────────────────
self.addEventListener("message", event => {
  if (event.data && event.data.type === "NOTIFY") {
    const title = event.data.title || "T-Minus";
    const opts  = event.data.opts || {};
    self.registration.showNotification(title, {
      body:     opts.body  || "",
      icon:     opts.icon  || "/icon-192.png",
      badge:    "/icon-192.png",
      tag:      opts.tag   || title,
      renotify: true,
      vibrate:  [150, 80, 150],
      data:     { url: "/" },
    });
  }
});

// ── NOTIFICATION CLICK ────────────────────────────────────────
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const c of list) if ("focus" in c) return c.focus();
      return self.clients.openWindow("/");
    })
  );
});

// ── FIREBASE CLOUD MESSAGING (optional, defensive) ────────────
try {
  importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
  importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");

  firebase.initializeApp({
    apiKey:            "AIzaSyBNPh-0vnQqBWLwf3vfjs7We_yCrJhI5eM",
    authDomain:        "t-minus-29098.firebaseapp.com",
    projectId:         "t-minus-29098",
    storageBucket:     "t-minus-29098.firebasestorage.app",
    messagingSenderId: "423063227627",
    appId:             "1:423063227627:web:749647258fe8d511eb82ae",
  });

  firebase.messaging().onBackgroundMessage(payload => {
    const d = payload.data || {};
    return self.registration.showNotification(d.title || "T-Minus", {
      body:     d.body || "",
      icon:     "/icon-192.png",
      badge:    "/icon-192.png",
      tag:      d.tag || "tminus",
      renotify: true,
      vibrate:  [150, 80, 150],
      data:     { url: "/" },
    });
  });
} catch (e) {
  // FCM unavailable — page-driven notifications still work.
  console.warn("SW: Firebase messaging not loaded:", e && e.message);
}
