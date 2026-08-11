import { and, asc, eq } from 'drizzle-orm'
import { board, conversation, message, post } from '#layers/feedlog/server/db/schemas'
import { isConversationId, ownedConversation, withinRetention } from '#layers/feedlog/server/utils/conversation'

export interface WidgetConversationMessage {
  id: string
  role: string
  kind: string | null
  text: string
  images: string[]
  post: { id: string, slug: string, title: string, board: string | null, status: string } | null
  createdAt: Date
}

// One conversation in full, oldest first — the frame renders the whole thread.
export default defineEventHandler(async (event): Promise<{ data: WidgetConversationMessage[] }> => {
  const { session, orgId } = await requireAuthInOrg(event)
  const id = getRouterParam(event, 'id')
  if (!isConversationId(id)) {
    throw createError({ statusCode: 404, message: 'Conversation not found' })
  }

  const db = useDB()

  // Out of the retention window reads the same as gone.
  const [owned] = await db
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(ownedConversation(id, orgId, session.user.id), withinRetention(orgId)))
    .limit(1)
  if (!owned) {
    throw createError({ statusCode: 404, message: 'Conversation not found' })
  }

  const rows = await db
    .select({
      id: message.id,
      role: message.role,
      kind: message.kind,
      text: message.text,
      images: message.images,
      createdAt: message.createdAt,
      postId: post.id,
      postSlug: post.slug,
      postTitle: post.title,
      postStatus: post.status,
      boardName: board.name,
    })
    .from(message)
    .leftJoin(post, and(eq(post.id, message.postId), eq(post.orgId, orgId)))
    .leftJoin(board, eq(board.id, post.boardId))
    .where(eq(message.conversationId, id))
    .orderBy(asc(message.createdAt), asc(message.id))

  return {
    data: rows.map(r => ({
      id: r.id,
      role: r.role,
      kind: r.kind,
      text: r.text,
      images: r.images,
      createdAt: r.createdAt,
      post: r.postId
        ? { id: r.postId, slug: r.postSlug!, title: r.postTitle!, board: r.boardName, status: r.postStatus! }
        : null,
    })),
  }
})
