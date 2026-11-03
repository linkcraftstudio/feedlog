import type { Ref } from 'vue'

export const INBOX_STATUS_FILTERS = ['all', 'open', 'pending', 'snoozed', 'closed', 'ai_handling'] as const
export type InboxStatusFilter = typeof INBOX_STATUS_FILTERS[number]

export function inboxStatusFilter(value: unknown): InboxStatusFilter | undefined {
  return INBOX_STATUS_FILTERS.find(status => status === value)
}

// The Inbox status filter the user picked, remembered across visits. A cookie,
// so the server render already lists the right conversations. One ref per app:
// a value set by the dashboard middleware must be what the Inbox page reads in
// the same server render, and separate useCookie refs only see the request.
const refs = new WeakMap<object, Ref<string | null | undefined>>()

export function useInboxStatusCookie() {
  const nuxtApp = useNuxtApp()
  let cookie = refs.get(nuxtApp)
  if (!cookie) {
    cookie = useCookie<string | null | undefined>('fl-inbox-status', { maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' })
    refs.set(nuxtApp, cookie)
  }
  return cookie
}
