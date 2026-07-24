import { and, eq } from 'drizzle-orm'
import { post, postSubscription } from '#layers/feedlog/server/db/schemas'
import { isActorAdmin } from '#layers/feedlog/shared/utils/notifications'

// POST /api/posts/:postId/subscription — subscribe to this post. A row means
// subscribed. Idempotent. Admins are refused: they don't receive post-thread
// mail, so a row would only become dead data skipped at send time.
export default defineEventHandler(async (event) => {
  const { session, orgId } = await requireAuthInOrg(event)
  const postId = getRouterParam(event, 'postId')!
  const db = useDB()

  const [p] = await db.select({ id: post.id }).from(post)
    .where(and(eq(post.id, postId), eq(post.orgId, orgId))).limit(1)
  if (!p) {
    throw createError({ statusCode: 404, message: 'Post not found' })
  }
  if (isActorAdmin(session, orgId)) {
    throw createError({ statusCode: 403, message: 'Admins do not subscribe to posts' })
  }

  await db.insert(postSubscription)
    .values({ postId, userId: session.user.id })
    .onConflictDoNothing()

  return { subscribed: true }
})
