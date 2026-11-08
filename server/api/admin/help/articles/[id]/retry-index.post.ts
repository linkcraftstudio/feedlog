import { withHelpPool, kickHelpIndex } from '../../../../../lib/help-search/runtime'
import { helpVectorsEnabled } from '../../../../../lib/help-search/embedding'
export default defineEventHandler(async event => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })
  if (!helpVectorsEnabled()) throw createError({ statusCode: 409, message: 'Semantic search is disabled' })
  const id = getRouterParam(event, 'id')!
  if (!await checkRateLimit(`help-index-retry:${orgId}`, { limit: 10, windowSeconds: 60 })) throw createError({ statusCode: 429, message: 'Too many retry requests' })
  const result = await withHelpPool(event, pool => pool.query(`UPDATE scheduled_task t SET id=gen_random_uuid(),status='pending',attempts=0,
      result=NULL,schedule_at=clock_timestamp(),manual_retry=true,updated_at=clock_timestamp()
    FROM help_article a WHERE t.kind='help_index' AND t.item_id IS NULL AND t.ref_id=a.id
      AND a.id=$1 AND a.org_id=$2 AND a.status='published' AND t.status='done' AND t.result IS DISTINCT FROM 'indexed' RETURNING t.id`, [id, orgId]))
  if (!result.rows.length) throw createError({ statusCode: 409, message: 'Only failed indexing jobs can be retried' })
  kickHelpIndex(event, id)
  return { status: 'pending' }
})
