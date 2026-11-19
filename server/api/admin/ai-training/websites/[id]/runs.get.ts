import { z } from 'zod'
import { listAiTrainingWebsiteRuns } from '#layers/feedlog/server/services/ai-training'
import { webSourceRequest } from '#layers/feedlog/server/lib/web-source/http'
export default defineEventHandler(async event => {
  const { orgId } = await requireOrgMember(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  return webSourceRequest(event, pool => listAiTrainingWebsiteRuns(pool, orgId, id))
})
