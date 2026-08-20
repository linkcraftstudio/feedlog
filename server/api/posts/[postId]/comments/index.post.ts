import { and, eq, sql } from 'drizzle-orm'
import { getRequestURL } from 'h3'
import { z } from 'zod/v4'
import { comment, post, user } from '#layers/feedlog/server/db/schemas'
import { isActorAdmin } from '#layers/feedlog/shared/utils/notifications'

const createCommentSchema = z.object({
  content: z.string().trim().min(1, 'Content is required').max(5000, 'Comment must be 5000 characters or less'),
  parentId: z.uuid().optional(),
  replyToId: z.uuid().optional(),
  // Admin opt-out for pinging upvoters; author + manual subscribers always get it.
  notifyVoters: z.boolean().optional(),
})

// POST /api/posts/:postId/comments — Create a comment (any authenticated user).
export default defineEventHandler(async (event) => {
  const { session, orgId } = await requireAuthInOrg(event)
  const postId = getRouterParam(event, 'postId')!

  const body = await readValidatedBody(event, createCommentSchema.parse)

  const db = useDB()

  // Verify post exists, belongs to org, and is not merged.
  const [p] = await db.select({ id: post.id, authorId: post.authorId, mergedTo: post.mergedTo, slug: post.slug, title: post.title }).from(post)
    .where(and(eq(post.id, postId), eq(post.orgId, orgId))).limit(1)
  if (!p) {
    throw createError({ statusCode: 404, message: 'Post not found' })
  }
  if (p.mergedTo) {
    throw createError({ statusCode: 403, message: 'Cannot comment on a merged post' })
  }

  // Guests may always keep talking under their own report — adding a detail or
  // answering an admin's follow-up is part of filing it. The switch governs
  // speaking up on other people's posts.
  if (p.authorId !== session.user.id) {
    await assertGuestMay(event, session, 'allowComment')
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

  // Best-effort, after the write. Subscribers only hear from an admin's top-level
  // comment (resolveCommentEvents no-ops for replies / non-admins). Author +
  // manual subscribers always get it; upvoters only when notifyVoters isn't false.
  event.waitUntil(
    emitCommentNotifications({
      orgId,
      postId,
      snippet: body.content,
      actorId: session.user.id,
      authorIsAdmin: isActorAdmin(session, orgId),
      isTopLevel: !parentId,
      notifyVoters: body.notifyVoters !== false,
      requestOrigin: getRequestURL(event).origin,
    }).catch((err: unknown) => console.error('[notifications] comment emit failed', err)),
  )

  if (!isActorAdmin(session, orgId)) {
    event.waitUntil(
      emitAdminNotification({
        orgId,
        typeKey: 'post.user_commented',
        postSlug: p.slug,
        postTitle: p.title,
        snippet: body.content,
        actorId: session.user.id,
        requestOrigin: getRequestURL(event).origin,
      }).catch((err: unknown) => console.error('[notifications] comment admin emit failed', err)),
    )
  }

  const [author] = await db
    .select({ id: user.id, name: user.name, image: user.image, isAnonymous: user.isAnonymous })
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
    author: {
      ...(author ?? { id: session.user.id, name: null, image: null }),
      isAnonymous: !!author?.isAnonymous,
      isAdmin: isActorAdmin(session, orgId),
    },
    content: created!.content,
    editedAt: created!.editedAt,
    createdAt: created!.createdAt,
  }
})
