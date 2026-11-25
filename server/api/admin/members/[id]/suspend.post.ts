import { and, eq } from 'drizzle-orm'
import { member } from '#layers/feedlog/server/db/schemas'

const isOwner = (role: string) => role.split(',').map(r => r.trim()).includes('owner')

// POST /api/admin/members/:id/suspend
//
// Frees a seat without removing the member: they keep their role and history
// but lose access until activated. Same threshold as activate. Nobody suspends
// themselves, a manager cannot suspend an owner, and the organization always
// keeps one active owner. Suspending a suspended member is a no-op.
export default defineEventHandler(async (event) => {
  const { orgId, session } = await requireOrgPermission(event, { member: ['update'] })
  const id = getRouterParam(event, 'id')!

  return useDB().transaction(async (tx) => {
    // Locking every member row serializes concurrent suspensions, so two of
    // them cannot each leave the other as the last active owner.
    const rows = await tx
      .select({ id: member.id, userId: member.userId, role: member.role, suspendedAt: member.suspendedAt })
      .from(member)
      .where(eq(member.organizationId, orgId))
      .for('update')
    const target = rows.find(row => row.id === id)
    if (!target) {
      throw createError({ statusCode: 404, message: 'Member not found' })
    }
    if (target.suspendedAt) return { id, suspendedAt: target.suspendedAt }
    if (target.userId === session.user.id) {
      throw createError({ statusCode: 400, message: 'You cannot suspend yourself', data: { code: 'cannot_suspend_self' } })
    }
    if (isOwner(target.role)) {
      const actor = rows.find(row => row.userId === session.user.id)
      if (!actor || !isOwner(actor.role)) {
        throw createError({ statusCode: 403, message: 'Only an owner can suspend an owner', data: { code: 'PERMISSION_DENIED' } })
      }
      if (!rows.some(row => row.id !== id && isOwner(row.role) && !row.suspendedAt)) {
        throw createError({ statusCode: 400, message: 'The organization needs at least one active owner', data: { code: 'last_active_owner' } })
      }
    }
    const [updated] = await tx.update(member).set({ suspendedAt: new Date(), suspendedReason: 'manual' })
      .where(and(eq(member.id, id), eq(member.organizationId, orgId)))
      .returning({ suspendedAt: member.suspendedAt })
    return { id, suspendedAt: updated!.suspendedAt }
  })
})
