import { and, eq, sql } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { z } from 'zod'
import { db } from '../db'
import { mcpAuditLog, mcpConsentOrganization, member } from '../db/schemas'
import { contentError, runAfterCommit, type ContentContext } from '../services/content-context'
import { activeGrant, grantOrganizations, lockMcpGrant, mcpError } from './grants'
import { writeResult } from './output'
import type { McpIdentity } from './authorization'

export type ToolContext = ContentContext & { orgSlug: string }
export type ToolOptions = { write?: boolean; destructive?: boolean; target?: string; targetKey?: string; openWorld?: boolean }

function toolFailure(error: unknown, write: boolean) {
  const failure = error as { statusCode?: number; message?: string; data?: { code?: string } }
  if (error instanceof z.ZodError) return { code: 'INVALID_ARGUMENT', message: error.issues.map(issue => issue.message).join('; ') }
  if (failure.statusCode && failure.statusCode < 500) return { code: failure.data?.code ?? (failure.statusCode === 403 ? 'FORBIDDEN' : failure.statusCode === 404 ? 'NOT_FOUND' : 'INVALID_ARGUMENT'), message: failure.message ?? 'The operation could not be completed' }
  console.error('[mcp] tool operation failed', { name: (error as Error)?.name, code: (error as { cause?: { code?: string } })?.cause?.code })
  return { code: write ? 'WRITE_RESULT_UNKNOWN' : 'INTERNAL_ERROR', message: write ? 'The write result is uncertain. Read the object before retrying.' : 'The operation could not be completed. Try again later.' }
}

export async function executeMcpOperation(event: H3Event, identity: McpIdentity, origin: string, name: string, args: Record<string, unknown>, options: ToolOptions, handler: (context: ToolContext) => Promise<Record<string, unknown>>, validationError?: z.ZodError) {
  const orgId = args.organization_id as string | undefined
  const afterCommit: ContentContext['afterCommit'] = []
  let enteredOrganization = false
  try {
    if (validationError) throw validationError
    const value: Record<string, unknown> = await db.transaction(async tx => {
      await lockMcpGrant(tx, identity.userId, identity.clientId)
      const current = await activeGrant(identity.consentId, tx, true)
      if (!current || current.consent.userId !== identity.userId || current.consent.clientId !== identity.clientId || !current.consent.scopes.includes('mcp:access') || !current.consent.resources?.includes(identity.resource)) throw mcpError(403, 'FORBIDDEN', 'This authorization is no longer available. Reconnect the application.')
      const organizations = await grantOrganizations(identity.consentId, identity.userId, tx)
      if (!organizations.length) throw contentError(403, 'Organization access is no longer authorized')
      if (name === 'list_organizations') return { organizations: organizations.map(({ id, name, role }) => ({ id, name, role })) }
      const organization = organizations.find(org => org.id === orgId)
      if (!organization) throw contentError(403, 'Organization access is not authorized')
      const [membership] = await tx.select().from(member).where(and(eq(member.id, organization.memberId), eq(member.userId, identity.userId), eq(member.organizationId, orgId!))).for('share')
      if (!membership || !['owner', 'manager', 'contributor'].includes(membership.role)) throw contentError(403, 'Organization membership is required')
      if (membership.suspendedAt) throw contentError(403, 'Your seat in this organization is suspended')
      enteredOrganization = true
      await tx.update(mcpConsentOrganization).set({ lastUsedAt: sql`greatest(coalesce(${mcpConsentOrganization.lastUsedAt}, '-infinity'::timestamptz), clock_timestamp())` })
        .where(and(eq(mcpConsentOrganization.consentId, identity.consentId), eq(mcpConsentOrganization.organizationId, orgId!)))
      const context: ToolContext = { db: tx, orgId: orgId!, orgSlug: organization.slug, userId: identity.userId, role: membership.role, origin, event, afterCommit }
      const payload = await handler(context)

      return { organization_id: orgId, ...payload }
    })
    runAfterCommit({ event, afterCommit })
    // The business transaction has committed. Audit failure must not invite a duplicate write.
    if (options.write) await db.insert(mcpAuditLog).values({
      organizationId: orgId, actorUserId: identity.userId, authorizationUserId: identity.userId,
      consentId: identity.consentId, clientId: identity.clientId, operation: name, status: 'success',
      targetType: options.target, targetId: String((args as Record<string, unknown>)[options.targetKey ?? 'id'] ?? value.id ?? '') || null,
      details: Object.fromEntries(Object.entries(args).filter(([key, value]) => key.endsWith('_id') && key !== 'organization_id' && typeof value === 'string')),
    }).catch(() => console.error('[mcp] failed to record successful operation', { operation: name, consentId: identity.consentId }))
    return { value: options.write ? writeResult(value, options.target) : value, isError: false }
  } catch (error) {
    const failure = toolFailure(error, !!options.write)
    if (enteredOrganization && orgId) await db.update(mcpConsentOrganization)
      .set({ lastUsedAt: sql`greatest(coalesce(${mcpConsentOrganization.lastUsedAt}, '-infinity'::timestamptz), clock_timestamp())` })
      .where(and(eq(mcpConsentOrganization.consentId, identity.consentId), eq(mcpConsentOrganization.organizationId, orgId)))
      .catch(() => console.error('[mcp] failed to update activity'))
    if (options.write) await db.insert(mcpAuditLog).values({
      organizationId: orgId, actorUserId: identity.userId, authorizationUserId: identity.userId,
      consentId: identity.consentId, clientId: identity.clientId, operation: name, status: 'failure',
      targetType: options.target, targetId: String((args as Record<string, unknown>)[options.targetKey ?? 'id'] ?? '') || null,
      errorCode: failure.code,
    }).catch(() => console.error('[mcp] failed to record rejected operation'))
    return { value: { error: failure }, isError: true }
  }
}
