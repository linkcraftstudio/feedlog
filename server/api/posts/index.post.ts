import { getRequestURL } from 'h3'
import { createPostSchema } from '#layers/feedlog/shared/schemas/post'
import { isActorAdmin } from '#layers/feedlog/shared/utils/notifications'

// POST /api/posts — Create a post (any authenticated user: end-user or staff).
export default defineEventHandler(async (event) => {
  const { session, orgId } = await requireAuthInOrg(event)
  await assertGuestMay(event, session, 'allowPost')

  const body = await readValidatedBody(event, createPostSchema.parse)

  const created = await createPostRecord({
    orgId,
    authorId: session.user.id,
    title: body.title,
    content: body.content,
    boardId: body.boardId,
    subscribeAuthor: !isActorAdmin(session, orgId),
  })

  // Async embedding generation (non-blocking)
  event.waitUntil(
    generatePostEmbedding(created.id, orgId, body.title, body.content, created.contentHash),
  )

  if (!isActorAdmin(session, orgId)) {
    event.waitUntil(
      emitAdminNotification({
        orgId,
        typeKey: 'post.created',
        postSlug: created.slug,
        postTitle: created.title,
        snippet: body.content,
        actorId: session.user.id,
        requestOrigin: getRequestURL(event).origin,
      }).catch((err: unknown) => console.error('[notifications] post created emit failed', err)),
    )
  }

  const author = await fetchPostAuthor(session.user.id)

  setResponseStatus(event, 201)
  return {
    id: created.id,
    slug: created.slug,
    title: created.title,
    content: created.content,
    status: created.status,
    boardId: created.boardId,
    voteCount: created.voteCount,
    commentCount: created.commentCount,
    mergedCount: 0,
    mergedTo: null,
    hasVoted: false,
    author: author ?? { id: session.user.id, name: null, image: null },
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
  } satisfies PostDetail
})
