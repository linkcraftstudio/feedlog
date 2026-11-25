import { and, eq } from 'drizzle-orm'
import { createError, type H3Event } from 'h3'
import { member } from '../db/schemas'
import { getUserSession } from './auth'

// Read from the member row, not the session's orgList: that list sits in the
// session cookie cache for up to 60s, and a suspension must bind at once.
export async function isSuspendedMember(userId: string, orgId: string): Promise<boolean> {
  const [row] = await useDB().select({ suspendedAt: member.suspendedAt }).from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId))).limit(1)
  return !!row?.suspendedAt
}

function allowedForSuspended(event: H3Event): boolean {
  const path = event.path.split('?')[0]!
  const prefixes: string[] = useAppConfig().suspendedMemberAccess?.apis ?? []
  return prefixes.some(prefix => path.startsWith(prefix))
}

// Suspended members keep their membership but may only reach the allow-listed
// APIs (SaaS adds its own in app.config `suspendedMemberAccess.apis`).
export async function assertMemberNotSuspended(event: H3Event, userId: string, orgId: string): Promise<void> {
  if (!await isSuspendedMember(userId, orgId) || allowedForSuspended(event)) return
  throw createError({
    statusCode: 403,
    message: 'Your seat in this organization is suspended',
    data: { code: 'member_suspended' },
  })
}

// Better Auth's organization endpoints bypass the requireOrg* helpers. A
// suspended member keeps read access (the Members page) and may leave, but
// cannot change the organization, its members or its invitations.
const SUSPENDED_READ_ENDPOINTS = new Set([
  'list',
  'list-members',
  'list-invitations',
  'list-user-invitations',
  'get-full-organization',
  'get-active-member',
  'get-active-member-role',
  'get-invitation',
  'has-permission',
  'check-slug',
  'set-active',
  'leave',
  'accept-invitation',
  'reject-invitation',
])

export async function guardSuspendedAuthRequest(event: H3Event): Promise<void> {
  const orgId = event.context.orgId as string | undefined
  const match = event.path.split('?')[0]!.match(/^\/api\/auth\/organization\/([^/]+)$/)
  if (!orgId || !match || SUSPENDED_READ_ENDPOINTS.has(match[1]!)) return
  const session = await getUserSession(event)
  if (session) await assertMemberNotSuspended(event, session.user.id, orgId)
}
