// Outbound postMessage protocol. One-way by design: the iframe talks, the SDK
// listens. No message listener is registered here on purpose — adding one would
// open an inbound surface the protocol says doesn't exist.

import type { InjectionKey } from 'vue'

const PROTOCOL_VERSION = 1

export type WidgetOutboundType = 'ready' | 'auth-requested' | 'unread' | 'navigate' | 'close-request'

export function useWidgetProtocol() {
  const route = useRoute()
  const embedded = ref(false)

  // targetOrigin must never be '*', so the SDK hands us the host origin on the
  // embed URL. We use it verbatim: deriving it here would break Firefox, which
  // has no location.ancestorOrigins and whose referrer the host's referrer-policy
  // may strip, leaving nothing to send to.
  //
  // A forged value buys an attacker nothing: if evil.com frames this page and
  // claims origin=acme.com, the browser sees the real parent and refuses to
  // deliver. targetOrigin stops a message going to the wrong place; it was never
  // the identity boundary — the session token is.
  const parentOrigin = computed(() => {
    const raw = route.query.origin
    return typeof raw === 'string' && raw ? raw : null
  })

  function send(type: WidgetOutboundType, payload?: Record<string, unknown>) {
    if (!embedded.value || !parentOrigin.value) return
    const message = payload === undefined
      ? { v: PROTOCOL_VERSION, type }
      : { v: PROTOCOL_VERSION, type, payload }
    window.parent.postMessage(message, parentOrigin.value)
  }

  function init() {
    embedded.value = window.parent !== window
  }

  return {
    embedded,
    parentOrigin,
    init,
    send,
    ready: () => send('ready'),
    requestAuth: (reason: 'user' | 'expired') => send('auth-requested', { reason }),
    reportUnread: (count: number) => send('unread', { count }),
    navigateToFeedback: (slug: string) => send('navigate', { to: 'feedback', slug }),
    requestClose: () => send('close-request'),
  }
}

// `embedded` is per call and starts false, making a child's send() a no-op.
export type WidgetProtocol = ReturnType<typeof useWidgetProtocol>
export const widgetProtocolKey = Symbol('widgetProtocol') as InjectionKey<WidgetProtocol>
