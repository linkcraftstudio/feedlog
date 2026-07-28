import { and, desc, eq, sql } from 'drizzle-orm'
import { post, postUnread } from '#layers/feedlog/server/db/schemas'
import type { CursorPaginatedList } from '#layers/feedlog/shared/types/pagination'

export interface WidgetFeedbackItem {
  id: string
  slug: string
  title: string
  status: string
  voteCount: number
  createdAt: Date
  unread: boolean
}

// The visitor's own feedback, newest first, each flagged with whether it has an
// unread admin update. requireAuthInOrg, not requireOrgMember: the caller is an
// end user of the customer's product, never a FeedLog staff member.
export default defineEventHandler(async (event): Promise<CursorPaginatedList<WidgetFeedbackItem>> => {
  const { session, orgId } = await requireAuthInOrg(event)
  const userId = session.user.id
  const query = getQuery(event)
  const cursor = query.cursor as string | undefined
  const pageSize = Math.min(Number(query.pageSize) || 20, 50)

  const conditions = [eq(post.orgId, orgId), eq(post.authorId, userId)]

  if (cursor) {
    const decoded = decodeCursor(cursor)
    if (decoded) {
      conditions.push(sql`(${post.createdAt}, ${post.id}) < (${decoded.s}::timestamptz, ${decoded.id}::uuid)`)
    }
  }

  // Merged posts stay in the list: merging freezes a post but the author still
  // has updates on it worth reading, and the badge counts them, so hiding them
  // here would leave a count the list can't account for.
  const rows = await useDB()
    .select({
      id: post.id,
      slug: post.slug,
      title: post.title,
      status: post.status,
      voteCount: post.voteCount,
      createdAt: post.createdAt,
      unreadAt: postUnread.createdAt,
    })
    .from(post)
    .leftJoin(postUnread, and(eq(postUnread.postId, post.id), eq(postUnread.userId, userId)))
    .where(and(...conditions))
    .orderBy(desc(post.createdAt), desc(post.id))
    .limit(pageSize + 1)

  const hasMore = rows.length > pageSize
  const data = rows.slice(0, pageSize).map(r => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    status: r.status,
    voteCount: r.voteCount,
    createdAt: r.createdAt,
    unread: r.unreadAt !== null,
  }))

  const lastItem = data[data.length - 1]
  const nextCursor = hasMore && lastItem
    ? encodeCursor({ s: lastItem.createdAt, id: lastItem.id })
    : null

  return { data, pagination: { nextCursor } }
})

function encodeCursor(data: { s: unknown; id: string }): string {
  return Buffer.from(JSON.stringify(data)).toString('base64url')
}

function decodeCursor(cursor: string): { s: any; id: string } | null {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString())
  }
  catch {
    return null
  }
}
