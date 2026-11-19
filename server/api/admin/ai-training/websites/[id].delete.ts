import { z } from 'zod'
import { removeWebSource } from '#layers/feedlog/server/services/web-source'
import { webSourceRequest } from '#layers/feedlog/server/lib/web-source/http'
export default defineEventHandler(async event => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  return webSourceRequest(event, pool => removeWebSource(pool, orgId, id), true)
})
