import { resolveOnboardingStatus } from '#layers/feedlog/app/composables/useOnboarding'

// /dashboard/* gate: any org staff (owner / manager / contributor) may enter.
// Fine-grained capability checks happen inside individual pages / API calls.
export default defineNuxtRouteMiddleware(async (to, from) => {
  const { data } = await useAuthSession()

  if (!data.value?.user) {
    return navigateTo('/')
  }

  // An SSO session is not bounced: the server honours its real member role, and
  // the orgList check below still gates it — for such a session that list holds
  // only the org that minted it.
  const orgList = (data.value as { orgList?: { role: string }[] }).orgList
  if (!orgList || orgList.length === 0) {
    return navigateTo('/')
  }
  const { canVisit, entry, notifyDenied } = useDashboardAccess()
  const localePath = useLocalePath()
  const path = to.path.replace(/^\/(?:en|zh)(?=\/|$)/, '')
  if (!canVisit(path)) {
    if (import.meta.client) notifyDenied()
    // A direct URL needs a destination; an in-app refusal stays on the current page.
    if (import.meta.client && !useNuxtApp().isHydrating && from.matched.length && from.path !== to.path) return abortNavigation()
    return navigateTo(localePath(entry.value), { replace: true })
  }
  await resolveOnboardingStatus()
})
