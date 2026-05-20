import { eq, and, desc, asc, sql, inArray, isNull } from 'drizzle-orm'
import { post, user, vote } from '#layers/feedlog/server/db/schemas'

// GET /api/posts — Public post list (cursor pagination)
export default defineEventHandler(async (event): Promise<CursorPaginatedList<PostListItem>> => {
  const session = await getUserSession(event)
  const query = getQuery(event)

  const boardId = query.boardId as string | undefined
  const status = query.status as string | undefined
  const sort = (query.sort as string) || 'createdAt'
  const order = (query.order as string) || 'desc'
  const cursor = query.cursor as string | undefined
  const pageSize = Math.min(Number(query.pageSize) || 10, 100)

  const db = useDB()
  const orgId = event.context.orgId!

  // Default: exclude merged posts
  const conditions: any[] = [eq(post.orgId, orgId), isNull(post.mergedTo)]
  if (boardId) conditions.push(eq(post.boardId, boardId))
  if (status) conditions.push(eq(post.status, status))

  // Cursor conditions
  if (cursor) {
    const decoded = decodeCursor(cursor)
    if (decoded) {
      if (sort === 'votes') {
        if (order === 'desc') {
          conditions.push(sql`(${post.voteCount}, ${post.id}) < (${decoded.s}::int, ${decoded.id}::uuid)`)
        } else {
          conditions.push(sql`(${post.voteCount}, ${post.id}) > (${decoded.s}::int, ${decoded.id}::uuid)`)
        }
      } else {
        if (order === 'desc') {
          conditions.push(sql`(${post.createdAt}, ${post.id}) < (${decoded.s}::timestamptz, ${decoded.id}::uuid)`)
        } else {
          conditions.push(sql`(${post.createdAt}, ${post.id}) > (${decoded.s}::timestamptz, ${decoded.id}::uuid)`)
        }
      }
    }
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined
  const orderFn = order === 'desc' ? desc : asc
  const sortCol = sort === 'votes' ? post.voteCount : post.createdAt

  const result = await db
    .select({
      id: post.id,
      slug: post.slug,
      title: post.title,
      excerpt: post.excerpt,
      status: post.status,
      boardId: post.boardId,
      voteCount: post.voteCount,
      commentCount: post.commentCount,
      mergedCount: sql<number>`(SELECT count(*)::int FROM post p2 WHERE p2.merged_to = ${post.id})`,
      authorId: post.authorId,
      authorName: user.name,
      authorImage: user.image,
      createdAt: post.createdAt,
    })
    .from(post)
    .leftJoin(user, eq(post.authorId, user.id))
    .where(whereClause)
    .orderBy(orderFn(sortCol), orderFn(post.id))
    .limit(pageSize + 1)

  // Batch query hasVoted when authenticated
  let votedPostIds = new Set<string>()
  if (session && result.length > 0) {
    const postIds = result.map(r => r.id)
    const votes = await db
      .select({ postId: vote.postId })
      .from(vote)
      .where(and(
        eq(vote.userId, session.user.id),
        inArray(vote.postId, postIds),
      ))
    votedPostIds = new Set(votes.map(v => v.postId))
  }

  const hasMore = result.length > pageSize
  const items = hasMore ? result.slice(0, pageSize) : result
  const data: PostListItem[] = items.map(r => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    excerpt: r.excerpt,
    status: r.status,
    boardId: r.boardId,
    voteCount: r.voteCount,
    commentCount: r.commentCount,
    mergedCount: r.mergedCount,
    hasVoted: votedPostIds.has(r.id),
    author: { id: r.authorId, name: r.authorName, image: r.authorImage },
    createdAt: r.createdAt,
  }))

  const lastItem = data[data.length - 1]
  const nextCursor = hasMore && lastItem
    ? encodeCursor({ s: sort === 'votes' ? lastItem.voteCount : lastItem.createdAt, id: lastItem.id })
    : null

  return { data, pagination: { nextCursor } }
})

function encodeCursor(data: { s: unknown; id: string }): string {
  return Buffer.from(JSON.stringify(data)).toString('base64url')
}

function decodeCursor(cursor: string): { s: any; id: string } | null {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString())
  } catch {
    return null
  }
}
