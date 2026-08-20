import type { GuestAction } from '#layers/feedlog/shared/utils/guest'
import { GUEST_TOKEN_STORAGE_KEY } from '#layers/feedlog/shared/utils/guest'

// Guest identity for the portal.
//
// Minted lazily — nothing happens until the visitor actually writes, so browsing
// never leaves a user row behind. The raw session token is kept in localStorage
// because the session cookie is httpOnly: the mint response is the only moment
// this page can keep a copy, and claiming the content later needs one.

// Module-scoped so two writes racing each other (a vote and a comment, say) share
// one mint instead of creating two guests.
let mintInFlight: Promise<boolean> | null = null
let claimInFlight: Promise<void> | null = null

function readToken(): string | null {
  try {
    return localStorage.getItem(GUEST_TOKEN_STORAGE_KEY)
  }
  catch {
    return null
  }
}

function writeToken(token: string): void {
  try {
    localStorage.setItem(GUEST_TOKEN_STORAGE_KEY, token)
  }
  catch {
    // Private mode. The identity still works for this visit; it just can't be
    // claimed onto an account later, which beats refusing the write.
  }
}

function clearToken(): void {
  try {
    localStorage.removeItem(GUEST_TOKEN_STORAGE_KEY)
  }
  catch { /* nothing left to do */ }
}

export function useGuestSession() {
  const portal = usePortalOrg()
  // Reads the session already in the payload instead of asking for it again.
  // useAuthSession() is a useFetch, and its key only dedupes once the answer has
  // landed — several callers starting inside the same tick each get their own
  // request. This composable is used by half a dozen components on one page, so
  // fetching here would multiply that.
  //
  // Requires something up the tree to have awaited useAuthSession() first. The
  // default layout does, and every surface using this sits under it.
  const { data: session } = useNuxtData<{ user?: { isAnonymous?: boolean } } | null>('auth-session')
  const loginModal = useLoginModal()

  const isGuest = computed(() => !!session.value?.user?.isAnonymous)
  // A guest counts as signed in to every API, but the portal chrome must keep
  // offering a real sign-in — so "holds an account" is its own thing.
  const hasAccount = computed(() => !!session.value?.user && !isGuest.value)
  const hasIdentity = computed(() => !!session.value?.user)

  function guestMay(action: GuestAction): boolean {
    return portal.value.guest[action]
  }

  // Whether this visitor may do the thing at all. An account holder always may;
  // everyone else does it as a guest, so it comes down to the org's switches.
  // Deliberately not keyed on "is signed in": a guest is signed in as far as
  // every API is concerned and is still governed by the switches.
  function mayAct(action: GuestAction): boolean {
    return hasAccount.value || guestMay(action)
  }

  // better-auth's own route. It sets the signed session cookie itself and hands
  // back the raw token in the body — the only moment the page can keep a copy,
  // since the cookie is httpOnly.
  //
  // The org's switches are not checked here: this route knows nothing about
  // organizations. ensureIdentity() below refuses ahead of it, and every write
  // endpoint refuses again server-side, which is where the switch is actually
  // enforced.
  async function doMint(): Promise<boolean> {
    try {
      const res = await $fetch<{ token: string | null }>('/api/auth/sign-in/anonymous', {
        method: 'POST',
        body: {},
      })
      if (res.token) writeToken(res.token)
      await refreshNuxtData('auth-session')
      return true
    }
    catch {
      return false
    }
  }

  function mint(): Promise<boolean> {
    const pending = mintInFlight ?? (mintInFlight = doMint().finally(() => { mintInFlight = null }))
    return pending
  }

  // Call this before any write. Returns false when the write must not go ahead —
  // the sign-in modal is already open by then, so the caller just stops.
  async function ensureIdentity(action: GuestAction): Promise<boolean> {
    if (hasAccount.value) return true
    if (!guestMay(action)) {
      loginModal.open()
      return false
    }
    // Already a guest, and allowed: nothing to mint.
    if (hasIdentity.value) return true
    return await mint()
  }

  async function runClaim(anonymousToken: string): Promise<void> {
    let moved = false
    try {
      const res = await $fetch<{ claimed?: boolean }>('/api/auth/claim-anonymous', {
        method: 'POST',
        body: { anonymousToken },
      })
      moved = res?.claimed === true
    }
    catch (e) {
      const status = (e as { statusCode?: number })?.statusCode ?? 0
      // Keep the token only while a retry could plausibly work; the next page
      // load will try again. Anything else is permanent, and retrying it forever
      // is worse than losing a claim that was never going to land.
      if (status === 0 || status === 429 || status >= 500) return
    }
    // Cleared only once the call has answered. Clearing it up front would dedupe
    // across contexts, but it also throws the claim away whenever the context
    // dies mid-call — and the endpoint is idempotent, so a duplicate costs one
    // no-op request while a dropped token costs the visitor their content.
    clearToken()

    // Everything already on screen was rendered before the rows changed owner —
    // the feedback list keeps showing the guest it was fetched with, and it holds
    // its posts in a plain ref, so there is no cached key to invalidate. Reload
    // rather than teach each surface to re-fetch.
    //
    // force, because signing in already reloaded once: the auth-reload plugin
    // fires on the account switch, and reloadNuxtApp leaves a 10-second marker
    // that makes any further reload of the same path a no-op. Without force this
    // call is swallowed and the list stays on the guest.
    //
    // Safe from looping even so: this only runs when the claim moved something,
    // and the token is gone by now, so the next load has nothing to claim.
    if (moved) reloadNuxtApp({ force: true })
  }

  // Runs once, the first time a real account shows up with a guest token still
  // stored. Silent by design: the visitor is told nothing, because from their
  // side nothing happened — their feedback is simply still theirs.
  function claimIfPending(): void {
    if (!import.meta.client || !hasAccount.value) return
    const token = readToken()
    if (!token) return
    // The lock is per-realm while the token is shared across the whole origin,
    // so it only dedupes within this context. Overlap between contexts is left
    // to the endpoint, which answers a spent token with claimed:false.
    claimInFlight ??= runClaim(token).finally(() => { claimInFlight = null })
  }

  return { isGuest, hasAccount, hasIdentity, guestMay, mayAct, ensureIdentity, claimIfPending }
}
