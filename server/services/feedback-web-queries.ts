import { timestampCursorKey } from './query-pagination'
import { feedbackSummaryFields } from './feedback-queries'
import { postFilterConditions, type PostFilter } from '../utils/postFilterConditions'
import { eq, and, desc, asc, sql, inArray } from 'drizzle-orm'
import { post, user, vote, conversation } from '../db/schemas'
import type { ContentReader } from './content-context'
import { z } from 'zod'
import { encodeWebCursor, decodeWebCursor } from './web-pagination'
import { createError } from 'h3'

export async function listPublicFeedback(context: ContentReader, input: { boardId?: string; status?: string[]; sort: string; order: string; cursor?: string; pageSize: number }, viewerId?: string) {
  const { db, orgId } = context
  const { boardId, status, sort, order, cursor, pageSize } = input
  // Default: exclude merged posts
  const conditions = postFilterConditions({ orgId, boardId: boardId ? [boardId] : undefined, status })

  // Cursor conditions
  if (cursor) {
    const decoded = decodeWebCursor(cursor)
    if (decoded) {
      if (sort === 'votes') {
        if (order === 'desc') {
          conditions.push(sql`(${post.voteCount}, ${post.id}) < (${decoded.s}::int, ${decoded.id}::uuid)`)
        } else {
          conditions.push(sql`(${post.voteCount}, ${post.id}) > (${decoded.s}::int, ${decoded.id}::uuid)`)
        }
      } else {
        if (order === 'desc') {
          conditions.push(sql`(${post.createdAt}, ${post.id}) < (${decoded.s}::timestamptz, ${decoded.id}::uuid)`)
        } else {
          conditions.push(sql`(${post.createdAt}, ${post.id}) > (${decoded.s}::timestamptz, ${decoded.id}::uuid)`)
        }
      }
    }
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined
  const orderFn = order === 'desc' ? desc : asc
  const sortCol = sort === 'votes' ? post.voteCount : post.createdAt

  const result = await db
    .select({
      ...feedbackSummaryFields,
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
      cursorKey: timestampCursorKey(post.createdAt),
    })
    .from(post)
    .leftJoin(user, eq(post.authorId, user.id))
    .where(whereClause)
    .orderBy(orderFn(sortCol), orderFn(post.id))
    .limit(pageSize + 1)

  // Batch query hasVoted when authenticated
  let votedPostIds = new Set<string>()
  if (viewerId && result.length > 0) {
    const postIds = result.map(r => r.id)
    const votes = await db
      .select({ postId: vote.postId })
      .from(vote)
      .where(and(
        eq(vote.userId, viewerId!),
        inArray(vote.postId, postIds),
      ))
    votedPostIds = new Set(votes.map(v => v.postId))
  }

  const hasMore = result.length > pageSize
  const items = hasMore ? result.slice(0, pageSize) : result
  const data: PostListItem[] = items.map(r => ({
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
    author: { id: r.authorId, name: r.authorName, image: r.authorImage, isAnonymous: !!r.authorIsAnonymous },
    createdAt: r.createdAt.toISOString(),
  }))

  const lastItem = data[data.length - 1]
  const nextCursor = hasMore && lastItem
    ? encodeWebCursor({ s: sort === 'votes' ? lastItem.voteCount : items.at(-1)!.cursorKey, id: lastItem.id })
    : null

  return { data, pagination: { nextCursor } }
}

export async function getFeedbackDetail(context: ContentReader, slug: string, viewerId: string | undefined, role: string | null) {
  const { db, orgId } = context
  const [row] = await db
    .select({
      id: post.id,
      sourceConversationId: post.sourceConversationId,
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
      cursorKey: timestampCursorKey(post.createdAt),
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
  if (viewerId) {
    if (!row.mergedTo && (row.mergedCount as number) > 0) {
      // Canonical with merged posts: check across family tree
      const [result] = await db.execute(sql`
        WITH RECURSIVE family AS (
          SELECT id FROM post WHERE id = ${row.id}
          UNION ALL
          SELECT p.id FROM post p JOIN family f ON p.merged_to = f.id
        )
        SELECT EXISTS(
          SELECT 1 FROM vote WHERE user_id = ${viewerId!} AND post_id IN (SELECT id FROM family)
        ) as voted
      `)
      hasVoted = !!result?.voted
    } else {
      const [v] = await db
        .select({ postId: vote.postId })
        .from(vote)
        .where(and(eq(vote.postId, row.id), eq(vote.userId, viewerId!)))
        .limit(1)
      hasVoted = !!v
    }
  }

  // subscribed: is the current user on this post's notification list, across
  // the whole merge family. Drives the sidebar subscribe card's button state.
  let subscribed = false
  if (viewerId) {
    const [result] = await db.execute(sql`
      WITH RECURSIVE family AS (
        SELECT id FROM post WHERE id = ${row.id}
        UNION ALL
        SELECT p.id FROM post p JOIN family f ON p.merged_to = f.id
      )
      SELECT EXISTS(
        SELECT 1 FROM post_subscription WHERE user_id = ${viewerId!} AND post_id IN (SELECT id FROM family)
      ) as subscribed
    `)
    subscribed = !!result?.subscribed
  }

  // Gates author.email below: shipping it to end users would hand every
  // reporter's address to anyone who opens a post.
  //
  // A guest's address is a reserved-domain placeholder nobody can write to, so it
  // is withheld from staff as well — showing it only invites someone to try.
  const canReadInbox = role === 'owner' || role === 'manager'
  const isStaff = !!role
  const showAuthorEmail = isStaff && !row.authorIsAnonymous

  // Fetch the display title only after the same permission check as the source ID.
  let sourceConversationTitle: string | null = null
  if (canReadInbox && row.sourceConversationId) {
    const [source] = await db.select({ title: conversation.title }).from(conversation)
      .where(and(eq(conversation.id, row.sourceConversationId), eq(conversation.orgId, orgId))).limit(1)
    sourceConversationTitle = source?.title ?? null
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
    ...(canReadInbox ? { sourceConversationId: row.sourceConversationId, sourceConversationTitle } : {}),
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    canonicalPost,
  }
}

export async function listManagementFeedback(context: ContentReader, input: { filter: PostFilter; sort: string; order: string; page: number; pageSize: number; sourceConversationId?: string }) {
  const { db, orgId } = context
  const { filter, sort, order, page, pageSize, sourceConversationId } = input
  const offset = (page - 1) * pageSize
  const filters = postFilterConditions({ ...filter, orgId })
  if (sourceConversationId !== undefined) {
    const parsed = z.uuid().safeParse(sourceConversationId)
    if (!parsed.success) throw createError({ statusCode: 422, message: 'Invalid source conversation' })
    const [source] = await db.select({ id: conversation.id }).from(conversation).where(and(eq(conversation.id, parsed.data), eq(conversation.orgId, orgId))).limit(1)
    if (!source) throw createError({ statusCode: 404, message: 'Conversation not found' })
    filters.push(eq(post.sourceConversationId, parsed.data))
  }
  const whereClause = and(...filters)

  const sortCol = sort === 'votes' ? post.voteCount : sort === 'comments' ? post.commentCount : post.createdAt
  // The id tiebreaker follows the same direction, or equal-value rows shift between pages.
  const orderFn = order === 'asc' ? asc : desc

  const [countResult] = await db
    .select({ total: sql<number>`cast(count(*) as int)` })
    .from(post)
    .where(whereClause)

  const rows = await db
    .select({
      ...feedbackSummaryFields,
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
      cursorKey: timestampCursorKey(post.createdAt),
    })
    .from(post)
    .leftJoin(user, eq(post.authorId, user.id))
    .where(whereClause)
    .orderBy(orderFn(sortCol), orderFn(post.id))
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
      author: { id: r.authorId, name: r.authorName, image: r.authorImage, isAnonymous: !!r.authorIsAnonymous },
      createdAt: r.createdAt.toISOString(),
    })),
    pagination: { page, pageSize, total: countResult?.total ?? 0 },
  }
}

