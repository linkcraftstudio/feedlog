import { dashboardLoginRedirect } from '../../shared/auth/dashboard'

// /dashboard/* gate: any org staff (owner / manager / contributor) may enter.
// Fine-grained capability checks happen inside individual pages / API calls.
export default defineNuxtRouteMiddleware(async (to, from) => {
  const { data } = await useAuthSession()
  const localePath = useLocalePath()
  const requestLocalLogin = () => navigateTo(dashboardLoginRedirect(to.fullPath, localePath('/')))

  if (!data.value?.user || data.value.user.isAnonymous) {
    return requestLocalLogin()
  }

  if ((data.value.session as { ssoOrgId?: string | null }).ssoOrgId) {
    return requestLocalLogin()
  }

  const orgList = (data.value as { orgList?: { role: string }[] }).orgList
  if (!orgList || orgList.length === 0) {
    return navigateTo('/')
  }
  const { canVisit, entry, notifyDenied } = useDashboardAccess()
  const path = to.path.replace(/^\/(?:en|zh)(?=\/|$)/, '')
  if (!canVisit(path)) {
    if (import.meta.client) notifyDenied()
    // A direct URL needs a destination; an in-app refusal stays on the current page.
    if (import.meta.client && !useNuxtApp().isHydrating && from.matched.length && from.path !== to.path) return abortNavigation()
    return navigateTo(localePath(entry.value), { replace: true })
  }
  await resolveOnboardingStatus()
})
