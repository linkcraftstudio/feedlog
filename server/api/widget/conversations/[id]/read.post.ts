import { conversation } from '#layers/feedlog/server/db/schemas'
import { isConversationId, ownedConversation } from '#layers/feedlog/server/utils/conversation'
import { countWidgetBadge } from '#layers/feedlog/server/utils/widget-unread'

// Clears one conversation's dot: on opening it, and again once a reply arrives.
export default defineEventHandler(async (event): Promise<{ count: number, feedback: number }> => {
  const { session, orgId } = await requireAuthInOrg(event)
  const userId = session.user.id
  const id = getRouterParam(event, 'id')
  if (!isConversationId(id)) {
    throw createError({ statusCode: 404, message: 'Conversation not found' })
  }

  const db = useDB()
  const [cleared] = await db
    .update(conversation)
    .set({ unread: false })
    .where(ownedConversation(id, orgId, userId))
    .returning({ id: conversation.id })
  if (!cleared) {
    throw createError({ statusCode: 404, message: 'Conversation not found' })
  }

  return countWidgetBadge(orgId, userId)
})
