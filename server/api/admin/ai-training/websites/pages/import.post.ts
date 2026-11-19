import { webSourceIndividualImport } from '#layers/feedlog/shared/schemas/web-source'
import { importIndividualWebSourcePages } from '#layers/feedlog/server/services/web-source'
import { webSourceRequest } from '#layers/feedlog/server/lib/web-source/http'
export default defineEventHandler(async event => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })
  const input = await readValidatedBody(event, webSourceIndividualImport.parse)
  return webSourceRequest(event, pool => importIndividualWebSourcePages(pool, orgId, input), true)
})
