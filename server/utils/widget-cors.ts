import type { H3Event } from 'h3'

// Any origin is allowed: customers embed the widget on hosts we have no registry
// of. Safe because these endpoints carry no ambient authority — auth is an
// explicit Bearer header, never a cookie, so credentials stay off.

export const WIDGET_API_PREFIX = '/api/widget/'

const ALLOWED_HEADERS = 'Content-Type, Authorization'
const ALLOWED_METHODS = 'GET, POST, OPTIONS'
const PREFLIGHT_MAX_AGE = '86400'

export function isWidgetApiPath(path: string): boolean {
  return path.startsWith(WIDGET_API_PREFIX)
}

export function applyWidgetCors(event: H3Event): void {
  const origin = getRequestHeader(event, 'origin')
  if (origin) {
    setResponseHeader(event, 'Access-Control-Allow-Origin', origin)
    // Stops a shared cache (config is cacheable) replaying one customer's
    // Allow-Origin to another.
    appendResponseHeader(event, 'Vary', 'Origin')
  }
  else {
    setResponseHeader(event, 'Access-Control-Allow-Origin', '*')
  }
  setResponseHeader(event, 'Access-Control-Allow-Headers', ALLOWED_HEADERS)
  setResponseHeader(event, 'Access-Control-Allow-Methods', ALLOWED_METHODS)
  setResponseHeader(event, 'Access-Control-Max-Age', PREFLIGHT_MAX_AGE)
}

// Returns true when the caller should stop: route handlers are .get/.post only,
// so Nitro would 405 an OPTIONS request.
export function handleWidgetPreflight(event: H3Event): boolean {
  if (event.method !== 'OPTIONS') return false
  setResponseStatus(event, 204)
  return true
}
