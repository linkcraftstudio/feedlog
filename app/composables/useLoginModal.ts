// `reason` holds an i18n key rather than rendered text: the modal is mounted
// elsewhere and may render in a different locale than the caller.
export function useLoginModal() {
  const isOpen = useState('login-modal', () => false)
  const reason = useState<string | null>('login-modal-reason', () => null)
  const { dashboardLoginOnly } = useRuntimeConfig().public
  const router = useRouter()
  return {
    isOpen,
    reason,
    open: (reasonKey?: string) => {
      if (dashboardLoginOnly && !router.currentRoute.value.path.includes('/dashboard')) {
        return navigateTo('/dashboard/login')
      }
      reason.value = reasonKey ?? null
      isOpen.value = true
    },
  }
}

export const LOCAL_AUTH_REASON = 'auth.localAuthRequired'

// better-auth's fetch wrapper and plain $fetch nest the h3 error body
// differently, and both reach here.
function extractErrorCode(payload: unknown): string | undefined {
  const at = (o: unknown, ...path: string[]) => path.reduce<unknown>(
    (v, k) => (v && typeof v === 'object') ? (v as Record<string, unknown>)[k] : undefined,
    o,
  )
  const code = at(payload, 'data', 'code')
    ?? at(payload, 'code')
    ?? at(payload, '_data', 'data', 'code')
    ?? at(payload, 'response', '_data', 'data', 'code')
  return typeof code === 'string' ? code : undefined
}

// Returns whether it handled the error, so callers can skip their own toast.
export function promptLocalAuthIfRequired(payload: unknown): boolean {
  if (!import.meta.client) return false
  if (extractErrorCode(payload) !== 'LOCAL_AUTH_REQUIRED') return false
  useLoginModal().open(LOCAL_AUTH_REASON)
  return true
}
