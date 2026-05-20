import { eq, and, desc, asc, sql, isNull, isNotNull, inArray } from 'drizzle-orm'
import { comment, commentLike, user, post } from '#layers/feedlog/server/db/schemas'

// GET /api/posts/:postId/comments — Unified comment query (top-level, children, pagination)
export default defineEventHandler(async (event) => {
  const session = await getUserSession(event)
  const orgId = event.context.orgId!
  const postId = getRouterParam(event, 'postId')!
  const query = getQuery(event)

  const parentId = query.parentId as string | undefined
  const cursor = query.cursor as string | undefined
  const limit = Math.min(Number(query.limit) || 10, 100)
  const sort = (query.sort as string) || 'oldest'
  const withChildren = query.withChildren === 'true'
  const childrenLimit = Math.min(Number(query.childrenLimit) || 5, 20)

  const db = useDB()

  // Confirm the parent post belongs to the active org before exposing comments.
  const [postRow] = await db.select({ id: post.id }).from(post)
    .where(and(eq(post.id, postId), eq(post.orgId, orgId))).limit(1)
  if (!postRow) {
    throw createError({ statusCode: 404, message: 'Post not found' })
  }

  // Loading child comments for a specific parent
  if (parentId) {
    const conditions = [
      eq(comment.postId, postId),
      eq(comment.parentId, parentId),
    ]
    if (cursor) {
      const decoded = decodeCursor(cursor)
      if (decoded) {
        conditions.push(sql`(${comment.createdAt}, ${comment.id}) > (${decoded.s}::timestamptz, ${decoded.id}::uuid)`)
      }
    }

    const rows = await db
      .select({
        id: comment.id,
        parentId: comment.parentId,
        replyToId: comment.replyToId,
        likeCount: comment.likeCount,
        authorId: comment.authorId,
        authorName: user.name,
        authorImage: user.image,
        content: comment.content,
        editedAt: comment.editedAt,
        createdAt: comment.createdAt,
      })
      .from(comment)
      .leftJoin(user, eq(comment.authorId, user.id))
      .where(and(...conditions))
      .orderBy(asc(comment.createdAt), asc(comment.id))
      .limit(limit + 1)

    const hasMore = rows.length > limit
    const items = hasMore ? rows.slice(0, limit) : rows
    const data = await attachLikeStatus(db, items, session?.user.id)

    const lastItem = items[items.length - 1]
    return {
      data,
      pagination: {
        nextCursor: hasMore && lastItem
          ? encodeCursor({ s: new Date(lastItem.createdAt).toISOString(), id: lastItem.id })
          : null,
      },
    }
  }

  // Loading top-level comments (includes both comment and mergedPost types)
  const conditions: any[] = [
    eq(comment.postId, postId),
    isNull(comment.parentId),
  ]

  if (cursor) {
    const decoded = decodeCursor(cursor)
    if (decoded) {
      if (sort === 'top') {
        conditions.push(sql`(${comment.likeCount}, ${comment.id}) < (${decoded.s}::int, ${decoded.id}::uuid)`)
      } else if (sort === 'newest') {
        conditions.push(sql`(${comment.createdAt}, ${comment.id}) < (${decoded.s}::timestamptz, ${decoded.id}::uuid)`)
      } else {
        conditions.push(sql`(${comment.createdAt}, ${comment.id}) > (${decoded.s}::timestamptz, ${decoded.id}::uuid)`)
      }
    }
  }

  const orderBy = sort === 'newest'
    ? [desc(comment.createdAt), desc(comment.id)]
    : sort === 'top'
      ? [desc(comment.likeCount), desc(comment.id)]
      : [asc(comment.createdAt), asc(comment.id)]

  const topRows = await db
    .select({
      id: comment.id,
      parentId: comment.parentId,
      replyToId: comment.replyToId,
      replyCount: comment.replyCount,
      likeCount: comment.likeCount,
      authorId: comment.authorId,
      authorName: user.name,
      authorImage: user.image,
      content: comment.content,
      type: comment.type,
      metadata: comment.metadata,
      editedAt: comment.editedAt,
      createdAt: comment.createdAt,
    })
    .from(comment)
    .leftJoin(user, eq(comment.authorId, user.id))
    .where(and(...conditions))
    .orderBy(...orderBy)
    .limit(limit + 1)

  const hasMore = topRows.length > limit
  const topItems = hasMore ? topRows.slice(0, limit) : topRows

  // Eager-load children if requested
  let childrenMap = new Map<string, any[]>()
  if (withChildren && topItems.length > 0) {
    const topIds = topItems.map(t => t.id)
    const childRows = await db
      .select({
        id: comment.id,
        parentId: comment.parentId,
        replyToId: comment.replyToId,
        likeCount: comment.likeCount,
        authorId: comment.authorId,
        authorName: user.name,
        authorImage: user.image,
        content: comment.content,
        editedAt: comment.editedAt,
        createdAt: comment.createdAt,
      })
      .from(comment)
      .leftJoin(user, eq(comment.authorId, user.id))
      .where(and(
        eq(comment.postId, postId),
        isNotNull(comment.parentId),
        inArray(comment.parentId, topIds),
      ))
      .orderBy(asc(comment.createdAt))

    // Group by parentId, limit per parent
    for (const child of childRows) {
      const pid = child.parentId!
      if (!childrenMap.has(pid)) childrenMap.set(pid, [])
      const arr = childrenMap.get(pid)!
      if (arr.length < childrenLimit) arr.push(child)
    }

    // Attach like status to children
    if (session?.user.id) {
      for (const [, children] of childrenMap) {
        const enriched = await attachLikeStatus(db, children, session.user.id)
        children.splice(0, children.length, ...enriched)
      }
    }
  }

  const topData = await attachLikeStatus(db, topItems, session?.user.id)

  // Enrich mergedPost entries: fetch post info + sub-post comments
  const mergedPostItems = topItems.filter(t => t.type === 'mergedPost' && t.metadata)
  const mergedPostIds = mergedPostItems
    .map(t => (t.metadata as any)?.merged_post_id)
    .filter(Boolean) as string[]

  let mergedPostInfoMap = new Map<string, any>()
  let mergedPostCommentsMap = new Map<string, { data: any[]; pagination: { nextCursor: string | null } }>()

  if (mergedPostIds.length > 0) {
    // Step 3: Fetch merged post info (parallel with Step 2B)
    const [postInfoRows, subCommentRows] = await Promise.all([
      db
        .select({
          id: post.id,
          slug: post.slug,
          title: post.title,
          excerpt: post.excerpt,
          authorId: post.authorId,
          authorName: user.name,
          authorImage: user.image,
        })
        .from(post)
        .leftJoin(user, eq(post.authorId, user.id))
        .where(inArray(post.id, mergedPostIds)),
      // Step 2B: Fetch sub-post top-level comments
      db
        .select({
          id: comment.id,
          postId: comment.postId,
          parentId: comment.parentId,
          replyToId: comment.replyToId,
          replyCount: comment.replyCount,
          likeCount: comment.likeCount,
          authorId: comment.authorId,
          authorName: user.name,
          authorImage: user.image,
          content: comment.content,
          type: comment.type,
          metadata: comment.metadata,
          editedAt: comment.editedAt,
          createdAt: comment.createdAt,
        })
        .from(comment)
        .leftJoin(user, eq(comment.authorId, user.id))
        .where(and(
          inArray(comment.postId, mergedPostIds),
          isNull(comment.parentId),
        ))
        .orderBy(asc(comment.createdAt), asc(comment.id))
        .limit((childrenLimit + 1) * mergedPostIds.length),
    ])

    // Build post info map
    for (const r of postInfoRows) {
      mergedPostInfoMap.set(r.id, {
        id: r.id,
        slug: r.slug,
        title: r.title,
        excerpt: r.excerpt,
        author: { id: r.authorId, name: r.authorName, image: r.authorImage },
      })
    }

    // Build sub-post comments map (group by postId, limit per post)
    const groupedSubComments = new Map<string, any[]>()
    for (const r of subCommentRows) {
      if (!groupedSubComments.has(r.postId)) groupedSubComments.set(r.postId, [])
      groupedSubComments.get(r.postId)!.push(r)
    }

    // Collect second-level merged post IDs from sub-comments
    const level2MergedPostIds: string[] = []
    for (const r of subCommentRows) {
      if (r.type === 'mergedPost' && r.metadata) {
        const l2Id = (r.metadata as any).merged_post_id
        if (l2Id) level2MergedPostIds.push(l2Id)
      }
    }

    // Fetch second-level merged post info (title + excerpt only, no recursive comments)
    let level2PostInfoMap = new Map<string, any>()
    if (level2MergedPostIds.length > 0) {
      const l2Rows = await db
        .select({
          id: post.id,
          slug: post.slug,
          title: post.title,
          excerpt: post.excerpt,
          commentCount: post.commentCount,
          authorId: post.authorId,
          authorName: user.name,
          authorImage: user.image,
        })
        .from(post)
        .leftJoin(user, eq(post.authorId, user.id))
        .where(inArray(post.id, level2MergedPostIds))
      for (const r of l2Rows) {
        level2PostInfoMap.set(r.id, {
          id: r.id,
          slug: r.slug,
          title: r.title,
          excerpt: r.excerpt,
          commentCount: r.commentCount,
          author: { id: r.authorId, name: r.authorName, image: r.authorImage },
        })
      }
    }

    for (const mpId of mergedPostIds) {
      const allSubComments = groupedSubComments.get(mpId) ?? []
      const hasMoreSub = allSubComments.length > childrenLimit
      const subItems = hasMoreSub ? allSubComments.slice(0, childrenLimit) : allSubComments
      const subData = await attachLikeStatus(db, subItems, session?.user.id)

      // Enrich second-level mergedPost sub-comments with post info
      const enrichedSubData = subData.map(c => {
        const raw = subItems.find((s: any) => s.id === c.id)
        if (raw?.type === 'mergedPost' && raw.metadata) {
          const l2Id = (raw.metadata as any).merged_post_id
          const l2Info = l2Id ? level2PostInfoMap.get(l2Id) : null
          if (l2Info) {
            return {
              ...c,
              type: 'mergedPost',
              mergedPost: {
                post: l2Info,
                comments: { data: [], pagination: { nextCursor: null } },
              },
            }
          }
        }
        return { ...c, type: c.type ?? 'comment' }
      })

      const lastSub = subItems[subItems.length - 1]
      mergedPostCommentsMap.set(mpId, {
        data: enrichedSubData,
        pagination: {
          nextCursor: hasMoreSub && lastSub
            ? encodeCursor({ s: new Date(lastSub.createdAt).toISOString(), id: lastSub.id })
            : null,
        },
      })
    }
  }

  // Step 4: Assemble final response
  const data = topData.map(item => {
    const raw = topItems.find(t => t.id === item.id)!
    const result: any = {
      ...item,
      type: raw.type ?? 'comment',
      children: withChildren ? (childrenMap.get(item.id) ?? []) : undefined,
    }

    if (raw.type === 'mergedPost' && raw.metadata) {
      const mpId = (raw.metadata as any).merged_post_id
      if (mpId) {
        result.mergedPost = {
          post: mergedPostInfoMap.get(mpId) ?? null,
          comments: mergedPostCommentsMap.get(mpId) ?? { data: [], pagination: { nextCursor: null } },
        }
      }
    }

    return result
  })

  const lastItem = topItems[topItems.length - 1]
  let nextCursor: string | null = null
  if (hasMore && lastItem) {
    nextCursor = sort === 'top'
      ? encodeCursor({ s: lastItem.likeCount, id: lastItem.id })
      : encodeCursor({ s: new Date(lastItem.createdAt).toISOString(), id: lastItem.id })
  }

  return {
    data,
    pagination: { nextCursor },
  }
})

