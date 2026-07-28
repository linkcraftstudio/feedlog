// Built-in handoff rules live in code; organization_widget only stores the ids
// of built-ins an org has disabled. `scenario` (English) is injected into the AI
// prompt; `scenarioZh` is admin-facing display only.

export interface WidgetCustomRule {
  id: string
  scenario: string
  enabled: boolean
}

export interface WidgetBuiltinRule {
  id: string
  scenario: string
  scenarioZh: string
}

export const WIDGET_MAX_RULE_LENGTH = 180
export const WIDGET_MAX_ENABLED_RULES = 10

export const WIDGET_BUILTIN_RULES: readonly WidgetBuiltinRule[] = [
  {
    id: 'builtin-billing',
    scenario: 'the user needs help with a charge, refund, payment failure, or invoice on their account',
    scenarioZh: '用户就扣费、退款、支付失败或发票问题寻求客服帮助',
  },
  {
    id: 'builtin-account-access',
    scenario: 'the user is blocked by a login problem, account lockout, or unauthorized access to their account',
    scenarioZh: '用户遇到登录问题、账号被锁或账号被盗用,需要帮助',
  },
  {
    id: 'builtin-privacy-legal',
    scenario: 'the user is making a privacy, data-deletion, copyright, or other legal request about their own data or rights',
    scenarioZh: '用户就隐私、数据删除、版权或其他法律问题提出诉求',
  },
] as const

export const WIDGET_BUILTIN_RULE_IDS: readonly string[] = WIDGET_BUILTIN_RULES.map(r => r.id)
