import { eq } from 'drizzle-orm'
import { useDB } from './db'
import { post, postUnread } from '../db/schemas'

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