const ROADMAP_STATUSES = ['planned', 'in_progress', 'done'] as const
const PAGE_SIZE = 10

interface RoadmapColumn {
  data: PostListItem[]
  total: number
  nextCursor: string | null
}

type RoadmapResponse = Record<typeof ROADMAP_STATUSES[number], RoadmapColumn>


export async function getRoadmap(context: ContentReader, boardId?: string, viewerId?: string) {
  const { db, orgId } = context
  // Build board filter condition
  const boardCondition = boardId ? eq(post.boardId, boardId) : undefined

  // Query 1: UNION ALL — top 20 per status by votes
  const statusQueries = ROADMAP_STATUSES.map(status => {
    const conditions = postFilterConditions({ orgId, status: [status] })
    if (boardCondition) conditions.push(boardCondition)

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
      cursorKey: timestampCursorKey(post.createdAt),
      })
      .from(post)
      .leftJoin(user, eq(post.authorId, user.id))
      .where(and(...conditions))
      .orderBy(desc(post.createdAt), desc(post.id))
      .limit(PAGE_SIZE + 1)
  })

  // Query 2: counts per status
  const countConditions = postFilterConditions({ orgId, status: [...ROADMAP_STATUSES] })
  if (boardCondition) countConditions.push(boardCondition)

  const [results, counts] = await Promise.all([
    Promise.all(statusQueries),
    db
      .select({
        status: post.status,
        count: sql<number>`count(*)::int`,
      })
      .from(post)
      .where(and(...countConditions))
      .groupBy(post.status),
  ])

  // Build count map
  const countMap = new Map(counts.map(c => [c.status, c.count]))

  // Batch query hasVoted
  const allRows = results.flat()
  let votedPostIds = new Set<string>()
  if (viewerId && allRows.length > 0) {
    const postIds = allRows.map(r => r.id)
    const votes = await db
      .select({ postId: vote.postId })
      .from(vote)
      .where(and(
        eq(vote.userId, viewerId!),
        inArray(vote.postId, postIds),
      ))
    votedPostIds = new Set(votes.map(v => v.postId))
  }

  // Build response
  const response = {} as RoadmapResponse
  for (let i = 0; i < ROADMAP_STATUSES.length; i++) {
    const status = ROADMAP_STATUSES[i]!
    const rows = results[i]!
    const hasMore = rows.length > PAGE_SIZE
    const items = hasMore ? rows.slice(0, PAGE_SIZE) : rows

    const data: PostListItem[] = items.map(r => ({
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
      author: { id: r.authorId, name: r.authorName, image: r.authorImage, isAnonymous: !!r.authorIsAnonymous },
      createdAt: r.createdAt.toISOString(),
    }))

    const lastItem = data[data.length - 1]
    const nextCursor = hasMore && lastItem
      ? encodeWebCursor({ s: items.at(-1)!.cursorKey, id: lastItem.id })
      : null

    response[status] = {
      data,
      total: countMap.get(status) ?? 0,
      nextCursor,
    }
  }

  return response
}
