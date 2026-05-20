import { and, eq } from 'drizzle-orm'
import { invitation, organization } from '#layers/feedlog/server/db/schemas'
import { buildInviteLink } from '../../../../utils/invite'

// POST /api/admin/invitations/:id/resend
//
// Re-issues the invitation email for a still-pending invitation. The
// invitation row itself is unchanged — only the email goes out again.
// Gated on `invitation:create` (same threshold as creating one).
//
// Open-source: emails fire only when RESEND_API_KEY is configured;
// otherwise the manager is expected to use "Copy invitation link" in the
// UI as a manual fallback.
export default defineEventHandler(async (event) => {
  const { orgId } = await requireOrgPermission(event, { invitation: ['create'] })
  const id = getRouterParam(event, 'id')!

  const db = useDB()
  const [row] = await db
    .select({
      id: invitation.id,
      email: invitation.email,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      orgName: organization.name,
      orgSlug: organization.slug,
    })
    .from(invitation)
    .innerJoin(organization, eq(invitation.organizationId, organization.id))
    .where(and(eq(invitation.id, id), eq(invitation.organizationId, orgId)))
    .limit(1)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Invitation not found' })
  }
  if (row.status !== 'pending') {
    throw createError({ statusCode: 400, message: 'Only pending invitations can be resent' })
  }
  if (row.expiresAt.getTime() < Date.now()) {
    throw createError({ statusCode: 400, message: 'Invitation has expired' })
  }

  const url = buildInviteLink({ id: row.id, organization: { slug: row.orgSlug } }, event)
  if (!process.env.RESEND_API_KEY) {
    // No transport configured — return the link so the caller can copy it.
    return { sent: false, url }
  }
  await sendEmail({
    to: row.email,
    subject: `You're invited to join ${row.orgName} on FeedLog`,
    html: renderInvitationEmail({ url, orgName: row.orgName }),
  })
  return { sent: true }
})
