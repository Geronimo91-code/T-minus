// T-Minus Service Worker — background notification relay
// Deploy this file at the root of your Netlify site (same level as index.html)

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Receive NOTIFY messages from the main page and show them even when tab is backgrounded
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'NOTIFY') {
    const { title, opts } = event.data;
    self.registration.showNotification(title, {
      body:      opts.body || '',
      icon:      opts.icon || '/favicon.ico',
      badge:     '/favicon.ico',
      tag:       opts.tag  || title,
      renotify:  true,
      vibrate:   [150, 80, 150],
    });
  }
});

// Clicking the notification focuses the app tab
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('/');
    })
  );
});
