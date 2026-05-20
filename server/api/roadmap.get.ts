import { eq, and, desc, sql, inArray, isNull } from 'drizzle-orm'
import { post, user, vote } from '#layers/feedlog/server/db/schemas'

const ROADMAP_STATUSES = ['planned', 'in_progress', 'done'] as const
const PAGE_SIZE = 10

interface RoadmapColumn {
  data: PostListItem[]
  total: number
  nextCursor: string | null
}

type RoadmapResponse = Record<typeof ROADMAP_STATUSES[number], RoadmapColumn>

// GET /api/roadmap — Roadmap view: posts grouped by status
export default defineEventHandler(async (event): Promise<RoadmapResponse> => {
  const session = await getUserSession(event)
  const orgId = event.context.orgId!
  const query = getQuery(event)
  const boardId = query.boardId as string | undefined

  const db = useDB()

  // Build board filter condition
  const boardCondition = boardId ? eq(post.boardId, boardId) : undefined

  // Query 1: UNION ALL — top 20 per status by votes
  const statusQueries = ROADMAP_STATUSES.map(status => {
    const conditions: any[] = [eq(post.orgId, orgId), eq(post.status, status), isNull(post.mergedTo)]
    if (boardCondition) conditions.push(boardCondition)

    return db
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
      .where(and(...conditions))
      .orderBy(desc(post.createdAt), desc(post.id))
      .limit(PAGE_SIZE + 1)
  })

  // Query 2: counts per status
  const countConditions: any[] = [eq(post.orgId, orgId), inArray(post.status, [...ROADMAP_STATUSES]), isNull(post.mergedTo)]
  if (boardCondition) countConditions.push(boardCondition)

  const [results, counts] = await Promise.all([
    Promise.all(statusQueries),
    db
      .select({
        status: post.status,
        count: sql<number>`count(*)::int`,
      })
      .from(post)
      .where(and(...countConditions))
      .groupBy(post.status),
  ])

  // Build count map
  const countMap = new Map(counts.map(c => [c.status, c.count]))

  // Batch query hasVoted
  const allRows = results.flat()
  let votedPostIds = new Set<string>()
  if (session && allRows.length > 0) {
    const postIds = allRows.map(r => r.id)
    const votes = await db
      .select({ postId: vote.postId })
      .from(vote)
      .where(and(
        eq(vote.userId, session.user.id),
        inArray(vote.postId, postIds),
      ))
    votedPostIds = new Set(votes.map(v => v.postId))
  }

  // Build response
  const response = {} as RoadmapResponse
  for (let i = 0; i < ROADMAP_STATUSES.length; i++) {
    const status = ROADMAP_STATUSES[i]
    const rows = results[i]
    const hasMore = rows.length > PAGE_SIZE
    const items = hasMore ? rows.slice(0, PAGE_SIZE) : rows

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
      ? encodeCursor({ s: lastItem.createdAt, id: lastItem.id })
      : null

    response[status] = {
      data,
      total: countMap.get(status) ?? 0,
      nextCursor,
    }
  }

  return response
})

function encodeCursor(data: { s: unknown; id: string }): string {
  return Buffer.from(JSON.stringify(data)).toString('base64url')
}
