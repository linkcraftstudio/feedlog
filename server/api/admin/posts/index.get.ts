import { eq, and, desc, sql, isNull, isNotNull } from 'drizzle-orm'
import { post, user } from '#layers/feedlog/server/db/schemas'

// GET /api/admin/posts — Admin post list (page pagination)
// Org-member gate only: the list itself is read-only and contributors need
// it to navigate the dashboard. Moderation actions (delete / merge /
// change-status / update:any) are gated on their own endpoints.
export default defineEventHandler(async (event): Promise<PagePaginatedList<PostListItem>> => {
  const { orgId } = await requireOrgMember(event)

  const query = getQuery(event)
  const boardId = query.boardId as string | undefined
  const status = query.status as string | undefined
  const merged = (query.merged as string) || 'canonical_only'
  const sort = (query.sort as string) || 'createdAt'
  const page = Math.max(Number(query.page) || 1, 1)
  const pageSize = Math.min(Number(query.pageSize) || 10, 100)
  const offset = (page - 1) * pageSize

  const db = useDB()

  const conditions: any[] = [eq(post.orgId, orgId)]
  if (boardId) conditions.push(eq(post.boardId, boardId))
  if (status) conditions.push(eq(post.status, status))
  if (merged === 'canonical_only') conditions.push(isNull(post.mergedTo))
  else if (merged === 'merged_only') conditions.push(isNotNull(post.mergedTo))
  // 'all' — no merge filter
  const whereClause = and(...conditions)

  const sortCol = sort === 'votes' ? post.voteCount : sort === 'comments' ? post.commentCount : post.createdAt

  const [countResult] = await db
    .select({ total: sql<number>`cast(count(*) as int)` })
    .from(post)
    .where(whereClause)

  const rows = await db
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
    .orderBy(desc(sortCol), desc(post.id))
    .limit(pageSize)
    .offset(offset)

  return {
    data: rows.map(r => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      excerpt: r.excerpt,
      status: r.status,
      boardId: r.boardId,
      voteCount: r.voteCount,
      commentCount: r.commentCount,
      mergedCount: r.mergedCount,
      hasVoted: false,
      author: { id: r.authorId, name: r.authorName, image: r.authorImage },
      createdAt: r.createdAt,
    })),
    pagination: { page, pageSize, total: countResult?.total ?? 0 },
  }
})
