// Session + transport for the embedded widget page. Identity here comes ONLY
// from the bearer token the SDK passes in the URL fragment — never a cookie.

import type { InjectionKey } from 'vue'

export interface WidgetEmbedUser {
  id: string
  email: string
  name: string
  image: string | null
}

// Captured at module evaluation, NOT in onMounted: vue-router consumes and
// clears the hash while hydrating, so by the time a component mounts the
// fragment is already gone.
//
// A fragment never reaches a server, so the token stays out of access logs and
// Referer — but it would sit in the address bar and history, hence the wipe.
let capturedToken: string | null = null
if (import.meta.client) {
  const hash = window.location.hash
  if (hash.length > 1) {
    capturedToken = new URLSearchParams(hash.slice(1)).get('token')
    if (capturedToken) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }
}

export function useWidgetEmbed() {
  const token = ref<string | null>(null)
  const user = ref<WidgetEmbedUser | null>(null)
  const status = ref<'loading' | 'authenticated' | 'anonymous'>('loading')

  // The ONLY way this page talks to the API. `credentials: 'omit'` is the whole
  // point, and fetch's default ('same-origin') is wrong here: under a same-site
  // self-host a Lax cookie really is sent, so the frame would render whoever is
  // logged into this browser instead of the identity in the token. It also masks
  // revoked sessions, which silently kills the expired-session path.
  async function widgetFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(path, {
      ...init,
      credentials: 'omit',
      headers: {
        // FormData must set its own Content-Type so the multipart boundary
        // survives; only JSON bodies get the header spelled out here.
        ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
        ...(token.value ? { Authorization: `Bearer ${token.value}` } : {}),
      },
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { message?: string } | null
      // A plain Error with the status attached: createError() is server-flavoured
      // and this runs only in the browser.
      const err = new Error(body?.message || `Request failed (${res.status})`) as Error & { statusCode: number }
      err.statusCode = res.status
      throw err
    }
    return await res.json() as T
  }

  async function loadSession(): Promise<boolean> {
    token.value = capturedToken
    if (!token.value) {
      status.value = 'anonymous'
      return false
    }
    try {
      const body = await widgetFetch<{ user?: WidgetEmbedUser }>('/api/auth/get-session')
      if (!body?.user) throw new Error('no user')
      user.value = body.user
      status.value = 'authenticated'
      return true
    }
    catch {
      // The SDK is expected to silently re-exchange and rebuild the frame.
      token.value = null
      status.value = 'anonymous'
      return false
    }
  }

  return { token, user, status, widgetFetch, loadSession }
}

// Refs are per call: a child calling the composable gets an unauthenticated one.
export type WidgetEmbedSession = ReturnType<typeof useWidgetEmbed>
export const widgetEmbedKey = Symbol('widgetEmbed') as InjectionKey<WidgetEmbedSession>
