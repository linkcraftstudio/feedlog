import { and, count, eq } from 'drizzle-orm'
import { useDB } from './db'
import { conversation, post, postUnread } from '../db/schemas'
import { withinRetention } from './conversation'

// Badge = posts + conversations; `feedback` is the posts-only half. Conversations
// past the retention window are left out: the list hides them, so that dot would
// never be clearable.
export async function countWidgetBadge(orgId: string, userId: string): Promise<{ count: number, feedback: number }> {
  const db = useDB()

  const [posts] = await db
    .select({ value: count() })
    .from(postUnread)
    .innerJoin(post, eq(post.id, postUnread.postId))
    .where(and(eq(postUnread.userId, userId), eq(post.orgId, orgId)))

  const [threads] = await db
    .select({ value: count() })
    .from(conversation)
    .where(and(
      eq(conversation.orgId, orgId),
      eq(conversation.userId, userId),
      eq(conversation.unread, true),
      withinRetention(orgId),
    ))

  const feedback = Number(posts?.value ?? 0)
  return { count: feedback + Number(threads?.value ?? 0), feedback }
}

// Marks a post unread for its author — the widget's red dot. Fired on the same
// two events the email notifications use (admin reply, status change), but with
// a narrower audience: only the author, because the widget's "My feedback" list
// shows only their own posts, so an unread on someone else's post would be a
// badge the list can never account for.
//
// Best-effort like the notification emit it rides along with: a failure here
// must not fail the admin's action.
export async function markPostUnreadForAuthor(postId: string, actorId: string): Promise<void> {
  const db = useDB()
  const [row] = await db
    .select({ authorId: post.authorId })
    .from(post)
    .where(eq(post.id, postId))
    .limit(1)
  // An admin acting on their own post shouldn't flag it for themselves.
  if (!row || row.authorId === actorId) return

  await db
    .insert(postUnread)
    .values({ postId, userId: row.authorId })
    .onConflictDoNothing()
}
