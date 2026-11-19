import { webSourceInput } from '#layers/feedlog/shared/schemas/web-source'
import { createWebSource } from '#layers/feedlog/server/services/web-source'
import { webSourceRequest } from '#layers/feedlog/server/lib/web-source/http'
export default defineEventHandler(async event => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })
  const input = await readValidatedBody(event, webSourceInput.parse)
  return webSourceRequest(event, pool => createWebSource(pool, orgId, input), true)
})
