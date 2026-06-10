export interface DashboardNavItem {
  label: string
  to: string
  icon: string
}

export interface DashboardNav {
  mainNav: DashboardNavItem[]
  settingsNav: DashboardNavItem[]
  // Advanced / integration surfaces. Rendered as a separate, collapsed-by-default
  // section so it doesn't crowd the everyday Settings items.
  developerNav: DashboardNavItem[]
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
      { label: 'Portal',    to: '/dashboard/settings/portal',     icon: 'lucide:layout-template' },
      { label: 'Workspace', to: '/dashboard/settings/workspace',  icon: 'lucide:building-2' },
    ],
    developerNav: [
      { label: 'Single Sign-On', to: '/dashboard/developer/sso', icon: 'lucide:key-round' },
    ],
  }
}
