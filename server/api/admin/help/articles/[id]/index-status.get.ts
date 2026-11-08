import { withHelpPool } from '../../../../../lib/help-search/runtime'
import { helpIndexBadgeEnabled } from '../../../../../lib/help-search/management'
export default defineEventHandler(async event => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })
  const id = getRouterParam(event, 'id')!
  return withHelpPool(event, async pool => {
    const { rows: [row] } = await pool.query(`SELECT CASE
        WHEN t.id IS NULL THEN 'not_indexed'
        WHEN t.status='done' AND t.result='indexed' THEN 'ready'
        WHEN t.status='done' THEN 'failed'
        ELSE 'indexing' END AS status,
      a.status AS publication, t.attempts,CASE WHEN t.result='indexed' THEN NULL ELSE t.result END AS "errorCode",
      CASE WHEN t.status='done' AND t.result='indexed' THEN t.updated_at ELSE NULL END AS "indexedAt",
      t.schedule_at AS "availableAt"
      FROM help_article a LEFT JOIN scheduled_task t ON t.ref_id=a.id AND t.kind='help_index' AND t.item_id IS NULL
      WHERE a.id=$1 AND a.org_id=$2`, [id, orgId])
    if (!row) throw createError({ statusCode: 404, message: 'Article not found' })
    const { publication, ...state } = row
    return { ...state, enabled: publication === 'published' && helpIndexBadgeEnabled() }
  })
})
