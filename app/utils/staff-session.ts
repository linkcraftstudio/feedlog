// The same rule as the dashboard gate (app/middleware/admin.ts): staff is a
// user with one or more organizations. A guest or a customer SSO session is not.
export function hasStaffAccess(session: { user?: unknown, orgList?: readonly unknown[] } | null | undefined): boolean {
  return !!session?.user && !!session.orgList?.length
}

// Dashboard and invitation pages open the sign-in form where they are, so a
// staff sign-in and an invitation keep their page.
export function signsInInPlace(path: string): boolean {
  return /^(?:\/(?:en|zh))?\/(?:dashboard|invite)(?:\/|$)/.test(path)
}
