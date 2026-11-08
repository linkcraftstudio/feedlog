import { listManagementFeedback } from '#layers/feedlog/server/services/feedback-web-queries'
import { z } from 'zod'

export default defineEventHandler(async (event): Promise<PagePaginatedList<PostListItem>> => {
  const { orgId } = await requireOrgMember(event)

  const query = getQuery(event)
  const sort = (query.sort as string) || 'createdAt'
  const order = query.order === 'asc' ? 'asc' : 'desc'
  const page = Math.max(Number(query.page) || 1, 1)
  const pageSize = Math.min(Number(query.pageSize) || 10, 100)

  if (query.sourceConversationId !== undefined) {
    await requireOrgPermission(event, { feedlog: ['inbox'] })
    if (!z.uuid().safeParse(query.sourceConversationId).success) throw createError({ statusCode: 422, message: 'Invalid source conversation' })
  }
  return listManagementFeedback({ db: useDB(), orgId }, { filter: parsePostFilter(query, orgId), sort, order, page, pageSize, sourceConversationId: query.sourceConversationId as string | undefined })
})
