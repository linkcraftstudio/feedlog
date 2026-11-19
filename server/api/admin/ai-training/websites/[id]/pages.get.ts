import { z } from 'zod'
import { listAiTrainingWebsitePages } from '#layers/feedlog/server/services/ai-training'
import { webSourceRequest } from '#layers/feedlog/server/lib/web-source/http'
const query = z.object({ q: z.string().max(300).optional(), status: z.enum(['all', 'ready', 'indexing', 'failed']).default('all'), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(10) })
export default defineEventHandler(async event => {
  const { orgId } = await requireOrgMember(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const input = await getValidatedQuery(event, query.parse)
  return webSourceRequest(event, pool => listAiTrainingWebsitePages(pool, orgId, id, input))
})
