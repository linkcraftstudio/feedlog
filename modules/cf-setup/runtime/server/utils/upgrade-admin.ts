// Who may run upgrade migrations: a global admin, or an email in SYSTEM_ADMIN_EMAILS.
export function isUpgradeAdmin(user: { role?: string | null, email?: string | null } | null | undefined, allowlist: readonly string[]): boolean {
  return user?.role === 'admin' || (!!user?.email && allowlist.includes(user.email))
}
