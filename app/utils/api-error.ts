import { toast } from 'vue-sonner'

// One shape for errors from $fetch (H3: code under body.data) and from the
// Better Auth client (code on the body itself).
export interface ApiErrorInfo {
  status: number
  data: { code?: string; [key: string]: unknown }
}

// Returns true when the error was handled (e.g. SaaS opens an upgrade dialog);
// the default message is then skipped. Callers still receive the rejection.
export type ApiErrorHandler = (error: ApiErrorInfo) => boolean

let _handler: ApiErrorHandler | null = null

export function registerApiErrorHandler(handler: ApiErrorHandler): void {
  _handler = handler
}

const CODED_ERRORS = new Set(['seat_limit_reached', 'feature_not_in_plan', 'member_suspended'])

export function apiErrorFromFetch(status: number | undefined, body: unknown): ApiErrorInfo {
  const data = (body as { data?: ApiErrorInfo['data'] } | null)?.data
  return { status: status ?? 0, data: data && typeof data === 'object' ? data : {} }
}

export function apiErrorFromAuth(error: unknown): ApiErrorInfo {
  const { status, statusText: _statusText, ...data } = (error ?? {}) as { status?: number; statusText?: string; [key: string]: unknown }
  return { status: status ?? 0, data }
}

// Runs before the generic 403 notice so coded refusals get their own message.
export function handleApiError(error: ApiErrorInfo): boolean {
  if (!import.meta.client) return false
  if (_handler?.(error)) return true
  const code = error.data.code
  if (!code || !CODED_ERRORS.has(code)) return false
  const { $i18n } = useNuxtApp()
  toast.error($i18n.t(`dashboard.apiErrors.${code}`), { id: `api-error-${code}` })
  return true
}
