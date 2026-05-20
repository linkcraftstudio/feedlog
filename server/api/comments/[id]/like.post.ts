import { eq, and, sql } from 'drizzle-orm'
import { commentLike, comment, post } from '#layers/feedlog/server/db/schemas'

// POST /api/comments/:id/like — Like a comment (any authenticated user, idempotent).
export default defineEventHandler(async (event) => {
  const { session, orgId } = await requireAuthInOrg(event)
  const commentId = getRouterParam(event, 'id')!

  const db = useDB()

  // Confirm the comment lives in this org via its parent post.
  const [scope] = await db
    .select({ id: comment.id })
    .from(comment)
    .leftJoin(post, eq(comment.postId, post.id))
    .where(and(eq(comment.id, commentId), eq(post.orgId, orgId)))
    .limit(1)
  if (!scope) {
    throw createError({ statusCode: 404, message: 'Comment not found' })
  }

  // Check if already liked
  const [existing] = await db
    .select({ commentId: commentLike.commentId })
    .from(commentLike)
    .where(and(eq(commentLike.commentId, commentId), eq(commentLike.userId, session.user.id)))
    .limit(1)

  if (existing) {
    const [c] = await db.select({ likeCount: comment.likeCount }).from(comment).where(eq(comment.id, commentId))
    return { liked: true, likeCount: c?.likeCount ?? 0 }
  }

  await db.insert(commentLike).values({ commentId, userId: session.user.id })
  const [updated] = await db
    .update(comment)
    .set({ likeCount: sql`${comment.likeCount} + 1` })
    .where(eq(comment.id, commentId))
    .returning({ likeCount: comment.likeCount })

  return { liked: true, likeCount: updated?.likeCount ?? 0 }
})
