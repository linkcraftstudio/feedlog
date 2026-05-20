import { and, eq } from 'drizzle-orm'
import { post, postSearch } from '#layers/feedlog/server/db/schemas'
import { updatePostSchema } from '#layers/feedlog/shared/schemas/post'

// PATCH /api/admin/posts/:id — Moderator-style update (status / board / title / content).
// Moderator gate covers all moderation fields uniformly; the dedicated public
// PATCH /api/posts/:id handles author edits with the inline ownership check.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readValidatedBody(event, updatePostSchema.parse)

  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })

  const db = useDB()

  const [existing] = await db
    .select({ id: post.id, title: post.title, content: post.content })
    .from(post)
    .where(and(eq(post.id, id), eq(post.orgId, orgId)))
    .limit(1)

  if (!existing) {
    throw createError({ statusCode: 404, message: 'Post not found' })
  }

  const updates: Record<string, unknown> = {}
  if (body.title !== undefined) updates.title = body.title
  if (body.content !== undefined) {
    updates.content = body.content
    updates.excerpt = generateExcerpt(body.content)
  }
  if (body.status !== undefined) updates.status = body.status
  if (body.boardId !== undefined) updates.boardId = body.boardId

  if (Object.keys(updates).length === 0) {
    throw createError({ statusCode: 400, message: 'No fields to update' })
  }

  // Check if title or content changed
  const newTitle = (updates.title as string) ?? existing.title
  const newContent = (updates.content as string) ?? existing.content
  const contentChanged = newTitle !== existing.title || newContent !== existing.content

  if (contentChanged) {
    updates.contentHash = computeContentHash(newTitle, newContent)
  }

  const [updated] = await db
    .update(post)
    .set(updates)
    .where(and(eq(post.id, id), eq(post.orgId, orgId)))
    .returning()

  // Update search text and trigger embedding if content changed
  if (contentChanged) {
    const searchText = stripMarkdown(newTitle + '\n' + newContent)
    await db
      .insert(postSearch)
      .values({ postId: id, orgId, searchText })
      .onConflictDoUpdate({
        target: postSearch.postId,
        set: { searchText },
      })

    event.waitUntil(
      generatePostEmbedding(id, orgId, newTitle, newContent, updates.contentHash as string),
    )
  }

  return updated
})
