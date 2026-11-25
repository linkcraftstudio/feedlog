import { and, eq } from 'drizzle-orm'
import { member } from '#layers/feedlog/server/db/schemas'

// POST /api/admin/members/:id/activate
//
// Gives a suspended member their access back. A deployment may refuse it from
// the `feedlog:member:before-activate` runtime hook (see utils/member-hooks.ts);
// its error is returned as is. Same threshold as changing a member's role.
// Activating an active member is a no-op.
export default defineEventHandler(async (event) => {
  const { orgId } = await requireOrgPermission(event, { member: ['update'] })
  const id = getRouterParam(event, 'id')!

  return useDB().transaction(async (tx) => {
    const [row] = await tx
      .select({ id: member.id, suspendedAt: member.suspendedAt })
      .from(member)
      .where(and(eq(member.id, id), eq(member.organizationId, orgId)))
      .for('update')
    if (!row) {
      throw createError({ statusCode: 404, message: 'Member not found' })
    }
    if (row.suspendedAt) {
      await useNitroApp().hooks.callHook('feedlog:member:before-activate', { orgId, memberId: id })
      await tx.update(member).set({ suspendedAt: null, suspendedReason: null }).where(eq(member.id, id))
    }
    return { id, suspendedAt: null }
  })
})
