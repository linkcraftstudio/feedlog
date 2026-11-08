// Per-user state (vote highlight, subscription) sits in refs a soft session
// refresh won't rebuild — hard-reload on account switch so it can't leak.
export default defineNuxtPlugin(() => {
  if (/\/widget\/embed\/?$/.test(window.location.pathname)) return
  const { data: session } = useAuthSession()
  watch(() => session.value?.user?.id, (id, prev) => {
    // The first guest identity belongs to the current draft, not an account switch.
    if (!prev && session.value?.user?.isAnonymous) return
    if (id && id !== prev) reloadNuxtApp()
  })
})
