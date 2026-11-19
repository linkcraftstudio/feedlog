import type { OrgMetadataInput } from './branding'
import { parseOrgMetadata } from './branding'

export type ExternalAuthIntent = 'login' | 'signup'

export interface ExternalAuthUrls {
  login: string | null
  signup: string | null
}

export interface PortalAuthConfig {
  loginUrl?: string
  signupUrl?: string
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const SENSITIVE_RETURN_PARAMS = new Set([
  'access_token',
  'api_key',
  'code',
  'id_token',
  'jwt',
  'key',
  'password',
  'refresh_token',
  'secret',
  'state',
  'token',
])

function isSensitiveParam(key: string): boolean {
  const normalized = key.toLowerCase()
  return SENSITIVE_RETURN_PARAMS.has(normalized)
    || normalized.endsWith('_token')
    || normalized.endsWith('_secret')
}

/** Validate an organization-configured external authentication endpoint. */
export function validateExternalAuthUrl(raw: string | undefined | null): string | null {
  if (!raw?.trim()) return null

  try {
    const url = new URL(raw.trim())
    const isLocalHttp = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)
    if (url.protocol !== 'https:' && !isLocalHttp) return null
    if (url.username || url.password) return null
    if ([...url.searchParams.keys()].some(isSensitiveParam)) return null
    // This is FeedLog's destination after external authentication, not an
    // external authentication page. Pointing to it would create a loop.
    if (url.pathname.replace(/\/+$/, '') === '/api/sso/jwt') return null
    return url.toString()
  }
  catch {
    return null
  }
}

export function parsePortalAuthConfig(metadata: OrgMetadataInput): PortalAuthConfig {
  const raw = parseOrgMetadata(metadata).portalAuth
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const record = raw as Record<string, unknown>
  const loginUrl = typeof record.loginUrl === 'string' ? validateExternalAuthUrl(record.loginUrl) : null
  const signupUrl = typeof record.signupUrl === 'string' ? validateExternalAuthUrl(record.signupUrl) : null
  return {
    ...(loginUrl ? { loginUrl } : {}),
    ...(signupUrl ? { signupUrl } : {}),
  }
}

export function resolvePortalAuthConfig(metadata: OrgMetadataInput): ExternalAuthUrls {
  const config = parsePortalAuthConfig(metadata)
  return resolveExternalAuthUrls(config.loginUrl, config.signupUrl)
}

export function mergePortalAuthMetadata(
  metadata: OrgMetadataInput,
  config: PortalAuthConfig,
): Record<string, unknown> {
  const current = parseOrgMetadata(metadata)
  const loginUrl = config.loginUrl?.trim() ? validateExternalAuthUrl(config.loginUrl) : null
  const signupUrl = config.signupUrl?.trim() ? validateExternalAuthUrl(config.signupUrl) : null
  if (config.loginUrl?.trim() && !loginUrl) throw new Error('Invalid portal login URL')
  if (config.signupUrl?.trim() && !signupUrl) throw new Error('Invalid portal signup URL')

  const portalAuth = {
    ...(loginUrl ? { loginUrl } : {}),
    ...(signupUrl ? { signupUrl } : {}),
  }
  if (Object.keys(portalAuth).length) return { ...current, portalAuth }
  const { portalAuth: _removed, ...rest } = current
  return rest
}

export function resolveExternalAuthUrls(
  loginUrl: string | undefined | null,
  signupUrl: string | undefined | null,
): ExternalAuthUrls {
  const login = validateExternalAuthUrl(loginUrl)
  const signup = validateExternalAuthUrl(signupUrl)
  return {
    login: login ?? signup,
    signup: signup ?? login,
  }
}

export function selectExternalAuthUrl(
  urls: ExternalAuthUrls,
  intent: ExternalAuthIntent,
  context: { portal: boolean, localAuthRequired?: boolean },
): string | null {
  if (!context.portal || context.localAuthRequired) return null
  return intent === 'signup'
    ? urls.signup ?? urls.login
    : urls.login ?? urls.signup
}

/**
 * Build the configured external URL without accepting any redirect target from
 * browser input. The return destination is always derived from the current
 * FeedLog page. Authentication-shaped query values and the fragment are
 * omitted so credentials cannot be copied into the external application's URL.
 */
export function buildExternalAuthRedirectUrl(
  externalUrl: string,
  feedlogOrigin: string | undefined,
  currentDestination: string | undefined,
): string | null {
  if (!feedlogOrigin || !currentDestination) return null
  const destination = validateExternalAuthUrl(externalUrl)
  if (!destination) return null

  try {
    const external = new URL(destination)
    const trustedFeedlog = new URL(feedlogOrigin)
    if (!['http:', 'https:'].includes(trustedFeedlog.protocol)) return null
    if (trustedFeedlog.username || trustedFeedlog.password) return null
    if (currentDestination.includes('\\') || currentDestination.startsWith('//')) return null

    const returnTo = new URL(currentDestination, trustedFeedlog.origin)
    if (returnTo.origin !== trustedFeedlog.origin) return null

    for (const key of [...returnTo.searchParams.keys()]) {
      if (isSensitiveParam(key)) returnTo.searchParams.delete(key)
    }
    returnTo.hash = ''

    // Refuse the most direct redirect loop even when a same-origin endpoint is
    // intentionally configured (for example, behind a reverse proxy).
    if (external.origin === returnTo.origin && external.pathname === returnTo.pathname) return null

    external.searchParams.set('return_to', returnTo.toString())
    return external.toString()
  }
  catch {
    return null
  }
}
