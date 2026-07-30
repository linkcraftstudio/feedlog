import { and, count, desc, eq, sql } from 'drizzle-orm'
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
// `total` rides along so the header can count posts without paging to the end.
export default defineEventHandler(async (event): Promise<CursorPaginatedList<WidgetFeedbackItem> & { total: number }> => {
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

  // Counted without the cursor condition, so it stays the same on every page.
  const [totalRow] = await useDB()
    .select({ value: count() })
    .from(post)
    .where(and(eq(post.orgId, orgId), eq(post.authorId, userId)))

  return { data, total: Number(totalRow?.value ?? 0), pagination: { nextCursor } }
})

// JSON turns the Date into an ISO string on the way out and never turns it back,
// so the two halves are deliberately not symmetric.
function encodeCursor(data: { s: Date; id: string }): string {
  return Buffer.from(JSON.stringify(data)).toString('base64url')
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The contents are checked, not just the encoding: the halves go straight into a
// ::timestamptz / ::uuid cast, and Postgres answers anything it can't parse with
// an error the handler has no way to catch. Rejecting here falls back to the
// first page, which is what an unreadable cursor already did.
function decodeCursor(cursor: string): { s: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString())
    if (typeof parsed?.s !== 'string' || Number.isNaN(Date.parse(parsed.s))) return null
    if (typeof parsed?.id !== 'string' || !UUID.test(parsed.id)) return null
    return { s: parsed.s, id: parsed.id }
  }
  catch {
    return null
  }
}
