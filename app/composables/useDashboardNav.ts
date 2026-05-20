export interface DashboardNavItem {
  label: string
  to: string
  icon: string
}

export interface DashboardNav {
  mainNav: DashboardNavItem[]
  settingsNav: DashboardNavItem[]
}

export function useDashboardNav(): DashboardNav {
  return {
    mainNav: [
      { label: 'Feedback',  to: '/dashboard/feedback',  icon: 'lucide:message-square' },
      { label: 'Roadmap',   to: '/dashboard/roadmap',   icon: 'lucide:map' },
      { label: 'Changelog', to: '/dashboard/changelog', icon: 'lucide:newspaper' },
    ],
    settingsNav: [
      { label: 'Board',     to: '/dashboard/boards',              icon: 'lucide:settings-2' },
      { label: 'Members',   to: '/dashboard/settings/members',    icon: 'lucide:users' },
      { label: 'Workspace', to: '/dashboard/settings/workspace',  icon: 'lucide:building-2' },
    ],
  }
}
