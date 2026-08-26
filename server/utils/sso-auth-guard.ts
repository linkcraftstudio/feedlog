import type { H3Event } from 'h3'
import { isAgentEmail } from '#layers/feedlog/shared/constants/agent'

// better-auth's own endpoints bypass the requireOrg* helpers — the organization
// plugin reads permission off the member table, the admin plugin off user.role —
// so the host-binding collar in getUserSession never sees them. This guards them
// for sessions nobody verified: product-SSO, guest, and agent-token.
//
// Unrecognised endpoints are refused, not allowed: better-auth adds routes in
// minor bumps, and a new one must not become reachable on its own.
//
// Agent tokens are the third unverified caller, and they are refused outright
// rather than scoped like an SSO session. An agent IS a real member of the org
// it acts in (usually `manager`), so the org-scoped path below would judge it
// entitled to invite-member and update-member-role — the one route by which an
// agent could promote itself to owner. Keyed on the reserved-domain address,
// which only provisionAgentUser issues and nothing can register.

const GLOBAL_IDENTITY_ENDPOINTS = new Set([
  'set-password',
  'change-password',
  'change-email',
  'update-user',
  'delete-user',
  'link-social',
  'unlink-account',
])

// Reachable for an SSO session, provided the org they name is the one that
// minted it (enforced in assertTargetOrgIsSessionOrg).
const ORG_SCOPED_ORGANIZATION_ENDPOINTS = new Set([
  'get-full-organization',
  'update',
  'list-members',
  'list-invitations',
  'invite-member',
  'cancel-invitation',
  'update-member-role',
  'remove-member',
  'has-permission',
  'get-active-member',
  'get-active-member-role',
  'check-slug',
])

const PAYLOAD_METHODS = new Set(['POST', 'PUT', 'PATCH'])

function localAuthRequired(): Error {
  return createError({
    statusCode: 403,
    message: 'Sign in directly to perform this action',
    data: { code: 'LOCAL_AUTH_REQUIRED' },
  })
}

async function assertTargetOrgIsSessionOrg(
  event: H3Event,
  request: Request,
  ssoOrgId: string,
) {
  // Most endpoints name an org by id, a few (get-full-organization) by slug.
  const allowedSlug = event.context.orgSlug as string | undefined

  const reject = (): never => {
    throw createError({
      statusCode: 403,
      message: 'This session cannot act on another organization',
      data: { code: 'LOCAL_AUTH_REQUIRED' },
    })
  }

  const check = (id: unknown, slug: unknown) => {
    if (typeof id === 'string' && id && id !== ssoOrgId) reject()
    if (typeof slug === 'string' && slug && allowedSlug && slug !== allowedSlug) reject()
  }

  const query = getQuery(event)
  check(query.organizationId, query.organizationSlug)

  if (!PAYLOAD_METHODS.has(request.method)) return
  // clone() tees the stream; reading the body off the h3 event would consume the
  // only copy better-auth gets on the Workers adapter.
  let body: Record<string, unknown> | null = null
  try {
    body = await request.clone().json() as Record<string, unknown>
  }
  catch {
    return
  }
  if (!body || typeof body !== 'object') return
  check(body.organizationId, body.organizationSlug)
}

// Returns true when the caller must answer as if nobody were signed in.
export async function guardSsoAuthRequest(event: H3Event, request: Request): Promise<boolean> {
  const path = event.path
  if (!path.startsWith('/api/auth/')) return false
  const rest = path.slice('/api/auth/'.length)

  const isOrganization = rest.startsWith('organization/')
  const isAdmin = rest.startsWith('admin/')
  const segment = rest.split(/[?/]/)[0] ?? ''
  const isGlobalIdentity = GLOBAL_IDENTITY_ENDPOINTS.has(segment)
  const isGetSession = segment === 'get-session'

  // Resolve the session only for paths that can be refused, so sign-in and
  // callbacks keep their current cost.
  if (!isOrganization && !isAdmin && !isGlobalIdentity && !isGetSession) return false

  const session = await auth.api.getSession({ headers: event.headers })
  const ssoOrgId = (session?.session as { ssoOrgId?: string | null } | undefined)?.ssoOrgId
  const isGuest = !!(session?.user as { isAnonymous?: boolean | null } | undefined)?.isAnonymous
  const isAgent = isAgentEmail(session?.user?.email)
  if (!ssoOrgId && !isGuest && !isAgent) return false

  // Business endpoints already refuse a session on a host it wasn't issued for,
  // but this route skips the collar and would still hand back name and email.
  if (isGetSession) {
    return !!ssoOrgId && ssoOrgId !== event.context.orgId
  }

  if (isGuest || isAgent) {
    throw createError({
      statusCode: 403,
      message: 'This session cannot manage credentials, profile, or organization',
    })
  }

  // The admin plugin judges by user.role, which has no notion of the current org.
  if (isAdmin || isGlobalIdentity) throw localAuthRequired()

  const endpoint = rest.slice('organization/'.length).split(/[?/]/)[0] ?? ''
  if (!ORG_SCOPED_ORGANIZATION_ENDPOINTS.has(endpoint)) throw localAuthRequired()

  await assertTargetOrgIsSessionOrg(event, request, ssoOrgId!)
  return false
}
