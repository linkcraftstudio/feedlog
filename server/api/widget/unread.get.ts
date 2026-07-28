import { and, count, eq } from 'drizzle-orm'
import { post, postUnread } from '#layers/feedlog/server/db/schemas'

// Badge count for the launcher. requireAuthInOrg, not requireOrgMember: the
// caller is an end user of the customer's product, never a FeedLog staff member.
export default defineEventHandler(async (event): Promise<{ count: number }> => {
  const { session, orgId } = await requireAuthInOrg(event)

  // post_unread carries no org column, so the join is what scopes the count to
  // this tenant — a user with feedback in two orgs must not see one org's badge
  // on the other's widget.
  const [row] = await useDB()
    .select({ value: count() })
    .from(postUnread)
    .innerJoin(post, eq(post.id, postUnread.postId))
    .where(and(
      eq(postUnread.userId, session.user.id),
      eq(post.orgId, orgId),
    ))

  return { count: Number(row?.value ?? 0) }
})
