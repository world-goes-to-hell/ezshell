// Service worker of the phone page: shows the push the PC sends when an MCP approval request is
// waiting ({ title, body, tag }: the kind of request and its risk only), and opens the page when the
// notification is tapped (the open tab if there is one).
'use strict'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'ezShell'
  const body = typeof data.body === 'string' ? data.body : ''
  const tag = typeof data.tag === 'string' && data.tag ? data.tag : 'ezshell'
  event.waitUntil(self.registration.showNotification(title, { body, tag, renotify: true, requireInteraction: true }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const open = windows.find((client) => new URL(client.url).origin === self.location.origin)
    if (open) return open.focus()
    return self.clients.openWindow('/')
  })())
})
