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
  return auth.api.getSession({ headers: event.headers })
}

// Throws 401 if not authenticated.
export async function requireAuth(event: H3Event) {
  const session = await getUserSession(event)
  if (!session) {
    throw createError({ statusCode: 401, message: 'Authentication required' })
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
  const orgId = event.context.orgId
  if (!orgId) {
    throw createError({ statusCode: 500, message: 'orgId missing from request context' })
  }
  // Cast: customSession's $Infer return shadows organization plugin endpoint
  // typing in InferAPI; the underlying hasPermission endpoint still exists at
  // runtime. https://github.com/better-auth/better-auth/issues/* (cf-#3?)
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
// the active org. orgId comes from event.context (set by
// middleware/org-context.ts: default-org in single-tenant, parsed from the
// subdomain in multi-tenant), not from session.activeOrganizationId. Use
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
