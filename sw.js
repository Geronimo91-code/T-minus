// T-Minus Service Worker — FCM push + background notification relay

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

// Handle background FCM push messages (app closed / backgrounded)
messaging.onBackgroundMessage(payload => {
  const d = payload.data || {};
  return self.registration.showNotification(d.title || 'T-Minus', {
    body:     d.body || '',
    icon:     '/favicon.ico',
    badge:    '/favicon.ico',
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
      icon:     opts.icon || '/favicon.ico',
      badge:    '/favicon.ico',
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

self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(self.clients.claim()));
