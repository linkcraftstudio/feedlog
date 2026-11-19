import { listAiTrainingSources } from '#layers/feedlog/server/services/ai-training'
import { webSourceRequest } from '#layers/feedlog/server/lib/web-source/http'
export default defineEventHandler(async event => {
  const { orgId } = await requireOrgMember(event)
  return webSourceRequest(event, pool => listAiTrainingSources(pool, orgId))
})
