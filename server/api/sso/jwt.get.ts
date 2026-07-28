import { and, eq } from 'drizzle-orm'
import { organizationSso } from '#layers/feedlog/server/db/schemas'

// GET /api/sso/jwt — third-party product SSO entry (JWT handoff).
//
// The customer's backend pre-signs an HS256 JWT with one of this org's shared
// secrets and redirects the signed-in user here. The org is resolved from the
// host, so the whole flow stays same-domain — no cross-domain hop, hence no
// one-time-token handoff.
//
// `auth`, `useDB`, the sso helpers and h3 utils are auto-imported by Nitro.
export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  // Derive a safe return target up front — needed even on failure so the
  // friendly error page can continue on to the board afterwards.
  const returnTo = validateReturnTo(event, typeof query.return_to === 'string' ? query.return_to : undefined)

  try {
    const orgId = event.context.orgId
    if (!orgId) {
      throw createError({ statusCode: 404, message: 'Organization not found' })
    }

    const token = typeof query.jwt === 'string' ? query.jwt : ''
    if (!token) {
      throw createError({ statusCode: 400, message: 'Missing jwt parameter' })
    }

    const db = useDB()

    // Try every enabled secret for this org (no `kid` — see schemas/sso.ts).
    const secrets = await db
      .select({ secret: organizationSso.secret })
      .from(organizationSso)
      .where(and(eq(organizationSso.orgId, orgId), eq(organizationSso.enabled, true)))
    if (secrets.length === 0) {
      throw createError({ statusCode: 404, message: 'SSO is not configured for this organization' })
    }

    const identity = await verifySsoJwt(token, secrets.map(s => s.secret))
    const userId = await findOrCreateSsoUser(db, identity)

    // Mint the session and mark it with ssoOrgId. createSession persists the
    // override field because ssoOrgId carries no defaultValue (so the framework's
    // default-fields pass can't clobber it) — verified against better-auth 1.5.4.
    const ctx = await auth.$context
    const sessionRow = await ctx.internalAdapter.createSession(userId, false, { ssoOrgId: orgId })
    if (!sessionRow?.token) {
      throw createError({ statusCode: 500, message: 'Failed to create SSO session' })
    }

    // Set the better-auth signed session cookie ourselves. Host-only on purpose
    // (no domain attribute), so the SSO session stays bound to the exact host
    // that minted it and never widens to a parent domain.
    const cookie = ctx.authCookies.sessionToken
    const value = await signSessionCookieValue(sessionRow.token, ctx.secret)
    // better-auth's sameSite type allows capitalized variants ("Lax"); h3 wants
    // lowercase. Runtime default is "lax" — normalize to keep both happy.
    const rawSameSite = cookie.attributes.sameSite
    const sameSite = typeof rawSameSite === 'string'
      ? (rawSameSite.toLowerCase() as 'lax' | 'strict' | 'none')
      : rawSameSite
    setCookie(event, cookie.name, value, {
      httpOnly: cookie.attributes.httpOnly,
      sameSite,
      path: cookie.attributes.path ?? '/',
      secure: cookie.attributes.secure,
      maxAge: ctx.sessionConfig.expiresIn,
    })

    // Invalidate the cookie cache (session_data, possibly chunked). better-auth's
    // getSession returns the cached payload WITHOUT cross-checking session_token,
    // so a leftover cache from a prior login (e.g. an existing Google session on
    // this host) would otherwise win and mask the new SSO session for up to its
    // maxAge. Clearing it forces the next getSession to read the fresh session
    // from the DB (and re-cache it).
    //
    // The deletion must carry the cookie's own attributes — matching better-auth's
    // expireCookie. Under secure cookies the name is `__Secure-…`, and a browser
    // rejects any Set-Cookie for a `__Secure-`-prefixed name that omits Secure.
    const dataCookie = ctx.authCookies.sessionData
    const dataRawSameSite = dataCookie.attributes.sameSite
    const dataSameSite = typeof dataRawSameSite === 'string'
      ? (dataRawSameSite.toLowerCase() as 'lax' | 'strict' | 'none')
      : dataRawSameSite
    const dataDeleteOpts = {
      path: dataCookie.attributes.path ?? '/',
      secure: dataCookie.attributes.secure,
      httpOnly: dataCookie.attributes.httpOnly,
      sameSite: dataSameSite,
    }
    const dataCookieName = dataCookie.name
    for (const name of Object.keys(parseCookies(event))) {
      if (name === dataCookieName || name.startsWith(`${dataCookieName}.`)) {
        deleteCookie(event, name, dataDeleteOpts)
      }
    }

    return sendRedirect(event, returnTo, 302)
  }
  catch (err) {
    // The token comes from the customer's product, so a failure is the
    // integrator's problem, not the visitor's. Instead of a raw 400, send a
    // friendly interstitial (contact admin) that auto-continues to the board
    // logged out. Log the real reason server-side for the integrator to debug.
    console.warn('[sso] login failed:', (err as { statusMessage?: string })?.statusMessage ?? (err as Error)?.message)
    return sendRedirect(event, `/sso/error?return_to=${encodeURIComponent(returnTo)}`, 302)
  }
})
