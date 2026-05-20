import { post, postSearch, user } from '#layers/feedlog/server/db/schemas'
import { eq } from 'drizzle-orm'
import { createPostSchema } from '#layers/feedlog/shared/schemas/post'

// POST /api/posts — Create a post (any authenticated user: end-user or staff).
export default defineEventHandler(async (event) => {
  const { session, orgId } = await requireAuthInOrg(event)

  const body = await readValidatedBody(event, createPostSchema.parse)

  const slug = await generateSlug(body.title)
  const excerpt = generateExcerpt(body.content)
  const contentHash = computeContentHash(body.title, body.content)

  const db = useDB()
  const [created] = await db
    .insert(post)
    .values({
      orgId,
      title: body.title,
      content: body.content,
      excerpt,
      slug,
      contentHash,
      boardId: body.boardId || null,
      authorId: session.user.id,
    })
    .returning()

  if (!created) {
    throw createError({ statusCode: 500, message: 'Failed to create' })
  }

  // Sync write post_search for trgm search
  const searchText = stripMarkdown(body.title + '\n' + body.content)
  await db
    .insert(postSearch)
    .values({ postId: created.id, orgId, searchText })

  // Async embedding generation (non-blocking)
  event.waitUntil(
    generatePostEmbedding(created.id, orgId, body.title, body.content, contentHash),
  )

  const [author] = await db
    .select({ id: user.id, name: user.name, image: user.image })
    .from(user)
    .where(eq(user.id, session.user.id))

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
