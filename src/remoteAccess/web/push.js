// "알림 켜기" on the phone: web push, so an MCP approval request reaches the phone while the page is
// closed. Offered only when the PC says push is available (HTTPS with a Tailscale certificate) and
// the browser can do it. The subscription lives in the browser's push service; the page stores nothing.
// Plain script (no build step).
(() => {
  'use strict'
  const ns = (window.ezRemote = window.ezRemote || {})

  /** The server's public key (base64url) as the bytes PushManager.subscribe wants */
  function keyBytes(base64url) {
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }

  const isSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext

  /**
   * @param {{ button: HTMLButtonElement, status: HTMLElement, send: (message: object) => void }} options
   */
  ns.createPush = function createPush({ button, status, send }) {
    let publicKey = null
    let busy = false

    function say(text) {
      status.textContent = text
      status.hidden = !text
    }

    async function registration() {
      return navigator.serviceWorker.register('/sw.js', { scope: '/' })
    }

    async function currentSubscription() {
      const reg = await navigator.serviceWorker.getRegistration('/')
      return reg ? reg.pushManager.getSubscription() : null
    }

    async function refreshButton() {
      if (!publicKey || !isSupported()) {
        button.hidden = true
        return
      }
      button.hidden = false
      let subscribed = false
      try {
        subscribed = Notification.permission === 'granted' && (await currentSubscription()) !== null
      } catch {
        subscribed = false
      }
      button.textContent = subscribed ? '알림 끄기' : '알림 켜기'
      button.setAttribute('aria-pressed', String(subscribed))
      button.disabled = busy
    }

    async function turnOn() {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        say('알림이 허용되지 않았습니다. 브라우저의 사이트 설정에서 알림을 허용해 주세요.')
        return
      }
      const reg = await registration()
      await navigator.serviceWorker.ready
      let subscription = await reg.pushManager.getSubscription()
      if (!subscription) {
        subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
      }
      send({ type: 'push-subscribe', subscription: subscription.toJSON() })
      say('알림을 켜는 중…')
    }

    async function turnOff() {
      const subscription = await currentSubscription()
      if (subscription) {
        send({ type: 'push-unsubscribe', endpoint: subscription.endpoint })
        await subscription.unsubscribe()
      }
      say('알림을 껐습니다.')
    }

    button.addEventListener('click', async () => {
      if (busy) return
      busy = true
      button.disabled = true
      try {
        if (button.getAttribute('aria-pressed') === 'true') await turnOff()
        else await turnOn()
      } catch {
        say('알림을 설정하지 못했습니다.')
      } finally {
        busy = false
        await refreshButton()
      }
    })

    return {
      /** `ready.push`: offered only when available and the browser supports it */
      async setAvailability(push) {
        publicKey = push && push.available && typeof push.publicKey === 'string' ? push.publicKey : null
        say('')
        await refreshButton()
        // Already on in this browser: tell the PC again (it may have dropped an expired subscription)
        if (!publicKey || !isSupported() || Notification.permission !== 'granted') return
        try {
          const subscription = await currentSubscription()
          if (subscription) send({ type: 'push-subscribe', subscription: subscription.toJSON() })
        } catch {
          // Shown as off; the button turns it on again
        }
      },
      result({ ok, message }) {
        say(ok ? '' : (message || '알림을 켜지 못했습니다.'))
        void refreshButton()
      },
      reset() {
        publicKey = null
        button.hidden = true
        say('')
      }
    }
  }
})()
