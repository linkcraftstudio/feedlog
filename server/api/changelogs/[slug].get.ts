import { eq, and, isNotNull, sql } from 'drizzle-orm'
import { changelog, changelogReaction } from '#layers/feedlog/server/db/schemas'

// GET /api/changelogs/:slug — Public changelog detail
export default defineEventHandler(async (event): Promise<ChangelogListItem> => {
  const session = await getUserSession(event)
  const orgId = event.context.orgId!
  const slug = getRouterParam(event, 'slug')!

  const db = useDB()

  const [entry] = await db
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
    .where(and(eq(changelog.slug, slug), eq(changelog.orgId, orgId), isNotNull(changelog.publishedAt)))
    .limit(1)

  if (!entry) {
    throw createError({ statusCode: 404, message: 'Changelog not found' })
  }

  // Reaction counts
  const reactionRows = await db
    .select({
      emoji: changelogReaction.emoji,
      count: sql<number>`cast(count(*) as int)`,
    })
    .from(changelogReaction)
    .where(eq(changelogReaction.changelogId, entry.id))
    .groupBy(changelogReaction.emoji)

  const reactionCounts: Record<string, number> = {}
  for (const r of reactionRows) {
    reactionCounts[r.emoji] = r.count
  }

  // User's own reactions
  let userReactions: string[] = []
  if (session) {
    const rows = await db
      .select({ emoji: changelogReaction.emoji })
      .from(changelogReaction)
      .where(and(
        eq(changelogReaction.changelogId, entry.id),
        eq(changelogReaction.userId, session.user.id),
      ))
    userReactions = rows.map(r => r.emoji)
  }

  return {
    id: entry.id,
    slug: entry.slug,
    title: entry.title ?? '',
    content: entry.content ?? '',
    categories: (entry.categories as string[]) ?? [],
    cover: entry.cover ?? null,
    publishedAt: entry.publishedAt!.toISOString(),
    reactionCounts,
    userReactions,
  }
})
