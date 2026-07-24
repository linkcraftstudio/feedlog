import { and, eq } from 'drizzle-orm'
import { post, postSubscription } from '#layers/feedlog/server/db/schemas'

// DELETE /api/posts/:postId/subscription — unsubscribe. Removes the row.
// Idempotent: deleting a non-existent row is a no-op.
export default defineEventHandler(async (event) => {
  const { session, orgId } = await requireAuthInOrg(event)
  const postId = getRouterParam(event, 'postId')!
  const db = useDB()

  const [p] = await db.select({ id: post.id }).from(post)
    .where(and(eq(post.id, postId), eq(post.orgId, orgId))).limit(1)
  if (!p) {
    throw createError({ statusCode: 404, message: 'Post not found' })
  }

  await db.delete(postSubscription)
    .where(and(eq(postSubscription.postId, postId), eq(postSubscription.userId, session.user.id)))

  return { subscribed: false }
})