// Format comment row to API response
function formatComment(r: any) {
  return {
    id: r.id,
    parentId: r.parentId,
    replyToId: r.replyToId,
    replyCount: r.replyCount ?? undefined,
    likeCount: r.likeCount,
    hasLiked: r.hasLiked ?? false,
    author: { id: r.authorId, name: r.authorName, image: r.authorImage },
    content: r.content,
    type: r.type ?? 'comment',
    editedAt: r.editedAt,
    createdAt: r.createdAt,
  }
}

// Batch attach hasLiked status
async function attachLikeStatus(db: any, items: any[], userId?: string) {
  if (!userId || items.length === 0) {
    return items.map(r => formatComment(r))
  }

  const commentIds = items.map(r => r.id)
  const likes = await db
    .select({ commentId: commentLike.commentId })
    .from(commentLike)
    .where(and(
      eq(commentLike.userId, userId),
      inArray(commentLike.commentId, commentIds),
    ))
  const likedSet = new Set(likes.map((l: any) => l.commentId))

  return items.map(r => ({
    ...formatComment(r),
    hasLiked: likedSet.has(r.id),
  }))
}

function encodeCursor(data: { s: unknown; id: string }): string {
  return Buffer.from(JSON.stringify(data)).toString('base64url')
}

function decodeCursor(cursor: string): { s: any; id: string } | null {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString())
  } catch {
    return null
  }
}
