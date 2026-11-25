import { shallowRef } from 'vue'

// Workspace-wide notices shown in one bar at the top of the dashboard. Deployments (and FeedLog itself) register
// sources: functions that read reactive state and return the notices that apply right now. The bar shows only the
// highest-priority notice that has not been dismissed, so a state change is all it takes to show or hide one.

export interface DashboardNoticeAction {
  label: string
  variant?: 'primary' | 'secondary'
  onClick: () => void
}

export interface DashboardNotice {
  /** Stable while the notice says the same thing. Put the stage in it (e.g. `trial:<id>:ending`) so a new stage shows again after a dismissal. */
  id: string
  level: 'info' | 'warning' | 'danger'
  icon?: string
  text: string
  actions?: DashboardNoticeAction[]
  /** Higher shows first. */
  priority: number
  /** How long a dismissal hides the notice, in milliseconds. Default 7 days; urgent notices use less. */
  dismissFor?: number
}

export type DashboardNoticeSource = () => DashboardNotice[]

export const DEFAULT_NOTICE_DISMISS_MS = 7 * 86_400_000

// Sources are registered by client plugins, before any dashboard renders.
const sources = shallowRef<DashboardNoticeSource[]>([])

export function registerDashboardNotices(source: DashboardNoticeSource): void {
  sources.value = [...sources.value, source]
}

export function dashboardNoticeSources(): DashboardNoticeSource[] {
  return sources.value
}
