import { and, eq, sql, asc } from 'drizzle-orm'
import { board, post } from '#layers/feedlog/server/db/schemas'

// GET /api/boards — List boards (sorted by position, with post_count and total)
export default defineEventHandler(async (event): Promise<{ data: BoardItem[]; totalPostCount: number }> => {
  const db = useDB()
  const orgId = event.context.orgId!

  const [boards, totalResult] = await Promise.all([
    db
      .select({
        id: board.id,
        name: board.name,
        description: board.description,
        position: board.position,
        postCount: sql<number>`cast(count(${post.id}) as int)`,
        createdAt: board.createdAt,
      })
      .from(board)
      .leftJoin(post, and(eq(post.boardId, board.id), eq(post.orgId, orgId)))
      .where(eq(board.orgId, orgId))
      .groupBy(board.id)
      .orderBy(asc(board.position)),
    db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(post)
      .where(eq(post.orgId, orgId)),
  ])

  return { data: boards, totalPostCount: totalResult[0]?.count ?? 0 }
})
