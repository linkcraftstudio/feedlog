import { and, eq } from 'drizzle-orm'
import { changelog } from '#layers/feedlog/server/db/schemas'
import { updateChangelogSchema } from '#layers/feedlog/shared/schemas/changelog'

// PATCH /api/admin/changelogs/:id — Save changelog (feedlog:moderate).
export default defineEventHandler(async (event) => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })

  const id = getRouterParam(event, 'id')!
  const body = await readValidatedBody(event, updateChangelogSchema.parse)

  const db = useDB()

  const [existing] = await db
    .select({ status: changelog.status })
    .from(changelog)
    .where(and(eq(changelog.id, id), eq(changelog.orgId, orgId)))
    .limit(1)

  if (!existing) {
    throw createError({ statusCode: 404, message: 'Changelog not found' })
  }

  // Status transition: published → needs_update on edit
  const updates: Record<string, unknown> = { ...body }
  if (existing.status === 'published') {
    updates.status = 'needs_update'
  }

  const [updated] = await db
    .update(changelog)
    .set(updates)
    .where(and(eq(changelog.id, id), eq(changelog.orgId, orgId)))
    .returning()

  return updated
})
