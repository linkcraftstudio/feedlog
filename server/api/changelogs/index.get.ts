import { and, desc, sql, isNotNull, inArray, eq } from 'drizzle-orm'
import { changelog, changelogReaction } from '#layers/feedlog/server/db/schemas'

// GET /api/changelogs — Public changelog list (cursor pagination)
export default defineEventHandler(async (event): Promise<CursorPaginatedList<ChangelogListItem>> => {
  const session = await getUserSession(event)
  const orgId = event.context.orgId!
  const query = getQuery(event)

  const cursor = query.cursor as string | undefined
  const pageSize = Math.min(Number(query.pageSize) || 10, 50)

  const db = useDB()

  const conditions: any[] = [eq(changelog.orgId, orgId), isNotNull(changelog.publishedAt)]

  if (cursor) {
    const decoded = decodeCursor(cursor)
    if (decoded) {
      conditions.push(
        sql`(${changelog.publishedAt}, ${changelog.id}) < (${decoded.s}::timestamptz, ${decoded.id}::uuid)`,
      )
    }
  }

  const whereClause = and(...conditions)

  const rows = await db
    .select({
      id: changelog.id,
      slug: changelog.slug,
      title: changelog.publishedTitle,
      content: changelog.publishedContent,
      categories: changelog.publishedCategories,
      cover: changelog.publishedCover,
      publishedAt: changelog.publishedAt,
    })
    .from(changelog)
    .where(whereClause)
    .orderBy(desc(changelog.publishedAt), desc(changelog.id))
    .limit(pageSize + 1)

  const hasMore = rows.length > pageSize
  const items = hasMore ? rows.slice(0, pageSize) : rows

  // Batch query reaction counts
  const changelogIds = items.map(r => r.id)
  let reactionCountsMap: Record<string, Record<string, number>> = {}
  let userReactionsMap: Record<string, string[]> = {}

  if (changelogIds.length > 0) {
    const reactionRows = await db
      .select({
        changelogId: changelogReaction.changelogId,
        emoji: changelogReaction.emoji,
        count: sql<number>`cast(count(*) as int)`,
      })
      .from(changelogReaction)
      .where(inArray(changelogReaction.changelogId, changelogIds))
      .groupBy(changelogReaction.changelogId, changelogReaction.emoji)

    for (const r of reactionRows) {
      if (!reactionCountsMap[r.changelogId]) reactionCountsMap[r.changelogId] = {}
      reactionCountsMap[r.changelogId][r.emoji] = r.count
    }

    // User's own reactions
    if (session) {
      const userReactions = await db
        .select({
          changelogId: changelogReaction.changelogId,
          emoji: changelogReaction.emoji,
        })
        .from(changelogReaction)
        .where(and(
          inArray(changelogReaction.changelogId, changelogIds),
          eq(changelogReaction.userId, session.user.id),
        ))

      for (const r of userReactions) {
        if (!userReactionsMap[r.changelogId]) userReactionsMap[r.changelogId] = []
        userReactionsMap[r.changelogId].push(r.emoji)
      }
    }
  }

  const data: ChangelogListItem[] = items.map(r => ({
    id: r.id,
    slug: r.slug,
    title: r.title ?? '',
    content: r.content ?? '',
    categories: (r.categories as string[]) ?? [],
    cover: r.cover ?? null,
    publishedAt: r.publishedAt!.toISOString(),
    reactionCounts: reactionCountsMap[r.id] ?? {},
    userReactions: userReactionsMap[r.id] ?? [],
  }))

  const lastItem = data[data.length - 1]
  const nextCursor = hasMore && lastItem
    ? encodeCursor({ s: lastItem.publishedAt, id: lastItem.id })
    : null

  return { data, pagination: { nextCursor } }
})

function encodeCursor(data: { s: unknown; id: string }): string {
  return Buffer.from(JSON.stringify(data)).toString('base64url')
}

function decodeCursor(cursor: string): { s: any; id: string } | null {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString())
  } catch {
    return null
  }
}
