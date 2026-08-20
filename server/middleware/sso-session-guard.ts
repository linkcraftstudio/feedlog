// Blocks identity elevation on sessions that were never proven to belong to a
// person: product-SSO sessions and guest (no sign-in) sessions.
//
// An SSO session asserts an org-provided email that FeedLog never verified, so
// it must not set/change a password, change email, edit profile, or bind a
// login method — any of which would turn a borrowed email into a fully-owned
// account. A guest session is the same problem one step further along: its email
// is a placeholder nobody vouched for, so changing it would hand the guest an
// address they never proved they own, ready for a later real login to link onto.
//
// Neither may reach org-management or admin endpoints: better-auth's organization
// plugin enforces permission off the member table, and its admin plugin off
// user.role — both bypass our requireOrg* gates and the host-binding collar, so
// an SSO session whose email matches an owner/admin could otherwise drive them.
// Blocking the /api/auth/organization/ and /api/auth/admin/ prefixes wholesale
// stays robust as better-auth adds endpoints.
//
// Keyed on session.ssoOrgId / user.isAnonymous, NOT user.emailVerified: the
// latter is global and a separate verified login could flip it true for an SSO
// session to ride on. `auth` is auto-imported.

const BLOCKED_AUTH_ENDPOINTS = new Set([
  'set-password',
  'change-password',
  'change-email',
  'update-user',
  'delete-user',
  'link-social',
  'unlink-account',
])

function isBlockedPath(path: string): boolean {
  if (!path.startsWith('/api/auth/')) return false
  const rest = path.slice('/api/auth/'.length)
  if (rest.startsWith('organization/') || rest.startsWith('admin/')) return true
  const suffix = rest.split(/[?/]/)[0]
  return !!suffix && BLOCKED_AUTH_ENDPOINTS.has(suffix)
}

export default defineEventHandler(async (event) => {
  if (!isBlockedPath(event.path)) return

  const session = await auth.api.getSession({ headers: event.headers })
  const ssoOrgId = (session?.session as { ssoOrgId?: string | null } | undefined)?.ssoOrgId
  const isGuest = !!(session?.user as { isAnonymous?: boolean | null } | undefined)?.isAnonymous
  if (ssoOrgId || isGuest) {
    throw createError({
      statusCode: 403,
      message: 'This session cannot manage credentials, profile, or organization',
    })
  }
})
