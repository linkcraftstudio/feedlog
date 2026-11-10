import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin, anonymous, bearer, customSession, organization } from 'better-auth/plugins'
import { defu } from 'defu'
import { and, eq, sql } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import { db } from '../db'
import { member, organization as orgTable, user as userTable } from '../db/schemas'
import { ac, contributor, manager, owner } from '../../shared/auth/permissions'
import { DEFAULT_ORG_ID } from '../../shared/constants/default-org'
import { GUEST_EMAIL_DOMAIN } from '../../shared/utils/guest'
import { guestTag } from '../../shared/utils/identity'
import { hashPassword, verifyPassword } from './password-hash'
import { consola } from 'consola'
import { mcpAuthPlugins } from '../mcp/auth-plugins'
import { mcpEnabled, type mcpConfig } from '../mcp/config'
import { cleanupMemberMcpAccess, cleanupOrganizationMcpAccess, cleanupUserMcpAccess } from '../mcp/grants'

const logger = consola.withTag('auth')

const env = process.env

export const systemAdminEmails = env.SYSTEM_ADMIN_EMAILS?.split(',').map(s => s.trim()).filter(Boolean) ?? []

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

// First OAuth signup still copies name / avatar from the provider. Later
// callbacks must not overwrite them: users can edit both in-app, and a re-login
// would otherwise discard those edits.
const socialProviders: Record<string, {
  clientId: string
  clientSecret: string
  overrideUserInfoOnSignIn: boolean
}> = {}
if (hasGoogle) {
  socialProviders.google = {
    clientId: env.GOOGLE_CLIENT_ID!,
    clientSecret: env.GOOGLE_CLIENT_SECRET!,
    overrideUserInfoOnSignIn: false,
  }
}
if (hasGithub) {
  socialProviders.github = {
    clientId: env.GITHUB_CLIENT_ID!,
    clientSecret: env.GITHUB_CLIENT_SECRET!,
    overrideUserInfoOnSignIn: false,
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
// changes is acceptable.
//
// `confineToOrgId` exists for product-SSO sessions: the asserting org signs
// whatever email it likes, so an unfiltered list would answer "which other orgs
// does this person belong to, and as what?" for any address it cares to guess.
async function loadOrgList(userId: string, confineToOrgId?: string | null) {
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
    .where(
      confineToOrgId
        ? and(eq(member.userId, userId), eq(member.organizationId, confineToOrgId))
        : eq(member.userId, userId),
    )
  return rows
}

// Bootstrap hook: any email listed in SYSTEM_ADMIN_EMAILS is auto-enrolled
// as owner of the default org on signup.
//
// We intentionally do NOT auto-accept pending invitations on registration:
// invited users sign in and click Accept on /invite?id=... themselves.
async function bootstrapAfterUserCreate(newUser: { id: string; email: string }) {
  if (!systemAdminEmails.includes(newUser.email)) return
  // default-org comes from a migration, so the first owner joining is the
  // install's "new organization" moment. Later admins and upgraded installs
  // with an owner already in place get no sample data.
  const [existingOwner] = await db.select({ id: member.id }).from(member)
    .where(and(eq(member.organizationId, DEFAULT_ORG_ID), sql`'owner' = ANY(string_to_array(${member.role}, ','))`)).limit(1)
  const inserted = await db.insert(member).values({
    id: uuidv7(),
    organizationId: DEFAULT_ORG_ID,
    userId: newUser.id,
    role: 'owner',
  }).onConflictDoNothing().returning({ id: member.id })
  if (existingOwner || !inserted.length) return
  const { seedOnboarding } = await import('../lib/onboarding/seed')
  await seedOnboarding({ orgId: DEFAULT_ORG_ID, ownerId: newUser.id })
}

// The plugin picks the name before the row exists, so the id-derived tag can only
// be written once it does. One extra UPDATE, on a path that runs at most once per
// guest — worth it so the dashboard and a raw DB query can tell two guests apart
// without composing the tag themselves.
async function nameGuestUser(userId: string) {
  await db.update(userTable)
    .set({ name: `Anonymous ${guestTag(userId)}` })
    .where(eq(userTable.id, userId))
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

// Trusts the request's own Host, per-request — keeps sign-up zero-config
// without baseURL getting stuck on whichever host asked first.
export function defaultTrustedOrigins(request?: Request): string[] {
  const host = request?.headers.get('host')
  return host ? [`http://${host}`, `https://${host}`] : []
}

export function buildAuthConfig(overrides: AuthConfigOverrides = {}): BetterAuthOptions {
  type SendInvite = NonNullable<NonNullable<Parameters<typeof organization>[0]>['sendInvitationEmail']>
  // Default invite email: `${BETTER_AUTH_URL}/invite?id=...`. No-op when Resend isn't
  // configured; the Members page "copy invitation link" button is the manual fallback.
  const layerDefaultSendInvite: SendInvite = async (data) => {
    if (!hasEmailProvider) return
    const baseUrl = env.BETTER_AUTH_URL || 'http://localhost:3000'
    const url = `${baseUrl}/invite?id=${data.id}`
    await sendEmail({
      to: data.email,
      subject: `You're invited to join ${data.organization.name} on FeedLog`,
      html: renderInvitationEmail({ url, orgName: data.organization.name }),
    })
  }
  const rawSendInvite: SendInvite = overrides.organizationExtras?.sendInvitationEmail ?? layerDefaultSendInvite
  const sendInvitationEmail: SendInvite = async (data, request) => {
    try {
      await rawSendInvite(data, request)
    }
    catch (e) {
      logger.warn(`Invitation email failed for ${data.email}: ${(e as Error)?.message ?? e}`)
    }
  }
  const orgOpts: NonNullable<Parameters<typeof organization>[0]> = {
    ac,
    roles: { owner, manager, contributor },
    creatorRole: 'owner' as const,
    invitationExpiresIn: 7 * 24 * 60 * 60,
    ...overrides.organizationExtras,
    // After the spread so our best-effort wrapper wins over an override's own
    // sender (it already delegates to that override via rawSendInvite).
    sendInvitationEmail,
    organizationHooks: {
      ...overrides.organizationExtras?.organizationHooks,
      afterRemoveMember: async (data) => {
        await cleanupMemberMcpAccess(data.member.id, data.user.id)
        await overrides.organizationExtras?.organizationHooks?.afterRemoveMember?.(data)
      },
      afterDeleteOrganization: async (data, context) => {
        await cleanupOrganizationMcpAccess(data.organization.id, data.user.id)
        await overrides.organizationExtras?.organizationHooks?.afterDeleteOrganization?.(data, context)
      },
    },
  }
  const mergedSocial = defu(overrides.socialProviderOverrides ?? {}, socialProviders) as typeof socialProviders
  // Guests short-circuit ahead of the override so a deployment that swaps in its
  // own bootstrap still gets them named — and never runs
  // org-membership bootstrap for an identity that can't be a member.
  const bootstrap = overrides.userCreateAfter ?? bootstrapAfterUserCreate
  const afterUserCreate = async (newUser: { id: string; email: string; isAnonymous?: boolean | null }) => {
    if (newUser.isAnonymous) {
      await nameGuestUser(newUser.id)
      return
    }
    await bootstrap(newUser)
  }
  return {
    database: drizzleAdapter(db, { provider: 'pg' }),
    emailAndPassword,
    ...(emailVerification && { emailVerification }),
    socialProviders: mergedSocial,
    trustedOrigins: overrides.trustedOrigins ?? defaultTrustedOrigins,
    ...(overrides.account && { account: overrides.account }),
    plugins: [
      // The widget runs in a cross-site iframe where the session cookie is
      // unreliable (third-party cookie blocking), so endpoints must also accept
      // `Authorization: Bearer <session token>`. Opt-in per request — cookie
      // flows are unaffected.
      //
      // requireSignature stays off: the widget gets the RAW session token (see
      // /api/widget/auth/exchange), and the plugin signs it itself with
      // base64urlnopad HMAC, which a standard-base64 cookie value would not match.
      bearer(),
      admin(),
      anonymous({
        // Reserved by RFC 2606 — nobody can ever register it, so a stray email
        // aimed at a guest can't land in someone's real inbox.
        generateRandomEmail: () => `anon-${uuidv7()}@${GUEST_EMAIL_DOMAIN}`,
        // Posts, votes and comments point at the guest's user id with no foreign
        // key back to `user`, so the plugin's delete-on-sign-in would leave them
        // pointing at a row that no longer exists. Claiming moves the content
        // across and drops the row itself.
        disableDeleteAnonymousUser: true,
      }),
      organization(orgOpts),
      customSession(async ({ user, session }) => {
        const ssoOrgId = (session as { ssoOrgId?: string | null }).ssoOrgId
        const orgList = await loadOrgList(user.id, ssoOrgId)
        return { user, session, orgList }
      }),
      ...(overrides.extraPlugins ?? []),
    ],
    session: {
      additionalFields: {
        // Product-SSO marker (see schemas/auth.ts session.ssoOrgId). Written by
        // the /api/sso/jwt endpoint via internalAdapter.createSession override.
        // input:false — clients can't forge it through the API; returned:true —
        // surfaced in getSession so the UI can gate credential controls.
        ssoOrgId: { type: 'string', required: false, input: false, returned: true },
      },
      cookieCache: { enabled: true, maxAge: 60 },
    },
    databaseHooks: {
      user: {
        create: {
          after: afterUserCreate,
        },
        delete: {
          before: async (deletedUser, context) => {
            await cleanupUserMcpAccess(deletedUser.id, context?.context.session?.user.id ?? deletedUser.id)
          },
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

// Keep the OAuth issuer independent of ordinary web auth host switching.
const mcpInstances = new Map<string, ReturnType<typeof createMcpAuth>>()
function createMcpAuth(config: ReturnType<typeof mcpConfig>) {
  const base = buildAuthConfig(_registeredOverrides ?? {})
  return betterAuth({
    ...base,
    baseURL: config.origin,
    // Organization scope and audit must change through the application management API.
    disabledPaths: [...(base.disabledPaths ?? []), '/oauth2/delete-consent', '/oauth2/update-consent'],
    trustedOrigins: [config.origin],
    plugins: [...(base.plugins ?? []), ...mcpAuthPlugins(config)],
    session: { ...base.session, cookieCache: { enabled: false } },
  })
}

export function getMcpAuth(config: ReturnType<typeof mcpConfig>) {
  let instance = mcpInstances.get(config.origin)
  if (!instance) {
    instance = createMcpAuth(config)
    // Self-hosted installations may expose aliases; do not retain unbounded host keys.
    if (mcpInstances.size >= 16) mcpInstances.delete(mcpInstances.keys().next().value!)
    mcpInstances.set(config.origin, instance)
  }
  return instance
}

export const authConfig = {
  mcp: mcpEnabled(),
  google: hasGoogle,
  github: hasGithub,
  email: emailLoginEnabled,
  emailVerification: !!emailVerification,
  // True when an outbound email provider (Resend) is configured. Surfaced
  // so the invite modal can warn admins when invites will be created but
  // not delivered, and they must copy the link manually.
  emailProvider: hasEmailProvider,
}
