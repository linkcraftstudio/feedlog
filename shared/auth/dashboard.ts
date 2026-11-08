export interface DashboardAccess {
  member: boolean
  inbox: boolean
  moderate: boolean
  owner: boolean
}

// Match pages whose read endpoints are restricted. Read-only settings remain accessible.
export function canVisitDashboard(path: string, access: DashboardAccess) {
  const route = path.replace(/\/$/, '')
  if (!access.member) return false
  if (route === '/dashboard/inbox' || route.startsWith('/dashboard/inbox/')) return access.inbox
  if (route === '/dashboard/settings/widget') return access.moderate
  if (route === '/dashboard/developer/sso') return access.owner
  if (['/dashboard/help/new', '/dashboard/changelog/new'].includes(route)) return access.moderate
  return true
}

export function dashboardEntry(access: DashboardAccess) {
  return ['/dashboard/inbox', '/dashboard/feedback', '/dashboard/roadmap', '/dashboard/changelog', '/dashboard/help']
    .find(path => canVisitDashboard(path, access)) ?? '/'
}
