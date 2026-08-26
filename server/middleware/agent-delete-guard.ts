import { eq } from 'drizzle-orm'
import { agentToken } from '#layers/feedlog/server/db/schemas'
import { isAgentEmail } from '#layers/feedlog/shared/constants/agent'

// Withholds destructive deletes from agent tokens that were not granted them.
//
// Deleting is the one thing an agent does that nobody can undo, so it is a
// capability an owner grants per token rather than something bundled into the
// `manager` role. The flag lives on agent_token.allow_delete and can be turned
// on or off at any time without re-minting: this guard reads it per request, so
// withdrawing it takes effect on the very next call.
//
// Enforced here rather than in the route handlers for the same reason
// sso-session-guard blocks by path prefix: a list of routes to protect stays
// correct as routes are added, whereas a check sprinkled through handlers
// silently misses the next one.

// Deleting *content* is what is gated. Deletes that only unwind the caller's
// own action — withdrawing a vote, unsubscribing, removing a reaction — are
// ordinary participation, not destruction, and stay allowed. Without that
// distinction a read-only agent could not even take back its own upvote.
const PROTECTED_DELETE_PATTERNS: RegExp[] = [
  /^\/api\/admin\/posts\/[^/]+$/, // delete a card
  /^\/api\/admin\/changelogs\/[^/]+$/, // delete a changelog entry
  /^\/api\/admin\/boards\/[^/]+$/, // delete a board
  /^\/api\/comments\/[^/]+$/, // delete a comment
  /^\/api\/posts\/[^/]+$/, // delete a card via the public route
]

function isProtectedDelete(method: string, path: string): boolean {
  if (method !== 'DELETE') return false
  const clean = path.split('?')[0] ?? path
  return PROTECTED_DELETE_PATTERNS.some(re => re.test(clean))
}

export default defineEventHandler(async (event) => {
  if (!isProtectedDelete(event.method, event.path)) return

  const session = await auth.api.getSession({ headers: event.headers })
  if (!session?.user || !isAgentEmail(session.user.email)) return

  // The token is identified by the session it was minted as — agent_token.
  // session_id is unique, so this is a single indexed lookup on a path that
  // only agent-authenticated deletes ever reach.
  const db = useDB()
  const [row] = await db
    .select({ allowDelete: agentToken.allowDelete })
    .from(agentToken)
    .where(eq(agentToken.sessionId, session.session.id))
    .limit(1)

  // No row means the session belongs to an agent identity but not to any token
  // this deployment issued — refuse rather than guess.
  if (!row?.allowDelete) {
    throw createError({
      statusCode: 403,
      message: 'This agent token is not allowed to delete content. An owner can grant it under Developer → Agent tokens.',
    })
  }
})
