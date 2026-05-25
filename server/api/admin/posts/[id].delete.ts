import { and, eq, sql } from 'drizzle-orm'
import { post, comment, commentLike, vote } from '#layers/feedlog/server/db/schemas'

// DELETE /api/admin/posts/:id — Moderator-only hard delete. Once a post is
// public it belongs to the community (others' upvotes/comments/status); the
// author has no self-delete path, only edit via PATCH /api/posts/:id.
export default defineEventHandler(async (event) => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })
  const id = getRouterParam(event, 'id')!
  const db = useDB()

  const [existing] = await db
    .select({ mergedTo: post.mergedTo })
    .from(post)
    .where(and(eq(post.id, id), eq(post.orgId, orgId)))
    .limit(1)
  if (!existing) {
    throw createError({ statusCode: 404, message: 'Post not found' })
  }
  if (existing.mergedTo) {
    throw createError({ statusCode: 400, message: 'Cannot delete a merged post. Unmerge it first.' })
  }

  // Delete associated data (no DB foreign keys, cascade at application level)
  // 1. Delete all comment likes for this post
  await db.delete(commentLike).where(
    sql`${commentLike.commentId} IN (SELECT ${comment.id} FROM ${comment} WHERE ${comment.postId} = ${id})`,
  )
  // 2. Delete all comments for this post
  await db.delete(comment).where(eq(comment.postId, id))
  // 3. Delete votes for this post
  await db.delete(vote).where(eq(vote.postId, id))
  // 4. Delete the post itself (re-check org for safety)
  const [deleted] = await db.delete(post).where(and(eq(post.id, id), eq(post.orgId, orgId))).returning({ id: post.id })

  if (!deleted) {
    throw createError({ statusCode: 404, message: 'Post not found' })
  }

  setResponseStatus(event, 204)
  return null
})
