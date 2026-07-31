// Per-user state (vote highlight, subscription) sits in refs a soft session
// refresh won't rebuild — hard-reload on account switch so it can't leak.
export default defineNuxtPlugin(() => {
  if (/\/widget\/embed\/?$/.test(window.location.pathname)) return
  const { data: session } = useAuthSession()
  watch(() => session.value?.user?.id, (id, prev) => {
    if (id && id !== prev) reloadNuxtApp()
  })
})
