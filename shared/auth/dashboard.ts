export interface DashboardAccess {
  member: boolean
  inbox: boolean
  moderate: boolean
  owner: boolean
}

const DASHBOARD_PATH = /^\/(?:en\/|zh\/)?dashboard(?:\/|$)/

// Only dashboard paths from this origin may survive the public login handoff.
// Keeping this pure lets middleware and the public layout share the same rule.
export function resolveDashboardReturn(value: unknown, fallback = '/dashboard') {
  if (typeof value !== 'string') return fallback
  try {
    const base = new URL('https://feedlog.invalid')
    const destination = new URL(value, base)
    if (destination.origin !== base.origin || !DASHBOARD_PATH.test(destination.pathname)) return fallback
    return `${destination.pathname}${destination.search}${destination.hash}`
  }
  catch {
    return fallback
  }
}

export function dashboardLoginRedirect(destination: unknown, loginPath = '/') {
  return {
    path: loginPath,
    query: {
      dashboard_login: '1',
      dashboard_return: resolveDashboardReturn(destination),
    },
  }
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
