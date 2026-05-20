import { eq, and, sql } from 'drizzle-orm'
import { commentLike, comment, post } from '#layers/feedlog/server/db/schemas'

// DELETE /api/comments/:id/like — Unlike a comment (any authenticated user, idempotent).
export default defineEventHandler(async (event) => {
  const { session, orgId } = await requireAuthInOrg(event)
  const commentId = getRouterParam(event, 'id')!

  const db = useDB()

  // Confirm comment scope.
  const [scope] = await db
    .select({ id: comment.id })
    .from(comment)
    .leftJoin(post, eq(comment.postId, post.id))
    .where(and(eq(comment.id, commentId), eq(post.orgId, orgId)))
    .limit(1)
  if (!scope) {
    throw createError({ statusCode: 404, message: 'Comment not found' })
  }

  const [deleted] = await db
    .delete(commentLike)
    .where(and(eq(commentLike.commentId, commentId), eq(commentLike.userId, session.user.id)))
    .returning({ commentId: commentLike.commentId })

  if (!deleted) {
    const [c] = await db.select({ likeCount: comment.likeCount }).from(comment).where(eq(comment.id, commentId))
    return { liked: false, likeCount: c?.likeCount ?? 0 }
  }

  const [updated] = await db
    .update(comment)
    .set({ likeCount: sql`greatest(${comment.likeCount} - 1, 0)` })
    .where(eq(comment.id, commentId))
    .returning({ likeCount: comment.likeCount })

  return { liked: false, likeCount: updated?.likeCount ?? 0 }
})
