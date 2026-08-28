import { desc, eq } from 'drizzle-orm'
import { agentToken } from '#layers/feedlog/server/db/schemas'

// GET /api/developer/agent-tokens — list this org's agent tokens (owner-only).
//
// Returns the label, the display prefix and the dates, and NEVER the token.
// There is no reveal endpoint anywhere: that absence is what makes the token
// show-once. A lost token is revoked and re-minted, not recovered.
export default defineEventHandler(async (event) => {
  const { orgId } = await requireOrgOwner(event)
  const db = useDB()
  const rows = await db
    .select()
    .from(agentToken)
    .where(eq(agentToken.orgId, orgId))
    .orderBy(desc(agentToken.createdAt))
  return rows.map(agentTokenToView)
})
