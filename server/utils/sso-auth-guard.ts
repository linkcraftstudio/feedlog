import type { H3Event } from 'h3'

// better-auth's own endpoints bypass the requireOrg* helpers — the organization
// plugin reads permission off the member table, the admin plugin off user.role —
// so the host-binding collar in getUserSession never sees them. This guards them
// for sessions nobody verified: portal SSO and guest.
//
// Unrecognised endpoints are refused, not allowed: better-auth adds routes in
// minor bumps, and a new one must not become reachable on its own.

const GLOBAL_IDENTITY_ENDPOINTS = new Set([
  'set-password',
  'change-password',
  'change-email',
  'update-user',
  'delete-user',
  'link-social',
  'unlink-account',
])

function localAuthRequired(): Error {
  return createError({
    statusCode: 403,
    message: 'Sign in directly to perform this action',
    data: { code: 'LOCAL_AUTH_REQUIRED' },
  })
}

// Returns true when the caller must answer as if nobody were signed in.
export async function guardSsoAuthRequest(event: H3Event, _request: Request): Promise<boolean> {
  const path = event.path
  if (!path.startsWith('/api/auth/')) return false
  const rest = path.slice('/api/auth/'.length)

  const isOrganization = rest.startsWith('organization/')
  const isAdmin = rest.startsWith('admin/')
  const isOAuthProvider = rest.startsWith('oauth2/')
  const segment = rest.split(/[?/]/)[0] ?? ''
  const isGlobalIdentity = GLOBAL_IDENTITY_ENDPOINTS.has(segment)
  const isGetSession = segment === 'get-session'

  // Resolve the session only for paths that can be refused, so sign-in and
  // callbacks keep their current cost.
  if (!isOrganization && !isAdmin && !isOAuthProvider && !isGlobalIdentity && !isGetSession) return false

  const session = await auth.api.getSession({ headers: event.headers })
  const ssoOrgId = (session?.session as { ssoOrgId?: string | null } | undefined)?.ssoOrgId
  const isGuest = !!(session?.user as { isAnonymous?: boolean | null } | undefined)?.isAnonymous
  if (!ssoOrgId && !isGuest) return false

  // Business endpoints already refuse a session on a host it wasn't issued for,
  // but this route skips the collar and would still hand back name and email.
  if (isGetSession) {
    return !!ssoOrgId && ssoOrgId !== event.context.orgId
  }

  if (isGuest) {
    throw createError({
      statusCode: 403,
      message: 'This session cannot manage credentials, profile, or organization',
    })
  }

  // Portal SSO establishes an end-user identity only. It cannot call any
  // Better Auth organization, admin, OAuth-provider, or global identity route,
  // even when the asserted email belongs to an existing staff account.
  throw localAuthRequired()
}
