import { createError, isError } from 'h3'
import { webSourceFailureCode, webSourceFailureMessages } from '../../../shared/utils/web-source-failure'
import { CrawlError } from './fetch'

// Log identifiers/codes, not page bodies, model payloads or provider credentials.
export function logWebSourceFailure(error: unknown, context: Record<string, string | number | boolean | undefined>) {
  const detail = error instanceof Error ? error : undefined
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
  const message = detail?.message.replace(/https?:\/\/[^\s]+/g, '[URL]').replace(/Bearer\s+[^\s]+|sk-[A-Za-z0-9_-]+/gi, '[REDACTED]').slice(0, 500)
  console.warn('[web-source] Operation failed', { ...context, code: code ?? 'sync_unavailable', errorType: detail?.name ?? 'UnknownError', message })
  if (detail && !(error instanceof CrawlError) && !code) {
    // Preserve unexpected program errors for investigation without dumping SDK requests.
    const stack = detail.stack?.split('\n').slice(1, 7).join('\n')
    if (stack) console.warn('[web-source] Failure location', { ...context, stack })
  }
}

export function publicWebSourceError(error: unknown) {
  if (error instanceof CrawlError) {
    // Input validation remains actionable; crawl/model failures use grouped messages.
    if (['invalid_url', 'private_address'].includes(error.code)) return createError({ statusCode: 422, message: error.code, data: { code: error.code } })
    const code = webSourceFailureCode(error.code)
    return createError({ statusCode: 422, message: webSourceFailureMessages[code], data: { code } })
  }
  if (isError(error) && error.statusCode < 500) return error
  const code = 'service_unavailable'
  return createError({ statusCode: 500, message: webSourceFailureMessages[code], data: { code } })
}
