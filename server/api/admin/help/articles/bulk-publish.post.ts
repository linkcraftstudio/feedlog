import { queueHelpIndex } from '#layers/feedlog/server/lib/help-search/jobs'
import { kickHelpIndex } from '#layers/feedlog/server/lib/help-search/runtime'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { helpArticle } from '#layers/feedlog/server/db/schemas'
import { bulkHelpArticleSchema } from '#layers/feedlog/shared/schemas/help'

export default defineEventHandler(async (event) => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })
  const body = await readValidatedBody(event, bulkHelpArticleSchema.parse)

  const db = useDB()

  const queued: string[] = []
  const affected = await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${orgId + ':help'}, 0))`)
    const changed = await tx
      .update(helpArticle)
      .set({ status: 'published', publishedAt: sql`coalesce(${helpArticle.publishedAt}, now())` })
      .where(and(
        eq(helpArticle.orgId, orgId),
        inArray(helpArticle.id, body.ids),
        ne(helpArticle.status, 'published'),
      ))
      .returning({ id: helpArticle.id })

    for (const article of changed) {
      await queueHelpIndex(tx, article.id)
      queued.push(article.id)
    }
    return changed
  })
  for (const id of queued) kickHelpIndex(event, id)

  return { affected: affected.length, skipped: body.ids.length - affected.length }
})
