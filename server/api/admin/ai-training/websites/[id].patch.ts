import { z } from 'zod'
import { webSourceSettings } from '#layers/feedlog/shared/schemas/web-source'
import { updateWebSourceSettings } from '#layers/feedlog/server/services/web-source'
import { webSourceRequest } from '#layers/feedlog/server/lib/web-source/http'
export default defineEventHandler(async event => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const input = await readValidatedBody(event, webSourceSettings.parse)
  return webSourceRequest(event, pool => updateWebSourceSettings(pool, orgId, id, input), true)
})
