import { and, eq } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import { agentToken, member, session as sessionTable, user } from '#layers/feedlog/server/db/schemas'
import {
  AGENT_EMAIL_DOMAIN,
  AGENT_TOKEN_MAX_DAYS,
  AGENT_TOKEN_PREFIX_LENGTH,
  type AgentTokenRole,
} from '#layers/feedlog/shared/constants/agent'

// Agent tokens: a machine credential that authenticates through the app's own
// front door rather than beside it.
//
// The credential is a better-auth session row with a far-future expiry, sent as
// `Authorization: Bearer <token>`. The bearer plugin turns that header into a
// session cookie before any better-auth endpoint runs, so every existing gate —
// getUserSession, requireAuthInOrg, requireOrgMember (via customSession's
// orgList) and requireOrgPermission (via auth.api.hasPermission) — behaves
// exactly as it does for a signed-in human. That is why none of them needed
// changing. It also means all the app's bookkeeping still happens: vote tallies,
// duplicate-detection embeddings, subscriptions, notifications, activity trail.

export interface AgentTokenView {
  id: string
  label: string | null
  prefix: string
  role: string
  createdAt: string
  expiresAt: string
  expired: boolean
}

// The raw token appears in exactly one place in this codebase: the `token` field
// of this shape, returned by the create endpoint. It is never persisted here,
// never logged, and never returned by the list endpoint.
export interface AgentTokenCreated extends AgentTokenView {
  token: string
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

export function agentTokenToView(row: {
  id: string
  label: string | null
  prefix: string
  role: string
  createdAt: Date | string
  expiresAt: Date | string
}): AgentTokenView {
  const expiresAt = iso(row.expiresAt)
  return {
    id: row.id,
    label: row.label,
    prefix: row.prefix,
    role: row.role,
    createdAt: iso(row.createdAt),
    expiresAt,
    expired: new Date(expiresAt).getTime() <= Date.now(),
  }
}

// Clamp to a sane window. A caller may ask for anything; they get 1 day at the
// least and AGENT_TOKEN_MAX_DAYS at the most, because an unbounded expiry is a
// credential nobody ever revisits.
export function resolveAgentExpiry(days: number): Date {
  const clamped = Math.min(Math.max(Math.floor(days), 1), AGENT_TOKEN_MAX_DAYS)
  return new Date(Date.now() + clamped * 24 * 60 * 60 * 1000)
}

// Provision the robot identity.
//
// It has to be done server-side. Sign-up on this deployment can require e-mail
// verification, and the invitation flow deliberately does not auto-accept — the
// invitee must sign in and click Accept (see better-auth.ts). A robot has no
// inbox and no way to sign in, so it could never complete either path.
//
// Crucially we insert a `user` row and nothing else: no `account` row means no
// password and no linked provider, so there is no credential that could be used
// against the login form. The address is under a reserved `.invalid` domain, so
// it can never be registered or receive mail either. The only way to act as this
// identity is to hold a token minted below.
//
// Mirrors findOrCreateSsoUser's insert (emailVerified: true so the row is never
// nagged for verification) and bootstrapAfterUserCreate's member insert.
export async function provisionAgentUser(
  db: ReturnType<typeof useDB>,
  input: { orgId: string; label: string | null; role: AgentTokenRole },
): Promise<string> {
  const userId = uuidv7()
  const email = `agent-${userId}@${AGENT_EMAIL_DOMAIN}`
  await db.insert(user).values({
    id: userId,
    email,
    name: input.label?.trim() || 'Agent',
    emailVerified: true,
  })
  await db.insert(member).values({
    id: uuidv7(),
    organizationId: input.orgId,
    userId,
    role: input.role,
  })
  return userId
}

// Mint the credential.
//
// The 4th argument is load-bearing. internalAdapter.createSession writes its own
// `expiresAt` AFTER spreading the override, so a 3-argument call silently gets
// the default 7-day expiry; only `overrideAll` re-applies the override last.
// (The existing 3-argument calls in widget/auth/exchange.post.ts and sso/jwt.get.ts
// are correct as they stand — `ssoOrgId` is not one of the clobbered fields.)
//
// A far expiry also stops better-auth's rolling refresh from ever firing: the
// refresh is due only within `updateAge` of the end, so the row is never
// rewritten and the token string never changes.
export async function mintAgentSession(
  userId: string,
  expiresAt: Date,
): Promise<{ id: string; token: string }> {
  const ctx = await auth.$context
  const row = await ctx.internalAdapter.createSession(userId, false, { expiresAt }, true)
  if (!row?.token) {
    throw createError({ statusCode: 500, message: 'Failed to mint agent session' })
  }
  return { id: row.id, token: row.token }
}

export function agentTokenPrefix(token: string): string {
  return token.slice(0, AGENT_TOKEN_PREFIX_LENGTH)
}

// Revoke = delete the session row, then the bookkeeping row. Deleting the
// session is what actually ends access, and it takes effect on the very next
// request: a bearer client sends no cookie, so the 60s session cookie cache
// never applies to it and every request does a live lookup.
//
// The robot `user` row is left behind on purpose — its comments and status
// changes keep a valid author. Removing the identity entirely is the Members
// page's job, and cascades this table.
export async function revokeAgentToken(
  db: ReturnType<typeof useDB>,
  input: { id: string; orgId: string },
): Promise<boolean> {
  const [row] = await db
    .select({ id: agentToken.id, sessionId: agentToken.sessionId })
    .from(agentToken)
    .where(and(eq(agentToken.id, input.id), eq(agentToken.orgId, input.orgId)))
    .limit(1)
  if (!row) return false
  await db.delete(sessionTable).where(eq(sessionTable.id, row.sessionId))
  await db.delete(agentToken).where(eq(agentToken.id, row.id))
  return true
}
