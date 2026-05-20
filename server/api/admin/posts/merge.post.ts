import { eq, and, sql } from 'drizzle-orm'
import { z } from 'zod/v4'
import { post, comment } from '#layers/feedlog/server/db/schemas'

const mergeSchema = z.object({
  canonicalPostId: z.uuid(),
  mergedPostId: z.uuid(),
})

// POST /api/admin/posts/merge — Merge a post into a canonical post (manager+).
export default defineEventHandler(async (event) => {
  const { session, orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })
  const body = await readValidatedBody(event, mergeSchema.parse)

  if (body.canonicalPostId === body.mergedPostId) {
    throw createError({ statusCode: 400, message: 'Cannot merge a post into itself' })
  }

  const db = useDB()

  // Fetch both posts (must belong to current org)
  const [canonical] = await db
    .select({ id: post.id, mergedTo: post.mergedTo })
    .from(post)
    .where(and(eq(post.id, body.canonicalPostId), eq(post.orgId, orgId)))
    .limit(1)

  if (!canonical) {
    throw createError({ statusCode: 400, message: 'Canonical post not found' })
  }
  if (canonical.mergedTo) {
    throw createError({ statusCode: 400, message: 'Canonical post is itself merged into another post' })
  }

  const [merged] = await db
    .select({ id: post.id, mergedTo: post.mergedTo })
    .from(post)
    .where(and(eq(post.id, body.mergedPostId), eq(post.orgId, orgId)))
    .limit(1)

  if (!merged) {
    throw createError({ statusCode: 400, message: 'Merged post not found' })
  }

  // Idempotent: already merged to this canonical
  if (merged.mergedTo === body.canonicalPostId) {
    return { success: true }
  }

  // Transaction: set merge relation → recalculate vote_count → insert merge comment
  await db.transaction(async (tx) => {
    // 1. Set merged_to
    await tx
      .update(post)
      .set({ mergedTo: body.canonicalPostId })
      .where(eq(post.id, body.mergedPostId))

    // 2. Recalculate canonical vote_count using recursive CTE (DISTINCT user_id)
    await tx.execute(sql`
      WITH RECURSIVE family AS (
        SELECT id FROM post WHERE id = ${body.canonicalPostId}
        UNION ALL
        SELECT p.id FROM post p JOIN family f ON p.merged_to = f.id
      )
      UPDATE post SET vote_count = (
        SELECT COUNT(DISTINCT user_id) FROM vote WHERE post_id IN (SELECT id FROM family)
      )
      WHERE id = ${body.canonicalPostId}
    `)

    // 4. Insert merge comment record (org-scoped via canonical post)
    await tx
      .insert(comment)
      .values({
        postId: body.canonicalPostId,
        authorId: session.user.id,
        content: '',
        type: 'mergedPost',
        metadata: { merged_post_id: body.mergedPostId },
      })

    // 5. Increment canonical's commentCount
    await tx
      .update(post)
      .set({ commentCount: sql`${post.commentCount} + 1` })
      .where(eq(post.id, body.canonicalPostId))
  })

  return { success: true }
})
