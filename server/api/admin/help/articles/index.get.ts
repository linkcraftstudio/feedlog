import { z } from 'zod'
import { listManagementArticles } from '#layers/feedlog/server/services/help-center-queries'
const input = z.object({ q: z.string().trim().max(300).optional(), collectionId: z.uuid().optional(), status: z.enum(['published', 'unpublished', 'draft', 'archived']).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(10) })
export default defineEventHandler(async event => {
  const { orgId } = await requireOrgMember(event)
  return listManagementArticles({ db: useDB(), orgId }, await getValidatedQuery(event, input.parse))
})
