import { eq, and, isNull, inArray, sql } from 'drizzle-orm'
import { post, postSearch, user, vote } from '#layers/feedlog/server/db/schemas'

// GET /api/posts/search?q=&limit= — Public semantic search over an org's feedback.
//
// Fully consistent with the similar-posts search: embed the query and return the nearest N by
// pgvector cosine distance with NO threshold — always shows the closest posts (no
// empty-state cutoff). Anonymous callers are rate-limited; when embeddings are
// disabled / errored / over-limit it degrades to a pg_trgm nearest-N over post_search
// (the same whole-string `<->` distance searchSimilarByTrgm uses),
// never 5xx. post_search is sync-maintained on post create/update.
const PUBLIC_SEARCH_LIMIT = 30
const RATE_LIMIT = { limit: 20, windowSeconds: 60 }

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event)
  const query = getQuery(event)
  const orgId = event.context.orgId!

  const q = ((query.q as string | undefined) ?? '').trim()
  if (!q) return { data: [] as PostListItem[] }

  const db = useDB()

  const ip = getRequestIP(event, { xForwardedFor: true }) || 'unknown'
  const allowed = await checkRateLimit(`posts-search:${ip}`, RATE_LIMIT)
  const embedding = allowed ? await embedQueryOrNull(q) : null

  let rows
  if (embedding) {
    rows = await searchPostsBySemantic(embedding, {
      orgId,
      merged: 'canonical_only',
      limit: PUBLIC_SEARCH_LIMIT,
    })
  }
  else {
    // Fallback (embeddings unavailable): pg_trgm nearest-N over post_search, matching
    // searchSimilarByTrgm — whole-string `<->` distance, no threshold,
    // global across boards. post_search is sync-written on post create/update.
    rows = await db
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
      .where(and(eq(post.orgId, orgId), isNull(post.mergedTo)))
      .orderBy(sql`${postSearch.searchText} <-> ${q}`)
      .limit(PUBLIC_SEARCH_LIMIT)
  }

  // Batch hasVoted when authenticated (same pattern as GET /api/posts).
  let votedPostIds = new Set<string>()
  if (session && rows.length > 0) {
    const ids = rows.map(r => r.id)
    const votes = await db
      .select({ postId: vote.postId })
      .from(vote)
      .where(and(eq(vote.userId, session.user.id), inArray(vote.postId, ids)))
    votedPostIds = new Set(votes.map(v => v.postId))
  }

  const data: PostListItem[] = rows.map(r => ({
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

  return { data }
})
