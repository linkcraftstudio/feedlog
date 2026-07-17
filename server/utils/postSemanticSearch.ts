import { and, eq, isNull, isNotNull, sql } from 'drizzle-orm'
import { post, postEmbedding, user } from '#layers/feedlog/server/db/schemas'

export interface SemanticOpts {
  orgId: string
  boardId?: string
  status?: string
  merged?: 'canonical_only' | 'merged_only' | 'all'
  maxDistance?: number // cosine-distance cutoff (public threshold); omit = no cutoff
  limit: number
}

// Posts ranked by pgvector cosine distance to `embedding`, in the PostListItem
// column shape (hasVoted attached by the caller). Inner-joins post_embedding, so
// only embedded posts appear — coverage is ensured by the backfill.
export async function searchPostsBySemantic(embedding: number[], opts: SemanticOpts) {
  const db = useDB()
  const vec = `[${embedding.join(',')}]`
  const distance = sql`${postEmbedding.embedding} <=> ${vec}::vector`

  const conditions = [eq(post.orgId, opts.orgId)]
  if (opts.merged === 'merged_only') conditions.push(isNotNull(post.mergedTo))
  else if (opts.merged === 'all') { /* include both — no mergedTo filter */ }
  else conditions.push(isNull(post.mergedTo)) // default + canonical_only
  if (opts.boardId) conditions.push(eq(post.boardId, opts.boardId))
  if (opts.status) conditions.push(eq(post.status, opts.status))
  if (opts.maxDistance != null) conditions.push(sql`${distance} <= ${opts.maxDistance}`)

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
    .innerJoin(postEmbedding, eq(post.id, postEmbedding.postId))
    .leftJoin(user, eq(post.authorId, user.id))
    .where(and(...conditions))
    .orderBy(distance)
    .limit(opts.limit)
}
