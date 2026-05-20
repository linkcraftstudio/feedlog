// GET /api/invitations/:id — public invitation lookup for the /invite page.
//
// Returns just enough for the UI to render: org name + invited email +
// status. No auth required — the invitation id is itself the secret (long
// random token, only delivered via email or copy-link).
//
// We deliberately don't use better-auth's `organization.get-invitation`
// endpoint because it requires the requester to already be signed in as
// the invited email — which collapses our anonymous/match/mismatch states
// into a single "Invitation unavailable" surface and breaks the flow.
//
// Acceptance still goes through better-auth's `acceptInvitation`, which
// keeps the email-binding check at the security-critical step.
//
// 404 for missing / non-pending / expired so the client can render a
// single "Invitation unavailable" state without leaking which specific
// failure mode occurred.

import { eq } from 'drizzle-orm'
import { db } from '#layers/feedlog/server/db'
import { invitation, organization } from '#layers/feedlog/server/db/schemas'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 404, message: 'Invitation not found' })

  const rows = await db
    .select({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      organizationId: invitation.organizationId,
      organizationName: organization.name,
      organizationSlug: organization.slug,
    })
    .from(invitation)
    .innerJoin(organization, eq(invitation.organizationId, organization.id))
    .where(eq(invitation.id, id))
    .limit(1)

  const row = rows[0]
  if (!row) throw createError({ statusCode: 404, message: 'Invitation not found' })
  if (row.status !== 'pending') throw createError({ statusCode: 404, message: 'Invitation not pending' })
  if (row.expiresAt < new Date()) throw createError({ statusCode: 404, message: 'Invitation expired' })

  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    organizationName: row.organizationName,
    organizationSlug: row.organizationSlug,
  }
})
