import type { H3Event } from 'h3'

// `auth` is the better-auth instance, auto-imported from
// server/utils/better-auth.ts by Nitro. No explicit import needed.

// Per-organization permission check. Statement is the access-control body the
// org plugin's hasPermission expects (e.g. `{ post: ['delete:any'] }`).
// orgId is taken from event.context (set by server/middleware/org-context.ts)
// — never from session.activeOrganizationId, which is per-user UX state and
// breaks multi-tab usage.
export type OrgPermissionStatement = Record<string, string[]>

export async function getUserSession(event: H3Event) {
  const result = await auth.api.getSession({ headers: event.headers })
  if (!result) return null
  // Host-binding collar: a portal SSO session is valid only on the
  // org host that minted it. On any other host — e.g. a token replayed to a
  // different org's host — treat it as unauthenticated so it can't reach
  // staff surfaces or another org's data. Single-tenant deployments: ssoOrgId
  // always equals the default org → no-op. Every requireAuth* helper inherits this.
  const ssoOrgId = (result.session as { ssoOrgId?: string | null }).ssoOrgId
  if (ssoOrgId && ssoOrgId !== event.context.orgId) {
    return null
  }
  return result
}

// Throws 401 if not authenticated.
export async function requireAuth(event: H3Event) {
  const session = await getUserSession(event)
  if (!session) {
    throw createError({ statusCode: 401, message: 'Authentication required' })
  }
  return session
}

// Dashboard/staff authorization accepts only identities established through
// FeedLog's own login methods. Portal SSO is org-bound but its asserted email
// may collide with an existing owner/manager, so membership must never promote
// that session into dashboard access.
function assertDashboardSession(session: Awaited<ReturnType<typeof requireAuth>>) {
  if ((session.session as { ssoOrgId?: string | null }).ssoOrgId) {
    throw createError({
      statusCode: 403,
      message: 'Portal SSO sessions cannot access staff areas',
      data: { code: 'LOCAL_AUTH_REQUIRED' },
    })
  }
  if ((session.user as { isAnonymous?: boolean | null }).isAnonymous) {
    throw createError({ statusCode: 403, message: 'Guest sessions cannot access staff areas' })
  }
}

// Gate for anything reaching beyond the org that vouched for this identity, or
// changing the global user record behind it: an SSO email was asserted by one
// org and verified by nobody. The stable `code` is what the client matches on —
// prose changes with translations.
export async function requireLocalSession(event: H3Event) {
  const session = await requireAuth(event)
  const ssoOrgId = (session.session as { ssoOrgId?: string | null }).ssoOrgId
  if (ssoOrgId) {
    throw createError({
      statusCode: 403,
      message: 'Sign in directly to perform this action',
      data: { code: 'LOCAL_AUTH_REQUIRED' },
    })
  }
  if ((session.user as { isAnonymous?: boolean | null }).isAnonymous) {
    throw createError({
      statusCode: 403,
      message: 'Sign in directly to perform this action',
      data: { code: 'LOCAL_AUTH_REQUIRED' },
    })
  }
  return session
}

// Throws 403 if the current user lacks any of the requested actions in the
// active org. Combines "is a member of this org" and "role grants action" in
// one call — both checks delegate to better-auth's hasPermission internals.
export async function requireOrgPermission(
  event: H3Event,
  permissions: OrgPermissionStatement,
) {
  const session = await requireAuth(event)
  assertDashboardSession(session)
  const orgId = event.context.orgId
  if (!orgId) {
    throw createError({ statusCode: 500, message: 'orgId missing from request context' })
  }
  // Cast: customSession's $Infer return shadows organization plugin endpoint
  // typing in InferAPI; the underlying hasPermission endpoint still exists at
  // runtime.
  const orgApi = auth.api as unknown as {
    hasPermission: (input: {
      headers: Headers
      body: { organizationId?: string; permissions: OrgPermissionStatement }
    }) => Promise<{ success: boolean; error: string | null }>
  }
  const result = await orgApi.hasPermission({
    headers: event.headers,
    body: { organizationId: orgId, permissions },
  })
  if (!result?.success) {
    throw createError({ statusCode: 403, message: 'Forbidden' })
  }
  return { session, orgId }
}

// End-user write paths (post / vote / comment / reaction). End-users and
// staff share the same write surface — both authenticate, both write under
// the active org. orgId comes from event.context (resolved per request by
// middleware/org-context.ts), not from session.activeOrganizationId. Use
// this — not requireOrgMember — for any surface a non-member should reach.
// Mirrors requireOrgMember's return shape so call sites diff cleanly.
export async function requireAuthInOrg(event: H3Event) {
  const session = await requireAuth(event)
  const orgId = event.context.orgId
  if (!orgId) {
    throw createError({ statusCode: 500, message: 'orgId missing from request context' })
  }
  return { session, orgId }
}

// Convenience: gate any dashboard surface on "current user is in this org".
// Permission-less — for fine-grained checks use requireOrgPermission.
export async function requireOrgMember(event: H3Event) {
  const session = await requireAuth(event)
  assertDashboardSession(session)
  const orgId = event.context.orgId
  if (!orgId) {
    throw createError({ statusCode: 500, message: 'orgId missing from request context' })
  }
  const orgList = (session as { orgList?: { orgId: string; role: string }[] }).orgList
  const found = orgList?.find(o => o.orgId === orgId)
  if (!found) {
    throw createError({ statusCode: 403, message: 'Not a member of this organization' })
  }
  return { session, orgId, role: found.role }
}

// Non-throwing counterpart of requireOrgMember, for endpoints that serve
// everyone but enrich the payload for staff — a throwing gate can't express
// "same route, more fields". Guests get null; an SSO session is read at its real
// member role, since callers only ask about the org this request resolved to.
export function getOrgMemberRole(
  session: Awaited<ReturnType<typeof getUserSession>>,
  orgId: string | undefined,
): string | null {
  if (!session || !orgId) return null
  if ((session.session as { ssoOrgId?: string | null }).ssoOrgId) return null
  if ((session.user as { isAnonymous?: boolean | null }).isAnonymous) return null
  const orgList = (session as { orgList?: { orgId: string; role: string }[] }).orgList
  return orgList?.find(o => o.orgId === orgId)?.role ?? null
}

// Gate a dashboard surface on "current user is owner of this org". Used for
// owner-only settings such as SSO signing secrets.
export async function requireOrgOwner(event: H3Event) {
  const result = await requireOrgMember(event)
  if (result.role !== 'owner') {
    throw createError({ statusCode: 403, message: 'Owner role required' })
  }
  return result
}
