import { listPublicFeedback } from '#layers/feedlog/server/services/feedback-web-queries'
import { parseStatusParam } from '#layers/feedlog/shared/types/post'

export default defineEventHandler(async (event): Promise<CursorPaginatedList<PostListItem>> => {
  const session = await getUserSession(event)
  const query = getQuery(event)

  const boardId = query.boardId as string | undefined
  // `status` takes one name or a comma-separated list, so the board can ask for
  // "everything still live" in one round trip. Unknown names are dropped.
  const statuses = parseStatusParam(query.status)
  const sort = (query.sort as string) || 'createdAt'
  const order = (query.order as string) || 'desc'
  const cursor = query.cursor as string | undefined
  const pageSize = Math.min(Number(query.pageSize) || 10, 100)

  const orgId = event.context.orgId!

  return listPublicFeedback({ db: useDB(), orgId }, { boardId, status: statuses, sort, order, cursor, pageSize }, session?.user.id)
})
