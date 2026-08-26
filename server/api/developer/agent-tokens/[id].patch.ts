import { and, eq } from 'drizzle-orm'
import { agentToken } from '#layers/feedlog/server/db/schemas'

// PATCH /api/developer/agent-tokens/:id — change what an existing token may do
// (owner-only). Body: { allowDelete }.
//
// Separate from minting on purpose: an owner should be able to grant or
// withdraw the delete capability without re-issuing the credential, so a token
// already deployed in an agent's config keeps working. The guard reads the flag
// per request, so withdrawing it bites on the very next call — there is no
// window in which the old answer is still cached.
//
// The label, role and expiry are deliberately NOT editable. Role and expiry are
// baked into the session that was minted, so changing the row would say one
// thing while the credential did another.
export default defineEventHandler(async (event) => {
  const { orgId } = await requireOrgOwner(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 404, message: 'Token not found' })

  const body = await readBody<{ allowDelete?: boolean }>(event).catch(() => ({} as { allowDelete?: boolean }))
  if (typeof body?.allowDelete !== 'boolean') {
    throw createError({ statusCode: 400, message: 'allowDelete must be true or false' })
  }

  const db = useDB()
  const [row] = await db
    .update(agentToken)
    .set({ allowDelete: body.allowDelete })
    .where(and(eq(agentToken.id, id), eq(agentToken.orgId, orgId)))
    .returning()
  if (!row) throw createError({ statusCode: 404, message: 'Token not found' })

  return agentTokenToView(row)
})
