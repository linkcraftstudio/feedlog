import { CONVERSATION_RETENTION_DEFAULT_DAYS } from '../constants/conversation'
import {
  WIDGET_BUILTIN_RULES,
  WIDGET_BUILTIN_RULE_IDS,
  type WidgetCustomRule,
} from '../constants/widget-rules'

// Resolves an organization_widget row (or its absence) into the shape the admin
// UI renders and the AI prompt consumes. No row = all defaults (lazy creation).

export interface WidgetConfigRow {
  enabled: boolean
  supportEmail: string | null
  disabledBuiltins: string[]
  customRules: WidgetCustomRule[]
  conversationRetentionDays: number
}

// Both wordings travel to the client: the admin page shows whichever matches
// the dashboard locale, while `scenario` is what reaches the AI prompt.
export interface ResolvedBuiltinRule {
  id: string
  scenario: string
  scenarioZh: string
  enabled: boolean
}

export interface ResolvedWidgetSettings {
  enabled: boolean
  supportEmail: string | null
  conversationRetentionDays: number
  rules: {
    builtins: ResolvedBuiltinRule[]
    custom: WidgetCustomRule[]
  }
  enabledCount: number
}

export function countEnabledRules(disabledBuiltins: string[], customRules: WidgetCustomRule[]): number {
  const builtinsOn = WIDGET_BUILTIN_RULE_IDS.filter(id => !disabledBuiltins.includes(id)).length
  const customOn = customRules.filter(r => r.enabled).length
  return builtinsOn + customOn
}

export function resolveWidgetSettings(row: WidgetConfigRow | undefined | null): ResolvedWidgetSettings {
  const enabled = row?.enabled ?? true
  const supportEmail = row?.supportEmail ?? null
  const disabledBuiltins = row?.disabledBuiltins ?? []
  const customRules = row?.customRules ?? []

  const builtins: ResolvedBuiltinRule[] = WIDGET_BUILTIN_RULES.map(r => ({
    id: r.id,
    scenario: r.scenario,
    scenarioZh: r.scenarioZh,
    enabled: !disabledBuiltins.includes(r.id),
  }))

  return {
    enabled,
    supportEmail,
    conversationRetentionDays: row?.conversationRetentionDays ?? CONVERSATION_RETENTION_DEFAULT_DAYS,
    rules: { builtins, custom: customRules },
    enabledCount: countEnabledRules(disabledBuiltins, customRules),
  }
}

// Enabled builtins + enabled custom rules, as English scenario texts for the AI
// prompt. Empty = no handoff rules, so the AI never redirects to support.
export function getEnabledRuleScenarios(row: WidgetConfigRow | undefined | null): string[] {
  const disabledBuiltins = row?.disabledBuiltins ?? []
  const customRules = row?.customRules ?? []
  const builtin = WIDGET_BUILTIN_RULES
    .filter(r => !disabledBuiltins.includes(r.id))
    .map(r => r.scenario)
  const custom = customRules
    .filter(r => r.enabled)
    .map(r => r.scenario)
  return [...builtin, ...custom]
}
