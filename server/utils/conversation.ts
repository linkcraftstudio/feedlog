import { and, eq, gt, sql } from 'drizzle-orm'
import { conversation } from '../db/schemas'

// A visibility window, not a deletion job: rows stay, reads stop returning them.
export const CONVERSATION_RETENTION_DAYS = 180

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Postgres throws on a non-uuid comparison.
export function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

export function ownedConversation(id: string, orgId: string, userId: string) {
  return and(eq(conversation.id, id), eq(conversation.orgId, orgId), eq(conversation.userId, userId))
}

export function withinRetention() {
  return gt(conversation.lastMessageAt, sql`now() - make_interval(days => ${CONVERSATION_RETENTION_DAYS})`)
}
