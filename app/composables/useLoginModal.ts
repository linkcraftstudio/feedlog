import {
  buildExternalAuthRedirectUrl,
  selectExternalAuthUrl,
  type ExternalAuthIntent,
} from '#layers/feedlog/shared/utils/external-auth'

// `reason` holds an i18n key rather than rendered text: the modal is mounted
// elsewhere and may render in a different locale than the caller.
export function useLoginModal() {
  const isOpen = useState('login-modal', () => false)
  const reason = useState<string | null>('login-modal-reason', () => null)
  const intent = useState<ExternalAuthIntent>('login-modal-intent', () => 'login')
  const { data: authConfig, status, refresh } = useAuthConfig()

  async function redirectExternal(requestedIntent: ExternalAuthIntent): Promise<boolean> {
    if (!import.meta.client || reason.value === LOCAL_AUTH_REASON) return false
    // Remember which action failed so the retry affordance can resume it.
    intent.value = requestedIntent
    if (status.value !== 'success') {
      try {
        await refresh()
      }
      catch { /* The missing config below opens the retry state. */ }
    }
    if (!authConfig.value) {
      isOpen.value = true
      return true
    }

    const externalUrl = selectExternalAuthUrl({
      login: authConfig.value?.externalLoginUrl ?? null,
      signup: authConfig.value?.externalSignupUrl ?? null,
    }, requestedIntent)
    if (!externalUrl) return false

    const destination = buildExternalAuthRedirectUrl(
      externalUrl,
      window.location.origin,
      window.location.pathname + window.location.search,
    )
    if (!destination) return false
    window.location.assign(destination)
    return true
  }

  async function open(reasonKey?: string) {
    reason.value = reasonKey ?? null
    if (reasonKey !== LOCAL_AUTH_REASON && await redirectExternal('login')) return
    isOpen.value = true
  }

  return {
    isOpen,
    reason,
    intent,
    open,
    redirectExternal,
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
