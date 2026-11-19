import { webSourceBulkPages } from '#layers/feedlog/shared/schemas/web-source'
import { removeWebSourcePages } from '#layers/feedlog/server/services/web-source'
import { webSourceRequest } from '#layers/feedlog/server/lib/web-source/http'
export default defineEventHandler(async event => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })
  const body = await readValidatedBody(event, webSourceBulkPages.parse)
  return webSourceRequest(event, pool => removeWebSourcePages(pool, orgId, body.ids), true)
})
