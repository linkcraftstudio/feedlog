import type { ComputedRef } from 'vue'

export interface DashboardNavItem {
  label: string
  to: string
  icon: string
}

export interface DashboardNav {
  mainNav: ComputedRef<DashboardNavItem[]>
  settingsNav: ComputedRef<DashboardNavItem[]>
  // Advanced / integration surfaces. Rendered as a separate, collapsed-by-default
  // section so it doesn't crowd the everyday Settings items.
  developerNav: ComputedRef<DashboardNavItem[]>
}

export function useDashboardNav(): DashboardNav {
  const { t } = useI18n()
  return {
    mainNav: computed(() => [
      { label: t('nav.feedback'),  to: '/dashboard/feedback',  icon: 'lucide:message-square' },
      { label: t('nav.roadmap'),   to: '/dashboard/roadmap',   icon: 'lucide:map' },
      { label: t('nav.changelog'), to: '/dashboard/changelog', icon: 'lucide:newspaper' },
    ]),
    settingsNav: computed(() => [
      { label: t('nav.board'),     to: '/dashboard/boards',              icon: 'lucide:settings-2' },
      // Round chat bubble: matches the launcher visitors actually see, and stays
      // distinct from Feedback's square one.
      { label: t('nav.widget'),    to: '/dashboard/settings/widget',     icon: 'lucide:message-circle' },
      { label: t('nav.members'),   to: '/dashboard/settings/members',    icon: 'lucide:users' },
      { label: t('nav.portal'),    to: '/dashboard/settings/portal',     icon: 'lucide:layout-template' },
      { label: t('nav.workspace'), to: '/dashboard/settings/workspace',  icon: 'lucide:building-2' },
    ]),
    developerNav: computed(() => [
      { label: t('nav.sso'), to: '/dashboard/developer/sso', icon: 'lucide:key-round' },
      { label: t('nav.agentTokens'), to: '/dashboard/developer/agent-tokens', icon: 'lucide:bot' },
    ]),
  }
}
