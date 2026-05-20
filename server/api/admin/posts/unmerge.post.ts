import { eq, and, sql } from 'drizzle-orm'
import { z } from 'zod/v4'
import { post, comment } from '#layers/feedlog/server/db/schemas'

const unmergeSchema = z.object({
  postId: z.uuid(),
})

// POST /api/admin/posts/unmerge — Unmerge a previously merged post (manager+).
export default defineEventHandler(async (event) => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })
  const body = await readValidatedBody(event, unmergeSchema.parse)

  const db = useDB()

  const [mergedPost] = await db
    .select({ id: post.id, mergedTo: post.mergedTo })
    .from(post)
    .where(and(eq(post.id, body.postId), eq(post.orgId, orgId)))
    .limit(1)

  if (!mergedPost) {
    throw createError({ statusCode: 400, message: 'Post not found' })
  }
  if (!mergedPost.mergedTo) {
    throw createError({ statusCode: 400, message: 'Post is not merged' })
  }

  const canonicalPostId = mergedPost.mergedTo

  await db.transaction(async (tx) => {
    // 1. Clear merged_to
    await tx
      .update(post)
      .set({ mergedTo: null })
      .where(eq(post.id, body.postId))

    // 2. Recalculate canonical vote_count
    await tx.execute(sql`
      WITH RECURSIVE family AS (
        SELECT id FROM post WHERE id = ${canonicalPostId}
        UNION ALL
        SELECT p.id FROM post p JOIN family f ON p.merged_to = f.id
      )
      UPDATE post SET vote_count = (
        SELECT COUNT(DISTINCT user_id) FROM vote WHERE post_id IN (SELECT id FROM family)
      )
      WHERE id = ${canonicalPostId}
    `)

    // 4. Recalculate unmerged post vote_count (it may still have its own sub-tree)
    await tx.execute(sql`
      WITH RECURSIVE family AS (
        SELECT id FROM post WHERE id = ${body.postId}
        UNION ALL
        SELECT p.id FROM post p JOIN family f ON p.merged_to = f.id
      )
      UPDATE post SET vote_count = (
        SELECT COUNT(DISTINCT user_id) FROM vote WHERE post_id IN (SELECT id FROM family)
      )
      WHERE id = ${body.postId}
    `)

    // 5. Delete the merge comment record + decrement commentCount
    const deleted = await tx
      .delete(comment)
      .where(and(
        eq(comment.postId, canonicalPostId),
        eq(comment.type, 'mergedPost'),
        sql`${comment.metadata}->>'merged_post_id' = ${body.postId}`,
      ))
      .returning({ id: comment.id })

    if (deleted.length > 0) {
      await tx
        .update(post)
        .set({ commentCount: sql`GREATEST(${post.commentCount} - ${deleted.length}, 0)` })
        .where(eq(post.id, canonicalPostId))
    }
  })

  return { success: true }
})
