import { sendEmail, type SendEmailOptions } from './email'
import { buildPostLink } from './post-link-builder'
import { renderNotificationEmail } from './email-templates'
import type { NotificationTypeKey } from '../../shared/constants/notifications'
import type { NotificationPayload } from '../db/schemas'

// One recipient's decision + delivery, run inline in the triggering request's
// waitUntil. Recipients are already resolved and English-only, so everything the
// email needs is here.

export interface SendNotificationInput {
  orgId: string
  orgSlug: string
  brandColor: string
  recipientEmail: string
  typeKey: NotificationTypeKey
  postSlug: string
  postTitle: string
  payload: NotificationPayload
  // Origin the triggering request arrived on; the link builder's fallback when
  // BETTER_AUTH_URL is unset (it is optional in OSS).
  requestOrigin?: string
}

// Returns null for a type with no email template (a config error; the caller
// logs it rather than sending blank).
function buildNotificationEmail(input: SendNotificationInput, brandName?: string): SendEmailOptions | null {
  const postUrl = buildPostLink(input.orgSlug, `/p/${input.postSlug}`, input.requestOrigin)
  const actorImage = input.payload.actorImage
  const content = renderNotificationEmail({
    typeKey: input.typeKey,
    postTitle: input.postTitle,
    postUrl,
    preferencesUrl: input.typeKey === 'post.created' || input.typeKey === 'post.user_commented'
      ? buildPostLink(input.orgSlug, '/dashboard/settings/personal', input.requestOrigin)
      : undefined,
    to: input.payload.to,
    note: input.payload.note,
    snippet: input.payload.snippet,
    actorName: input.payload.actorName,
    actorImage: actorImage?.startsWith('/api/files/') ? new URL(actorImage, postUrl).href : actorImage,
    brandColor: input.brandColor,
    brandName,
  })
  if (!content) return null
  return { to: input.recipientEmail, subject: content.subject, html: content.html, text: content.text }
}

export async function sendNotification(input: SendNotificationInput): Promise<void> {
  const options = buildNotificationEmail(input, await emailBrandName())
  if (!options) {
    console.error(`[notifications] no template for type=${input.typeKey} org=${input.orgId}`)
    return
  }

  // At-most-once: one immediate retry for transient jitter, then give up.
  try {
    await sendEmail(options)
  }
  catch {
    try {
      await sendEmail(options)
    }
    catch (err) {
      console.error(`[notifications] send failed org=${input.orgId} type=${input.typeKey}`, err)
    }
  }
}
