import { z } from 'zod'
import { updateWebsiteAiReference } from '#layers/feedlog/server/services/web-source'
import { webSourceRequest } from '#layers/feedlog/server/lib/web-source/http'
export default defineEventHandler(async event => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const input = await readValidatedBody(event, z.object({ enabled: z.boolean() }).strict().parse)
  return webSourceRequest(event, pool => updateWebsiteAiReference(pool, orgId, id, input.enabled))
})
