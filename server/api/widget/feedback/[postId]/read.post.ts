import { and, eq } from 'drizzle-orm'
import { post, postUnread } from '#layers/feedlog/server/db/schemas'
import { countWidgetBadge } from '#layers/feedlog/server/utils/widget-unread'

// Clears the red dot on one feedback item when the visitor opens it.
export default defineEventHandler(async (event): Promise<{ ok: true, count: number, feedback: number }> => {
  const { session, orgId } = await requireAuthInOrg(event)
  const userId = session.user.id
  const postId = getRouterParam(event, 'postId')
  if (!postId) {
    throw createError({ statusCode: 400, message: 'Missing postId' })
  }

  const db = useDB()

  // Confirms the post is the caller's own and in this org before touching
  // post_unread, which carries neither an org column nor an author column.
  const [target] = await db
    .select({ id: post.id })
    .from(post)
    .where(and(eq(post.id, postId), eq(post.orgId, orgId), eq(post.authorId, userId)))
    .limit(1)
  if (!target) {
    throw createError({ statusCode: 404, message: 'Feedback not found' })
  }

  await db
    .delete(postUnread)
    .where(and(eq(postUnread.postId, postId), eq(postUnread.userId, userId)))

  // Remaining count, so the iframe can push the new badge value to the SDK
  // without a follow-up request to /api/widget/unread.
  return { ok: true, ...await countWidgetBadge(orgId, userId) }
})
