import { changelog } from '#layers/feedlog/server/db/schemas'
import { createChangelogSchema } from '#layers/feedlog/shared/schemas/changelog'

// POST /api/admin/changelogs — Create changelog (feedlog:moderate).
export default defineEventHandler(async (event) => {
  const { session, orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })
  const body = await readValidatedBody(event, createChangelogSchema.parse)

  const db = useDB()
  const slug = await generateChangelogSlug(body.title)

  const [created] = await db
    .insert(changelog)
    .values({
      orgId,
      authorId: session.user.id,
      slug,
      title: body.title,
      content: body.content,
      categories: body.categories,
      cover: body.cover ?? null,
    })
    .returning()

  setResponseStatus(event, 201)
  return created
})
