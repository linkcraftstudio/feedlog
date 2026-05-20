import { eq, and, sql } from 'drizzle-orm'
import { post, user, vote } from '#layers/feedlog/server/db/schemas'

// GET /api/posts/:slug — Get post detail
export default defineEventHandler(async (event): Promise<PostDetail> => {
  const session = await getUserSession(event)
  const orgId = event.context.orgId!
  const slug = getRouterParam(event, 'postId')!

  const db = useDB()

  const [row] = await db
    .select({
      id: post.id,
      slug: post.slug,
      title: post.title,
      content: post.content,
      status: post.status,
      boardId: post.boardId,
      voteCount: post.voteCount,
      commentCount: post.commentCount,
      mergedTo: post.mergedTo,
      mergedCount: sql<number>`(SELECT count(*)::int FROM post p2 WHERE p2.merged_to = ${post.id})`,
      authorId: post.authorId,
      authorName: user.name,
      authorImage: user.image,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
    })
    .from(post)
    .leftJoin(user, eq(post.authorId, user.id))
    .where(and(eq(post.slug, slug), eq(post.orgId, orgId)))
    .limit(1)

  if (!row) {
    throw createError({ statusCode: 404, message: 'Post not found' })
  }

  // hasVoted: for canonical posts, check across merge family tree
  let hasVoted = false
  if (session) {
    if (!row.mergedTo && (row.mergedCount as number) > 0) {
      // Canonical with merged posts: check across family tree
      const [result] = await db.execute(sql`
        WITH RECURSIVE family AS (
          SELECT id FROM post WHERE id = ${row.id}
          UNION ALL
          SELECT p.id FROM post p JOIN family f ON p.merged_to = f.id
        )
        SELECT EXISTS(
          SELECT 1 FROM vote WHERE user_id = ${session.user.id} AND post_id IN (SELECT id FROM family)
        ) as voted
      `)
      hasVoted = !!(result as any)?.voted
    } else {
      const [v] = await db
        .select({ postId: vote.postId })
        .from(vote)
        .where(and(eq(vote.postId, row.id), eq(vote.userId, session.user.id)))
        .limit(1)
      hasVoted = !!v
    }
  }

  // If merged, fetch canonical post info
  let canonicalPost: { slug: string; title: string } | undefined
  if (row.mergedTo) {
    const [cp] = await db
      .select({ slug: post.slug, title: post.title })
      .from(post)
      .where(eq(post.id, row.mergedTo))
      .limit(1)
    if (cp) canonicalPost = cp
  }

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    content: row.content,
    status: row.status,
    boardId: row.boardId,
    voteCount: row.voteCount,
    commentCount: row.commentCount,
    mergedTo: row.mergedTo,
    mergedCount: row.mergedCount,
    hasVoted,
    author: { id: row.authorId, name: row.authorName, image: row.authorImage },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    canonicalPost,
  }
})
