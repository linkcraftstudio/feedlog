import { toast } from 'vue-sonner'
import { canVisitDashboard, dashboardEntry } from '#layers/feedlog/shared/auth/dashboard'

export function useDashboardAccess() {
  const org = useOrgContext()
  const { canAccessInbox, canModerate, isOrgOwner } = usePermission(computed(() => undefined), 'post')
  const { $i18n } = useNuxtApp()
  const access = computed(() => ({ member: !!org.value.role, inbox: canAccessInbox.value, moderate: canModerate.value, owner: isOrgOwner.value }))
  const canVisit = (path: string) => canVisitDashboard(path, access.value)
  function notifyDenied() {
    toast.error($i18n.t('dashboard.accessDenied'), { id: 'dashboard-access-denied', description: $i18n.t('dashboard.requestAccess') })
  }
  function guardNavigation(event: MouseEvent, path: string) {
    if (canVisit(path)) return
    event.preventDefault()
    event.stopPropagation()
    notifyDenied()
  }
  return { canVisit, entry: computed(() => dashboardEntry(access.value)), notifyDenied, guardNavigation }
}
