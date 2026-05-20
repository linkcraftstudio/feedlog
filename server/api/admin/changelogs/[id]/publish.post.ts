import { and, eq } from 'drizzle-orm'
import { changelog } from '#layers/feedlog/server/db/schemas'

// POST /api/admin/changelogs/:id/publish — Publish changelog (feedlog:moderate).
export default defineEventHandler(async (event) => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })

  const id = getRouterParam(event, 'id')!
  const db = useDB()

  const [existing] = await db
    .select({
      id: changelog.id,
      title: changelog.title,
      content: changelog.content,
      categories: changelog.categories,
      cover: changelog.cover,
    })
    .from(changelog)
    .where(and(eq(changelog.id, id), eq(changelog.orgId, orgId)))
    .limit(1)

  if (!existing) {
    throw createError({ statusCode: 404, message: 'Changelog not found' })
  }

  if (!existing.title?.trim() || !existing.content?.trim()) {
    throw createError({ statusCode: 400, message: 'Title and content are required to publish' })
  }

  // Copy editing fields to published snapshot
  const [updated] = await db
    .update(changelog)
    .set({
      publishedTitle: existing.title,
      publishedContent: existing.content,
      publishedCategories: existing.categories,
      publishedCover: existing.cover,
      status: 'published',
      publishedAt: new Date(),
    })
    .where(and(eq(changelog.id, id), eq(changelog.orgId, orgId)))
    .returning()

  return updated
})
