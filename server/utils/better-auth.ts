import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin, customSession, organization } from 'better-auth/plugins'
import { defu } from 'defu'
import { eq } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import { db } from '../db'
import { member, organization as orgTable } from '../db/schemas'
import { ac, contributor, manager, owner } from '../../shared/auth/permissions'
import { DEFAULT_ORG_ID } from '../../shared/constants/default-org'
import { hashPassword, verifyPassword } from './password-hash'

const env = process.env

const systemAdminEmails = env.SYSTEM_ADMIN_EMAILS?.split(',').map(s => s.trim()).filter(Boolean) ?? []

const hasGoogle = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
const hasGithub = !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)
const hasOAuth = hasGoogle || hasGithub
const hasEmailProvider = !!env.RESEND_API_KEY

function parseBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())
}

const emailLoginEnabled = parseBool(env.AUTH_EMAIL_ENABLED) ?? !hasOAuth
const requireEmailVerification = parseBool(env.AUTH_EMAIL_VERIFY) ?? hasEmailProvider

if (!hasOAuth && !emailLoginEnabled) {
  throw new Error(
    '[auth] No sign-in method configured. Enable OAuth (GOOGLE_CLIENT_ID / GITHUB_CLIENT_ID) or set AUTH_EMAIL_ENABLED=true.',
  )
}

const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {}
if (hasGoogle) {
  socialProviders.google = {
    clientId: env.GOOGLE_CLIENT_ID!,
    clientSecret: env.GOOGLE_CLIENT_SECRET!,
  }
}
if (hasGithub) {
  socialProviders.github = {
    clientId: env.GITHUB_CLIENT_ID!,
    clientSecret: env.GITHUB_CLIENT_SECRET!,
  }
}

const emailAndPassword = emailLoginEnabled
  ? {
    enabled: true,
    requireEmailVerification,
    password: { hash: hashPassword, verify: verifyPassword },
    ...(hasEmailProvider && {
      sendResetPassword: async ({ user, url }: { user: { email: string; name: string }; url: string }) => {
        await sendEmail({
          to: user.email,
          subject: 'Reset your FeedLog password',
          html: renderResetPasswordEmail({ url, name: user.name }),
        })
      },
    }),
  }
  : { enabled: false }

const emailVerification = hasEmailProvider
  ? {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    expiresIn: 3600,
    sendVerificationEmail: async ({ user, url }: { user: { email: string; name: string }; url: string }) => {
      await sendEmail({
        to: user.email,
        subject: 'Confirm your email to start using FeedLog',
        html: renderVerificationEmail({ url, name: user.name }),
      })
    },
  }
  : undefined

// Build the orgList shape attached to every session via customSession plugin.
// Cookie cache (60s) keeps this off the DB hot path; ≤60s staleness on role
// changes is acceptable per tech.md §3.2.
async function loadOrgList(userId: string) {
  const rows = await db
    .select({
      orgId: orgTable.id,
      slug: orgTable.slug,
      name: orgTable.name,
      logo: orgTable.logo,
      role: member.role,
    })
    .from(member)
    .innerJoin(orgTable, eq(member.organizationId, orgTable.id))
    .where(eq(member.userId, userId))
  return rows
}

// Bootstrap hook: any email listed in SYSTEM_ADMIN_EMAILS is auto-enrolled
// as owner of the default org on signup.
//
// We intentionally do NOT auto-accept pending invitations on registration:
// invited users sign in and click Accept on /invite?id=... themselves.
async function bootstrapAfterUserCreate(newUser: { id: string; email: string }) {
  if (!systemAdminEmails.includes(newUser.email)) return
  await db.insert(member).values({
    id: uuidv7(),
    organizationId: DEFAULT_ORG_ID,
    userId: newUser.id,
    role: 'owner',
  }).onConflictDoNothing()
}

