// Session + transport for the embedded widget page. Identity here comes ONLY
// from a bearer token — never a cookie. Two sources, in order: the token the SDK
// passes in the URL fragment (the product saying who this is), and failing that
// a guest token this frame minted for itself on an earlier visit.

import type { InjectionKey } from 'vue'
import { GUEST_TOKEN_STORAGE_KEY } from '#layers/feedlog/shared/utils/guest'

export interface WidgetEmbedUser {
  id: string
  email: string
  name: string
  image: string | null
  isAnonymous?: boolean
}

// 'guest' = nobody yet, but the org allows writing without a sign-in, so the
// composer stays usable and an identity appears on the first send.
export type WidgetEmbedStatus = 'loading' | 'authenticated' | 'guest' | 'anonymous'

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

function readGuestToken(): string | null {
  try {
    return localStorage.getItem(GUEST_TOKEN_STORAGE_KEY)
  }
  catch {
    // Safari blocks storage for a third-party frame outright. The guest identity
    // then lasts one page load instead of persisting — still better than refusing
    // the write.
    return null
  }
}

function writeGuestToken(token: string): void {
  try {
    localStorage.setItem(GUEST_TOKEN_STORAGE_KEY, token)
  }
  catch { /* see readGuestToken */ }
}

function clearGuestToken(): void {
  try {
    localStorage.removeItem(GUEST_TOKEN_STORAGE_KEY)
  }
  catch { /* see readGuestToken */ }
}

export function useWidgetEmbed() {
  const token = ref<string | null>(null)
  const user = ref<WidgetEmbedUser | null>(null)
  const status = ref<WidgetEmbedStatus>('loading')
  // Set from /api/widget/config once it lands. Starts false so a config that
  // never arrives is read as "no guests", the safe direction.
  const allowGuest = ref(false)
  let mintInFlight: Promise<boolean> | null = null

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

  async function claimGuest(anonymousToken: string): Promise<void> {
    try {
      await widgetFetch('/api/auth/claim-anonymous', {
        method: 'POST',
        body: JSON.stringify({ anonymousToken }),
      })
    }
    catch (e) {
      const statusCode = (e as { statusCode?: number })?.statusCode ?? 0
      // Keep the token only while a retry could plausibly work; the next frame
      // load will try again. Anything else is permanent, and retrying it forever
      // is worse than losing a claim that was never going to land.
      if (statusCode === 0 || statusCode === 429 || statusCode >= 500) return
    }
    // Cleared only once the call has answered. The SDK can drop this iframe
    // mid-call, and clearing up front would throw the claim away when it does —
    // the endpoint is idempotent, so a duplicate costs one no-op request while a
    // dropped token costs the visitor their content.
    clearGuestToken()
  }

  async function loadSession(): Promise<boolean> {
    // The product's own token wins: it names a real person, where the stored one
    // is only whoever last used this browser anonymously.
    const stored = readGuestToken()
    token.value = capturedToken ?? stored
    if (!token.value) {
      status.value = 'anonymous'
      return false
    }
    try {
      const body = await widgetFetch<{ user?: WidgetEmbedUser }>('/api/auth/get-session')
      if (!body?.user) throw new Error('no user')
      user.value = body.user
      status.value = 'authenticated'
      // A stored guest token alongside a product identity means this visitor
      // filed something before the product knew who they were. Fold it in, once.
      if (capturedToken && stored && stored !== capturedToken) void claimGuest(stored)
      return true
    }
    catch {
      // A dead product token means the SDK re-exchanges and rebuilds the frame.
      // A dead stored token is just stale — drop it and carry on as nobody.
      if (!capturedToken) clearGuestToken()
      token.value = null
      user.value = null
      status.value = 'anonymous'
      return false
    }
  }

  async function mint(): Promise<boolean> {
    try {
      // credentials omitted as everywhere else here: better-auth still returns the
      // raw token in the body, and the Set-Cookie it also sends is simply not
      // stored — which is what this frame wants, being bearer-only.
      const res = await fetch('/api/auth/sign-in/anonymous', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      if (!res.ok) return false
      const body = await res.json() as { token?: string | null; user?: WidgetEmbedUser | null }
      if (!body?.token || !body.user) return false
      token.value = body.token
      user.value = body.user
      writeGuestToken(body.token)
      status.value = 'authenticated'
      return true
    }
    catch {
      return false
    }
  }

  // Call before any write. Mints a guest the first time, so a visitor who opens
  // the panel and closes it again leaves nothing behind.
  //
  // Checks the org's switch first, the same way the portal does. The server
  // refuses too, but arriving at a refusal the frame could have predicted costs
  // a wasted guest row and turns a knowable state into a generic send failure.
  function ensureIdentity(): Promise<boolean> {
    if (token.value) return Promise.resolve(true)
    if (!allowGuest.value) return Promise.resolve(false)
    return mintInFlight ?? (mintInFlight = mint().finally(() => { mintInFlight = null }))
  }

  return { token, user, status, allowGuest, widgetFetch, loadSession, ensureIdentity }
}

// Refs are per call: a child calling the composable gets an unauthenticated one.
export type WidgetEmbedSession = ReturnType<typeof useWidgetEmbed>
export const widgetEmbedKey = Symbol('widgetEmbed') as InjectionKey<WidgetEmbedSession>
