// GET /api/posts/:postId/similar — Similar posts by stored embedding (for post detail + merge dialog default)
export default defineEventHandler(async (event) => {
  const session = await getUserSession(event)
  const orgId = event.context.orgId!
  const postId = getRouterParam(event, 'postId')!
  const query = getQuery(event)
  const limit = Math.min(Math.max(Number(query.limit) || 3, 1), 10)

  const userId = session?.user?.id
  const data = await searchSimilarByPostId(postId, { orgId, limit, userId })
  return { data }
})
