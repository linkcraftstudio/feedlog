import { eq } from 'drizzle-orm'
import { agentToken } from '#layers/feedlog/server/db/schemas'
import {
  AGENT_TOKEN_DEFAULT_DAYS,
  AGENT_TOKEN_LIMIT,
  AGENT_TOKEN_ROLES,
  type AgentTokenRole,
} from '#layers/feedlog/shared/constants/agent'

// POST /api/developer/agent-tokens — mint a machine credential (owner-only).
// Body: { label?, role?, expiresInDays? }.
//
// Creates a fresh robot account each time, so revoking one token can never
// affect another, and the Members page shows one removable row per agent.
//
// The response is the ONLY place the raw token ever appears. Do not log it, do
// not put it in an error message, and — on the client side — send it as an
// Authorization header, never a query parameter: server/plugins/access-log.ts
// writes the path and query string of every request to the container log.
export default defineEventHandler(async (event) => {
  const { session, orgId } = await requireOrgOwner(event)
  const body = await readBody<{
    label?: string
    role?: string
    expiresInDays?: number
    allowDelete?: boolean
  }>(event).catch(() => ({} as Record<string, never>))
  const db = useDB()

  const existing = await db.$count(agentToken, eq(agentToken.orgId, orgId))
  if (existing >= AGENT_TOKEN_LIMIT) {
    throw createError({ statusCode: 409, message: `Limit of ${AGENT_TOKEN_LIMIT} agent tokens reached` })
  }

  const label = typeof body?.label === 'string' && body.label.trim()
    ? body.label.trim().slice(0, 80)
    : null

  // Default to manager: it carries feedlog:moderate, which is what an agent
  // working the roadmap and changelog needs. `owner` is not on the list at all.
  const role = (body?.role ?? 'manager') as AgentTokenRole
  if (!AGENT_TOKEN_ROLES.includes(role)) {
    throw createError({ statusCode: 400, message: 'Invalid role' })
  }

  const days = typeof body?.expiresInDays === 'number' && Number.isFinite(body.expiresInDays)
    ? body.expiresInDays
    : AGENT_TOKEN_DEFAULT_DAYS
  const expiresAt = resolveAgentExpiry(days)

  // Off unless asked for. Deleting cannot be undone, so it is never the
  // default — and it can be granted later without re-minting the token.
  const allowDelete = body?.allowDelete === true

  const userId = await provisionAgentUser(db, { orgId, label, role })
  const minted = await mintAgentSession(userId, expiresAt)

  const [row] = await db
    .insert(agentToken)
    .values({
      orgId,
      userId,
      sessionId: minted.id,
      label,
      prefix: agentTokenPrefix(minted.token),
      role,
      allowDelete,
      createdBy: session.user.id,
      expiresAt,
    })
    .returning()

  setResponseStatus(event, 201)
  return { ...agentTokenToView(row!), token: minted.token }
})
