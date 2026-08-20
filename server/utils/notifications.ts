import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { useDB } from './db'
import { sendNotification } from './notification-send'
import { markPostUnreadForAuthor } from './widget-unread'
import { resolveCommentEvents } from '../../shared/utils/notifications'
import { resolveBranding } from '../../shared/utils/branding'
import { member, organization, user } from '../db/schemas'
import type { NotificationPayload } from '../db/schemas'

// DB-touching notification emit. Pure who/whether decisions live in
// shared/utils/notifications.ts; the per-recipient send lives in
// notification-send.ts. This module answers only WHO.
//
//  · Subscriber audience = whoever is subscribed to this post (across the whole
//    merge family), minus org admins and the acting user. Authorship and votes
//    have already written subscription rows, so the table IS the audience.
//  · Resolving is one SELECT; sending is a loop the caller owns (inside
//    waitUntil), so a failure is logged, never thrown.

export type PostThreadType = 'post.status_changed' | 'post.admin_replied'
export type OrgAdminType = 'post.created' | 'post.user_commented'

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
      -- A guest's address is a reserved-domain placeholder; mailing it would only
      -- generate bounces. They still get the widget's unread dot, and once they
      -- claim the content onto a real account the mail starts flowing.
      AND u.is_anonymous IS NOT TRUE
      ${excludeVoters}
      AND NOT EXISTS (
        SELECT 1 FROM member m
        WHERE m.user_id = ps.user_id AND m.organization_id = ${orgId}
          AND m.role IN ('owner', 'manager')
      )
  `) as unknown as RecipientRow[]
}

export async function resolveOrgBranding(orgId: string): Promise<{ slug: string; brandColor: string }> {
  const db = useDB()
  const rows = await db.select({ slug: organization.slug, metadata: organization.metadata }).from(organization).where(eq(organization.id, orgId)).limit(1)
  return { slug: rows[0]?.slug ?? '', brandColor: resolveBranding(rows[0]?.metadata).primaryColor }
}

// Mail an already-resolved recipient set. Called inside waitUntil.
export async function deliverToRecipients(
  orgId: string,
  orgSlug: string,
  brandColor: string,
  recipients: RecipientRow[],
  typeKey: PostThreadType,
  payload: NotificationPayload,
  requestOrigin?: string,
): Promise<void> {
  for (const r of recipients) {
    await sendNotification({
      orgId,
      orgSlug,
      brandColor,
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
  const { slug: orgSlug, brandColor } = await resolveOrgBranding(input.orgId)
  if (!orgSlug) {
    console.error(`[notifications] no org slug, skipping org=${input.orgId}`)
    return
  }
  const recipients = await resolvePostThreadRecipients(input.orgId, input.postId, input.actorId, input.notifyVoters)
  if (recipients.length === 0) return

  // Actor is the same for every recipient — resolve once for the email.
  const [actor] = await db.select({ name: user.name, image: user.image }).from(user).where(eq(user.id, input.actorId)).limit(1)
  await deliverToRecipients(input.orgId, orgSlug, brandColor, recipients, 'post.admin_replied', {
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

export interface AdminEmitInput {
  orgId: string
  typeKey: OrgAdminType
  postSlug: string
  postTitle: string
  snippet: string
  actorId: string
  requestOrigin?: string
}

export async function resolveOrgAdminRecipients(orgId: string, actorId: string) {
  const db = useDB()
  return await db
    .select({ userId: member.userId, email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(
      eq(member.organizationId, orgId),
      inArray(member.role, ['owner', 'manager']),
      ne(member.userId, actorId),
    ))
}

export async function emitAdminNotification(input: AdminEmitInput): Promise<void> {
  const db = useDB()
  const { slug: orgSlug, brandColor } = await resolveOrgBranding(input.orgId)
  if (!orgSlug) {
    console.error(`[notifications] no org slug, skipping org=${input.orgId}`)
    return
  }
  const recipients = await resolveOrgAdminRecipients(input.orgId, input.actorId)
  if (recipients.length === 0) return

  const [actor] = await db.select({ name: user.name, image: user.image }).from(user).where(eq(user.id, input.actorId)).limit(1)
  const payload: NotificationPayload = {
    snippet: input.snippet.slice(0, 280),
    actorName: actor?.name ?? undefined,
    actorImage: actor?.image ?? null,
  }
  for (const r of recipients) {
    await sendNotification({
      orgId: input.orgId,
      orgSlug,
      brandColor,
      recipientEmail: r.email,
      typeKey: input.typeKey,
      postSlug: input.postSlug,
      postTitle: input.postTitle,
      payload,
      requestOrigin: input.requestOrigin,
    })
  }
}
