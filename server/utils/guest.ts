import type { H3Event } from 'h3'
import type { GuestAction, ResolvedGuestAccess } from '../../shared/utils/guest'
import { resolveGuestAccess } from '../../shared/utils/guest'

// Server-side half of the guest (no sign-in) switches. `getOrgInfo` and
// `createError` are auto-imported by Nitro.

// `{ user: object }` rather than a shape naming isAnonymous: the plugin declares
// that field through its own schema, which better-auth's inferred session type
// does not carry — the same reason ssoOrgId is read through a cast elsewhere.
export function isGuestSession(session: { user: object }): boolean {
  return !!(session.user as { isAnonymous?: boolean | null }).isAnonymous
}

export async function getGuestAccess(event: H3Event): Promise<ResolvedGuestAccess> {
  const slug = event.context.orgSlug
  const info = slug ? await getOrgInfo(slug) : null
  return resolveGuestAccess(info?.metadata)
}

const DENIAL: Record<GuestAction, string> = {
  allowPost: 'Sign in to submit feedback',
  allowVote: 'Sign in to vote',
  allowComment: 'Sign in to comment',
}

// Gate one write behind the org's guest switches. A no-op for anyone signed in —
// the switches only ever narrow what a guest may do, never a member.
//
// 403 with a stable message so the portal can turn a refusal into the sign-in
// prompt rather than a generic failure toast.
export async function assertGuestMay(
  event: H3Event,
  session: { user: object },
  action: GuestAction,
): Promise<void> {
  if (!isGuestSession(session)) return
  const access = await getGuestAccess(event)
  if (!access[action]) {
    throw createError({ statusCode: 403, message: DENIAL[action] })
  }
}
