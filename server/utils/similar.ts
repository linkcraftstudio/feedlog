import { sql, eq, and, ne, isNull } from 'drizzle-orm'
import { post, postEmbedding, postSearch, vote } from '#layers/feedlog/server/db/schemas'
import { user } from '#layers/feedlog/server/db/schemas/auth'

interface SimilarSearchOptions {
  orgId: string
  excludePostId?: string
  limit?: number
  userId?: string // for hasVoted check
}

export interface SimilarPost {
  id: string
  slug: string
  title: string
  excerpt: string | null
  status: string
  voteCount: number
  commentCount: number
  hasVoted: boolean
  author: { id: string; name: string | null; image: string | null }
}

// Search similar posts using pgvector cosine distance
export async function searchSimilarByEmbedding(
  embedding: number[],
  options: SimilarSearchOptions,
): Promise<SimilarPost[]> {
  const { orgId, excludePostId, limit = 3, userId } = options
  const db = useDB()
  const vectorStr = `[${embedding.join(',')}]`

  const conditions = [eq(post.orgId, orgId), isNull(post.mergedTo)]
  if (excludePostId) conditions.push(ne(post.id, excludePostId))

  const rows = await db
    .select({
      id: post.id,
      slug: post.slug,
      title: post.title,
      excerpt: post.excerpt,
      status: post.status,
      voteCount: post.voteCount,
      commentCount: post.commentCount,
      authorId: post.authorId,
      authorName: user.name,
      authorImage: user.image,
    })
    .from(post)
    .innerJoin(postEmbedding, eq(post.id, postEmbedding.postId))
    .innerJoin(user, eq(post.authorId, user.id))
    .where(and(...conditions))
    .orderBy(sql`${postEmbedding.embedding} <=> ${vectorStr}::vector`)
    .limit(limit)

  return attachHasVoted(db, rows, userId)
}

// Search similar posts using pg_trgm text distance
export async function searchSimilarByTrgm(
  text: string,
  options: SimilarSearchOptions,
): Promise<SimilarPost[]> {
  const { orgId, excludePostId, limit = 3, userId } = options
  const db = useDB()

  const conditions = [eq(post.orgId, orgId), isNull(post.mergedTo)]
  if (excludePostId) conditions.push(ne(post.id, excludePostId))

  const rows = await db
    .select({
      id: post.id,
      slug: post.slug,
      title: post.title,
      excerpt: post.excerpt,
      status: post.status,
      voteCount: post.voteCount,
      commentCount: post.commentCount,
      authorId: post.authorId,
      authorName: user.name,
      authorImage: user.image,
    })
    .from(post)
    .innerJoin(postSearch, eq(post.id, postSearch.postId))
    .innerJoin(user, eq(post.authorId, user.id))
    .where(and(...conditions))
    .orderBy(sql`${postSearch.searchText} <-> ${text}`)
    .limit(limit)

  return attachHasVoted(db, rows, userId)
}

// Search similar posts by existing post ID (uses stored embedding or fallback to trgm)
export async function searchSimilarByPostId(
  postId: string,
  options: Omit<SimilarSearchOptions, 'excludePostId'>,
): Promise<SimilarPost[]> {
  const db = useDB()

  // Try embedding first
  if (isEmbeddingEnabled()) {
    const [emb] = await db
      .select({ embedding: postEmbedding.embedding })
      .from(postEmbedding)
      .where(eq(postEmbedding.postId, postId))
      .limit(1)

    if (emb) {
      return searchSimilarByEmbedding(emb.embedding, { ...options, excludePostId: postId })
    }
  }

  // Fallback to trgm
  const [search] = await db
    .select({ searchText: postSearch.searchText })
    .from(postSearch)
    .where(eq(postSearch.postId, postId))
    .limit(1)

  if (search) {
    return searchSimilarByTrgm(search.searchText, { ...options, excludePostId: postId })
  }

  return []
}

// Attach hasVoted flag to results
async function attachHasVoted(
  db: ReturnType<typeof useDB>,
  rows: {
    id: string; slug: string; title: string; excerpt: string | null
    status: string; voteCount: number; commentCount: number
    authorId: string; authorName: string | null; authorImage: string | null
  }[],
  userId?: string,
): Promise<SimilarPost[]> {
  if (!userId || rows.length === 0) {
    return rows.map(r => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      excerpt: r.excerpt,
      status: r.status,
      voteCount: r.voteCount,
      commentCount: r.commentCount,
      hasVoted: false,
      author: { id: r.authorId, name: r.authorName, image: r.authorImage },
    }))
  }

  const postIds = rows.map(r => r.id)
  const votes = await db
    .select({ postId: vote.postId })
    .from(vote)
    .where(and(
      eq(vote.userId, userId),
      sql`${vote.postId} IN ${postIds}`,
    ))

  const votedSet = new Set(votes.map(v => v.postId))

  return rows.map(r => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    excerpt: r.excerpt,
    status: r.status,
    voteCount: r.voteCount,
    commentCount: r.commentCount,
    hasVoted: votedSet.has(r.id),
    author: { id: r.authorId, name: r.authorName, image: r.authorImage },
  }))
}
