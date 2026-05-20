import { eq, and, desc, sql, or } from 'drizzle-orm'
import { changelog, user } from '#layers/feedlog/server/db/schemas'

// GET /api/admin/changelogs — Admin list. Any org member can read; mutation
// endpoints (create / update / publish / delete) are gated by feedlog:moderate.
// Note: this surfaces draft / scheduled rows to contributors too — that's
// intentional, since the dashboard route is the only place those exist.
export default defineEventHandler(async (event) => {
  const { orgId } = await requireOrgMember(event)

  const query = getQuery(event)
  const status = query.status as string | undefined
  const search = (query.search as string)?.trim()
  const page = Math.max(Number(query.page) || 1, 1)
  const pageSize = Math.min(Number(query.pageSize) || 10, 100)
  const offset = (page - 1) * pageSize

  const db = useDB()

  const conditions: any[] = [eq(changelog.orgId, orgId)]
  if (status) conditions.push(eq(changelog.status, status))
  if (search && search.length >= 1) {
    conditions.push(
      or(
        sql`${search} <% ${changelog.title}`,
        sql`${search} <% ${changelog.content}`,
        sql`${search} <% ${changelog.publishedTitle}`,
        sql`${search} <% ${changelog.publishedContent}`,
      ),
    )
  }

  const whereClause = and(...conditions)

  const [countResult] = await db
    .select({ total: sql<number>`cast(count(*) as int)` })
    .from(changelog)
    .where(whereClause)

  const rows = await db
    .select({
      id: changelog.id,
      slug: changelog.slug,
      title: changelog.title,
      status: changelog.status,
      categories: changelog.categories,
      cover: changelog.cover,
      publishedAt: changelog.publishedAt,
      updatedAt: changelog.updatedAt,
      authorId: changelog.authorId,
      authorName: user.name,
      authorImage: user.image,
    })
    .from(changelog)
    .leftJoin(user, eq(changelog.authorId, user.id))
    .where(whereClause)
    .orderBy(
      ...(search
        ? [sql`LEAST(${search} <<-> ${changelog.title}, ${search} <<-> ${changelog.content}, ${search} <<-> ${changelog.publishedTitle}, ${search} <<-> ${changelog.publishedContent})`]
        : [desc(changelog.updatedAt), desc(changelog.id)]),
    )
    .limit(pageSize)
    .offset(offset)

  return {
    data: rows.map(r => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      status: r.status,
      categories: r.categories,
      cover: r.cover,
      publishedAt: r.publishedAt,
      updatedAt: r.updatedAt,
      author: { id: r.authorId, name: r.authorName, image: r.authorImage },
    })),
    pagination: { page, pageSize, total: countResult?.total ?? 0 },
  }
})
