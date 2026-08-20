import { and, eq, sql } from 'drizzle-orm'
import type { PostFilter } from '#layers/feedlog/server/utils/postFilterConditions'
import { post, postEmbedding, user } from '#layers/feedlog/server/db/schemas'

export interface SemanticOpts {
  filter: PostFilter
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

  const conditions = postFilterConditions(opts.filter)
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
      authorIsAnonymous: user.isAnonymous,
      createdAt: post.createdAt,
    })
    .from(post)
    .innerJoin(postEmbedding, eq(post.id, postEmbedding.postId))
    .leftJoin(user, eq(post.authorId, user.id))
    .where(and(...conditions))
    .orderBy(distance)
    .limit(opts.limit)
}
