import { and, eq, exists, inArray, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import {
  changelogReaction,
  comment,
  commentLike,
  conversation,
  post,
  postSubscription,
  postUnread,
  user,
  vote,
} from '#layers/feedlog/server/db/schemas'

// Moves everything a guest left behind onto the account they just signed in with,
// then drops the guest row.
//
// Not scoped to one org on purpose. Possession of the guest's session token is
// the whole proof of ownership here, and whoever holds it already controlled that
// identity everywhere it wrote — narrowing by org would drop content the person
// legitimately owns without closing anything off.
//
// `useDB` is auto-imported by Nitro.

export interface ClaimedCounts {
  posts: number
  comments: number
  votes: number
  commentLikes: number
  conversations: number
}

export async function claimGuestContent(
  anonUserId: string,
  targetUserId: string,
): Promise<ClaimedCounts> {
  return await useDB().transaction(async (tx) => {
    // Votes and likes are one-per-user-per-target, so wherever the account has
    // already reacted the guest's row has nowhere to land. Dropping it leaves the
    // stored counter counting a reaction that no longer exists — hence the
    // decrement, and why these two run ahead of the plain renames below.
    const otherVote = alias(vote, 'existing_vote')
    const droppedVotes = await tx
      .delete(vote)
      .where(and(
        eq(vote.userId, anonUserId),
        exists(tx.select({ n: sql`1` }).from(otherVote).where(and(
          eq(otherVote.postId, vote.postId),
          eq(otherVote.userId, targetUserId),
        ))),
      ))
      .returning({ postId: vote.postId })
    if (droppedVotes.length) {
      await tx.update(post)
        .set({ voteCount: sql`greatest(${post.voteCount} - 1, 0)` })
        .where(inArray(post.id, droppedVotes.map(r => r.postId)))
    }

    const otherLike = alias(commentLike, 'existing_like')
    const droppedLikes = await tx
      .delete(commentLike)
      .where(and(
        eq(commentLike.userId, anonUserId),
        exists(tx.select({ n: sql`1` }).from(otherLike).where(and(
          eq(otherLike.commentId, commentLike.commentId),
          eq(otherLike.userId, targetUserId),
        ))),
      ))
      .returning({ commentId: commentLike.commentId })
    if (droppedLikes.length) {
      await tx.update(comment)
        .set({ likeCount: sql`greatest(${comment.likeCount} - 1, 0)` })
        .where(inArray(comment.id, droppedLikes.map(r => r.commentId)))
    }

    // Same collision, nothing to repair afterwards.
    const otherSub = alias(postSubscription, 'existing_subscription')
    await tx.delete(postSubscription).where(and(
      eq(postSubscription.userId, anonUserId),
      exists(tx.select({ n: sql`1` }).from(otherSub).where(and(
        eq(otherSub.postId, postSubscription.postId),
        eq(otherSub.userId, targetUserId),
      ))),
    ))

    const otherUnread = alias(postUnread, 'existing_unread')
    await tx.delete(postUnread).where(and(
      eq(postUnread.userId, anonUserId),
      exists(tx.select({ n: sql`1` }).from(otherUnread).where(and(
        eq(otherUnread.postId, postUnread.postId),
        eq(otherUnread.userId, targetUserId),
      ))),
    ))

    const otherReaction = alias(changelogReaction, 'existing_reaction')
    await tx.delete(changelogReaction).where(and(
      eq(changelogReaction.userId, anonUserId),
      exists(tx.select({ n: sql`1` }).from(otherReaction).where(and(
        eq(otherReaction.changelogId, changelogReaction.changelogId),
        eq(otherReaction.emoji, changelogReaction.emoji),
        eq(otherReaction.userId, targetUserId),
      ))),
    ))

    const posts = await tx.update(post)
      .set({ authorId: targetUserId })
      .where(eq(post.authorId, anonUserId))
      .returning({ id: post.id })
    const comments = await tx.update(comment)
      .set({ authorId: targetUserId })
      .where(eq(comment.authorId, anonUserId))
      .returning({ id: comment.id })
    const votes = await tx.update(vote)
      .set({ userId: targetUserId })
      .where(eq(vote.userId, anonUserId))
      .returning({ postId: vote.postId })
    const commentLikes = await tx.update(commentLike)
      .set({ userId: targetUserId })
      .where(eq(commentLike.userId, anonUserId))
      .returning({ commentId: commentLike.commentId })
    const conversations = await tx.update(conversation)
      .set({ userId: targetUserId })
      .where(eq(conversation.userId, anonUserId))
      .returning({ id: conversation.id })

    await tx.update(postSubscription).set({ userId: targetUserId }).where(eq(postSubscription.userId, anonUserId))
    await tx.update(postUnread).set({ userId: targetUserId }).where(eq(postUnread.userId, anonUserId))
    await tx.update(changelogReaction).set({ userId: targetUserId }).where(eq(changelogReaction.userId, anonUserId))

    // Last, so nothing above is left pointing at a row that is already gone.
    // Sessions cascade, which is what kills the guest token and turns a repeated
    // claim into a no-op.
    await tx.delete(user).where(eq(user.id, anonUserId))

    return {
      posts: posts.length,
      comments: comments.length,
      votes: votes.length,
      commentLikes: commentLikes.length,
      conversations: conversations.length,
    }
  })
}
