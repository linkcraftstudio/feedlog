import { and, eq, gt, sql } from 'drizzle-orm'
import { conversation, organizationWidget } from '../db/schemas'
import { CONVERSATION_RETENTION_DEFAULT_DAYS } from '../../shared/constants/conversation'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Postgres throws on a non-uuid comparison.
export function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

export function ownedConversation(id: string, orgId: string, userId: string) {
  return and(eq(conversation.id, id), eq(conversation.orgId, orgId), eq(conversation.userId, userId))
}

// Chosen from response time, not the model's window: the same link answers a
// 200k-token call in ~10s and an 800k one in ~50s, which nobody waits through.
export const CONVERSATION_TOKEN_BUDGET = 120_000

// CJK runs about a token per character, everything else about four characters
// per token. Close enough to place a ceiling; a tokenizer dependency is not.
const CJK = /[\u3000-\u9fff\uf900-\ufaff]/g

export function estimateTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0
  return cjk + Math.ceil((text.length - cjk) / 4)
}

export function withinRetention(orgId: string) {
  return gt(conversation.lastMessageAt, sql`now() - make_interval(days => coalesce(
    (select ${organizationWidget.conversationRetentionDays} from ${organizationWidget}
      where ${organizationWidget.orgId} = ${orgId}),
    ${CONVERSATION_RETENTION_DEFAULT_DAYS}))`)
}
