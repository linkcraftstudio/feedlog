import { and, eq, sql } from 'drizzle-orm'
import { comment, commentLike, post } from '#layers/feedlog/server/db/schemas'

// DELETE /api/comments/:id — Delete comment. Author can delete own;
// moderators can delete anyone's (escalates via feedlog:moderate).
// Cascades children for top-level.
export default defineEventHandler(async (event) => {
  const { session, orgId } = await requireAuthInOrg(event)
  const id = getRouterParam(event, 'id')!

  const db = useDB()

  const [existing] = await db
    .select({
      id: comment.id,
      postId: comment.postId,
      parentId: comment.parentId,
      replyCount: comment.replyCount,
      authorId: comment.authorId,
    })
    .from(comment)
    .leftJoin(post, eq(comment.postId, post.id))
    .where(and(eq(comment.id, id), eq(post.orgId, orgId)))
    .limit(1)

  if (!existing) {
    throw createError({ statusCode: 404, message: 'Comment not found' })
  }
  if (existing.authorId !== session.user.id) {
    await requireOrgPermission(event, { feedlog: ['moderate'] })
  }

  if (!existing.parentId) {
    // Deleting a top-level comment: cascade delete children + their likes
    await db.delete(commentLike).where(
      sql`${commentLike.commentId} IN (SELECT ${comment.id} FROM ${comment} WHERE ${comment.parentId} = ${id})`,
    )
    await db.delete(comment).where(eq(comment.parentId, id))
    // Delete own likes
    await db.delete(commentLike).where(eq(commentLike.commentId, id))
    // Delete self
    await db.delete(comment).where(eq(comment.id, id))
    // Decrement post comment count by 1 + replyCount
    await db.update(post).set({
      commentCount: sql`greatest(${post.commentCount} - ${1 + existing.replyCount}, 0)`,
    }).where(eq(post.id, existing.postId))
  } else {
    // Deleting a child comment
    await db.delete(commentLike).where(eq(commentLike.commentId, id))
    await db.delete(comment).where(eq(comment.id, id))
    // Decrement parent's replyCount
    await db.update(comment).set({
      replyCount: sql`greatest(${comment.replyCount} - 1, 0)`,
    }).where(eq(comment.id, existing.parentId))
    // Decrement post comment count
    await db.update(post).set({
      commentCount: sql`greatest(${post.commentCount} - 1, 0)`,
    }).where(eq(post.id, existing.postId))
  }

  setResponseStatus(event, 204)
  return null
})
