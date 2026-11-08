import { pauseHelpIndex } from '#layers/feedlog/server/lib/help-search/jobs'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { helpArticle } from '#layers/feedlog/server/db/schemas'
import { bulkHelpArticleSchema } from '#layers/feedlog/shared/schemas/help'

export default defineEventHandler(async (event) => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })
  const body = await readValidatedBody(event, bulkHelpArticleSchema.parse)

  const db = useDB()

  const affected = await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${orgId + ':help'}, 0))`)
    const changed = await tx
      .update(helpArticle)
      .set({ status: 'archived' })
      .where(and(
        eq(helpArticle.orgId, orgId),
        inArray(helpArticle.id, body.ids),
        eq(helpArticle.status, 'published'),
      ))
      .returning({ id: helpArticle.id })

    for (const article of changed) await pauseHelpIndex(tx, article.id)
    return changed
  })

  return { affected: affected.length, skipped: body.ids.length - affected.length }
})
