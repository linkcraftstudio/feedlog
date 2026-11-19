import { z } from 'zod'
import { syncWebSourcePage } from '#layers/feedlog/server/services/web-source'
import { webSourceRequest } from '#layers/feedlog/server/lib/web-source/http'
export default defineEventHandler(async event => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  return webSourceRequest(event, pool => syncWebSourcePage(pool, orgId, id), true)
})
