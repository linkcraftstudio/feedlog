import type { H3Event } from 'h3'
import { getRequestURL } from 'h3'
import { jwtVerify } from 'jose'
import { eq } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import { user } from '#layers/feedlog/server/db/schemas'

// Product-SSO helpers: verify the customer-signed HS256 JWT, resolve the
// asserted identity to a user row, guard the return_to target against open
// redirects, and produce the signed session cookie value.

// exp is required on every token. We reject tokens whose exp is more than this
// far in the future — a leaked pre-signed token stays usable only this long.
// Replay severity is already capped by the ssoOrgId session collar, so the TTL
// governs probability, not blast radius.
const MAX_TTL_SECONDS = 24 * 60 * 60
const CLOCK_TOLERANCE_SECONDS = 60

export interface SsoIdentity {
  email: string
  name: string
  image: string | null
}

// Verify against every enabled secret until one matches (no `kid` needed on the
// customer side). jose's jwtVerify already enforces exp with clock tolerance;
// we add the hard upper bound on how far exp may sit in the future.
export async function verifySsoJwt(token: string, secrets: string[]): Promise<SsoIdentity> {
  const enc = new TextEncoder()
  let payload: Record<string, unknown> | null = null
  for (const secret of secrets) {
    try {
      const res = await jwtVerify(token, enc.encode(secret), {
        algorithms: ['HS256'],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      })
      payload = res.payload as Record<string, unknown>
      break
    }
    catch {
      // Signature/exp mismatch — try the next enabled secret.
    }
  }
  if (!payload) {
    throw createError({ statusCode: 400, message: 'Invalid or expired SSO token' })
  }

  const exp = payload.exp
  if (typeof exp !== 'number') {
    throw createError({ statusCode: 400, message: 'SSO token must carry an exp claim' })
  }
  const now = Math.floor(Date.now() / 1000)
  if (exp - now > MAX_TTL_SECONDS + CLOCK_TOLERANCE_SECONDS) {
    throw createError({ statusCode: 400, message: 'SSO token exp is too far in the future' })
  }

  // email is the identity key — hard-required. name backs a NOT NULL
  // column; fall back to the email when the org omits it. All other claims are
  // ignored (no custom-field mechanism).
  const email = payload.email
  if (typeof email !== 'string' || !email.includes('@')) {
    throw createError({ statusCode: 400, message: 'SSO token must carry a valid email claim' })
  }
  const normalizedEmail = email.trim().toLowerCase()
  const name = typeof payload.name === 'string' && payload.name.trim()
    ? payload.name.trim()
    : normalizedEmail
  const image = typeof payload.picture === 'string' && payload.picture
    ? payload.picture
    : null

  return { email: normalizedEmail, name, image }
}

// Identity key = email. emailVerified=true so a later verified Google/password
// login can be linked onto this row instead of being rejected and locking the
// email out. ON CONFLICT keeps concurrent first-touch requests for the same
// email from racing on the unique email constraint.
//
// Insert-only: an existing row is reused as-is, never updated. The `user` row is
// global (one per email across all orgs) and this runs before the session's
// host-binding collar exists — updating name/image here would let an org
// overwrite a user's global profile from outside its own board.
export async function findOrCreateSsoUser(db: ReturnType<typeof useDB>, identity: SsoIdentity): Promise<string> {
  const existing = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, identity.email))
    .limit(1)
  if (existing[0]) return existing[0].id

  await db.insert(user)
    .values({
      id: uuidv7(),
      email: identity.email,
      name: identity.name,
      image: identity.image,
      emailVerified: true,
    })
    .onConflictDoNothing({ target: user.email })

  const row = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, identity.email))
    .limit(1)
  if (!row[0]) {
    throw createError({ statusCode: 500, message: 'Failed to resolve SSO user' })
  }
  return row[0].id
}

// Open-redirect guard for return_to. Allows only a same-host relative path
// or a same-host absolute URL; everything else falls back to "/". Rejects
// protocol-relative ("//evil.com") and backslash tricks before parsing.
export function validateReturnTo(event: H3Event, returnTo: string | undefined | null): string {
  if (!returnTo) return '/'
  if (returnTo.includes('\\') || returnTo.startsWith('//')) return '/'
  const reqUrl = getRequestURL(event)
  try {
    const url = new URL(returnTo, reqUrl.origin)
    if (url.host !== reqUrl.host) return '/'
    return url.pathname + url.search + url.hash
  }
  catch {
    return '/'
  }
}

// A raw signing secret: 32 random bytes (256 bits) as hex, no prefix.
// crypto.getRandomValues is edge-safe (CF Workers / Vercel / Node).
export function generateSsoSecret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0')
  return hex
}

export interface SsoSecretView {
  id: string
  label: string | null
  secret: string
  enabled: boolean
  createdAt: string
}

// secret is included (plaintext, recoverable) so the dashboard row can
// re-reveal it — see schemas/sso.ts.
export function ssoSecretToView(row: {
  id: string
  label: string | null
  secret: string
  enabled: boolean
  createdAt: Date | string
}): SsoSecretView {
  return {
    id: row.id,
    label: row.label,
    secret: row.secret,
    enabled: row.enabled,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  }
}

// Reproduce better-call's signed-cookie value: `${token}.${base64(HMAC-SHA256)}`.
// We return it UN-encoded — h3's setCookie (cookie-es) URL-encodes the value
// exactly once on the way out, matching better-call byte-for-byte. WebCrypto so
// this runs on CF Workers / edge as well as Node.
export async function signSessionCookieValue(token: string, secret: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(token))
  const bytes = new Uint8Array(sig)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return `${token}.${btoa(bin)}`
}
