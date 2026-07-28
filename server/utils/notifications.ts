import { eq, sql } from 'drizzle-orm'
import { useDB } from './db'
import { sendNotification } from './notification-send'
import { markPostUnreadForAuthor } from './widget-unread'
import { resolveCommentEvents } from '../../shared/utils/notifications'
import { organization, user } from '../db/schemas'
import type { NotificationPayload } from '../db/schemas'

// DB-touching notification emit. Pure who/whether decisions live in
// shared/utils/notifications.ts; the per-recipient send lives in
// notification-send.ts. This module answers only WHO.
//
//  · Recipients = whoever is subscribed to this post (across the whole merge
//    family), minus org admins and the acting user. Authorship and votes have
//    already written subscription rows, so the table IS the audience.
//  · Resolving is one SELECT; sending is a loop the caller owns (inside
//    waitUntil), so a failure is logged, never thrown.

export type PostThreadType = 'post.status_changed' | 'post.admin_replied'

export interface CommentEmitInput {
  orgId: string
  postId: string
  snippet: string
  actorId: string
  authorIsAdmin: boolean
  isTopLevel: boolean
  notifyVoters: boolean // false → skip upvoters (author + manual subscribers still get it)
  requestOrigin?: string // link-builder fallback; BETTER_AUTH_URL is optional in OSS
}

export interface RecipientRow {
  user_id: string
  email: string
  post_slug: string
  post_title: string
}

// The post's subscribers across its merge family. Excludes org admins and the
// actor. includeVoters=false also drops upvoters (the author subscribed via
// authorship, not a vote, so they survive).
export async function resolvePostThreadRecipients(orgId: string, postId: string, actorId: string, includeVoters = true): Promise<RecipientRow[]> {
  const db = useDB()
  const excludeVoters = includeVoters
    ? sql``
    : sql`AND NOT EXISTS (SELECT 1 FROM vote v WHERE v.user_id = ps.user_id AND v.post_id IN (SELECT id FROM family))`
  return await db.execute(sql`
    WITH RECURSIVE family AS (
      SELECT id FROM post WHERE id = ${postId}::uuid
      UNION ALL
      SELECT p.id FROM post p JOIN family f ON p.merged_to = f.id
    )
    SELECT DISTINCT ps.user_id, u.email, pp.slug AS post_slug, pp.title AS post_title
    FROM post_subscription ps
    JOIN "user" u ON u.id = ps.user_id
    CROSS JOIN (SELECT slug, title FROM post WHERE id = ${postId}::uuid) pp
    WHERE ps.post_id IN (SELECT id FROM family)
      AND ps.user_id <> ${actorId}
      AND u.email IS NOT NULL
      ${excludeVoters}
      AND NOT EXISTS (
        SELECT 1 FROM member m
        WHERE m.user_id = ps.user_id AND m.organization_id = ${orgId}
          AND m.role IN ('owner', 'manager')
      )
  `) as unknown as RecipientRow[]
}

export async function resolveOrgSlug(orgId: string): Promise<string> {
  const db = useDB()
  const rows = await db.select({ slug: organization.slug }).from(organization).where(eq(organization.id, orgId)).limit(1)
  return rows[0]?.slug ?? ''
}

// Mail an already-resolved recipient set. Called inside waitUntil.
export async function deliverToRecipients(
  orgId: string,
  orgSlug: string,
  recipients: RecipientRow[],
  typeKey: PostThreadType,
  payload: NotificationPayload,
  requestOrigin?: string,
): Promise<void> {
  for (const r of recipients) {
    await sendNotification({
      orgId,
      orgSlug,
      recipientEmail: r.email,
      typeKey,
      postSlug: r.post_slug,
      postTitle: r.post_title,
      payload,
      requestOrigin,
    })
  }
}

// Comment path — resolve and deliver in one go; the caller doesn't need a count.
async function emitAdminReply(input: CommentEmitInput): Promise<void> {
  const db = useDB()
  const orgSlug = await resolveOrgSlug(input.orgId)
  if (!orgSlug) {
    console.error(`[notifications] no org slug, skipping org=${input.orgId}`)
    return
  }
  const recipients = await resolvePostThreadRecipients(input.orgId, input.postId, input.actorId, input.notifyVoters)
  if (recipients.length === 0) return

  // Actor is the same for every recipient — resolve once for the email.
  const [actor] = await db.select({ name: user.name, image: user.image }).from(user).where(eq(user.id, input.actorId)).limit(1)
  await deliverToRecipients(input.orgId, orgSlug, recipients, 'post.admin_replied', {
    snippet: input.snippet.slice(0, 280),
    actorName: actor?.name ?? undefined,
    actorImage: actor?.image ?? null,
  }, input.requestOrigin)
}

// Only an admin's top-level comment notifies anyone (official reply).
export async function emitCommentNotifications(input: CommentEmitInput): Promise<void> {
  const events = resolveCommentEvents({ isTopLevel: input.isTopLevel, authorIsAdmin: input.authorIsAdmin })
  for (const typeKey of events) {
    if (typeKey === 'post.admin_replied') {
      // The widget's red dot rides the same event as the email, but reaches only
      // the author. Separate try so a widget failure can't cost anyone their mail.
      await markPostUnreadForAuthor(input.postId, input.actorId)
        .catch((err: unknown) => console.error('[widget] unread mark failed', err))
      await emitAdminReply(input)
    }
  }
}
