import { eq, and, sql, isNotNull } from 'drizzle-orm'
import { changelog, changelogReaction } from '#layers/feedlog/server/db/schemas'
import { reactionSchema } from '#layers/feedlog/shared/schemas/changelog'

// POST /api/changelogs/:id/reactions — Add reaction (any authenticated user, idempotent).
export default defineEventHandler(async (event) => {
  const { session, orgId } = await requireAuthInOrg(event)
  const id = getRouterParam(event, 'id')!
  const body = await readValidatedBody(event, reactionSchema.parse)

  const db = useDB()

  // Verify changelog exists, is published, and belongs to this org.
  const [entry] = await db
    .select({ id: changelog.id })
    .from(changelog)
    .where(and(eq(changelog.id, id), eq(changelog.orgId, orgId), isNotNull(changelog.publishedAt)))
    .limit(1)

  if (!entry) {
    throw createError({ statusCode: 404, message: 'Changelog not found' })
  }

  // Idempotent insert
  await db
    .insert(changelogReaction)
    .values({
      changelogId: id,
      userId: session.user.id,
      emoji: body.emoji,
    })
    .onConflictDoNothing()

  // Return current state
  return await getReactionState(db, id, session.user.id)
})

async function getReactionState(db: ReturnType<typeof useDB>, changelogId: string, userId: string) {
  const reactionRows = await db
    .select({
      emoji: changelogReaction.emoji,
      count: sql<number>`cast(count(*) as int)`,
    })
    .from(changelogReaction)
    .where(eq(changelogReaction.changelogId, changelogId))
    .groupBy(changelogReaction.emoji)

  const reactionCounts: Record<string, number> = {}
  for (const r of reactionRows) {
    reactionCounts[r.emoji] = r.count
  }

  const userRows = await db
    .select({ emoji: changelogReaction.emoji })
    .from(changelogReaction)
    .where(and(
      eq(changelogReaction.changelogId, changelogId),
      eq(changelogReaction.userId, userId),
    ))

  return {
    reacted: true,
    reactionCounts,
    userReactions: userRows.map(r => r.emoji),
  }
}
