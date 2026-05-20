import { and, eq } from 'drizzle-orm'
import { z } from 'zod/v4'
import { comment, post } from '#layers/feedlog/server/db/schemas'

const updateCommentSchema = z.object({
  content: z.string().trim().min(1, 'Content is required').max(5000, 'Comment must be 5000 characters or less'),
})

// PATCH /api/comments/:id — Edit own comment. Author-only: moderators can
// delete other people's comments but not rewrite them (product rule).
export default defineEventHandler(async (event) => {
  const { session, orgId } = await requireAuthInOrg(event)
  const id = getRouterParam(event, 'id')!

  const db = useDB()

  // Comment is org-scoped via post.org_id — join post and verify both.
  const [existing] = await db
    .select({ id: comment.id, authorId: comment.authorId, postOrgId: post.orgId })
    .from(comment)
    .leftJoin(post, eq(comment.postId, post.id))
    .where(and(eq(comment.id, id), eq(post.orgId, orgId)))
    .limit(1)

  if (!existing) {
    throw createError({ statusCode: 404, message: 'Comment not found' })
  }
  if (existing.authorId !== session.user.id) {
    throw createError({ statusCode: 403, message: 'You can only edit your own comments' })
  }

  const body = await readValidatedBody(event, updateCommentSchema.parse)

  const [updated] = await db
    .update(comment)
    .set({ content: body.content, editedAt: new Date() })
    .where(eq(comment.id, id))
    .returning()

  return updated
})
