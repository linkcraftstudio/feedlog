import { z } from 'zod/v4'
import type { ClaimedCounts } from '#layers/feedlog/server/utils/guest-claim'

// POST /api/auth/claim-anonymous — fold a guest identity into the account that
// just signed in, so nothing written before the sign-in is lost.
//
// Two credentials, deliberately: the Authorization header / cookie says who is
// receiving the content, and the body says which guest is handing it over. Both
// have to be held by the same browser for the call to do anything.
//
// Portal and widget share this route; the only difference is how the receiving
// identity travels (cookie vs bearer), which better-auth already normalises.
//
// Not a better-auth route despite the path — the plugin's own onLinkAccount hook
// fires on a fixed list of sign-in paths and depends on the anonymous session
// still being in a cookie, neither of which holds for the widget.
const RATE_LIMIT = { limit: 10, windowSeconds: 60 }

// Body, not query: a query string lands in access logs and Referer headers, and
// this value is a live session token until the moment the claim consumes it.
const claimSchema = z.object({
  anonymousToken: z.string().min(1),
})

interface ClaimResponse {
  claimed: boolean
  reason?: 'expired-or-already-claimed' | 'same-user'
  moved?: ClaimedCounts
}

export default defineEventHandler(async (event): Promise<ClaimResponse> => {
  const { session: target } = await requireAuthInOrg(event)
  if (isGuestSession(target)) {
    throw createError({ statusCode: 400, message: 'Sign in before claiming guest content' })
  }

  const ip = getRequestIP(event, { xForwardedFor: true }) || 'unknown'
  if (!await checkRateLimit(`claim-anonymous:${ip}`, RATE_LIMIT)) {
    throw createError({ statusCode: 429, message: 'Too many claims, try again shortly' })
  }

  const { anonymousToken } = await readValidatedBody(event, claimSchema.parse)

  const anon = await auth.api.getSession({
    headers: new Headers({ Authorization: `Bearer ${anonymousToken}` }),
  })
  // A stale token in localStorage is the normal case on a second sign-in, not an
  // error — the client clears it and stops asking.
  if (!anon) {
    return { claimed: false, reason: 'expired-or-already-claimed' }
  }
  if (!isGuestSession(anon)) {
    throw createError({ statusCode: 403, message: 'Only a guest identity can be claimed' })
  }
  if (anon.user.id === target.user.id) {
    return { claimed: false, reason: 'same-user' }
  }

  const moved = await claimGuestContent(anon.user.id, target.user.id)
  return { claimed: true, moved }
})
