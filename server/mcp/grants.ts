import { and, eq, inArray, isNull, like, sql } from 'drizzle-orm'
import { createError } from 'h3'
import { db } from '../db'
import { mcpAuditLog, mcpConsentOrganization, member, oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken, organization, user } from '../db/schemas'
import { MCP_STAFF_ROLES } from './config'

export type McpDatabase = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete' | 'execute'>
export type McpGrant = typeof oauthConsent.$inferSelect

export function mcpError(statusCode: number, code: string, message: string) {
  return createError({ statusCode, message, data: { code } })
}

export async function lockMcpGrant(database: McpDatabase, userId: string, clientId: string) {
  // The provider uses its own adapter, so serialize by identity without locking its rows.
  await database.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['mcp', userId, clientId])}, 0))`)
}

export async function eligibleOrganizations(userId: string, database: McpDatabase = db, lock = false) {
  const query = database.select({ id: organization.id, name: organization.name, slug: organization.slug, role: member.role, memberId: member.id })
    .from(member).innerJoin(organization, eq(organization.id, member.organizationId))
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.userId, userId), inArray(member.role, MCP_STAFF_ROLES), isNull(member.suspendedAt), sql`${user.isAnonymous} IS NOT TRUE`, sql`${user.banned} IS NOT TRUE`))
    .orderBy(organization.name, organization.id)
  return lock ? query.for('share', { of: member }) : query
}

export async function activeGrant(id: string, database: McpDatabase = db, lock = false) {
  const query = database.select({ consent: oauthConsent, client: oauthClient, user }).from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .innerJoin(user, eq(user.id, oauthConsent.userId))
    .where(and(eq(oauthConsent.id, id), like(oauthConsent.referenceId, 'mcp:%'), sql`${oauthClient.disabled} IS NOT TRUE`, sql`${user.banned} IS NOT TRUE`, sql`${user.isAnonymous} IS NOT TRUE`))
  const [row] = await (lock ? query.for('share', { of: oauthConsent }) : query)
  return row ?? null
}

export async function grantOrganizations(consentId: string, userId: string, database: McpDatabase = db) {
  return database.select({ id: organization.id, name: organization.name, slug: organization.slug, role: member.role, memberId: member.id })
    .from(mcpConsentOrganization)
    .innerJoin(member, and(eq(member.id, mcpConsentOrganization.memberId), eq(member.organizationId, mcpConsentOrganization.organizationId), eq(member.userId, userId)))
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(mcpConsentOrganization.consentId, consentId), inArray(member.role, MCP_STAFF_ROLES)))
    .orderBy(organization.name, organization.id)
}

export async function auditGrant(database: McpDatabase, consent: McpGrant, actorUserId: string, operation: string, organizationId: string | null = null) {
  await database.insert(mcpAuditLog).values({ consentId: consent.id, clientId: consent.clientId, authorizationUserId: consent.userId!, actorUserId, operation, organizationId, status: 'success' })
}

export async function revokeGrant(database: McpDatabase, consent: McpGrant, actorUserId: string) {
  await database.delete(mcpConsentOrganization).where(eq(mcpConsentOrganization.consentId, consent.id))
  await database.delete(oauthAccessToken).where(and(eq(oauthAccessToken.clientId, consent.clientId), eq(oauthAccessToken.userId, consent.userId!), eq(oauthAccessToken.referenceId, consent.referenceId!)))
  await database.delete(oauthRefreshToken).where(and(eq(oauthRefreshToken.clientId, consent.clientId), eq(oauthRefreshToken.userId, consent.userId!), eq(oauthRefreshToken.referenceId, consent.referenceId!)))
  await database.delete(oauthConsent).where(eq(oauthConsent.id, consent.id))
  await auditGrant(database, consent, actorUserId, 'authorization.revoke')
}

export async function updateGrantOrganizations(database: McpDatabase, consent: McpGrant, actorUserId: string, additions: string[], removals: string[]) {
  const eligible = await eligibleOrganizations(consent.userId!, database, true)
  if (additions.some(id => !eligible.some(org => org.id === id))) {
    throw mcpError(403, 'FORBIDDEN', 'Organization membership is required')
  }
  for (const organizationId of removals) {
    const removed = await database.delete(mcpConsentOrganization)
      .where(and(eq(mcpConsentOrganization.consentId, consent.id), eq(mcpConsentOrganization.organizationId, organizationId))).returning()
    if (removed.length) await auditGrant(database, consent, actorUserId, 'organization.remove', organizationId)
  }
  for (const organizationId of additions) {
    const org = eligible.find(org => org.id === organizationId)!
    // Rejoining with a new membership never restores a departed member's authorization.
    await database.delete(mcpConsentOrganization).where(and(eq(mcpConsentOrganization.consentId, consent.id), eq(mcpConsentOrganization.organizationId, organizationId), sql`${mcpConsentOrganization.memberId} <> ${org.memberId}`))
    const added = await database.insert(mcpConsentOrganization).values({ consentId: consent.id, organizationId, memberId: org.memberId }).onConflictDoNothing().returning()
    if (added.length) await auditGrant(database, consent, actorUserId, 'organization.add', organizationId)
  }
  const current = await grantOrganizations(consent.id, consent.userId!, database)
  if (!current.length) await revokeGrant(database, consent, actorUserId)
  return { connectionId: consent.id, organizationIds: current.map(org => org.id), disconnected: !current.length }
}

export async function cleanupMemberMcpAccess(memberId: string, actorUserId: string) {
  const rows = await db.select({ consent: oauthConsent, organizationId: mcpConsentOrganization.organizationId })
    .from(mcpConsentOrganization).innerJoin(oauthConsent, eq(oauthConsent.id, mcpConsentOrganization.consentId))
    .where(eq(mcpConsentOrganization.memberId, memberId))
  for (const row of rows) await db.transaction(async tx => {
    await lockMcpGrant(tx, row.consent.userId!, row.consent.clientId)
    const [current] = await tx.select().from(oauthConsent).where(eq(oauthConsent.id, row.consent.id))
    if (current) await updateGrantOrganizations(tx, current, actorUserId, [], [row.organizationId])
  })
  await db.delete(mcpConsentOrganization).where(eq(mcpConsentOrganization.memberId, memberId))
}

export async function cleanupOrganizationMcpAccess(organizationId: string, actorUserId: string) {
  const memberships = await db.selectDistinct({ memberId: mcpConsentOrganization.memberId }).from(mcpConsentOrganization)
    .where(eq(mcpConsentOrganization.organizationId, organizationId))
  for (const membership of memberships) await cleanupMemberMcpAccess(membership.memberId, actorUserId)
  await db.delete(mcpConsentOrganization).where(eq(mcpConsentOrganization.organizationId, organizationId))
}

export async function cleanupUserMcpAccess(userId: string, actorUserId: string) {
  const consents = await db.select().from(oauthConsent).where(and(eq(oauthConsent.userId, userId), like(oauthConsent.referenceId, 'mcp:%')))
  for (const consent of consents) await db.transaction(async tx => {
    await lockMcpGrant(tx, userId, consent.clientId)
    const [current] = await tx.select().from(oauthConsent).where(eq(oauthConsent.id, consent.id))
    if (current) await revokeGrant(tx, current, actorUserId)
  })
}
