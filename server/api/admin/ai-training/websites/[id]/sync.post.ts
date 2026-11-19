import { z } from 'zod'
import { webSourceTransaction, startWebSourceRun } from '#layers/feedlog/server/lib/web-source/jobs'
import { webSourceRequest } from '#layers/feedlog/server/lib/web-source/http'
export default defineEventHandler(async event => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  return webSourceRequest(event, pool => webSourceTransaction(pool, client => startWebSourceRun(client, orgId, id, 'manual')), true)
})
