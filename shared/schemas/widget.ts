import { z } from 'zod/v4'
import { CONVERSATION_RETENTION_MAX_DAYS, CONVERSATION_RETENTION_MIN_DAYS } from '../constants/conversation'
import { WIDGET_BUILTIN_RULE_IDS, WIDGET_MAX_ENABLED_RULES, WIDGET_MAX_RULE_LENGTH } from '../constants/widget-rules'

// Handoff rule text goes into the AI system prompt verbatim, so the limits are
// enforced here rather than in the UI alone.
const customRuleSchema = z.object({
  // Absent on a rule the admin just added; the endpoint assigns one.
  id: z.string().optional(),
  scenario: z.string().trim()
    .min(1, 'Rule cannot be empty')
    .max(WIDGET_MAX_RULE_LENGTH, `Rule must be ${WIDGET_MAX_RULE_LENGTH} characters or less`),
  enabled: z.boolean(),
})

export const updateWidgetSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  // Empty string clears it.
  supportEmail: z.union([z.email('Invalid support email'), z.literal('')]).optional(),
  disabledBuiltins: z.array(z.enum(WIDGET_BUILTIN_RULE_IDS as [string, ...string[]])).optional(),
  // Sent whole: the client posts the current list, not a diff.
  customRules: z.array(customRuleSchema).optional(),
  conversationRetentionDays: z.int('Retention must be a whole number of days')
    .min(CONVERSATION_RETENTION_MIN_DAYS, `Retention must be at least ${CONVERSATION_RETENTION_MIN_DAYS} days`)
    .max(CONVERSATION_RETENTION_MAX_DAYS, `Retention must be ${CONVERSATION_RETENTION_MAX_DAYS} days or less`)
    .optional(),
})

export type UpdateWidgetSettingsInput = z.infer<typeof updateWidgetSettingsSchema>

// Cross-field check the schema can't express: the cap spans built-ins and custom
// rules, and either half may be absent from a partial update, so the caller
// merges with the stored row first. Returns a message instead of throwing —
// shared/ is imported by the browser too, where h3's createError doesn't exist.
export function checkEnabledRuleCap(
  disabledBuiltins: string[],
  customRules: { enabled: boolean }[],
): string | null {
  const enabled = WIDGET_BUILTIN_RULE_IDS.filter(id => !disabledBuiltins.includes(id)).length
    + customRules.filter(r => r.enabled).length
  return enabled > WIDGET_MAX_ENABLED_RULES
    ? `At most ${WIDGET_MAX_ENABLED_RULES} rules can be enabled`
    : null
}
