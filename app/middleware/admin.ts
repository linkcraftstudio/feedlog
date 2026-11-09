import { resolveOnboardingStatus } from '#layers/feedlog/app/composables/useOnboarding'

// /dashboard/* gate: any org staff (owner / manager / contributor) may enter.
// Fine-grained capability checks happen inside individual pages / API calls.
export default defineNuxtRouteMiddleware(async (to, from) => {
  const { data } = await useAuthSession()

  // Staff is a user with an organization. An SSO session is not bounced for being
  // SSO: the server honours its real member role, and its list holds only the org
  // that minted it. A guest or a customer session goes to the staff sign-in.
  if (!hasStaffAccess(data.value)) {
    return navigateTo(useRuntimeConfig().public.dashboardLoginOnly ? '/dashboard/login' : '/')
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
