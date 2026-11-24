import type { ComputedRef } from 'vue'

export interface DashboardNavItem {
  label: string
  to: string
  icon: string
}

export interface DashboardNav {
  mainNav: ComputedRef<DashboardNavItem[]>
  aiNav: ComputedRef<DashboardNavItem[]>
  personalNav: ComputedRef<DashboardNavItem[]>
  productNav: ComputedRef<DashboardNavItem[]>
  settingsNav: ComputedRef<DashboardNavItem[]>
}

export function useDashboardNav(): DashboardNav {
  const { t } = useI18n()
  const { data: authConfig } = useFetch('/api/auth-config', { key: 'dashboard-auth-config' })
  const org = useOrgContext()
  return {
    mainNav: computed(() => [
      { label: t('inbox.title'), to: '/dashboard/inbox', icon: 'lucide:inbox' },
      { label: t('nav.feedback'),  to: '/dashboard/feedback',  icon: 'lucide:message-square' },
      { label: t('dashboard.agent.title'), to: '/dashboard/ai-agent', icon: 'lucide:sparkles' },
      { label: t('nav.roadmap'),   to: '/dashboard/roadmap',   icon: 'lucide:map' },
      { label: t('nav.changelog'), to: '/dashboard/changelog', icon: 'lucide:newspaper' },
      { label: t('nav.helpCenter'), to: '/dashboard/help', icon: 'lucide:book-open' },
    ]),
    aiNav: computed(() => [
      { label: t('dashboard.agent.training'), to: '/dashboard/ai-agent', icon: 'lucide:database' },
      { label: t('dashboard.agent.chat'), to: '/dashboard/ai-agent/chat', icon: 'lucide:settings-2' },
      { label: t('dashboard.agent.deploy'), to: '/dashboard/ai-agent/deploy', icon: 'lucide:rocket' },
    ]),
    personalNav: computed(() => [
      { label: t('settings.personal.profile'), to: '/dashboard/settings/profile', icon: 'lucide:user-round' },
      { label: t('settings.personal.notifications'), to: '/dashboard/settings/personal', icon: 'lucide:bell' },
    ]),
    productNav: computed(() => [
      { label: t('dashboard.nav.portalSettings'), to: '/dashboard/settings/portal', icon: 'lucide:layout-template' },
      { label: t('dashboard.boards.title'), to: '/dashboard/boards', icon: 'lucide:settings-2' },
    ]),
    settingsNav: computed(() => [
      { label: t('nav.workspace'), to: '/dashboard/settings/workspace', icon: 'lucide:building-2' },
      { label: t('nav.members'), to: '/dashboard/members', icon: 'lucide:users' },
      { label: t('dashboard.nav.ssoSettings'), to: '/dashboard/developer/sso', icon: 'lucide:key-round' },
      ...(authConfig.value?.mcp && ['owner', 'manager', 'contributor'].includes(org.value.role ?? '')
        ? [{ label: t('dashboard.nav.mcpConnections'), to: '/dashboard/mcp', icon: 'lucide:plug' }]
        : []),
    ]),
  }
}