// Extension points for `buildAuthConfig` callers. Granular knobs beat
// trying to merge BetterAuthOptions wholesale — the organization plugin
// must be re-instantiated to take new options, plugin arrays can't simply
// be concatenated, and the user.create.after hook is a single function.
export interface AuthConfigOverrides {
  extraPlugins?: BetterAuthOptions['plugins']
  organizationExtras?: Partial<Parameters<typeof organization>[0]>
  socialProviderOverrides?: Record<string, Record<string, unknown>>
  userCreateAfter?: (user: { id: string; email: string }) => Promise<void> | void
  trustedOrigins?: BetterAuthOptions['trustedOrigins']
  account?: BetterAuthOptions['account']
}

export function buildAuthConfig(overrides: AuthConfigOverrides = {}): BetterAuthOptions {
  const orgOpts = {
    ac,
    roles: { owner, manager, contributor },
    creatorRole: 'owner' as const,
    invitationExpiresIn: 7 * 24 * 60 * 60,
    // Default invite email: `${BETTER_AUTH_URL}/invite?id=...`. No-op when
    // Resend isn't configured; the Members page "copy invitation link"
    // button is the manual fallback.
    sendInvitationEmail: async (data: {
      id: string
      email: string
      organization: { name: string }
    }) => {
      if (!hasEmailProvider) return
      const baseUrl = env.BETTER_AUTH_URL || 'http://localhost:3000'
      const url = `${baseUrl}/invite?id=${data.id}`
      await sendEmail({
        to: data.email,
        subject: `You're invited to join ${data.organization.name} on FeedLog`,
        html: renderInvitationEmail({ url, orgName: data.organization.name }),
      })
    },
    ...overrides.organizationExtras,
  }
  const mergedSocial = defu(overrides.socialProviderOverrides ?? {}, socialProviders) as typeof socialProviders
  return {
    database: drizzleAdapter(db, { provider: 'pg' }),
    emailAndPassword,
    ...(emailVerification && { emailVerification }),
    socialProviders: mergedSocial,
    ...(overrides.trustedOrigins && { trustedOrigins: overrides.trustedOrigins }),
    ...(overrides.account && { account: overrides.account }),
    plugins: [
      admin(),
      organization(orgOpts),
      customSession(async ({ user, session }) => {
        const orgList = await loadOrgList(user.id)
        return { user, session, orgList }
      }),
      ...(overrides.extraPlugins ?? []),
    ],
    session: {
      cookieCache: { enabled: true, maxAge: 60 },
    },
    databaseHooks: {
      user: {
        create: {
          after: overrides.userCreateAfter ?? bootstrapAfterUserCreate,
        },
      },
    },
  }
}

// Lazy-build the auth instance so a Nitro plugin can inject
// AuthConfigOverrides via `registerAuthOverrides()` before any request
// touches `auth`. The proxy below resolves to the cached singleton on
// first access — calling `registerAuthOverrides()` after that throws
// (the instance is already built and can't be safely rebuilt).
type AuthInstance = ReturnType<typeof betterAuth>

let _registeredOverrides: AuthConfigOverrides | null = null
let _authInstance: AuthInstance | null = null

export function registerAuthOverrides(overrides: AuthConfigOverrides): void {
  if (_authInstance) {
    throw new Error('[auth] registerAuthOverrides called after auth was already built')
  }
  _registeredOverrides = overrides
}

function getAuthInstance(): AuthInstance {
  if (!_authInstance) {
    _authInstance = betterAuth(buildAuthConfig(_registeredOverrides ?? {}))
  }
  return _authInstance
}

// Backward-compatible `auth` export. Proxy forwards every access to the lazy
// singleton so existing call sites (`auth.api.xxx`, `auth.handler` …) keep
// working unchanged.
export const auth = new Proxy({} as AuthInstance, {
  get(_, prop) {
    const target = getAuthInstance() as unknown as Record<PropertyKey, unknown>
    return target[prop]
  },
  has(_, prop) {
    return prop in (getAuthInstance() as object)
  },
})

export const authConfig = {
  google: hasGoogle,
  github: hasGithub,
  email: emailLoginEnabled,
  emailVerification: !!emailVerification,
  // True when an outbound email provider (Resend) is configured. Surfaced
  // so the invite modal can warn admins when invites will be created but
  // not delivered, and they must copy the link manually.
  emailProvider: hasEmailProvider,
}
