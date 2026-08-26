// DELETE /api/developer/agent-tokens/:id — revoke (owner-only).
//
// Deletes the underlying session, so the token stops working on the very next
// request. Org-scoped → 404 for ids that don't belong to the caller's org.
// The robot account itself survives, so anything it wrote keeps its author;
// remove the account from the Members page to retire it entirely.
export default defineEventHandler(async (event) => {
  const { orgId } = await requireOrgOwner(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 404, message: 'Token not found' })

  const db = useDB()
  const revoked = await revokeAgentToken(db, { id, orgId })
  if (!revoked) throw createError({ statusCode: 404, message: 'Token not found' })
  return { ok: true }
})
