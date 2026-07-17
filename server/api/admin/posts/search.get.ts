import { eq, and, desc, sql, isNull, isNotNull } from 'drizzle-orm'
import { post, postSearch, user } from '#layers/feedlog/server/db/schemas'

// GET /api/admin/posts/search — Admin feedback search, semantic within the active
// filters (no threshold → nearest-N, consistent with the similar-posts search), with a pg_trgm
// nearest-N fallback (post_search `<->`) when embeddings are unavailable. While a query
// is active this returns a flat top-N (no offset pagination; the sort dropdown is inert),
// mirroring the changelog list. Empty query → the caller uses /api/admin/posts instead.
const ADMIN_SEARCH_LIMIT = 50

export default defineEventHandler(async (event): Promise<PagePaginatedList<PostListItem>> => {
  const { orgId } = await requireOrgMember(event)

  const query = getQuery(event)
  const q = ((query.q as string | undefined) ?? '').trim()
  const boardId = query.boardId as string | undefined
  const status = query.status as string | undefined
  const merged = (query.merged as string) || 'canonical_only'

  const db = useDB()

  const flat = (rows: Array<{
    id: string; slug: string; title: string; excerpt: string | null; status: string
    boardId: string | null; voteCount: number; commentCount: number; mergedCount: number
    authorId: string; authorName: string | null; authorImage: string | null; createdAt: Date
  }>): PagePaginatedList<PostListItem> => ({
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
    pagination: { page: 1, pageSize: rows.length, total: rows.length },
  })

  const embedding = q ? await embedQueryOrNull(q) : null

  if (q && embedding) {
    const rows = await searchPostsBySemantic(embedding, {
      orgId,
      boardId,
      status,
      merged: merged as 'canonical_only' | 'merged_only' | 'all',
      limit: ADMIN_SEARCH_LIMIT,
    })
    return flat(rows)
  }

  // Fallback (embeddings unavailable): pg_trgm nearest-N over post_search — whole-string
  // `<->` distance, no text threshold, WITHIN the active filters — matching
  // searchSimilarByTrgm. post_search is sync-maintained on post create/update.
  const conditions: any[] = [eq(post.orgId, orgId)]
  if (boardId) conditions.push(eq(post.boardId, boardId))
  if (status) conditions.push(eq(post.status, status))
  if (merged === 'canonical_only') conditions.push(isNull(post.mergedTo))
  else if (merged === 'merged_only') conditions.push(isNotNull(post.mergedTo))
  const whereClause = and(...conditions)

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
    .innerJoin(postSearch, eq(post.id, postSearch.postId))
    .leftJoin(user, eq(post.authorId, user.id))
    .where(whereClause)
    .orderBy(sql`${postSearch.searchText} <-> ${q}`, desc(post.id))
    .limit(ADMIN_SEARCH_LIMIT)

  return flat(rows)
})
