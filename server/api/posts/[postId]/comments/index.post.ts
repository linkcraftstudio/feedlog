import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod/v4'
import { comment, post, user } from '#layers/feedlog/server/db/schemas'

const createCommentSchema = z.object({
  content: z.string().trim().min(1, 'Content is required').max(5000, 'Comment must be 5000 characters or less'),
  parentId: z.uuid().optional(),
  replyToId: z.uuid().optional(),
})

// POST /api/posts/:postId/comments — Create a comment (any authenticated user).
export default defineEventHandler(async (event) => {
  const { session, orgId } = await requireAuthInOrg(event)
  const postId = getRouterParam(event, 'postId')!

  const body = await readValidatedBody(event, createCommentSchema.parse)

  const db = useDB()

  // Verify post exists, belongs to org, and is not merged.
  const [p] = await db.select({ id: post.id, mergedTo: post.mergedTo }).from(post)
    .where(and(eq(post.id, postId), eq(post.orgId, orgId))).limit(1)
  if (!p) {
    throw createError({ statusCode: 404, message: 'Post not found' })
  }
  if (p.mergedTo) {
    throw createError({ statusCode: 403, message: 'Cannot comment on a merged post' })
  }

  // Determine parent for reply flattening
  let parentId = body.parentId ?? null
  let replyToId = body.replyToId ?? null

  if (parentId) {
    // Verify parent comment exists and belongs to this post
    const [parent] = await db
      .select({ id: comment.id, parentId: comment.parentId })
      .from(comment)
      .where(eq(comment.id, parentId))
      .limit(1)

    if (!parent) {
      throw createError({ statusCode: 404, message: 'Parent comment not found' })
    }

    // If replying to a child comment, flatten: parentId = child's parentId
    if (parent.parentId) {
      replyToId = parentId
      parentId = parent.parentId
    }
  }

  // Insert comment
  const [created] = await db
    .insert(comment)
    .values({
      postId,
      parentId,
      replyToId,
      authorId: session.user.id,
      content: body.content,
    })
    .returning()

  // Update counts
  if (parentId) {
    // Reply: increment parent's replyCount + post's commentCount
    await db.update(comment).set({ replyCount: sql`${comment.replyCount} + 1` }).where(eq(comment.id, parentId))
  }
  await db.update(post).set({ commentCount: sql`${post.commentCount} + 1` }).where(eq(post.id, postId))

  // Fetch author info
  const [author] = await db
    .select({ id: user.id, name: user.name, image: user.image })
    .from(user)
    .where(eq(user.id, session.user.id))

  setResponseStatus(event, 201)
  return {
    id: created!.id,
    parentId: created!.parentId,
    replyToId: created!.replyToId,
    replyCount: created!.replyCount,
    likeCount: created!.likeCount,
    hasLiked: false,
    author: author ?? { id: session.user.id, name: null, image: null },
    content: created!.content,
    editedAt: created!.editedAt,
    createdAt: created!.createdAt,
  }
})
