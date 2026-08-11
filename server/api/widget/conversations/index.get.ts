import { and, desc, eq, sql } from 'drizzle-orm'
import { conversation, message } from '#layers/feedlog/server/db/schemas'
import { withinRetention } from '#layers/feedlog/server/utils/conversation'

export interface WidgetConversationItem {
  id: string
  title: string | null
  firstUserText: string | null
  preview: string | null
  lastMessageAt: Date
  unread: boolean
}

// The visitor's own conversations, newest first. Unpaged: a visitor accumulates
// a handful of these, not a feed.
export default defineEventHandler(async (event): Promise<{ data: WidgetConversationItem[] }> => {
  const { session, orgId } = await requireAuthInOrg(event)

  const rows = await useDB()
    .select({
      id: conversation.id,
      title: conversation.title,
      preview: conversation.previewText,
      lastMessageAt: conversation.lastMessageAt,
      unread: conversation.unread,
      // The outer id is spelled out, not interpolated: with one table in the
      // FROM, drizzle renders a column as a bare "id", which the subquery then
      // resolves against message — a legal, always-false m.conversation_id = m.id.
      firstUserText: sql<string | null>`CASE WHEN ${conversation.title} IS NULL THEN (
        SELECT m.text FROM ${message} m
        WHERE m.conversation_id = "conversation"."id" AND m.role = 'user'
        ORDER BY m.created_at, m.id
        LIMIT 1
      ) END`,
    })
    .from(conversation)
    .where(and(
      eq(conversation.orgId, orgId),
      eq(conversation.userId, session.user.id),
      withinRetention(orgId),
    ))
    .orderBy(desc(conversation.lastMessageAt), desc(conversation.id))

  return { data: rows }
})
