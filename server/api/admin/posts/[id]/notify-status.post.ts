import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { getRequestURL } from 'h3'
import { post } from '#layers/feedlog/server/db/schemas'
import { resolvePostThreadRecipients, resolveOrgSlug, deliverToRecipients } from '#layers/feedlog/server/utils/notifications'
import { POST_STATUSES } from '#layers/feedlog/shared/types/post'

// POST /api/admin/posts/:id/notify-status — mail the post's subscribers that it
// is now in status X. The status is already written by PATCH; this only sends.
const bodySchema = z.object({
  status: z.enum(POST_STATUSES as unknown as [string, ...string[]]),
  note: z.string().trim().max(2000).optional(),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readValidatedBody(event, bodySchema.parse)
  const { session, orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })

  const db = useDB()
  const [existing] = await db
    .select({ id: post.id, status: post.status })
    .from(post)
    .where(and(eq(post.id, id), eq(post.orgId, orgId)))
    .limit(1)

  if (!existing) {
    throw createError({ statusCode: 404, message: 'Post not found' })
  }
  // Optimistic lock: the admin acts on the status they saw on the card. If it
  // changed under them, refuse rather than announce a status they never saw.
  if (existing.status !== body.status) {
    throw createError({ statusCode: 409, message: 'Status was changed by someone else' })
  }

  // Resolve recipients synchronously so we can return the count; send async.
  const orgSlug = await resolveOrgSlug(orgId)
  const recipients = orgSlug ? await resolvePostThreadRecipients(orgId, id, session.user.id) : []

  if (recipients.length > 0) {
    event.waitUntil(
      deliverToRecipients(orgId, orgSlug, recipients, 'post.status_changed',
        { to: body.status, note: body.note || undefined }, getRequestURL(event).origin)
        .catch((err: unknown) => console.error('[notifications] status notify failed', err)),
    )
  }

  return { ok: true, recipients: recipients.length }
})
