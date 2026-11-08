import { toast } from 'vue-sonner'

export function notifyPermissionDenied(payload: unknown, status?: number): boolean {
  if (!import.meta.client) return false
  const error = payload as { code?: string; data?: { code?: string }; status?: number; statusCode?: number } | null
  const code = error?.data?.code ?? error?.code
  if (code === 'LOCAL_AUTH_REQUIRED') return false
  if (code !== 'PERMISSION_DENIED' && (status ?? error?.statusCode ?? error?.status) !== 403) return false
  const { $i18n } = useNuxtApp()
  toast.error($i18n.t('dashboard.accessDenied'), { id: 'dashboard-access-denied', description: $i18n.t('dashboard.requestAccess') })
  return true
}
