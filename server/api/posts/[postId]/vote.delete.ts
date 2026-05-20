import { eq, and, sql } from 'drizzle-orm'
import { vote, post } from '#layers/feedlog/server/db/schemas'

// DELETE /api/posts/:id/vote — Remove own vote (any authenticated user, idempotent).
// Scoped to the caller's userId, so "own" is implicit — no row check needed.
export default defineEventHandler(async (event) => {
  const { session, orgId } = await requireAuthInOrg(event)
  const postId = getRouterParam(event, 'postId')!

  const db = useDB()

  // Confirm post belongs to this org (defence in depth)
  const [p0] = await db.select({ id: post.id }).from(post)
    .where(and(eq(post.id, postId), eq(post.orgId, orgId))).limit(1)
  if (!p0) {
    throw createError({ statusCode: 404, message: 'Post not found' })
  }

  // Delete vote
  const [deleted] = await db
    .delete(vote)
    .where(and(eq(vote.postId, postId), eq(vote.userId, session.user.id)))
    .returning({ postId: vote.postId })

  if (!deleted) {
    // Not voted, return current state
    const [p] = await db.select({ voteCount: post.voteCount }).from(post).where(eq(post.id, postId))
    return { voted: false, voteCount: p?.voteCount ?? 0 }
  }

  // Decrement count
  const [updated] = await db
    .update(post)
    .set({ voteCount: sql`greatest(${post.voteCount} - 1, 0)` })
    .where(eq(post.id, postId))
    .returning({ voteCount: post.voteCount })

  return { voted: false, voteCount: updated?.voteCount ?? 0 }
})
