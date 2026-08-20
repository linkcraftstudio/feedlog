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
      authorEmail: user.email,
      authorIsAnonymous: user.isAnonymous,
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

  // subscribed: is the current user on this post's notification list, across
  // the whole merge family. Drives the sidebar subscribe card's button state.
  let subscribed = false
  if (session) {
    const [result] = await db.execute(sql`
      WITH RECURSIVE family AS (
        SELECT id FROM post WHERE id = ${row.id}
        UNION ALL
        SELECT p.id FROM post p JOIN family f ON p.merged_to = f.id
      )
      SELECT EXISTS(
        SELECT 1 FROM post_subscription WHERE user_id = ${session.user.id} AND post_id IN (SELECT id FROM family)
      ) as subscribed
    `)
    subscribed = !!(result as any)?.subscribed
  }

  // Gates author.email below: shipping it to end users would hand every
  // reporter's address to anyone who opens a post.
  //
  // A guest's address is a reserved-domain placeholder nobody can write to, so it
  // is withheld from staff as well — showing it only invites someone to try.
  const isStaff = !!getOrgMemberRole(session, orgId)
  const showAuthorEmail = isStaff && !row.authorIsAnonymous

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
    subscribed,
    author: {
      id: row.authorId,
      name: row.authorName,
      image: row.authorImage,
      isAnonymous: !!row.authorIsAnonymous,
      ...(showAuthorEmail ? { email: row.authorEmail } : {}),
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    canonicalPost,
  }
})
