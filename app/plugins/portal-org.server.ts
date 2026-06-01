// Resolve portal identity once per SSR request into usePortalOrg state, so the
// first SSR paint (all a crawler sees) carries the org name. Forward the incoming
// Host so the internal $fetch resolves org-context against the same request.
export default defineNuxtPlugin(async () => {
  const portal = usePortalOrg()
  try {
    portal.value = await $fetch('/api/portal-identity', {
      headers: useRequestHeaders(['host', 'x-forwarded-host', 'x-forwarded-proto']),
    })
  } catch {
    // Keep the branded default on failure — meta must never break the page.
  }
})
